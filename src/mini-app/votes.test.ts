import { TelegramError } from 'telegraf';
import type { Telegram } from 'telegraf';
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

describe('Saved ballot publication', () => {
  const live = { ...config, accessMode: 'LIVE' as const };
  const publish = { action: 'publish', kind: 'bv', id };

  function fixture() {
    const record = { ...budget, status: 'DRAFT', draftStep: 'SAVED', telegramMessageId: null as number | null };
    const { db, tx } = mockDatabase(record as unknown as typeof budget);
    const updateMany = vi.fn(async ({ where, data }: { where: { status: string }; data: Partial<typeof record> }) => {
      if (where.status !== record.status) return { count: 0 };
      Object.assign(record, data);
      return { count: 1 };
    });
    Object.assign(tx.budgetVote, { updateMany });
    const send = vi.fn().mockResolvedValue({ message_id: 99 });
    const telegram = { callApi: send } as unknown as Telegram;
    return { record, send, act: (body: unknown, user = 42n) => handleVoteAction(body, user, live, db, 'fixture_bot', telegram) };
  }

  it('exposes saved drafts only to their owner and publishes at most once', async () => {
    const { act, send, record } = fixture();
    expect(await act({ action: 'detail', kind: 'bv', id, mine: true }, 73n)).toMatchObject({ status: 404 });
    expect(await act(publish, 73n)).toMatchObject({ status: 404 });
    expect(await act({ action: 'detail', kind: 'bv', id, mine: true }))
      .toMatchObject({ status: 200, body: { canPublish: true, status: 'DRAFT' } });
    const results = await Promise.all([act(publish), act(publish)]);
    expect(results).toContainEqual(expect.objectContaining({ body: expect.objectContaining({ publication: 'published' }) }));
    expect(await act(publish)).toMatchObject({ body: { publication: 'published' } });
    expect(record.telegramMessageId).toBe(99);
    expect(send).toHaveBeenCalledExactlyOnceWith('sendMessage', expect.objectContaining({ chat_id: String(live.groupId) }), expect.anything());
  });

  it('permits a retry after Telegram rejection and holds an ambiguous delivery', async () => {
    const { act, send, record } = fixture();
    send.mockRejectedValueOnce(new TelegramError({ error_code: 403, description: 'Forbidden' }));
    expect(await act(publish)).toMatchObject({ body: { publication: 'retry' } });
    expect(record.status).toBe('DRAFT');
    send.mockRejectedValueOnce(new Error('connection lost'));
    expect(await act(publish)).toMatchObject({ body: { publication: 'unconfirmed' } });
    expect(record.status).toBe('PUBLISHING');
    expect(await act(publish)).toMatchObject({ body: { publication: 'unconfirmed' } });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
