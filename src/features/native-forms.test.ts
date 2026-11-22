import type { PrismaClient } from '@prisma/client';
import { Telegram, Telegraf } from 'telegraf';
import type { Update } from 'telegraf/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import { createBot } from '../bot/create-bot.js';
import { createLogger } from '../logger.js';
import { registerNativeBudgetFormHandlers } from './group-budget-vote/native-form.js';
import { registerNativeSmartPollFormHandlers } from './smart-poll/native-form.js';

const config: AppConfig = {
  botToken: '123456:test-token',
  groupId: -1001234567890n,
  prelaunchOwnerId: 42n,
  accessMode: 'PRELAUNCH',
  databaseUrl: 'postgresql://user:pass@localhost:5432/board',
  miniAppUrl: 'https://mini.example',
  logLevel: 'silent',
};

function messageUpdate(updateId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: updateId,
      chat: { id: 42, type: 'private', first_name: 'Owner' },
      from: { id: 42, is_bot: false, first_name: 'Owner' },
      text,
      ...(text.startsWith('/')
        ? {
            entities: [
              {
                offset: 0,
                length: text.split(' ')[0]?.length ?? text.length,
                type: 'bot_command' as const,
              },
            ],
          }
        : {}),
    },
  };
}

function callbackUpdate(updateId: number, data: string): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: 42, is_bot: false, first_name: 'Owner' },
      chat_instance: 'private-chat',
      message: {
        message_id: 700 + updateId,
        date: updateId,
        chat: { id: 42, type: 'private', first_name: 'Owner' },
        text: 'Form',
      },
      data,
    },
  };
}

function testBot(database: object, register: (bot: Telegraf) => void) {
  const bot = new Telegraf(config.botToken);
  const apiCall = vi
    .spyOn(Telegram.prototype, 'callApi')
    .mockResolvedValue({ message_id: 777 } as never);
  register(bot);
  return { bot, apiCall, database };
}

function matchesWhere(
  row: {
    id: string;
    creatorId: bigint;
    status: string;
    draftStep: string;
  },
  where: Record<string, unknown>,
): boolean {
  if (
    typeof where.id === 'string' &&
    where.id !== row.id
  ) {
    return false;
  }
  if (
    typeof where.creatorId === 'bigint' &&
    where.creatorId !== row.creatorId
  ) {
    return false;
  }
  if (typeof where.status === 'string' && where.status !== row.status) {
    return false;
  }
  if (typeof where.draftStep === 'string' && where.draftStep !== row.draftStep) {
    return false;
  }
  if (
    typeof where.draftStep === 'object' &&
    where.draftStep !== null &&
    'in' in where.draftStep &&
    Array.isArray(where.draftStep.in) &&
    !where.draftStep.in.includes(row.draftStep)
  ) {
    return false;
  }
  return true;
}

function pollDatabase(
  initial: { existingPoll?: boolean; existingBudget?: boolean } = {},
) {
  let poll:
    | {
        id: string;
        groupId: bigint;
        creatorId: bigint;
        question: string | null;
        status: string;
        draftStep: string;
        promptMessageId: number | null;
        isPrelaunchTest: boolean;
        options: { id: string; position: number; text: string }[];
        updatedAt: Date;
      }
    | null = initial.existingPoll
      ? {
          id: 'poll123',
          groupId: config.groupId,
          creatorId: config.prelaunchOwnerId,
          question: 'Where should we go?',
          status: 'DRAFT',
          draftStep: 'OPTIONS',
          promptMessageId: 90,
          isPrelaunchTest: true,
          options: [],
          updatedAt: new Date(1),
        }
      : null;
  const budget:
    | {
        id: string;
        creatorId: bigint;
        status: string;
        draftStep: string;
        promptMessageId: number | null;
        updatedAt: Date;
      }
    | null = initial.existingBudget
      ? {
          id: 'budget123',
          creatorId: config.prelaunchOwnerId,
          status: 'DRAFT',
          draftStep: 'RANGES',
          promptMessageId: 80,
          updatedAt: new Date(1),
        }
      : null;
  let nextOptionId = 0;
  const findPoll = vi.fn(async (args: { where: Record<string, unknown> }) =>
    poll && matchesWhere(poll, args.where)
      ? { ...poll, options: [...poll.options] }
      : null,
  );
  const updatePoll = vi.fn(
    async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      if (!poll || !matchesWhere(poll, args.where)) {
        return { count: 0 };
      }
      Object.assign(poll, args.data, { updatedAt: new Date() });
      return { count: 1 };
    },
  );
  const findBudget = vi.fn(async (args: { where: Record<string, unknown> }) =>
    budget && matchesWhere(budget, args.where) ? { ...budget } : null,
  );
  const createPoll = vi.fn(async (args: { data: Record<string, unknown> }) => {
    poll = {
      id: 'poll123',
      groupId: args.data.groupId as bigint,
      creatorId: args.data.creatorId as bigint,
      question: null,
      status: 'DRAFT',
      draftStep: 'QUESTION',
      promptMessageId: null,
      isPrelaunchTest: true,
      options: [],
      updatedAt: new Date(),
    };
    return { ...poll, options: [] };
  });
  const deleteOptions = vi.fn(
    async (args: { where: { pollId: string; id?: string } }) => {
      if (poll?.id !== args.where.pollId) {
        return { count: 0 };
      }
      const before = poll.options.length;
      poll.options = poll.options.filter(
        (option) => args.where.id && option.id !== args.where.id,
      );
      return { count: before - poll.options.length };
    },
  );
  const transaction = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'poll123' }]),
    telegramGroup: { upsert: vi.fn().mockResolvedValue({}) },
    member: { upsert: vi.fn().mockResolvedValue({}) },
    smartPoll: {
      findFirst: findPoll,
      create: createPoll,
      updateMany: updatePoll,
    },
    smartPollOption: {
      deleteMany: deleteOptions,
      createMany: vi.fn(async (args: { data: { position: number; text: string }[] }) => {
        if (poll) {
          poll.options = args.data.map((option) => ({
            ...option,
            id: `option${++nextOptionId}`,
          }));
        }
        return { count: args.data.length };
      }),
      findMany: vi.fn(async () => poll?.options ?? []),
      create: vi.fn(async (args: { data: { position: number; text: string } }) => {
        const option = { ...args.data, id: `option${++nextOptionId}` };
        poll?.options.push(option);
        return option;
      }),
      update: vi.fn(),
    },
    budgetVote: { findFirst: findBudget },
  };
  const database = {
    $transaction: vi.fn(
      async (run: (tx: typeof transaction) => Promise<unknown>) => run(transaction),
    ),
    smartPoll: {
      findFirst: findPoll,
      updateMany: updatePoll,
    },
    budgetVote: { findFirst: findBudget },
  };
  return {
    database: database as unknown as PrismaClient,
    transaction,
    createPoll,
    getPoll: () => poll,
    getBudget: () => budget,
  };
}

function budgetDatabase(
  initial: { existingPoll?: boolean; existingBudget?: boolean } = {},
) {
  let vote:
    | {
        id: string;
        groupId: bigint;
        creatorId: bigint;
        title: string | null;
        status: string;
        draftStep: string;
        promptMessageId: number | null;
        isPrelaunchTest: boolean;
        options: { id: string; position: number; amountMmk: bigint }[];
        ranges: [];
        updatedAt: Date;
      }
    | null = initial.existingBudget
      ? {
          id: 'budget123',
          groupId: config.groupId,
          creatorId: config.prelaunchOwnerId,
          title: 'Weekend trip',
          status: 'DRAFT',
          draftStep: 'RANGES',
          promptMessageId: 90,
          isPrelaunchTest: true,
          options: [
            { id: 'amount1', position: 0, amountMmk: 10_000n },
            { id: 'amount2', position: 1, amountMmk: 20_000n },
            { id: 'amount3', position: 2, amountMmk: 30_000n },
          ],
          ranges: [],
          updatedAt: new Date(1),
        }
      : null;
  const poll =
    initial.existingPoll
      ? {
          id: 'poll123',
          creatorId: config.prelaunchOwnerId,
          status: 'DRAFT',
          draftStep: 'OPTIONS',
          promptMessageId: 80,
          updatedAt: new Date(1),
        }
      : null;
  const findVote = vi.fn(async (args: { where: Record<string, unknown> }) =>
    vote && matchesWhere(vote, args.where)
      ? { ...vote, options: [...vote.options], ranges: [] as [] }
      : null,
  );
  const updateVote = vi.fn(
    async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      if (!vote || !matchesWhere(vote, args.where)) {
        return { count: 0 };
      }
      Object.assign(vote, args.data, { updatedAt: new Date() });
      return { count: 1 };
    },
  );
  const findPoll = vi.fn(async (args: { where: Record<string, unknown> }) =>
    poll && matchesWhere(poll, args.where) ? { ...poll } : null,
  );
  const createVote = vi.fn(async (args: { data: Record<string, unknown> }) => {
    vote = {
      id: 'budget123',
      groupId: args.data.groupId as bigint,
      creatorId: args.data.creatorId as bigint,
      title: null,
      status: 'DRAFT',
      draftStep: 'TITLE',
      promptMessageId: null,
      isPrelaunchTest: true,
      options: [],
      ranges: [],
      updatedAt: new Date(),
    };
    return { ...vote, options: [], ranges: [] as [] };
  });
  const createOption = vi.fn(
    async (args: {
      data: { id: string; budgetVoteId: string; position: number; amountMmk: bigint };
    }) => {
      const option = {
        id: args.data.id,
        position: args.data.position,
        amountMmk: args.data.amountMmk,
      };
      vote?.options.push(option);
      return option;
    },
  );
  const transaction = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    telegramGroup: { upsert: vi.fn().mockResolvedValue({}) },
    member: { upsert: vi.fn().mockResolvedValue({}) },
    smartPoll: { findFirst: findPoll },
    budgetVote: { findFirst: findVote, create: createVote, updateMany: updateVote },
    budgetVoteOption: {
      count: vi.fn(async () => vote?.options.length ?? 0),
      create: createOption,
      deleteMany: vi.fn(async () => {
        if (!vote) {
          return { count: 0 };
        }
        const count = vote.options.length;
        vote.options = [];
        return { count };
      }),
    },
  };
  const database = {
    $transaction: vi.fn(
      async (run: (tx: typeof transaction) => Promise<unknown>) => run(transaction),
    ),
    budgetVote: { findFirst: findVote, updateMany: updateVote },
    smartPoll: { findFirst: findPoll },
  };
  return {
    database: database as unknown as PrismaClient,
    transaction,
    createVote,
    getVote: () => vote,
    getPoll: () => poll,
  };
}

describe('native Telegram form workflows', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saves a poll question and multiline options to the private PRELAUNCH database', async () => {
    const state = pollDatabase({ existingBudget: true });
    const { bot, apiCall } = testBot(state.database, (instance) => {
      registerNativeSmartPollFormHandlers(
        instance,
        config,
        state.database,
        createLogger('silent'),
        async () => true,
      );
      registerNativeBudgetFormHandlers(
        instance,
        config,
        state.database,
        createLogger('silent'),
        async () => true,
      );
    });

    await bot.handleUpdate(
      callbackUpdate(1, 'draft:switch:poll:budget:budget123'),
    );
    await bot.handleUpdate(messageUpdate(2, 'Where should we go?'));
    await bot.handleUpdate(messageUpdate(3, 'Cafe\nPark\nMuseum'));
    await bot.handleUpdate(callbackUpdate(5, 'poll:done:poll123'));
    await bot.handleUpdate(callbackUpdate(6, 'poll:done:poll123'));

    expect(state.createPoll).toHaveBeenCalledOnce();
    expect(state.getPoll()?.question).toBe('Where should we go?');
    expect(state.getPoll()?.status).toBe('PRELAUNCH_PREVIEW');
    expect(state.getPoll()?.draftStep).toBe('SAVED');
    expect(state.getPoll()?.options.map(({ text }) => text)).toEqual([
      'Cafe',
      'Park',
      'Museum',
    ]);
    expect(apiCall).toHaveBeenCalledWith(
      'editMessageText',
      expect.objectContaining({
        text: expect.stringContaining('Saved privately. This poll has not been sent to the group.'),
      }),
    );
    expect(apiCall).not.toHaveBeenCalledWith('sendPoll', expect.anything());
    expect(state.database.$transaction).toHaveBeenCalled();
  });

  it('saves default exact MMK options and marks the vote private in PRELAUNCH', async () => {
    const state = budgetDatabase({ existingPoll: true });
    const { bot, apiCall } = testBot(state.database, (instance) => {
      registerNativeSmartPollFormHandlers(
        instance,
        config,
        state.database,
        createLogger('silent'),
        async () => true,
      );
      registerNativeBudgetFormHandlers(
        instance,
        config,
        state.database,
        createLogger('silent'),
        async () => true,
      );
    });

    await bot.handleUpdate(
      callbackUpdate(1, 'draft:switch:budget:poll:poll123'),
    );
    await bot.handleUpdate(messageUpdate(2, 'Weekend trip'));
    await bot.handleUpdate(callbackUpdate(3, 'bv:done:budget123'));
    await bot.handleUpdate(callbackUpdate(4, 'bv:done:budget123'));

    expect(state.createVote).toHaveBeenCalledOnce();
    expect(state.getVote()?.title).toBe('Weekend trip');
    expect(state.getVote()?.options.map(({ amountMmk }) => amountMmk)).toEqual([
      10_000n,
      20_000n,
      30_000n,
    ]);
    expect(state.getVote()?.status).toBe('PRELAUNCH_OPEN');
    expect(state.getVote()?.draftStep).toBe('SAVED');
    expect(state.transaction.budgetVoteOption.create).toHaveBeenCalledTimes(3);
    expect(apiCall).toHaveBeenCalledWith(
      'editMessageText',
      expect.objectContaining({
        text: expect.stringContaining('Saved privately. This vote has not been sent to the group.'),
      }),
    );
    expect(apiCall).not.toHaveBeenCalledWith(
      'sendMessage',
      expect.objectContaining({ chat_id: '-1001234567890' }),
    );
  });

  it('replaces defaults with custom exact MMK choices sent in one message', async () => {
    const state = budgetDatabase({ existingPoll: true });
    const { bot } = testBot(state.database, (instance) => {
      registerNativeSmartPollFormHandlers(
        instance,
        config,
        state.database,
        createLogger('silent'),
        async () => true,
      );
      registerNativeBudgetFormHandlers(
        instance,
        config,
        state.database,
        createLogger('silent'),
        async () => true,
      );
    });

    await bot.handleUpdate(
      callbackUpdate(1, 'draft:switch:budget:poll:poll123'),
    );
    await bot.handleUpdate(messageUpdate(2, 'Weekend trip'));
    await bot.handleUpdate(callbackUpdate(3, 'bv:edit-amounts:budget123'));
    await bot.handleUpdate(messageUpdate(4, '12500\n25000 MMK'));

    expect(state.getVote()?.options.map(({ amountMmk }) => amountMmk)).toEqual([
      12_500n,
      25_000n,
    ]);
  });

  it('refreshes a stale Smart Poll button despite a persisted Budget Vote draft', async () => {
    const state = pollDatabase({ existingBudget: true });
    const { bot, apiCall } = testBot(state.database, (instance) =>
      registerNativeSmartPollFormHandlers(
        instance,
        config,
        state.database,
        createLogger('silent'),
        async () => true,
      ),
    );

    await bot.handleUpdate(callbackUpdate(1, 'poll:create'));
    expect(apiCall).toHaveBeenCalledWith(
      'editMessageText',
      expect.objectContaining({
        text: 'Smart Poll',
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.arrayContaining([
            expect.arrayContaining([
              expect.objectContaining({
                text: 'Create Poll',
                web_app: { url: 'https://mini.example/mini-app?feature=poll' },
              }),
            ]),
          ]),
        }),
      }),
    );
    expect(state.createPoll).not.toHaveBeenCalled();
    expect(state.getBudget()).toMatchObject({
      status: 'DRAFT',
      draftStep: 'RANGES',
    });
  });

  it('refreshes a stale Budget Vote button despite a persisted Smart Poll draft', async () => {
    const state = budgetDatabase({ existingPoll: true });
    const { bot, apiCall } = testBot(state.database, (instance) =>
      registerNativeBudgetFormHandlers(
        instance,
        config,
        state.database,
        createLogger('silent'),
        async () => true,
      ),
    );

    await bot.handleUpdate(callbackUpdate(1, 'bv:create'));
    expect(apiCall).toHaveBeenCalledWith(
      'editMessageText',
      expect.objectContaining({
        text: 'Group Budget Vote',
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.arrayContaining([
            expect.arrayContaining([
              expect.objectContaining({
                text: 'Create Budget Vote',
                web_app: { url: 'https://mini.example/mini-app?feature=budget' },
              }),
            ]),
          ]),
        }),
      }),
    );
    expect(state.createVote).not.toHaveBeenCalled();
    expect(state.getPoll()).toMatchObject({
      status: 'DRAFT',
      draftStep: 'OPTIONS',
    });
  });

  it('continues a persisted budget step on a fresh bot instance', async () => {
    const state = budgetDatabase({ existingBudget: true, existingPoll: true });
    const { bot, apiCall } = testBot(state.database, (instance) => {
      registerNativeSmartPollFormHandlers(
        instance,
        config,
        state.database,
        createLogger('silent'),
        async () => true,
      );
      registerNativeBudgetFormHandlers(
        instance,
        config,
        state.database,
        createLogger('silent'),
        async () => true,
      );
    });

    await bot.handleUpdate(callbackUpdate(1, 'draft:continue:budget:budget123'));
    await bot.handleUpdate(messageUpdate(2, '12500\n25000'));

    expect(apiCall).toHaveBeenCalledWith(
      'editMessageText',
      expect.objectContaining({
        text: 'Send the amounts, one per line.',
      }),
    );
    expect(state.getVote()).toMatchObject({
      status: 'DRAFT',
      draftStep: 'READY',
    });
    expect(state.getVote()?.options.map(({ amountMmk }) => amountMmk)).toEqual([
      12_500n,
      25_000n,
    ]);
  });

  it('continues a persisted poll step on a fresh bot instance', async () => {
    const state = pollDatabase({ existingPoll: true, existingBudget: true });
    const { bot, apiCall } = testBot(state.database, (instance) => {
      registerNativeSmartPollFormHandlers(
        instance,
        config,
        state.database,
        createLogger('silent'),
        async () => true,
      );
      registerNativeBudgetFormHandlers(
        instance,
        config,
        state.database,
        createLogger('silent'),
        async () => true,
      );
    });

    await bot.handleUpdate(callbackUpdate(1, 'draft:continue:poll:poll123'));
    await bot.handleUpdate(messageUpdate(2, 'Cafe\nPark'));

    expect(apiCall).toHaveBeenCalledWith(
      'editMessageText',
      expect.objectContaining({
        text: 'Send the options, one per line.',
      }),
    );
    expect(state.getPoll()).toMatchObject({
      status: 'DRAFT',
      draftStep: 'READY',
    });
    expect(state.getPoll()?.options.map(({ text }) => text)).toEqual([
      'Cafe',
      'Park',
    ]);
  });

  it('ignores a stale switch callback without creating or deleting drafts', async () => {
    const state = pollDatabase({ existingBudget: true });
    const budget = state.getBudget();
    if (!budget) {
      throw new Error('Expected the seeded budget draft.');
    }
    budget.status = 'CANCELLED';
    const { bot, apiCall } = testBot(state.database, (instance) =>
      registerNativeSmartPollFormHandlers(
        instance,
        config,
        state.database,
        createLogger('silent'),
        async () => true,
      ),
    );

    await bot.handleUpdate(callbackUpdate(1, 'draft:switch:poll:budget:budget123'));

    expect(state.createPoll).not.toHaveBeenCalled();
    expect(state.getBudget()?.status).toBe('CANCELLED');
    expect(apiCall).toHaveBeenCalledWith(
      'answerCallbackQuery',
      expect.objectContaining({
        text: 'This draft is no longer active.',
        show_alert: true,
      }),
    );
  });

  it('cancels the switch prompt without cancelling its source draft', async () => {
    const state = pollDatabase({ existingBudget: true });
    const bot = createBot(
      config,
      state.database,
      'test_bot',
      createLogger('silent'),
    );
    const apiCall = vi
      .spyOn(Telegram.prototype, 'callApi')
      .mockResolvedValue({ message_id: 777 } as never);

    await bot.handleUpdate(callbackUpdate(1, 'draft:cancel:budget:budget123'));

    expect(state.getBudget()).toMatchObject({
      status: 'DRAFT',
      draftStep: 'RANGES',
    });
    expect(apiCall).toHaveBeenCalledWith(
      'editMessageText',
      expect.objectContaining({
        text: 'Switch cancelled. Your draft is unchanged.',
      }),
    );
  });
});
