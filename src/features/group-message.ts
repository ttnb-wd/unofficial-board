import type { PrismaClient } from '@prisma/client';
import { Markup, TelegramError } from 'telegraf';
import type { Telegram } from 'telegraf';
import type { AppConfig } from '../config.js';
import { announcement } from './bill-splitter/rules.js';
import { canViewPublished, publishedVotes, readVoteRecord } from './vote-store.js';
import type { Kind, VoteRecord } from './vote-store.js';

export function voteMessage(kind: Kind, vote: VoteRecord, username: string) {
  const heading = kind === 'poll' ? 'Smart Poll' : 'Group Budget Vote';
  const open = vote.status !== 'CLOSED';
  const text = [
    heading, vote.title, '',
    ...vote.choices.map(({ label, count }, index) => `${index + 1}. ${label} · ${count}`),
    '', `Total voters: ${vote.total}`, ...(open ? [] : ['Voting closed']),
  ].join('\n');
  const rows = open && !vote.multiple
    ? vote.choices.map((_, index) => [Markup.button.callback(`Vote ${index + 1}`, `gv:${kind}:${vote.id}:${index}`)])
    : [];
  return {
    text, ...Markup.inlineKeyboard([...rows, [Markup.button.url(
      open && vote.multiple ? 'Choose answers privately' : 'View ballot',
      `https://t.me/${username}?start=vote_${kind}_${vote.id}`,
    )]]),
  };
}

export function billMessage(bill: Parameters<typeof announcement>[0] & { id: string }, username: string) {
  return {
    text: announcement(bill),
    parse_mode: 'HTML' as const,
    ...Markup.inlineKeyboard([[
      Markup.button.url('View Bill', `https://t.me/${username}?start=bill_${bill.id}`),
      Markup.button.url('Debt Status', `https://t.me/${username}?start=bill_ledger`),
    ]]),
  };
}

async function refresh(telegram: Telegram, groupId: bigint, messageId: number,
  content: ReturnType<typeof voteMessage> | ReturnType<typeof billMessage>, now: Date,
) {
  type Signal = NonNullable<NonNullable<Parameters<Telegram['callApi']>[2]>['signal']>;
  try {
    await telegram.callApi('editMessageText', { chat_id: String(groupId), message_id: messageId, ...content },
      { signal: AbortSignal.timeout(8_000) as unknown as Signal });
    return null;
  } catch (error) {
    if (error instanceof TelegramError && [400, 401, 403, 404].includes(error.code)) return null;
    const retryAfter = error instanceof TelegramError ? error.parameters?.retry_after ?? 60 : 60;
    return new Date(+now + Math.max(60, retryAfter) * 1000);
  }
}

export async function refreshGroupMessages(db: PrismaClient, telegram: Telegram, config: AppConfig, username: string) {
  if (config.accessMode !== 'LIVE') return;
  const now = new Date();
  const groupId = config.groupId;
  const where = { ...publishedVotes(groupId), groupSyncAt: { lte: now } };
  const select = { id: true };
  const [polls, budgets, bills] = await Promise.all([
    db.smartPoll.findMany({ where: { ...where, telegramPollId: null }, select, take: 5, orderBy: { groupSyncAt: 'asc' } }),
    db.budgetVote.findMany({ where, select, take: 5, orderBy: { groupSyncAt: 'asc' } }),
    db.billDelivery.findMany({ where: { bill: { groupId }, status: 'SENT', groupSyncAt: { lte: now } },
      select, take: 5, orderBy: { groupSyncAt: 'asc' } }),
  ]);
  const limits = { maxWait: 10_000, timeout: 15_000 };
  const votes = [...polls.map(({ id }) => ({ id, kind: 'poll' as const })),
    ...budgets.map(({ id }) => ({ id, kind: 'bv' as const }))];
  for (const { id, kind } of votes) {
    await db.$transaction(async (tx) => {
      const locked = kind === 'poll'
        ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "SmartPoll" WHERE id = ${id} AND "groupSyncAt" <= ${now} FOR UPDATE SKIP LOCKED`
        : await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "BudgetVote" WHERE id = ${id} AND "groupSyncAt" <= ${now} FOR UPDATE SKIP LOCKED`;
      if (!locked.length) return;
      const vote = await readVoteRecord(tx, groupId, kind, id);
      const groupSyncAt = vote?.custom && canViewPublished(config, vote) && vote.telegramMessageId !== null
        ? await refresh(telegram, groupId, vote.telegramMessageId, voteMessage(kind, vote, username), new Date())
        : null;
      if (kind === 'poll') await tx.smartPoll.update({ where: { id }, data: { groupSyncAt } });
      else await tx.budgetVote.update({ where: { id }, data: { groupSyncAt } });
    }, limits);
  }
  for (const { id } of bills) {
    await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "BillDelivery" WHERE id = ${id} AND "groupSyncAt" <= ${now} FOR UPDATE SKIP LOCKED`;
      if (!locked.length) return;
      const delivery = await tx.billDelivery.findFirst({
        where: { id, status: 'SENT', bill: { groupId } },
        include: { bill: { include: { shares: { orderBy: { memberId: 'asc' } } } } },
      });
      if (!delivery?.bill || delivery.telegramMessageId === null) return;
      const groupSyncAt = await refresh(telegram, groupId, delivery.telegramMessageId, billMessage(delivery.bill, username), new Date());
      await tx.billDelivery.update({ where: { id }, data: { groupSyncAt } });
    }, limits);
  }
}
