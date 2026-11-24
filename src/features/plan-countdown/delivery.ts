import { allowsGroupWorkflows, groupDestination } from '../../access/policy.js';
import type { CountdownDeliveryStatus, PrismaClient } from '@prisma/client';
import { TelegramError } from 'telegraf';
import type { Telegram } from 'telegraf';
import type { AppConfig } from '../../config.js';
import { lockCountdown } from './api.js';
import { notification } from './rules.js';

export async function deliverCountdowns(db: PrismaClient, telegram: Telegram, config: AppConfig, username: string, clock = () => new Date()) {
  if (!allowsGroupWorkflows(config)) return;
  groupDestination(config, config.groupId);

  const now = clock();
  const countdown = { groupId: config.groupId };
  await db.planCountdownDelivery.updateMany({
    where: { countdown, status: 'SENDING', attemptAt: { lt: new Date(+now - 300_000) } },
    data: { status: 'UNKNOWN' },
  });
  await db.planCountdownDelivery.updateMany({
    where: { countdown, status: 'QUEUED', expiresAt: { lte: now } },
    data: { status: 'MISSED' },
  });
  const jobs = await db.planCountdownDelivery.findMany({
    where: { countdown, status: 'QUEUED', nextAttemptAt: { lte: now }, expiresAt: { gt: now } },
    orderBy: [{ nextAttemptAt: 'asc' }, { countdownId: 'asc' }, { kind: 'asc' }], take: 20,
    select: { countdownId: true, kind: true },
  });

  for (const key of jobs) {
    await db.$transaction(async (tx) => {
      await lockCountdown(tx, key.countdownId, config.groupId);
      const job = await tx.planCountdownDelivery.findFirst({
        where: { ...key, countdown }, include: { countdown: true },
      });
      const attemptAt = clock();
      if (!job || job.status !== 'QUEUED' || job.scheduledAt > attemptAt || job.nextAttemptAt > attemptAt || job.expiresAt <= attemptAt) return;
      const plan = job.countdown;
      if (plan.groupId !== config.groupId || plan.cancelledAt) return;

      // Commit the claim independently while the parent row prevents concurrent edits.
      const claimed = await db.planCountdownDelivery.updateMany({
        where: { ...key, countdown, status: 'QUEUED', expiresAt: { gt: attemptAt } },
        data: { status: 'SENDING', attemptAt, attempts: { increment: 1 } },
      });
      if (!claimed.count) return;
      const publishedAt = clock();
      if (job.expiresAt <= publishedAt || (key.kind !== 'AT_START' && plan.startsAt <= publishedAt)) {
        await db.planCountdownDelivery.updateMany({
          where: { ...key, countdown, status: 'SENDING', attemptAt },
          data: { status: 'MISSED' },
        });
        return;
      }

      let status: CountdownDeliveryStatus;
      let nextAttemptAt = job.nextAttemptAt;
      let delivery: { telegramMessageId: number; deliveredAt: Date } | undefined;
      try {
        const sent = await telegram.callApi('sendMessage', {
          chat_id: groupDestination(config, plan.groupId),
          text: notification(key.kind, plan.title, plan.startsAt, publishedAt, job.startVariant),
          reply_markup: { inline_keyboard: [[{
            text: 'View Countdown', url: `https://t.me/${username}?start=countdown_${plan.id}`,
          }]] },
        }, {
          // Telegraf's node-fetch accepts native signals, but its types use the polyfill.
          signal: AbortSignal.timeout(10_000) as unknown as NonNullable<NonNullable<Parameters<Telegram['callApi']>[2]>['signal']>,
        });
        status = 'SENT';
        delivery = { telegramMessageId: sent.message_id, deliveredAt: new Date(sent.date * 1000) };
      } catch (error) {
        const code = error instanceof TelegramError ? error.code : undefined;
        const retryAfter = error instanceof TelegramError ? error.parameters?.retry_after ?? 60 : 60;
        if (code === 429 && job.attempts < 4) {
          nextAttemptAt = new Date(+clock() + Math.max(1, retryAfter) * 1000);
          status = nextAttemptAt < job.expiresAt ? 'QUEUED' : 'MISSED';
        } else {
          status = code !== undefined && [400, 401, 403, 404, 429].includes(code) ? 'FAILED' : 'UNKNOWN';
        }
      }
      await db.planCountdownDelivery.updateMany({
        where: { ...key, countdown, status: { in: ['SENDING', 'UNKNOWN'] }, attemptAt },
        data: { status, nextAttemptAt, ...delivery },
      });
    }, { maxWait: 10_000, timeout: 30_000 });
  }
}
