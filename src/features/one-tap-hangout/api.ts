import { isOwnerPreview } from '../../access/policy.js';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import { eventStatus, eventTime, fields, hangoutId, rsvp } from './rules.js';
import { lockHangout, present, queueInvitationEdit, respondToHangout, scope } from './store.js';

const cursor = z.object({ startsAt: z.iso.datetime(), id: hangoutId }).optional();
const version = z.number().int().positive();
const actions = z.discriminatedUnion('action', [
  z.object({ action: z.literal('session') }),
  z.object({ action: z.literal('active'), cursor }),
  z.object({ action: z.literal('mine'), cursor }),
  z.object({ action: z.literal('completed'), cursor }),
  z.object({ action: z.literal('detail'), id: hangoutId }),
  fields.extend({ action: z.literal('create'), requestId: z.uuid() }),
  fields.extend({ action: z.literal('edit'), id: hangoutId, version }),
  z.object({ action: z.literal('cancel'), id: hangoutId, version }),
  z.object({ action: z.literal('rsvp'), id: hangoutId, response: rsvp }),
]);

const pageSize = 8;
const reject = (status: number, error: string) => ({ status, body: { error } });

export async function handleHangoutAction(
  input: unknown, actor: { id: bigint; name: string; receivedAt: Date }, config: AppConfig, db: PrismaClient,
  clock = () => new Date(),
) {
  const parsed = actions.safeParse(input);
  if (!parsed.success) return reject(400, 'Check the hangout details and use Yangon time.');
  const action = parsed.data;
  const preview = isOwnerPreview(config);
  const ok = <T extends object>(body: T) => ({ status: 200, body: { ...body, serverNow: clock().toISOString() } });
  if (preview && actor.id !== config.prelaunchOwnerId) return reject(403, 'Owner access is required.');
  if (action.action === 'session') return ok({ preview });
  if (preview) return reject(403, 'Use the isolated hangout simulation.');

  const group = scope(config.groupId);
  const now = clock();
  if (action.action === 'active' || action.action === 'mine' || action.action === 'completed') {
    const descending = action.action === 'completed';
    const direction = descending ? 'desc' : 'asc';
    const compare = descending ? 'lt' : 'gt';
    const where: Prisma.HangoutWhereInput = { ...group, startsAt: { not: null } };
    if (action.action === 'mine') where.creatorId = actor.id;
    if (action.action === 'active') {
      where.status = 'OPEN';
      where.startsAt = { gt: now };
    }
    if (descending) {
      where.status = { not: 'CANCELLED' };
      where.startsAt = { lte: now };
    }
    if (action.cursor) {
      const at = new Date(action.cursor.startsAt);
      where.OR = [{ startsAt: { [compare]: at } }, { startsAt: at, id: { [compare]: action.cursor.id } }];
    }
    const events = await db.hangout.findMany({
      where, orderBy: [{ startsAt: direction }, { id: direction }], take: pageSize + 1, include: { responses: true },
    });
    const page = events.slice(0, pageSize);
    const last = events.length > pageSize ? page.at(-1) : null;
    return ok({ hangouts: page.map((event) => present(event, actor.id, now, event.responses)),
      nextCursor: last ? { startsAt: last.startsAt, id: last.id } : null });
  }
  if (action.action === 'detail') {
    const event = await db.hangout.findFirst({
      where: { ...group, id: action.id }, include: { responses: { orderBy: { displayName: 'asc' } }, invitation: { select: { status: true } } },
    });
    return event ? ok({ hangout: { ...present(event, actor.id, now, event.responses, true), delivery: event.invitation?.status ?? null } }) : reject(404, 'Hangout not found.');
  }
  if (action.action === 'rsvp') {
    const result = await respondToHangout(db, config, action.id, actor, action.response, undefined, clock);
    return 'hangout' in result && result.hangout ? { ...ok({ hangout: result.hangout }), wake: true } : reject(result.status, result.error ?? 'RSVP unavailable.');
  }

  return db.$transaction(async (tx) => {
    if (action.action === 'create') {
      const key = { groupId: config.groupId, creatorId: actor.id, requestId: action.requestId };
      const lockKey = `hangout:${key.groupId}:${key.creatorId}:${key.requestId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const existing = await tx.hangout.findUnique({ where: { groupId_creatorId_requestId: key }, include: { responses: true } });
      if (existing) return ok({ hangout: present(existing, actor.id, clock(), existing.responses, true) });
      const at = clock();
      const startsAt = eventTime(action, at);
      if (!startsAt) return reject(400, 'Choose a future time in Asia/Yangon.');
      const event = await tx.hangout.create({
        data: { ...key, title: action.title, place: action.place, description: action.description, startsAt,
          invitation: { create: { nextAttemptAt: at } } },
      });
      return { ...ok({ hangout: present(event, actor.id, at, [], true) }), status: 201, wake: true };
    }
    await lockHangout(tx, action.id, config.groupId);
    const event = await tx.hangout.findFirst({ where: { ...group, id: action.id }, include: { responses: true } });
    if (!event) return reject(404, 'Hangout not found.');
    if (event.creatorId !== actor.id) return reject(403, 'Only the creator can change this hangout.');
    const at = clock();
    if (event.version !== action.version || eventStatus(event.status, event.startsAt, at) !== 'OPEN') {
      return reject(409, 'This hangout changed or closed. Reopen it to see the latest details.');
    }
    const startsAt = action.action === 'edit' ? eventTime(action, at) : null;
    if (action.action === 'edit' && !startsAt) return reject(400, 'Choose a future time in Asia/Yangon.');
    const modified = await tx.hangout.update({
      where: { id: event.id },
      data: { version: { increment: 1 }, ...(action.action === 'cancel'
        ? { status: 'CANCELLED', cancelledAt: at }
        : { title: action.title, description: action.description, place: action.place, startsAt }) },
    });
    if (action.action === 'cancel') {
      await tx.hangoutInvitation.updateMany({
        where: { hangoutId: event.id, status: 'QUEUED' }, data: { status: 'EXPIRED' },
      });
    }
    await queueInvitationEdit(tx, event.id, at);
    return { ...ok({ hangout: present(modified, actor.id, at, event.responses, true) }), wake: true };
  }, { timeout: 30_000 });
}
