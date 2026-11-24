import { isOwnerPreview } from '../../access/policy.js';
import type { PlanCountdown, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import { chooseStartVariant, deliveryWindows, notification, parseYangonTime, startExamples, yangon } from './rules.js';

const fields = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).default(''),
  date: z.string(),
  time: z.string(),
  timeZone: z.literal(yangon),
});
const id = z.uuid();
const version = z.number().int().positive();
const pageSize = 8;
const cursor = z.object({ startsAt: z.iso.datetime(), id }).optional();
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('session') }),
  z.object({ action: z.literal('upcoming'), cursor }),
  z.object({ action: z.literal('mine'), cursor }),
  z.object({ action: z.literal('completed'), cursor }),
  z.object({ action: z.literal('detail'), id }),
  fields.extend({ action: z.literal('create'), requestId: id }),
  fields.extend({ action: z.literal('edit'), id, version }),
  z.object({ action: z.literal('cancel'), id, version }),
]);

export async function lockCountdown(tx: Prisma.TransactionClient, countdownId: string, groupId: bigint) {
  await tx.$queryRaw`SELECT "id" FROM "PlanCountdown" WHERE "id" = ${countdownId} AND "groupId" = ${groupId} FOR UPDATE`;
}

function present(plan: PlanCountdown, userId: bigint) {
  return {
    id: plan.id, title: plan.title, description: plan.description, startsAt: plan.startsAt,
    timeZone: plan.timeZone, version: plan.version, cancelledAt: plan.cancelledAt,
    owned: plan.creatorId === userId,
  };
}

function scheduledJob(job: ReturnType<typeof deliveryWindows>[number], now: Date, startVariant?: number | null) {
  return {
    ...job, nextAttemptAt: job.scheduledAt,
    status: job.scheduledAt < now ? 'MISSED' as const : 'QUEUED' as const,
    startVariant: job.kind === 'AT_START' ? startVariant ?? chooseStartVariant() : null,
  };
}

function error(status: number, message: string) {
  return { status, body: { error: message } };
}

export async function handleCountdownAction(input: unknown, userId: bigint, config: AppConfig, db: PrismaClient, clock = () => new Date()) {
  const now = clock();
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success) return error(400, 'Check the plan details. Use Yangon time and a title up to 80 characters.');
  const action = parsed.data;
  const preview = isOwnerPreview(config);
  const ok = <T extends object>(body: T) => ({ status: 200, body: { serverNow: clock().toISOString(), ...body } });
  if (preview && userId !== config.prelaunchOwnerId) return error(403, 'Owner access is required.');
  if (action.action === 'session') {
    const example = { title: 'Weekend picnic', startsAt: new Date(now.getTime() + 48 * 3_600_000) };
    return ok({
      preview,
      ...(preview ? { messages: deliveryWindows(example.startsAt, now).map((job) => ({
        kind: job.kind, text: notification(job.kind, example.title, example.startsAt, job.scheduledAt),
        ...(job.kind === 'AT_START' ? { variants: startExamples(example.title) } : {}),
      })) } : {}),
    });
  }
  if (preview) return error(403, 'Use the isolated countdown preview.');
  const scope = { groupId: config.groupId };
  if (action.action === 'mine' || action.action === 'upcoming' || action.action === 'completed') {
    const descending = action.action === 'completed';
    const direction = descending ? 'desc' : 'asc';
    const compare = descending ? 'lt' : 'gt';
    const where: Prisma.PlanCountdownWhereInput = { ...scope };
    if (action.action === 'mine') where.creatorId = userId;
    else {
      where.cancelledAt = null;
      where.startsAt = descending ? { lte: now } : { gt: now };
    }
    if (action.cursor) {
      const before = new Date(action.cursor.startsAt);
      where.OR = [{ startsAt: { [compare]: before } }, { startsAt: before, id: { [compare]: action.cursor.id } }];
    }
    const plans = await db.planCountdown.findMany({
      where, orderBy: [{ startsAt: direction }, { id: direction }], take: pageSize + 1,
    });
    const page = plans.slice(0, pageSize);
    const last = plans.length > pageSize ? page.at(-1) : undefined;
    return ok({ plans: page.map((plan) => present(plan, userId)), nextCursor: last ? { startsAt: last.startsAt, id: last.id } : null });
  }
  if (action.action === 'detail') {
    const plan = await db.planCountdown.findFirst({ where: { ...scope, id: action.id } });
    return plan ? ok({ plan: present(plan, userId) }) : error(404, 'Countdown not found.');
  }

  return db.$transaction(async (tx) => {
    if (action.action === 'create') {
      const key = { ...scope, creatorId: userId, requestId: action.requestId };
      const lockKey = `countdown:${key.groupId}:${key.creatorId}:${key.requestId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const existing = await tx.planCountdown.findUnique({ where: { groupId_creatorId_requestId: key } });
      if (existing) return ok({ plan: present(existing, userId) });
      const mutationTime = clock();
      const startsAt = parseYangonTime(action.date, action.time);
      if (!startsAt || startsAt <= mutationTime) return error(400, 'Choose a valid future date and time in Yangon.');
      const plan = await tx.planCountdown.create({
        data: {
          ...key, title: action.title, description: action.description, startsAt, timeZone: yangon,
          deliveries: { create: deliveryWindows(startsAt, mutationTime).map((job) => scheduledJob(job, mutationTime)) },
        },
      });
      return { ...ok({ plan: present(plan, userId) }), status: 201 };
    }

    await lockCountdown(tx, action.id, config.groupId);
    const plan = await tx.planCountdown.findFirst({ where: { ...scope, id: action.id } });
    if (!plan) return error(404, 'Countdown not found.');
    if (plan.creatorId !== userId) return error(403, 'Only the creator can change this countdown.');
    const mutationTime = clock();
    if (plan.version !== action.version || plan.cancelledAt || plan.startsAt <= mutationTime) {
      return error(409, 'This countdown changed or ended. Reopen it to see the latest details.');
    }
    if (action.action === 'cancel') {
      const cancelled = await tx.planCountdown.update({
        where: { id: plan.id }, data: { cancelledAt: mutationTime, version: { increment: 1 } },
      });
      await tx.planCountdownDelivery.updateMany({
        where: { countdownId: plan.id, status: 'QUEUED' },
        data: { status: 'SKIPPED' },
      });
      return ok({ plan: present(cancelled, userId) });
    }
    const startsAt = parseYangonTime(action.date, action.time);
    if (!startsAt || startsAt <= mutationTime) return error(400, 'Choose a valid future date and time in Yangon.');
    const updated = await tx.planCountdown.update({
      where: { id: plan.id },
      data: { title: action.title, description: action.description, startsAt, version: { increment: 1 } },
    });
    if (startsAt.getTime() !== plan.startsAt.getTime()) {
      for (const job of deliveryWindows(startsAt, mutationTime)) {
        const key = { countdownId: plan.id, kind: job.kind };
        const existing = await tx.planCountdownDelivery.findUnique({ where: { countdownId_kind: key } });
        if (existing && !['QUEUED', 'SKIPPED', 'MISSED'].includes(existing.status)) continue;
        if (job.kind === 'ANNOUNCEMENT') {
          if (existing?.status === 'QUEUED') await tx.planCountdownDelivery.update({
            where: { countdownId_kind: key }, data: { expiresAt: job.expiresAt },
          });
          continue;
        }
        const schedule = scheduledJob(job, mutationTime, existing?.startVariant);
        await tx.planCountdownDelivery.upsert({
          where: { countdownId_kind: key },
          create: { ...schedule, countdownId: plan.id },
          update: { ...schedule, attemptAt: null, attempts: 0 },
        });
      }
    }
    return ok({ plan: present(updated, userId) });
  }, { timeout: 30_000 });
}
