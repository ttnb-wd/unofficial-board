import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import { handleVoteAction } from './votes.js';

const config: AppConfig = {
  botToken: 'test-token', groupId: -1001234567890n, prelaunchOwnerId: 42n,
  accessMode: 'PRELAUNCH', databaseUrl: 'postgresql://localhost/unused', logLevel: 'silent',
};
const id = 'budget1';
const budget = {
  id, groupId: config.groupId, creatorId: 42n, title: 'Next trip budget', status: 'OPEN', telegramMessageId: 75,
  isPrelaunchTest: false, ranges: [],
  options: [
    { id: 'one', amountMmk: 10000n, _count: { ballots: 3 } },
    { id: 'two', amountMmk: 20000n, _count: { ballots: 2 } },
  ],
};
const submit = { action: 'submit', kind: 'bv', id, mask: 2 };

function mockDatabase(record = budget) {
  const ballots = {
    upsert: vi.fn().mockResolvedValue({}),
    findMany: vi.fn().mockResolvedValue([{ optionId: 'one' }]),
  };
  const tx = {
    budgetVote: { findUnique: vi.fn().mockResolvedValue(record), update: vi.fn() },
    budgetVoteOptionBallot: ballots,
    $queryRaw: vi.fn().mockResolvedValue([{ id }]),
  };
  const database = {
    ...tx, $transaction: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx)),
  };
  return { db: database as unknown as PrismaClient, ballots, tx, database };
}

describe('Mini App ballots', () => {
  it('reads the existing member selection and writes through the shared ballot transaction', async () => {
    const { db, ballots, tx } = mockDatabase();
    const live = { ...config, accessMode: 'LIVE' as const };
    const detail = await handleVoteAction({ action: 'detail', id, kind: 'bv' }, 73n, live, db);
    expect(detail).toMatchObject({ status: 200, body: { mask: 1, total: 5, open: true, preview: false } });
    expect(ballots.findMany).toHaveBeenCalledWith({ where: { budgetVoteId: id, memberId: 73n }, select: { optionId: true } });
    expect(await handleVoteAction(submit, 73n, live, db)).toMatchObject({ status: 200, body: { mask: 2 } });
    expect(ballots.upsert).toHaveBeenCalledOnce();
    expect(ballots.upsert).toHaveBeenCalledWith({
      where: { budgetVoteId_memberId: { budgetVoteId: id, memberId: 73n } },
      create: { budgetVoteId: id, memberId: 73n, optionId: 'two' },
      update: { optionId: 'two' },
    });
    tx.$queryRaw.mockResolvedValueOnce([]);
    expect(await handleVoteAction(submit, 73n, live, db)).toMatchObject({ status: 409 });
    expect(ballots.upsert).toHaveBeenCalledOnce();
  });

  it('isolates PRELAUNCH simulations and rejects unauthorized or invalid selections', async () => {
    const { db, ballots, tx, database } = mockDatabase({ ...budget, isPrelaunchTest: true });
    expect(await handleVoteAction(submit, 73n, config, db)).toMatchObject({ status: 403 });
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(await handleVoteAction({ ...submit, mask: 3 }, 42n, config, db)).toMatchObject({ status: 400 });
    const result = await handleVoteAction(submit, 42n, config, db);
    expect(result).toMatchObject({
      status: 200, body: { preview: true, mask: 2, total: 1, choices: [{ count: 0 }, { count: 1 }] },
    });
    expect(ballots.upsert).not.toHaveBeenCalled();
    expect(ballots.findMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(await handleVoteAction(submit, 42n, { ...config, accessMode: 'LIVE' }, db)).toMatchObject({ status: 404 });
  });
});
