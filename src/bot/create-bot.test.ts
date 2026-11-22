import type { PrismaClient } from '@prisma/client';
import { Telegram } from 'telegraf';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Update } from 'telegraf/types';
import type { AppConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createBot } from './create-bot.js';

const config: AppConfig = {
  botToken: '123456:test-token',
  groupId: -1001234567890n,
  prelaunchOwnerId: 42n,
  accessMode: 'PRELAUNCH',
  databaseUrl: 'postgresql://user:pass@localhost:5432/board',
  miniAppUrl: 'https://mini.example',
  logLevel: 'silent',
};

function messageUpdate(
  userId: number,
  chat:
    | { id: number; type: 'private'; first_name: string }
    | { id: number; type: 'supergroup'; title: string },
  text: string,
): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat,
      from: { id: userId, is_bot: false, first_name: 'Tester' },
      text,
      entities: [
        {
          offset: 0,
          length: text.split(' ')[0]?.length ?? text.length,
          type: 'bot_command',
        },
      ],
    },
  };
}

function callbackUpdate(userId: number, data: string): Update {
  return {
    update_id: 2,
    callback_query: {
      id: 'callback-id',
      from: { id: userId, is_bot: false, first_name: 'Tester' },
      chat_instance: 'private-chat',
      message: {
        message_id: 2,
        date: 1,
        chat: { id: userId, type: 'private', first_name: 'Owner' },
        text: 'Feature menu',
      },
      data,
    },
  };
}

function setupBot(database?: PrismaClient, botConfig: AppConfig = config) {
  const testDatabase = database ?? ({
    $transaction: vi.fn(),
  } as unknown as PrismaClient);
  const bot = createBot(botConfig, testDatabase, 'test_bot', createLogger('silent'));
  const apiCall = vi
    .spyOn(Telegram.prototype, 'callApi')
    .mockResolvedValue({ message_id: 777 } as never);
  vi.spyOn(bot.telegram, 'getMe').mockResolvedValue({
    id: 123456,
    is_bot: true,
    first_name: 'Test',
    username: 'test_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  });
  const membershipCheck = vi.spyOn(Telegram.prototype, 'getChatMember');
  return { bot, database: testDatabase, apiCall, membershipCheck };
}

describe('PRELAUNCH bot access', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets the configured owner use the private dashboard without checking group membership', async () => {
    const { bot, database, apiCall, membershipCheck } = setupBot();

    await bot.handleUpdate(
      messageUpdate(42, { id: 42, type: 'private', first_name: 'Owner' }, '/start'),
    );

    expect(apiCall).toHaveBeenCalledOnce();
    expect(membershipCheck).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it('keeps the private menu available to the owner', async () => {
    const database = {
      $transaction: vi.fn(),
      smartPoll: { findFirst: vi.fn().mockResolvedValue({ status: 'DRAFT' }) },
      budgetVote: { findFirst: vi.fn().mockResolvedValue({ status: 'DRAFT' }) },
    } as unknown as PrismaClient;
    const { bot, apiCall, membershipCheck } = setupBot(database);

    await bot.handleUpdate(
      messageUpdate(42, { id: 42, type: 'private', first_name: 'Owner' }, '/menu'),
    );

    expect(apiCall).toHaveBeenCalledWith(
      'sendMessage',
      expect.objectContaining({
        text: expect.stringContaining('Choose a feature to get started.'),
      }),
    );
    expect(membershipCheck).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it('denies other private users without checking group membership', async () => {
    const { bot, database, apiCall, membershipCheck } = setupBot();

    await bot.handleUpdate(
      messageUpdate(84, { id: 84, type: 'private', first_name: 'Guest' }, '/start'),
    );

    expect(apiCall).toHaveBeenCalledOnce();
    expect(membershipCheck).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it('ignores group updates without contacting the group', async () => {
    const { bot, database, apiCall, membershipCheck } = setupBot();

    await bot.handleUpdate(
      messageUpdate(
        84,
        { id: -1001234567890, type: 'supergroup', title: 'Group' },
        '/menu',
      ),
    );

    expect(apiCall).not.toHaveBeenCalled();
    expect(membershipCheck).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
  });
});

describe('embedded Telegram form entry points', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [
      'Smart Poll',
      'feature:smart-poll',
      'Smart Poll',
      'Create Poll',
      'https://mini.example/mini-app?feature=poll',
    ],
    [
      'Group Budget Vote',
      'feature:group-budget-vote',
      'Group Budget Vote',
      'Create Budget Vote',
      'https://mini.example/mini-app?feature=budget',
    ],
  ])('shows the embedded %s form entry from the feature menu', async (
    _feature,
    action,
    text,
    button,
    url,
  ) => {
    const { bot, apiCall } = setupBot();

    await bot.handleUpdate(callbackUpdate(42, action));

    expect(apiCall).toHaveBeenCalledWith(
      'editMessageText',
      expect.objectContaining({
        text,
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.arrayContaining([
            expect.arrayContaining([
              expect.objectContaining({
                text: button,
                web_app: { url },
              }),
            ]),
          ]),
        }),
      }),
    );
    expect(
      apiCall.mock.calls.some(([, payload]) =>
        JSON.stringify(payload).includes('web_app'),
      ),
    ).toBe(true);
  });

  it('leaves persisted chat drafts alone when owners send plain text or tap old draft buttons', async () => {
    const lookup = vi.fn().mockResolvedValue({ id: 'olddraft', draftStep: 'QUESTION' });
    const database = {
      smartPoll: { findFirst: lookup },
      budgetVote: { findFirst: lookup },
    } as unknown as PrismaClient;
    const { bot, apiCall } = setupBot(database);
    const update = messageUpdate(42, { id: 42, type: 'private', first_name: 'Owner' }, 'An old draft answer');
    if ('message' in update && 'entities' in update.message) delete update.message.entities;
    await bot.handleUpdate(update);
    await bot.handleUpdate(callbackUpdate(42, 'draft:continue:poll:olddraft'));
    await bot.handleUpdate(callbackUpdate(42, 'draft:switch:budget:poll:olddraft'));
    expect(lookup).not.toHaveBeenCalled();
    expect(apiCall).not.toHaveBeenCalled();
  });

  it('keeps previously published group records read-only in PRELAUNCH', async () => {
    const store = {
      findFirst: vi.fn().mockResolvedValue({ status: 'OPEN', telegramMessageId: 10 }),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    const { bot, apiCall } = setupBot({
      smartPoll: store,
      budgetVote: store,
    } as unknown as PrismaClient);
    await bot.handleUpdate(callbackUpdate(42, 'poll:close:grouppoll'));
    await bot.handleUpdate(callbackUpdate(42, 'bv:close:groupvote'));
    expect(store.update).not.toHaveBeenCalled();
    expect(store.updateMany).not.toHaveBeenCalled();
    expect(apiCall.mock.calls.map(([method]) => method)).toEqual([
      'answerCallbackQuery',
      'answerCallbackQuery',
    ]);
  });

  it('explains when public HTTPS Mini App hosting is not configured', async () => {
    const configWithoutMiniApp = { ...config };
    delete configWithoutMiniApp.miniAppUrl;
    const { bot, apiCall } = setupBot(undefined, configWithoutMiniApp);

    await bot.handleUpdate(callbackUpdate(42, 'feature:smart-poll'));
    await bot.handleUpdate(callbackUpdate(42, 'poll:create'));

    expect(
      apiCall.mock.calls.flatMap(([, payload]) => JSON.stringify(payload)).join(' '),
    ).toContain('public HTTPS MINI_APP_URL is required');
  });
});
