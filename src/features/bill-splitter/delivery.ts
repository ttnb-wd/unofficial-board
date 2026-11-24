import { allowsGroupWorkflows, groupDestination } from '../../access/policy.js';
import type { PrismaClient } from '@prisma/client';
import { Markup, TelegramError } from 'telegraf';
import type { Telegram } from 'telegraf';
import type { AppConfig } from '../../config.js';
import { canAccessBoard } from '../../access/membership.js';
import { BillError } from './rules.js';
import { billMessage } from '../group-message.js';

const staleAfterMs = 5 * 60_000;

export async function deliverBills(db: PrismaClient, telegram: Telegram, config: AppConfig, username: string) {
  if (!allowsGroupWorkflows(config)) return;
  groupDestination(config, config.groupId);
  const scope = { OR: [
    { paymentId: null, bill: { groupId: config.groupId } },
    { billId: null, payment: { share: { bill: { groupId: config.groupId } } } },
  ] };
  const now = new Date();
  await db.billDelivery.updateMany({
    where: { ...scope, status: 'SENDING', attemptAt: { lt: new Date(now.getTime() - staleAfterMs) } },
    data: { status: 'UNKNOWN' },
  });
  const pending = await db.billDelivery.findMany({
    where: { ...scope, status: 'QUEUED', nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' }, take: 10,
    include: { bill: { include: { shares: { orderBy: { memberId: 'asc' } } } },
      payment: { select: { share: { select: { bill: { select: { id: true, receiverId: true, groupId: true } } } } } } },
  });
  const link = (start: string) => `https://t.me/${username}?start=${start}`;
  for (const item of pending) {
    const bill = item.bill ?? item.payment?.share.bill;
    if (!bill || (item.bill && item.payment) || bill.groupId !== config.groupId) continue;
    const claimKey = { ...scope, id: item.id };
    const attemptAt = new Date();
    const claim = await db.billDelivery.updateMany({
      where: { ...claimKey, status: 'QUEUED', nextAttemptAt: { lte: now } },
      data: { status: 'SENDING', attemptAt, attempts: { increment: 1 }, failureCode: null },
    });
    if (!claim.count) continue;
    const activeClaim = { ...claimKey, attemptAt, status: { in: ['SENDING', 'UNKNOWN'] as ('SENDING' | 'UNKNOWN')[] } };
    let messageId: number;
    try {
      if (item.bill) {
        const { text, ...extra } = billMessage(item.bill, username);
        const message = await telegram.sendMessage(groupDestination(config, item.bill.groupId), text, extra);
        messageId = message.message_id;
      } else if (item.payment) {
        const bill = item.payment.share.bill;
        if (config.testGroup) {
          groupDestination(config, bill.groupId);
          let eligible: boolean;
          try {
            eligible = bill.receiverId > 0n && await canAccessBoard(telegram, db, config, bill.receiverId, false);
          } catch {
            // Verification failed before a private send, so retry safely.
            await db.billDelivery.updateMany({
              where: activeClaim,
              data: { status: 'QUEUED', nextAttemptAt: new Date(Date.now() + 60_000) },
            });
            continue;
          }
          if (!eligible) {
            await db.billDelivery.updateMany({
              where: activeClaim, data: { status: 'FAILED' },
            });
            continue;
          }
        }
        const message = await telegram.sendMessage(String(bill.receiverId), 'Open Bill Splitter to check your private payment review.', {
          protect_content: true,
          ...Markup.inlineKeyboard([[Markup.button.url('Review payment', link(`bill_${bill.id}`))]]),
        });
        messageId = message.message_id;
      } else {
        continue;
      }
    } catch (error) {
      const code = error instanceof TelegramError ? error.code : null;
      const retry = code === 429 && item.attempts < 4;
      const delay = error instanceof TelegramError ? error.parameters?.retry_after ?? 60 : 60;
      await db.billDelivery.updateMany({
        where: activeClaim,
        data: { status: retry ? 'QUEUED' : code !== null && [400, 401, 403, 404, 429].includes(code) ? 'FAILED' : 'UNKNOWN',
          failureCode: code, ...(retry ? { nextAttemptAt: new Date(Date.now() + 1000 * delay) } : {}) },
      });
      continue;
    }
    await db.billDelivery.updateMany({
      where: activeClaim,
      data: { status: 'SENT', telegramMessageId: messageId },
    });
  }
}

export async function retryAnnouncement(db: PrismaClient, groupId: bigint, actor: bigint, id: string) {
  const result = await db.billDelivery.updateMany({
    where: { billId: id, paymentId: null, bill: { groupId, creatorId: actor }, status: 'FAILED' },
    data: { status: 'QUEUED', nextAttemptAt: new Date() },
  });
  if (!result.count) throw new BillError(409, 'Only a confirmed delivery failure can be retried.');
}

