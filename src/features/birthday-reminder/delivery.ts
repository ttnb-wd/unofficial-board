import { allowsGroupWorkflows, groupDestination } from '../../access/policy.js';
import type { PrismaClient } from '@prisma/client';
import { TelegramError } from 'telegraf';
import type { Telegram } from 'telegraf';
import type { AppConfig } from '../../config.js';
import { isTestParticipant } from '../../access/membership.js';
import { birthdayMember } from './api.js';
import { announcement, dateKey, occurrence, yangonDate } from './rules.js';

const claimTimeoutMs = 5 * 60_000;
const firstDeliveryHour = 9;

export async function deliverBirthdays(db: PrismaClient, telegram: Telegram, config: AppConfig, clock = () => new Date()) {
  if (!allowsGroupWorkflows(config)) return;
  groupDestination(config, config.groupId);

  const now = clock();
  const today = yangonDate(now);
  const scope = { groupId: config.groupId };
  await db.birthdayDelivery.updateMany({
    where: { ...scope, status: 'SENDING', attemptAt: { lt: new Date(now.getTime() - claimTimeoutMs) } },
    data: { status: 'UNKNOWN' },
  });
  if (today.hour < firstDeliveryHour) return;

  const isToday = (date: { month: number; day: number }) =>
    dateKey(occurrence(date, today.year)) === dateKey(today);
  const birthdays = await db.birthday.findMany({
    where: { ...scope, preview: false, month: today.month, day: { in: today.month === 2 && today.day === 28 ? [28, 29] : [today.day] } },
    select: { memberId: true, month: true, day: true },
  });
  const candidates = birthdays.filter(isToday);
  if (!candidates.length) return;

  const annual = { ...scope, year: today.year };
  await db.birthdayDelivery.createMany({
    data: candidates.map(({ memberId }) => ({ ...annual, memberId, nextAttemptAt: now })),
    skipDuplicates: true,
  });
  const items = await db.birthdayDelivery.findMany({
    where: { ...annual, memberId: { in: candidates.map(({ memberId }) => memberId) }, status: 'QUEUED', nextAttemptAt: { lte: now } },
    orderBy: [{ nextAttemptAt: 'asc' }, { memberId: 'asc' }], take: 20,
  });

  for (const item of items) {
    if (dateKey(yangonDate(clock())) !== dateKey(today)) return;
    const key = { ...annual, memberId: item.memberId };
    const pending = { ...key, status: 'QUEUED' as const, nextAttemptAt: { lte: now } };
    if (!await isTestParticipant(db, config, item.memberId)) {
      await db.birthdayDelivery.updateMany({
        where: pending, data: { nextAttemptAt: new Date(clock().getTime() + 15 * 60_000) },
      });
      continue;
    }
    let member;
    try {
      member = await birthdayMember(telegram, scope.groupId, item.memberId);
    } catch {
      // Membership verification failed before any message was attempted.
      await db.birthdayDelivery.updateMany({
        where: pending, data: { nextAttemptAt: new Date(clock().getTime() + 5 * 60_000) },
      });
      continue;
    }
    if (!member) {
      await db.birthdayDelivery.updateMany({
        where: pending, data: { nextAttemptAt: new Date(clock().getTime() + 15 * 60_000) },
      });
      continue;
    }

    const birthday = await db.birthday.findUnique({
      where: { groupId_memberId_preview: { ...scope, memberId: item.memberId, preview: false } },
      select: { month: true, day: true },
    });
    if (!birthday || !isToday(birthday)) continue;
    const attemptAt = clock();
    if (dateKey(yangonDate(attemptAt)) !== dateKey(today)) return;
    const claimed = await db.birthdayDelivery.updateMany({
      where: pending, data: { status: 'SENDING', attemptAt, attempts: { increment: 1 } },
    });
    if (!claimed.count) continue;

    const name = member.first_name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const mention = `<a href="tg://user?id=${item.memberId}">${name}</a>`;
    let messageId: number;
    try {
      const sent = await telegram.sendMessage(groupDestination(config, item.groupId), announcement(mention), { parse_mode: 'HTML' });
      messageId = sent.message_id;
    } catch (error) {
      const code = error instanceof TelegramError ? error.code : undefined;
      const retry = code === 429 && item.attempts < 4;
      const delay = error instanceof TelegramError ? error.parameters?.retry_after ?? 60 : 60;
      const definiteFailure = code !== undefined && [400, 401, 403, 404, 429].includes(code);
      await db.birthdayDelivery.updateMany({
        where: { ...key, status: { in: ['SENDING', 'UNKNOWN'] }, attemptAt },
        data: {
          status: retry ? 'QUEUED' : definiteFailure ? 'FAILED' : 'UNKNOWN',
          ...(retry ? { nextAttemptAt: new Date(clock().getTime() + Math.max(delay, 1) * 1000) } : {}),
        },
      });
      continue;
    }

    await db.birthdayDelivery.updateMany({
      where: { ...key, status: { in: ['SENDING', 'UNKNOWN'] }, attemptAt },
      data: { status: 'SENT', telegramMessageId: messageId },
    });
  }
}
