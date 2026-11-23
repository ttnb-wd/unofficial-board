import type { Hangout, HangoutInvitation, PrismaClient } from '@prisma/client';
import { TelegramError } from 'telegraf';
import type { Telegram } from 'telegraf';
import type { AppConfig } from '../../config.js';
import { yangon } from '../../mini-app/yangon.js';
import { choices, eventStatus, labels } from './rules.js';
import { countsFor, lockHangout } from './store.js';

const minutes = 60_000;
const maxAttempts = 5;
const zoneFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: yangon });
type TelegramSignal = NonNullable<NonNullable<Parameters<Telegram['callApi']>[2]>['signal']>;
const timeout = () => ({ signal: AbortSignal.timeout(10_000) as unknown as TelegramSignal });

export function invitationContent(
  event: Hangout & { responses: Parameters<typeof countsFor>[0] }, username: string, now: Date,
) {
  const state = eventStatus(event.status, event.startsAt, now);
  const counts = countsFor(event.responses);
  const counters = Object.values(choices).map((response) => `${labels[response]}: ${counts[response]}`).join('\n');
  const text = [
    `🍕 ${event.title}`,
    event.startsAt ? `📅 ${zoneFormat.format(event.startsAt)} · Yangon` : null,
    event.place ? `📍 ${event.place}` : null,
    event.description || null,
    '',
    state === 'OPEN' ? "Who's coming?" : state === 'CANCELLED' ? 'Cancelled' : 'Hangout started · RSVP closed',
    counters,
  ].filter((line) => line !== null).join('\n');
  const details = [{ text: 'View Details', url: `https://t.me/${username}?start=hangout_${event.id}` }];
  const buttons = Object.entries(choices).map(([key, response]) => ({
    text: labels[response], callback_data: `ho:${key}:${event.id}`,
  }));
  return { text, reply_markup: { inline_keyboard: state === 'OPEN' ? [buttons, details] : [details] } };
}

function retryAfter(error: unknown, fallback: number) {
  return Math.max(1, error instanceof TelegramError ? error.parameters?.retry_after ?? fallback : fallback);
}

export async function deliverHangouts(db: PrismaClient, telegram: Telegram, config: AppConfig, username: string, clock = () => new Date()) {
  if (config.accessMode !== 'LIVE') return;
  const now = clock();
  const hangout = { groupId: config.groupId };
  await db.hangoutInvitation.updateMany({
    where: { hangout, status: 'SENDING', attemptAt: { lt: new Date(+now - 5 * minutes) } },
    data: { status: 'UNKNOWN' },
  });
  const jobs = await db.hangoutInvitation.findMany({
    where: { hangout, OR: [
      { status: 'QUEUED', nextAttemptAt: { lte: now } },
      { status: 'SENT', syncAt: { lte: now }, unavailableAt: null },
    ] },
    orderBy: [{ nextAttemptAt: 'asc' }, { hangoutId: 'asc' }], take: 20,
  });

  for (const { hangoutId } of jobs) {
    await db.$transaction(async (tx) => {
      await lockHangout(tx, hangoutId, config.groupId);
      const event = await tx.hangout.findFirst({
        where: { id: hangoutId, ...hangout },
        include: { invitation: true, responses: { select: { response: true } } },
      });
      const job = event?.invitation;
      if (!event || !job) return;
      const at = clock();
      if (job.status === 'QUEUED' && job.nextAttemptAt <= at) {
        if (eventStatus(event.status, event.startsAt, at) !== 'OPEN') {
          await tx.hangoutInvitation.update({ where: { hangoutId }, data: { status: 'EXPIRED' } });
          return;
        }
        await sendInvitation(db, telegram, config, username, event, job, clock);
      } else if (job.status === 'SENT' && job.messageId !== null && job.syncAt && job.syncAt <= at && !job.unavailableAt) {
        const nextSync = eventStatus(event.status, event.startsAt, at) === 'OPEN' ? event.startsAt : null;
        const content = invitationContent(event, username, at);
        let data = { syncAt: nextSync, syncAttempts: 0, unavailableAt: null as Date | null };
        try {
          await telegram.callApi('editMessageText', {
            chat_id: String(config.groupId), message_id: job.messageId, ...content,
          }, timeout());
        } catch (error) {
          const code = error instanceof TelegramError ? error.code : undefined;
          const unchanged = code === 400 && error instanceof Error && /message is not modified/i.test(error.message);
          if (!unchanged) {
            const attempted = clock();
            const attempts = job.syncAttempts + 1;
            const unavailable = code !== undefined && [400, 401, 403, 404].includes(code);
            data = unavailable || attempts >= maxAttempts
              ? { syncAt: null, syncAttempts: attempts, unavailableAt: attempted }
              : { syncAt: new Date(+attempted + retryAfter(error, 15 * 2 ** attempts) * 1000),
                syncAttempts: attempts, unavailableAt: null };
          }
        }
        await tx.hangoutInvitation.update({ where: { hangoutId }, data });
      }
    }, { maxWait: 10_000, timeout: 30_000 });
  }
}

async function sendInvitation(
  db: PrismaClient, telegram: Telegram, config: AppConfig, username: string,
  event: Hangout & { responses: Parameters<typeof countsFor>[0] }, job: HangoutInvitation, clock: () => Date,
) {
  const where = { hangoutId: event.id };
  const attemptAt = clock();
  // Persist the claim on a second connection while the caller holds the event lock.
  const claimed = await db.hangoutInvitation.updateMany({
    where: { ...where, status: 'QUEUED', nextAttemptAt: { lte: attemptAt } },
    data: { status: 'SENDING', attemptAt, attempts: { increment: 1 } },
  });
  if (!claimed.count) return;
  const claim = { ...where, attemptAt, status: { in: ['SENDING', 'UNKNOWN'] as ('SENDING' | 'UNKNOWN')[] } };
  const at = clock();
  if (eventStatus(event.status, event.startsAt, at) !== 'OPEN') {
    await db.hangoutInvitation.updateMany({ where: claim, data: { status: 'EXPIRED' } });
    return;
  }
  let sent;
  try {
    sent = await telegram.callApi('sendMessage', {
      chat_id: String(config.groupId), ...invitationContent(event, username, at),
    }, timeout());
  } catch (error) {
    const code = error instanceof TelegramError ? error.code : undefined;
    const nextAttemptAt = new Date(+clock() + retryAfter(error, 30) * 1000);
    const retry = code === 429 && job.attempts + 1 < maxAttempts && event.startsAt && nextAttemptAt < event.startsAt;
    await db.hangoutInvitation.updateMany({
      where: claim,
      data: retry ? { status: 'QUEUED', nextAttemptAt } : {
        status: code !== undefined && [400, 401, 403, 404, 429].includes(code) ? 'FAILED' : 'UNKNOWN',
      },
    });
    return;
  }
  await db.hangoutInvitation.updateMany({
    where: claim, data: { status: 'SENT', messageId: sent.message_id, syncAt: event.startsAt },
  });
}
