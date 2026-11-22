import type { PrismaClient } from '@prisma/client';
import { Markup, TelegramError } from 'telegraf';
import type { Telegram } from 'telegraf';
import type { AppConfig } from '../../config.js';
import { announcement, BillError } from './rules.js';

const staleAfterMs = 5 * 60_000;

export async function deliverBills(db: PrismaClient, telegram: Telegram, config: AppConfig, username: string) {
  if (config.accessMode !== 'LIVE') return;
  const scope = { OR: [{ bill: { groupId: config.groupId } }, { payment: { share: { bill: { groupId: config.groupId } } } }] };
  const now = new Date();
  await db.billDelivery.updateMany({
    where: { ...scope, status: 'SENDING', attemptAt: { lt: new Date(now.getTime() - staleAfterMs) } },
    data: { status: 'UNKNOWN' },
  });
  const pending = await db.billDelivery.findMany({
    where: { ...scope, status: 'QUEUED', nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' }, take: 10,
    include: { bill: { include: { shares: { orderBy: { memberId: 'asc' } } } },
      payment: { select: { share: { select: { bill: { select: { id: true, receiverId: true } } } } } } },
  });
  const link = (start: string) => `https://t.me/${username}?start=${start}`;
  for (const item of pending) {
    const claim = await db.billDelivery.updateMany({
      where: { id: item.id, status: 'QUEUED', nextAttemptAt: { lte: now } },
      data: { status: 'SENDING', attemptAt: new Date(), attempts: { increment: 1 }, failureCode: null },
    });
    if (!claim.count) continue;
    let messageId: number;
    try {
      if (item.bill) {
        const message = await telegram.sendMessage(String(config.groupId), announcement(item.bill), {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[
            Markup.button.url('View Bill', link(`bill_${item.bill.id}`)),
            Markup.button.url('Debt Status', link('bill_ledger')),
          ]]),
        });
        messageId = message.message_id;
      } else if (item.payment) {
        const bill = item.payment.share.bill;
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
        where: { id: item.id, status: 'SENDING' },
        data: { status: retry ? 'QUEUED' : code !== null && [400, 401, 403, 404, 429].includes(code) ? 'FAILED' : 'UNKNOWN',
          failureCode: code, ...(retry ? { nextAttemptAt: new Date(Date.now() + 1000 * delay) } : {}) },
      });
      continue;
    }
    await db.billDelivery.updateMany({
      where: { id: item.id, status: { in: ['SENDING', 'UNKNOWN'] } },
      data: { status: 'SENT', telegramMessageId: messageId },
    });
  }
}

export async function retryAnnouncement(db: PrismaClient, groupId: bigint, actor: bigint, id: string) {
  const result = await db.billDelivery.updateMany({
    where: { billId: id, bill: { groupId, creatorId: actor }, status: 'FAILED' },
    data: { status: 'QUEUED', nextAttemptAt: new Date() },
  });
  if (!result.count) throw new BillError(409, 'Only a confirmed delivery failure can be retried.');
}

