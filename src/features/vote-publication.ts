import type { PrismaClient } from '@prisma/client';
import { TelegramError } from 'telegraf';
import type { Telegram } from 'telegraf';
import { groupDestination } from '../access/policy.js';
import type { AppConfig } from '../config.js';
import { voteMessage } from './group-message.js';
import { canViewPublished, loadVote } from './vote-store.js';
import type { Kind } from './vote-store.js';

export type Publication = 'published' | 'retry' | 'unconfirmed' | 'unavailable';

export function publicationMessage(result: Publication) {
  switch (result) {
    case 'published': return 'Published to the group.';
    case 'retry': return 'Saved, but Telegram rejected the announcement. You can retry from your list.';
    case 'unconfirmed': return 'Saved, but delivery is unconfirmed. Refresh your list and check the group before trying again.';
    case 'unavailable': return 'This saved ballot cannot be published.';
  }
}

export async function publishVote(
  db: PrismaClient, telegram: Telegram, config: AppConfig, username: string,
  kind: Kind, id: string, ownerId: bigint,
): Promise<Publication> {
  const chatId = groupDestination(config, config.groupId);
  const record = await loadVote(db, config.groupId, kind, id);
  if (!record || record.creatorId !== ownerId || record.isPrelaunchTest) return 'unavailable';
  if (canViewPublished(config, record)) return 'published';
  if (record.status === 'PUBLISHING') return 'unconfirmed';
  if (record.status !== 'DRAFT' || record.draftStep !== 'SAVED' || !record.ready || !record.custom ||
      record.telegramMessageId !== null) return 'unavailable';

  const key = { id, creatorId: ownerId, groupId: config.groupId, isPrelaunchTest: false };
  const claim = { ...key, status: 'DRAFT' as const, draftStep: 'SAVED' as const, telegramMessageId: null };
  const claimed = kind === 'poll'
    ? await db.smartPoll.updateMany({ where: claim, data: { status: 'PUBLISHING' } })
    : await db.budgetVote.updateMany({ where: claim, data: { status: 'PUBLISHING' } });
  if (claimed.count !== 1) {
    const current = await loadVote(db, config.groupId, kind, id);
    return current && canViewPublished(config, current) ? 'published' : 'unconfirmed';
  }

  const where = { ...key, status: 'PUBLISHING' as const };
  const claimedRecord = await loadVote(db, config.groupId, kind, id);
  // A draft may have been edited while this worker was acquiring its claim.
  if (!claimedRecord || claimedRecord.status !== 'PUBLISHING') return 'unconfirmed';
  let messageId: number;
  try {
    const { text, ...extra } = voteMessage(kind, claimedRecord, username);
    type Signal = NonNullable<NonNullable<Parameters<Telegram['callApi']>[2]>['signal']>;
    const message = await telegram.callApi('sendMessage', { chat_id: chatId, text, ...extra },
      { signal: AbortSignal.timeout(10_000) as unknown as Signal });
    messageId = message.message_id;
  } catch (error) {
    // An ambiguous send may have reached Telegram. Leave the claim in place.
    if (!(error instanceof TelegramError) || error.code < 400 || error.code >= 500) return 'unconfirmed';
    const data = { status: 'DRAFT' as const };
    const restored = kind === 'poll' ? await db.smartPoll.updateMany({ where, data })
      : await db.budgetVote.updateMany({ where, data });
    return restored.count === 1 ? 'retry' : 'unconfirmed';
  }

  const data = { status: 'OPEN' as const, telegramMessageId: messageId };
  const opened = kind === 'poll' ? await db.smartPoll.updateMany({ where, data })
    : await db.budgetVote.updateMany({ where, data });
  return opened.count === 1 ? 'published' : 'unconfirmed';
}

export async function closePublishedVote(db: PrismaClient, config: AppConfig, kind: Kind, id: string, creatorId: bigint) {
  groupDestination(config, config.groupId);
  const where = { id, groupId: config.groupId, creatorId, isPrelaunchTest: false,
    status: 'OPEN' as const, telegramMessageId: { not: null } };
  const now = new Date();
  const data = { status: 'CLOSED' as const, groupSyncAt: now, closedAt: now };
  return kind === 'poll'
    ? db.smartPoll.updateMany({ where: { ...where, telegramPollId: null }, data })
    : db.budgetVote.updateMany({ where, data });
}

export async function editBudgetDraft(db: PrismaClient, config: AppConfig, id: string, creatorId: bigint,
  title: string, amounts: bigint[],
) {
  groupDestination(config, config.groupId);
  return db.$transaction(async (tx) => {
    const claimed = await tx.budgetVote.updateMany({ where: {
      id, groupId: config.groupId, creatorId, status: 'DRAFT', draftStep: 'SAVED', isPrelaunchTest: false,
      telegramMessageId: null,
    }, data: { title } });
    if (!claimed.count) return false;
    await tx.budgetVoteOption.deleteMany({ where: { budgetVoteId: id } });
    await tx.budgetVoteOption.createMany({ data: amounts.map((amountMmk, position) => ({ budgetVoteId: id, position, amountMmk })) });
    return true;
  });
}
