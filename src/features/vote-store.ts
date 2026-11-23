import type { Prisma, PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config.js';

export type Kind = 'poll' | 'bv';
export type Choice = { id: string; label: string; count: number };
const choiceOrder = { orderBy: { position: 'asc' as const } };
const withCounts = { ...choiceOrder, include: { _count: { select: { votes: true } } } };
const withBallots = { ...choiceOrder, include: { _count: { select: { ballots: true } } } };

function mmk(amount: bigint) {
  return new Intl.NumberFormat('en-US').format(amount);
}

export function loadVote(database: PrismaClient, groupId: bigint, kind: Kind, id: string) {
  return database.$transaction((tx) => readVoteRecord(tx, groupId, kind, id), { isolationLevel: 'RepeatableRead' });
}

export type VoteRecord = NonNullable<Awaited<ReturnType<typeof readVoteRecord>>>;

export function publishedVotes(groupId: bigint) {
  return { groupId, isPrelaunchTest: false, telegramMessageId: { not: null },
    status: { in: ['OPEN', 'CLOSED'] as ('OPEN' | 'CLOSED')[] } };
}

export function canViewPublished(config: AppConfig, record: VoteRecord) {
  return config.accessMode === 'LIVE' && !record.isPrelaunchTest &&
    record.telegramMessageId !== null && ['OPEN', 'CLOSED'].includes(record.status);
}

export async function memberSelection(database: PrismaClient, kind: Kind, record: VoteRecord, memberId: bigint) {
  if (kind === 'bv' && 'ranges' in record && !record.options.length) {
    const ballot = await database.budgetVoteBallot.findUnique({
      where: { budgetVoteId_memberId: { budgetVoteId: record.id, memberId } }, select: { rangeId: true },
    });
    const index = record.choices.findIndex(({ id }) => id === ballot?.rangeId);
    return index < 0 ? 0 : 1 << index;
  }
  const selected = kind === 'poll'
    ? await database.smartPollVote.findMany({ where: { pollId: record.id, memberId }, select: { optionId: true } })
    : await database.budgetVoteOptionBallot.findMany({
      where: { budgetVoteId: record.id, memberId }, select: { optionId: true },
    });
  const ids = new Set(selected.map(({ optionId }) => optionId));
  return record.choices.reduce((mask, choice, index) => ids.has(choice.id) ? mask | (1 << index) : mask, 0);
}

export function validSelection(record: VoteRecord, mask: number, required: boolean) {
  return Number.isInteger(mask) && mask >= (required ? 1 : 0) && mask < (1 << record.choices.length) &&
    (record.multiple || (mask & (mask - 1)) === 0);
}

export async function readVoteRecord(tx: Prisma.TransactionClient, groupId: bigint, kind: Kind, id: string) {
  const where = { id, groupId };
  if (kind === 'poll') {
    const poll = await tx.smartPoll.findUnique({
      where, include: { options: withCounts },
    });
    if (!poll) return null;
    return {
      ...poll,
      title: poll.question ?? 'Untitled poll',
      ready: Boolean(poll.question) && poll.options.length >= 2,
      custom: poll.telegramPollId === null,
      multiple: poll.allowsMultipleAnswers,
      choices: poll.options.map(({ id, text, _count }) => ({ id, label: text, count: _count.votes })),
      total: poll.totalVoterCount,
      countsAvailable: !poll.telegramPollId || !poll.isAnonymous,
    };
  }

  const vote = await tx.budgetVote.findUnique({
    where, include: { options: withBallots, ranges: withBallots },
  });
  if (!vote) return null;
  const choices = vote.options.length
    ? vote.options.map(({ id, amountMmk, _count }) => ({ id, label: `${mmk(amountMmk)} MMK`, count: _count.ballots }))
    : vote.ranges.map(({ id, minMmk, maxMmk, _count }) => ({
        id, label: `${mmk(minMmk)}–${mmk(maxMmk)} MMK`, count: _count.ballots,
      }));
  return {
    ...vote,
    title: vote.title ?? 'Untitled budget vote',
    ready: Boolean(vote.title) && vote.options.length >= 2,
    custom: choices.length >= 2,
    multiple: false,
    choices,
    total: choices.reduce((sum, choice) => sum + choice.count, 0),
    countsAvailable: true,
  };
}

export async function saveBallot(database: PrismaClient, config: AppConfig, kind: Kind, record: VoteRecord, user: bigint, mask: number) {
  if (!canViewPublished(config, record) || record.status !== 'OPEN' || !record.custom ||
      !validSelection(record, mask, true)) return false;
  const selected = record.choices.filter((_, index) => mask & (1 << index));
  return database.$transaction(async (tx) => {
    const locked = kind === 'poll'
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "SmartPoll" WHERE "id" = ${record.id} AND "groupId" = ${config.groupId}
          AND "status" = 'OPEN' AND "telegramMessageId" IS NOT NULL AND NOT "isPrelaunchTest" AND "telegramPollId" IS NULL FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "BudgetVote" WHERE "id" = ${record.id} AND "groupId" = ${config.groupId}
          AND "status" = 'OPEN' AND "telegramMessageId" IS NOT NULL AND NOT "isPrelaunchTest" FOR UPDATE`;
    if (!locked.length) return false;
    if (kind === 'poll') {
      await tx.smartPollVote.deleteMany({ where: { pollId: record.id, memberId: user } });
      await tx.smartPollVote.createMany({
        data: selected.map(({ id }) => ({ pollId: record.id, memberId: user, optionId: id })),
      });
      const voters = await tx.$queryRaw<{ total: number }[]>`
        SELECT COUNT(DISTINCT "memberId")::int AS total FROM "SmartPollVote" WHERE "pollId" = ${record.id}`;
      await tx.smartPoll.update({ where: { id: record.id }, data: { totalVoterCount: voters[0]!.total, groupSyncAt: new Date() } });
    } else if ('ranges' in record && !record.options.length) {
      const rangeId = selected[0]!.id;
      await tx.budgetVoteBallot.upsert({
        where: { budgetVoteId_memberId: { budgetVoteId: record.id, memberId: user } },
        create: { budgetVoteId: record.id, memberId: user, rangeId },
        update: { rangeId },
      });
    } else {
      const optionId = selected[0]!.id;
      await tx.budgetVoteOptionBallot.upsert({
        where: { budgetVoteId_memberId: { budgetVoteId: record.id, memberId: user } },
        create: { budgetVoteId: record.id, memberId: user, optionId },
        update: { optionId },
      });
    }
    if (kind === 'bv') await tx.budgetVote.update({ where: { id: record.id }, data: { groupSyncAt: new Date() } });
    return true;
  }, { isolationLevel: 'ReadCommitted' });
}

