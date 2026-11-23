import type { PrismaClient } from '@prisma/client';
import { Telegram } from 'telegraf';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hangoutKeyboard } from '../features/one-tap-hangout/bot.js';
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

  it('opens the Hangout form directly and exposes only owner simulation buttons', async () => {
    const { bot, apiCall, membershipCheck } = setupBot();
    await bot.handleUpdate(callbackUpdate(73, 'feature:one-tap-hangout'));
    expect(apiCall.mock.calls.map(([method]) => method)).toEqual(['answerCallbackQuery']);
    await bot.handleUpdate(callbackUpdate(42, 'feature:one-tap-hangout'));
    const edit = apiCall.mock.calls.find(([method]) => method === 'editMessageText');
    expect(edit?.[1]).toMatchObject({ reply_markup: { inline_keyboard: [
      [{ text: 'Create Hangout', web_app: { url: 'https://mini.example/mini-app/hangout?view=create' } }],
      [{ text: 'Active Hangouts', web_app: { url: 'https://mini.example/mini-app/hangout?view=active' } }],
      [{ text: 'My Hangouts', web_app: { url: 'https://mini.example/mini-app/hangout?view=mine' } }],
      [{ text: 'Completed Hangouts', web_app: { url: 'https://mini.example/mini-app/hangout?view=completed' } }],
      [{ text: 'Preview Group Invitation', web_app: { url: 'https://mini.example/mini-app/hangout?view=preview' } }],
      [{ text: 'Preview Member View', web_app: { url: 'https://mini.example/mini-app/hangout?view=member' } }],
      [{ text: 'Back' }, { text: 'Main Menu' }],
    ] } });
    expect(hangoutKeyboard({ ...config, miniAppUrl: 'https://mini.example/mini-app' }, 'pizza')
      .reply_markup.inline_keyboard[0]).toEqual([
      { text: 'View Details', web_app: { url: 'https://mini.example/mini-app/hangout?view=detail&id=pizza' }, hide: false },
    ]);
    expect(membershipCheck).not.toHaveBeenCalled();
  });

  it('launches the countdown form directly and keeps its previews owner-only', async () => {
    const { bot, apiCall, membershipCheck } = setupBot();
    await bot.handleUpdate(callbackUpdate(73, 'feature:plan-countdown'));
    expect(apiCall.mock.calls.map(([method]) => method)).toEqual(['answerCallbackQuery']);
    await bot.handleUpdate(callbackUpdate(42, 'feature:plan-countdown'));
    const edit = apiCall.mock.calls.find(([method]) => method === 'editMessageText');
    expect(edit?.[1]).toMatchObject({ reply_markup: { inline_keyboard: [
      [{ text: 'Create Countdown', web_app: { url: 'https://mini.example/mini-app/countdown?view=create' } }],
      [{ text: 'Upcoming Countdowns' }],
      [{ text: 'My Events' }],
      [{ text: 'Completed Events' }],
      [{ text: 'Preview Notifications' }],
      [{ text: 'Preview Member View' }],
      [{ text: 'Back' }, { text: 'Main Menu' }],
    ] } });
    expect(membershipCheck).not.toHaveBeenCalled();
  });

  it('routes a LIVE announcement link to authorized countdown details', async () => {
    const upsert = vi.fn();
    const database = {
      $transaction: async (work: (tx: object) => Promise<unknown>) => work({
        telegramGroup: { upsert }, member: { upsert }, groupMembership: { upsert },
      }),
    } as unknown as PrismaClient;
    const { bot, apiCall, membershipCheck } = setupBot(database, { ...config, accessMode: 'LIVE' });
    membershipCheck.mockResolvedValue({
      status: 'member', user: { id: 73, is_bot: false, first_name: 'Fixture member' },
    });
    const id = 'c9633958-3bd2-4d2b-b4a6-42e0f565db81';
    await bot.handleUpdate(messageUpdate(73, { id: 73, type: 'private', first_name: 'Fixture member' }, `/start countdown_${id}`));
    expect(membershipCheck).toHaveBeenCalledWith(String(config.groupId), 73);
    expect(apiCall).toHaveBeenCalledWith('sendMessage', expect.objectContaining({
      reply_markup: { inline_keyboard: [
        [{ text: 'View Countdown', hide: false, web_app: { url: `https://mini.example/mini-app/countdown?view=detail&id=${id}` } }],
        [{ text: 'Back', hide: false, callback_data: 'feature:plan-countdown' },
          { text: 'Main Menu', hide: false, callback_data: 'nav:home' }],
      ] },
    }));
  });

  it('uses a private bot deep link for the group menu in a simulated LIVE update', async () => {
    const upsert = vi.fn();
    const database = {
      $transaction: async (work: (tx: object) => Promise<unknown>) => work({
        telegramGroup: { upsert }, member: { upsert }, groupMembership: { upsert },
      }),
    } as unknown as PrismaClient;
    const { bot, apiCall, membershipCheck } = setupBot(database, { ...config, accessMode: 'LIVE' });
    membershipCheck.mockResolvedValue({
      status: 'member', user: { id: 73, is_bot: false, first_name: 'Fixture member' },
    });
    await bot.handleUpdate(messageUpdate(73, { id: Number(config.groupId), type: 'supergroup', title: 'Fixture group' }, '/menu'));
    expect(apiCall).toHaveBeenCalledWith('sendMessage', expect.objectContaining({
      reply_markup: { inline_keyboard: [[{
        text: 'Open private dashboard', url: 'https://t.me/test_bot?start=dashboard', hide: false,
      }]] },
    }));
  });

  it('opens Birthday Reminder directly as an owner-only Mini App', async () => {
    const findUnique = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ day: 29 });
    const database = { birthday: { findUnique } } as unknown as PrismaClient;
    const { bot, apiCall, membershipCheck } = setupBot(database);
    await bot.handleUpdate(callbackUpdate(73, 'feature:birthday-reminder'));
    expect(findUnique).not.toHaveBeenCalled();
    await bot.handleUpdate(callbackUpdate(42, 'feature:birthday-reminder'));
    await bot.handleUpdate(callbackUpdate(42, 'feature:birthday-reminder'));
    const edits = apiCall.mock.calls.filter(([method]) => method === 'editMessageText');
    const button = (text: string, view: string) => ({ text, web_app: { url: `https://mini.example/mini-app/birthday?view=${view}` } });
    expect(edits[0]?.[1]).toMatchObject({ reply_markup: { inline_keyboard: [
      [button('Add My Birthday', 'form')],
      [button('Upcoming Birthdays', 'upcoming')],
      [button('Preview Group Announcement', 'preview')],
      [{ text: 'Back' }, { text: 'Main Menu' }],
    ] } });
    expect(edits[1]?.[1]).toMatchObject({ reply_markup: { inline_keyboard: [
      [button('Edit My Birthday', 'form')],
      [button('Upcoming Birthdays', 'upcoming')],
      [button('Preview Group Announcement', 'preview')],
      [{ text: 'Back' }, { text: 'Main Menu' }],
    ] } });
    expect(membershipCheck).not.toHaveBeenCalled();
  });

  it.each(['/start', '/menu', 'nav:home', 'nav:back'])('opens six feature homes from %s', async (entry) => {
    const { bot, database, apiCall, membershipCheck } = setupBot();

    const command = entry.startsWith('/');
    await bot.handleUpdate(command
      ? messageUpdate(42, { id: 42, type: 'private', first_name: 'Owner' }, entry)
      : callbackUpdate(42, entry));

    const screen = apiCall.mock.calls.find(([method]) => method === (command ? 'sendMessage' : 'editMessageText'))?.[1];
    const webApp = (text: string, path: string) => ({ text, hide: false, web_app: { url: 'https://mini.example' + path } });
    expect(screen).toMatchObject({
      reply_markup: { inline_keyboard: [
        [webApp('Smart Poll', '/mini-app?feature=poll&view=votes'), webApp('Bill Splitter', '/mini-app/bills?view=mine')],
        [webApp('Birthday Reminder', '/mini-app/birthday'), { text: 'Shared Memory Vault', callback_data: 'feature:shared-memory-vault' }],
        [webApp('Plan Countdown', '/mini-app/countdown'), webApp('One Tap Hangout', '/mini-app/hangout')],
        [webApp('Group Budget Vote', '/mini-app?feature=budget&view=votes')],
      ] },
    });
    expect(membershipCheck).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it('keeps callback menus when an HTTPS launch URL is unavailable', async () => {
    const { bot, apiCall } = setupBot(undefined, { ...config, miniAppUrl: 'http://localhost:3000' });
    await bot.handleUpdate(messageUpdate(42, { id: 42, type: 'private', first_name: 'Owner' }, '/menu'));
    const keyboard = apiCall.mock.calls.find(([method]) => method === 'sendMessage')?.[1];
    expect(JSON.stringify(keyboard)).not.toContain('web_app');
    expect(JSON.stringify(keyboard)).toContain('"callback_data":"feature:bill-splitter"');
  });

  it.each(['polls', 'budgets'])('opens %s management only for the PRELAUNCH owner', async (payload) => {
    const findMany = vi.fn().mockResolvedValue([]);
    const database = { smartPoll: { findMany }, budgetVote: { findMany } } as unknown as PrismaClient;
    const { bot, apiCall, membershipCheck } = setupBot(database);
    const start = (id: number) => bot.handleUpdate(messageUpdate(id,
      { id, type: 'private', first_name: 'Tester' }, `/start ${payload}`));
    await start(73);
    expect(findMany).not.toHaveBeenCalled();
    expect(apiCall).not.toHaveBeenCalled();
    await start(42);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { groupId: config.groupId, creatorId: 42n } }));
    expect(apiCall).toHaveBeenCalledWith('sendMessage', expect.objectContaining({
      text: expect.stringContaining(payload === 'polls' ? 'My polls' : 'My budget votes'),
    }));
    expect(membershipCheck).not.toHaveBeenCalled();
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
      'Bill Splitter',
      'feature:bill-splitter',
      'Bill Splitter',
      'Create Bill',
      'https://mini.example/mini-app/bills?view=create',
    ],
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
    expect(apiCall.mock.calls.map(([method]) => method)).toEqual([
      'answerCallbackQuery', 'answerCallbackQuery',
    ]);
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

describe('creator and member voting', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function record(kind: 'poll' | 'bv', isPrelaunchTest: boolean) {
    return {
      id: 'savedrecord', creatorId: 42n, groupId: config.groupId, isPrelaunchTest,
      telegramPollId: null, telegramMessageId: isPrelaunchTest ? null : 333,
      status: isPrelaunchTest ? (kind === 'poll' ? 'PRELAUNCH_PREVIEW' : 'PRELAUNCH_OPEN') : 'OPEN',
      draftStep: 'SAVED',
      question: 'Where should we go?', title: 'How much should we budget?',
      isAnonymous: true, allowsMultipleAnswers: kind === 'poll', totalVoterCount: 0,
      ranges: [],
      options: [10_000n, 20_000n, 30_000n].map((amountMmk, index) => ({
        id: `option${index}`, amountMmk, text: ['Cafe', 'Park', 'Museum'][index],
        _count: { votes: 0, ballots: 0 },
      })),
    };
  }

  function screens(apiCall: ReturnType<typeof setupBot>['apiCall']) {
    return apiCall.mock.calls.filter(([method]) => method === 'editMessageText')
      .map(([, payload]) => JSON.stringify(payload));
  }

  it.each(['poll', 'bv'] as const)('edits the %s list, detail, results and simulation without writes', async (kind) => {
    const saved = record(kind, true);
    const store = {
      findMany: vi.fn().mockResolvedValue([saved]),
      findUnique: vi.fn().mockResolvedValue(saved),
      updateMany: vi.fn(),
    };
    const tx = { smartPoll: store, budgetVote: store, $executeRaw: vi.fn(), $queryRaw: vi.fn() };
    const database = {
      ...tx,
      $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
    } as unknown as PrismaClient;
    const { bot, apiCall, membershipCheck } = setupBot(database);
    const owner = `vote:${kind}:owner:${saved.id}:0`;
    const preview = `vote:${kind}:preview:${saved.id}:0`;
    const tap = (route: string, user = 42) => bot.handleUpdate(callbackUpdate(user, route));

    await tap(`${kind}:list`);
    await tap(owner);
    await tap(`${owner}:r`);
    await tap(preview);
    await tap(`${preview}:o1`);
    await tap(`${preview}:s1`);
    await tap(preview, 84);
    await tap(`${owner}:p`);
    await tap(`vote:${kind}:live:${saved.id}:0:s1`);
    await tap('nav:home');

    const [list, detail, results, voting, selected, simulated, home] = screens(apiCall);
    expect(list).toContain(owner);
    expect(detail).toContain('Private draft');
    expect(detail).toContain(`vote:${kind}:mine:0`);
    expect(results).toContain('Total voters: 0');
    expect(voting).toContain('Member View Preview · Simulation');
    expect(voting).toContain(owner);
    expect(voting).toContain(kind === 'poll' ? 'Cafe' : '10,000 MMK');
    expect(selected).toContain('Submit vote');
    expect(simulated).toContain('Simulated vote submitted.');
    expect(simulated).toContain('1 · 100%');
    expect(home).toContain('Choose a feature to get started.');
    expect(store.updateMany).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(membershipCheck).not.toHaveBeenCalled();
    expect(apiCall.mock.calls.some(([method]) => method === 'sendMessage')).toBe(false);
  });

  it('gives all seven menus dashboard navigation', async () => {
    const db = { birthday: { findUnique: vi.fn().mockResolvedValue(null) } } as unknown as PrismaClient;
    const { bot, apiCall } = setupBot(db);
    for (const id of ['smart-poll', 'group-budget-vote', 'bill-splitter', 'one-tap-hangout',
      'shared-memory-vault', 'plan-countdown', 'birthday-reminder']) {
      await bot.handleUpdate(callbackUpdate(42, `feature:${id}`));
    }
    expect(screens(apiCall)).toHaveLength(7);
    for (const screen of screens(apiCall)) {
      expect(screen).toContain('"text":"Back","callback_data":"nav:home"');
      expect(screen).toContain('"text":"Main Menu","callback_data":"nav:home"');
    }
  });

  it.each(['poll', 'bv'] as const)('requires membership and replaces a repeat %s ballot using its transaction', async (kind) => {
    const saved = record(kind, false);
    const ballots = new Map<bigint, string[]>();
    const updateCounts = () => {
      const votes = [...ballots.values()];
      saved.totalVoterCount = votes.length;
      for (const option of saved.options) {
        option._count.votes = votes.filter((choices) => choices.includes(option.id)).length;
        option._count.ballots = option._count.votes;
      }
    };
    const store = { findUnique: vi.fn(async () => { updateCounts(); return saved; }), update: vi.fn(), updateMany: vi.fn() };
    const tx = {
      smartPoll: store, budgetVote: store,
      telegramGroup: { upsert: vi.fn() }, member: { upsert: vi.fn() }, groupMembership: { upsert: vi.fn() },
      $queryRaw: vi.fn(async (sql: TemplateStringsArray) => sql.join('').includes('FOR UPDATE')
        ? [{ id: saved.id }] : [{ total: ballots.size }]),
      smartPollVote: {
        deleteMany: vi.fn(async ({ where }: { where: { memberId: bigint } }) => { ballots.delete(where.memberId); }),
        createMany: vi.fn(async ({ data }: { data: { memberId: bigint; optionId: string }[] }) => {
          ballots.set(data[0]!.memberId, data.map(({ optionId }) => optionId));
        }),
      },
      budgetVoteOptionBallot: {
        upsert: vi.fn(async ({ create }: { create: { memberId: bigint; optionId: string } }) => {
          ballots.set(create.memberId, [create.optionId]);
        }),
      },
    };
    const database = {
      ...tx,
      $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
    } as unknown as PrismaClient;
    const { bot, apiCall, membershipCheck } = setupBot(database, { ...config, accessMode: 'LIVE' });
    membershipCheck.mockImplementation(async (_group, user) => ({ status: user === 99 ? 'left' : 'member' }) as never);
    const member = `vote:${kind}:live:${saved.id}:0`;

    await bot.handleUpdate(callbackUpdate(84, `${member}:s1`));
    await bot.handleUpdate(callbackUpdate(84, `${member}:s${kind === 'poll' ? 3 : 2}`));
    await bot.handleUpdate(callbackUpdate(99, `${member}:s4`));
    expect(ballots.size).toBe(1);
    expect(ballots.get(84n)).toEqual(kind === 'poll' ? ['option0', 'option1'] : ['option1']);
    expect(tx.$queryRaw.mock.calls.filter(([sql]) => sql.join('').includes('FOR UPDATE'))).toHaveLength(2);
    expect(screens(apiCall).at(-1)).toContain('Vote saved.');
    expect(screens(apiCall).at(-1)).toContain('Total voters: 1');
    expect(screens(apiCall).at(-1)).toContain(kind === 'poll' ? 'Park — 1 · 100%' : '20,000 MMK — 1 · 100%');

    saved.status = 'CLOSED';
    await bot.handleUpdate(callbackUpdate(84, `${member}:s4`));
    await bot.handleUpdate(callbackUpdate(84, `${member}:r`));
    expect(ballots.size).toBe(1);
    expect(screens(apiCall).at(-1)).toContain('Total voters: 1');
  });

  it.each(['poll', 'bv'] as const)('claims a LIVE %s draft once and opens it from the group deep link', async (kind) => {
    const saved = { ...record(kind, false), status: 'DRAFT', telegramMessageId: null as number | null };
    const store = {
      findUnique: vi.fn().mockResolvedValue(saved),
      updateMany: vi.fn(async ({ where, data }: {
        where: { status: string }; data: { status: string; telegramMessageId?: number };
      }) => {
        if (where.status !== saved.status) return { count: 0 };
        saved.status = data.status;
        if (data.telegramMessageId !== undefined) saved.telegramMessageId = data.telegramMessageId;
        return { count: 1 };
      }),
    };
    const tx = {
      smartPoll: store, budgetVote: store,
      telegramGroup: { upsert: vi.fn() }, member: { upsert: vi.fn() }, groupMembership: { upsert: vi.fn() },
    };
    const database = {
      ...tx,
      $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
    } as unknown as PrismaClient;
    const { bot, apiCall, membershipCheck } = setupBot(database, { ...config, accessMode: 'LIVE' });
    membershipCheck.mockResolvedValue({ status: 'member' } as never);
    const route = `vote:${kind}:owner:${saved.id}:0:p`;
    await Promise.all([bot.handleUpdate(callbackUpdate(42, route)), bot.handleUpdate(callbackUpdate(42, route))]);
    expect(saved.status).toBe('OPEN');
    const sends = apiCall.mock.calls.filter(([method]) => method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.[1]).toEqual(expect.objectContaining({
      chat_id: config.groupId.toString(),
      reply_markup: expect.objectContaining({
        inline_keyboard: [[expect.objectContaining({ url: `https://t.me/test_bot?start=vote_${kind}_${saved.id}` })]],
      }),
    }));
    await bot.handleUpdate(messageUpdate(84, { id: 84, type: 'private', first_name: 'Member' }, `/start vote_${kind}_${saved.id}`));
    expect(apiCall).toHaveBeenCalledWith('sendMessage', expect.objectContaining({
      chat_id: 84, text: expect.stringContaining('then submit.'),
    }));
  });

  it('never promotes a PRELAUNCH record in LIVE, even through an old publish button', async () => {
    const saved = record('poll', true);
    saved.status = 'DRAFT';
    const store = { findUnique: vi.fn().mockResolvedValue(saved), updateMany: vi.fn() };
    const tx = {
      smartPoll: store,
      telegramGroup: { upsert: vi.fn() }, member: { upsert: vi.fn() }, groupMembership: { upsert: vi.fn() },
    };
    const database = {
      $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
    } as unknown as PrismaClient;
    const { bot, apiCall, membershipCheck } = setupBot(database, { ...config, accessMode: 'LIVE' });
    membershipCheck.mockResolvedValue({ status: 'member' } as never);
    await bot.handleUpdate(callbackUpdate(42, `poll:publish:${saved.id}`));
    expect(store.updateMany).not.toHaveBeenCalled();
    expect(apiCall.mock.calls.some(([method]) => method === 'sendMessage')).toBe(false);
  });
});
