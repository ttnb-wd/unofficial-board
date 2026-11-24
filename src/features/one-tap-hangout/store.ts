import { allowsGroupWorkflows } from '../../access/policy.js';
import type { Hangout, HangoutRsvp, Prisma, PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config.js';
import { emptyCounts, eventStatus } from './rules.js';

export function lockHangout(tx: Prisma.TransactionClient, id: string, groupId: bigint) {
  return tx.$queryRaw`SELECT "id" FROM "Hangout" WHERE "id" = ${id} AND "groupId" = ${groupId} FOR NO KEY UPDATE`;
}

export function scope(groupId: bigint) {
  return { groupId, requestId: { not: null } };
}

export async function queueInvitationEdit(tx: Prisma.TransactionClient, id: string, now: Date) {
  await tx.hangoutInvitation.updateMany({
    where: { hangoutId: id, status: 'SENT', unavailableAt: null },
    data: { syncAt: now, syncAttempts: 0 },
  });
}

type Response = { memberId: bigint; response: HangoutRsvp; displayName: string };
export function countsFor(responses: { response: HangoutRsvp }[]) {
  const counts = emptyCounts();
  for (const entry of responses) counts[entry.response]++;
  return counts;
}

export function present(hangout: Hangout, memberId: bigint, now: Date, responses: Response[] = [], details = false) {
  return {
    id: hangout.id, title: hangout.title, place: hangout.place, description: hangout.description,
    version: hangout.version, startsAt: hangout.startsAt, owned: hangout.creatorId === memberId,
    status: eventStatus(hangout.status, hangout.startsAt, now), counts: countsFor(responses),
    myRsvp: responses.find((entry) => entry.memberId === memberId)?.response ?? null,
    ...(details ? { participants: responses.map(({ response, displayName }) => ({ response, displayName })) } : {}),
  };
}

type Actor = { id: bigint; name: string; receivedAt: Date };
type Callback = { messageId: number; updateId: bigint };
export async function respondToHangout(
  db: PrismaClient, config: AppConfig, id: string, actor: Actor, response: HangoutRsvp,
  callback?: Callback, clock = () => new Date(),
) {
  if (!allowsGroupWorkflows(config)) return { status: 403, error: 'An active group is required.' };
  return db.$transaction(async (tx) => {
    await lockHangout(tx, id, config.groupId);
    const event = await tx.hangout.findFirst({
      where: { ...scope(config.groupId), id }, include: { invitation: true },
    });
    if (!event) return { status: 404, error: 'Hangout not found.' };
    if (callback && event.invitation?.messageId !== callback.messageId) {
      return { status: 404, error: 'This invitation is unavailable. Use the private bot menu.' };
    }
    const now = clock();
    if (eventStatus(event.status, event.startsAt, now) !== 'OPEN') {
      return { status: 409, error: 'RSVP is closed.' };
    }
    if (config.testGroup && actor.id === config.prelaunchOwnerId &&
        !await tx.groupMembership.findUnique({ where: { groupId_memberId: { groupId: config.groupId, memberId: actor.id } } })) {
      return { status: 403, error: 'Join the test group before responding to invitations.' };
    }
    const key = { hangoutId: id, memberId: actor.id };
    const existing = await tx.hangoutResponse.findUnique({ where: { hangoutId_memberId: key } });
    const stale = existing && (existing.respondedAt > actor.receivedAt ||
      (callback && existing.updateId !== null && callback.updateId <= existing.updateId &&
        +actor.receivedAt - +existing.respondedAt < 7 * 86_400_000));
    if (!stale) {
      const data = {
        response, displayName: actor.name, respondedAt: actor.receivedAt,
        updateId: callback?.updateId ?? existing?.updateId ?? null,
      };
      await tx.hangoutResponse.upsert({
        where: { hangoutId_memberId: key },
        create: { ...key, ...data, groupId: config.groupId },
        update: data,
      });
      if (existing?.response !== response) await queueInvitationEdit(tx, id, now);
    }
    const responses = await tx.hangoutResponse.findMany({ where: { hangoutId: id }, orderBy: { displayName: 'asc' } });
    return { status: 200, hangout: present(event, actor.id, now, responses, true) };
  }, { timeout: 30_000 });
}
