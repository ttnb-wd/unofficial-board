import { createHmac } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Telegram } from 'telegraf';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import { createLogger } from '../logger.js';
import type { Update } from 'telegraf/types';
import { createBot } from '../bot/create-bot.js';
import { refreshGroupMessages } from '../features/group-message.js';
import { deliverBirthdays } from '../features/birthday-reminder/delivery.js';
import { deliverCountdowns } from '../features/plan-countdown/delivery.js';
import { handleCountdownAction } from '../features/plan-countdown/api.js';
import { deliverHangouts } from '../features/one-tap-hangout/delivery.js';
import { handleHangoutAction } from '../features/one-tap-hangout/api.js';
import { deliverBills } from '../features/bill-splitter/delivery.js';
import { createBillInput } from '../features/bill-splitter/rules.js';
import { createBill, submitPayment } from '../features/bill-splitter/ledger.js';
import { registerTestScope, verifyDatabaseScope } from '../startup.js';
import { createMiniAppServer } from './server.js';

const config: AppConfig = {
  botToken: '123456:test-token',
  groupId: -1001234567890n,
  prelaunchOwnerId: 42n,
  accessMode: 'PRELAUNCH',
  databaseUrl: 'postgresql://user:pass@localhost:5432/board',
  miniAppPort: 0,
  logLevel: 'silent',
};

function signedInitData(userId: number): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: 'Tester' }),
  });
  const checkString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData')
    .update(config.botToken)
    .digest();
  params.set(
    'hash',
    createHmac('sha256', secretKey).update(checkString).digest('hex'),
  );
  return params.toString();
}

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a test port.');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

describe('Mini App API', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves Dashboard Home and reads only the owner’s preview data in PRELAUNCH', async () => {
    const port = await getFreePort();
    const createdAt = new Date('2026-11-20T12:00:00Z');
    const findPolls = vi.fn()
      .mockResolvedValueOnce([{ id: 'poll1', question: 'Where next?', status: 'PRELAUNCH_PREVIEW', createdAt }])
      .mockResolvedValue([{ id: 'poll1', question: 'Where next?', status: 'PRELAUNCH_PREVIEW' }]);
    const findBirthday = vi.fn().mockResolvedValue({ month: 11, day: 23 });
    const forbidden = vi.fn(() => { throw new Error('Preview accessed live group state'); });
    const database = {
      smartPoll: { findMany: findPolls },
      budgetVote: { findMany: vi.fn().mockResolvedValue([]) },
      birthday: { findUnique: findBirthday, findMany: forbidden },
      planCountdown: { findMany: forbidden },
      hangout: { findMany: forbidden },
      groupBill: { findMany: forbidden },
    } as unknown as PrismaClient;
    const server = createMiniAppServer(
      { ...config, miniAppPort: port }, database, { getChatMember: forbidden } as unknown as Telegram,
      createLogger('silent'), 'test_bot',
    );
    await server.listen();
    const base = `http://127.0.0.1:${port}`;
    const post = (authorization: string) => fetch(base + '/api/dashboard', {
      method: 'POST', headers: { Authorization: authorization },
    });
    const votes = (userId: number, kind: 'poll' | 'bv') => fetch(base + '/api/votes', {
      method: 'POST',
      headers: { Authorization: 'tma ' + signedInitData(userId), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list', kind, page: 0 }),
    });
    try {
      expect(await (await fetch(base + '/mini-app')).text()).toContain('id="board-home"');
      for (const asset of ['board.js', 'home.js', 'votes.js', 'icons.svg', 'board-logo.png', 'welcome.webp', 'poll.webp', 'budget.webp', 'bill.webp']) {
        expect((await fetch(`${base}/mini-app/${asset}`)).status).toBe(200);
      }
      expect((await post('')).status).toBe(403);
      expect((await post('tma ' + signedInitData(73))).status).toBe(403);
      expect((await fetch(base + '/api/votes', { method: 'POST' })).status).toBe(403);
      expect((await votes(73, 'poll')).status).toBe(403);
      expect(findPolls).not.toHaveBeenCalled();
      const response = await post('tma ' + signedInitData(42));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        name: 'Tester', preview: true,
        birthday: { date: { month: 11, day: 23 } },
        polls: [{ id: 'poll1', title: 'Where next?', status: 'PRELAUNCH_PREVIEW', createdAt: createdAt.toISOString() }],
        budgets: [], plans: null, hangouts: null, birthdays: null, bills: null, debts: null,
        dashboardUrl: 'https://t.me/test_bot?start=dashboard',
      });
      expect(findPolls).toHaveBeenCalledWith(expect.objectContaining({
        where: { groupId: config.groupId, creatorId: 42n, isPrelaunchTest: true, question: { not: null } },
      }));
      expect(findBirthday).toHaveBeenCalledWith(expect.objectContaining({
        where: { groupId_memberId_preview: { groupId: config.groupId, memberId: 42n, preview: true } },
      }));
      expect(forbidden).not.toHaveBeenCalled();
      for (const [kind, payload] of [['poll', 'polls'], ['bv', 'budgets']] as const) {
        const response = await votes(42, kind);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          preview: true, managementUrl: `https://t.me/test_bot?start=${payload}`,
        });
      }
      expect(forbidden).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('keeps Hangout simulation owner-only and performs no Telegram or database operations', async () => {
    const port = await getFreePort();
    const use = vi.fn(() => { throw new Error('PRELAUNCH Hangout accessed external state'); });
    const denied = new Proxy({}, { get: use });
    const server = createMiniAppServer(
      { ...config, miniAppPort: port },
      denied as PrismaClient, denied as Telegram, createLogger('silent'), 'test_bot',
    );
    await server.listen();
    const post = (userId: number, action: string) => fetch(`http://127.0.0.1:${port}/api/hangouts`, {
      method: 'POST',
      headers: { Authorization: 'tma ' + signedInitData(userId), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    try {
      const page = await fetch(`http://127.0.0.1:${port}/mini-app/hangout`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('data-feature="one-tap-hangout"');
      expect(html).toContain('/mini-app/hangout-launch.js');
      for (const asset of ['hangout-launch.js', 'hangout.js', 'event-time.js', 'config.js']) {
        const response = await fetch(`http://127.0.0.1:${port}/mini-app/${asset}?v=2`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/javascript/);
        expect(await response.text()).not.toBe('');
      }
      expect((await post(73, 'session')).status).toBe(403);
      const owner = await post(42, 'session');
      expect(owner.status).toBe(200);
      expect(await owner.json()).toMatchObject({ preview: true });
      expect((await post(42, 'active')).status).toBe(403);
      server.wakeHangouts();
      expect(use).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('authenticates the countdown owner and isolates PRELAUNCH reads and writes from the database', async () => {
    const port = await getFreePort();
    const lookup = vi.fn();
    const writes = vi.fn();
    const server = createMiniAppServer(
      { ...config, miniAppPort: port },
      { $transaction: writes } as unknown as PrismaClient,
      { getChatMember: lookup } as unknown as Telegram,
      createLogger('silent'),
      'test_bot',
    );
    await server.listen();
    const base = `http://127.0.0.1:${port}`;
    const post = (authorization: string, action: string) => fetch(base + '/api/countdowns', {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    try {
      expect((await fetch(base + '/mini-app/countdown')).status).toBe(200);
      expect((await post('tma ' + signedInitData(73), 'session')).status).toBe(403);
      expect((await post('tma ' + signedInitData(42) + 'x', 'session')).status).toBe(403);
      const owner = await post('tma ' + signedInitData(42), 'session');
      expect(owner.status).toBe(200);
      expect(await owner.json()).toMatchObject({
        preview: true,
        messages: [
          { kind: 'ANNOUNCEMENT' },
          { kind: 'DAY_BEFORE' },
          { kind: 'SIX_HOURS_BEFORE' },
          { kind: 'HOUR_BEFORE' },
          { kind: 'AT_START', variants: expect.arrayContaining([expect.stringContaining('Weekend picnic')]) },
        ],
      });
      expect((await post('tma ' + signedInitData(42), 'upcoming')).status).toBe(403);
      expect(lookup).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('lets eligible LIVE members view shared countdowns and rejects departed members', async () => {
    const port = await getFreePort();
    const upsert = vi.fn();
    const findMany = vi.fn().mockResolvedValue([]);
    const db = {
      $transaction: async (work: (tx: object) => Promise<unknown>) => work({
        telegramGroup: { upsert }, member: { upsert }, groupMembership: { upsert },
      }),
      planCountdown: { findMany },
    } as unknown as PrismaClient;
    const getChatMember = vi.fn().mockResolvedValueOnce({ status: 'member' }).mockResolvedValueOnce({ status: 'left' });
    const server = createMiniAppServer(
      { ...config, miniAppPort: port, accessMode: 'LIVE' },
      db, { getChatMember } as unknown as Telegram, createLogger('silent'),
    );
    await server.listen();
    const post = (id: number) => fetch(`http://127.0.0.1:${port}/api/countdowns`, {
      method: 'POST',
      headers: { Authorization: 'tma ' + signedInitData(id), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'upcoming' }),
    });
    try {
      const allowed = await post(73);
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toMatchObject({ plans: [] });
      expect((await post(74)).status).toBe(403);
      expect(findMany).toHaveBeenCalledOnce();
      expect(getChatMember.mock.calls).toEqual([[String(config.groupId), 73], [String(config.groupId), 74]]);
    } finally {
      await server.close();
    }
  });

  it('serves the embedded form assets with exact MMK defaults and title labeling', async () => {
    const port = await getFreePort();
    const server = createMiniAppServer(
      { ...config, miniAppPort: port },
      {} as PrismaClient,
      {} as Telegram,
      createLogger('silent'),
    );
    await server.listen();

    try {
      const page = await fetch(`http://127.0.0.1:${port}/mini-app`);
      const script = await fetch(`http://127.0.0.1:${port}/mini-app/app.js`);
      const [pageHtml, appScript] = await Promise.all([
        page.text(),
        script.text(),
      ]);

      expect(page.status).toBe(200);
      expect(pageHtml).toContain('id="feature-form"');
      expect(script.status).toBe(200);
      expect(appScript).toContain("question: 'Title'");
      expect(appScript).toContain("addChoice('10000')");
      expect(appScript).toContain("addChoice('20000')");
      expect(appScript).toContain("addChoice('30000')");
      expect(appScript).toContain('Add amount');
      expect(appScript).toContain('Remove amount');
    } finally {
      await server.close();
    }
  });

  it('allows only the production browser origin in split hosting', async () => {
    const port = await getFreePort();
    const productionOrigin = 'https://board.example';
    const server = createMiniAppServer(
      { ...config, miniAppPort: port, miniAppUrl: productionOrigin, serveMiniApp: false },
      {} as PrismaClient,
      {} as Telegram,
      createLogger('silent'),
    );
    await server.listen();
    const base = `http://127.0.0.1:${port}`;
    const preflight = (path: string, origin: string) => fetch(base + path, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });

    try {
      for (const path of ['/api/smart-polls', '/api/budget-votes', '/api/countdowns', '/api/hangouts']) {
        const allowed = await preflight(path, productionOrigin);
        expect(allowed.status).toBe(204);
        expect(allowed.headers.get('access-control-allow-origin')).toBe(productionOrigin);
        expect(allowed.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type');
        expect(allowed.headers.get('vary')).toContain('Origin');

        const rejected = await preflight(path, 'https://board-preview.example');
        expect(rejected.status).toBe(403);
        expect(rejected.headers.has('access-control-allow-origin')).toBe(false);

        const unsigned = await fetch(base + path, { method: 'POST', headers: { Origin: productionOrigin } });
        expect(unsigned.status).toBe(403);
        expect(unsigned.headers.get('access-control-allow-origin')).toBe(productionOrigin);

        const wrongOrigin = await fetch(base + path, {
          method: 'POST',
          headers: { Origin: 'null', Authorization: `tma ${signedInitData(42)}` },
        });
        expect(wrongOrigin.status).toBe(403);
        expect(wrongOrigin.headers.has('access-control-allow-origin')).toBe(false);
      }
      const health = await fetch(base + '/healthz', { headers: { Origin: productionOrigin } });
      expect(await health.json()).toEqual({ status: 'ok' });
      expect(health.headers.get('access-control-allow-origin')).toBe(productionOrigin);
      expect((await fetch(base + '/healthz')).status).toBe(200);
      expect((await fetch(base + '/mini-app?feature=poll')).status).toBe(404);
      expect((await fetch(base + '/mini-app/config.js')).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('authenticates the PRELAUNCH owner and makes form submissions idempotent', async () => {
    const port = await getFreePort();
    const submissions = new Map<
      string,
      { creatorId: bigint; feature: string; resourceId: string; groupId: bigint }
    >();
    const transaction = {
      $executeRaw: vi.fn(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = strings.join('');
          if (sql.includes('INSERT INTO "MiniAppSubmission"')) {
            const feature = sql.includes('SMART_POLL')
              ? 'SMART_POLL'
              : 'BUDGET_VOTE';
            const requestId = String(values[0]);
            const creatorId = BigInt(values[1] as bigint);
            const resourceId = String(values[2]);
            submissions.set(requestId, { creatorId, feature, resourceId, groupId: config.groupId });
          }
          return 1;
        },
      ),
      $queryRaw: vi.fn(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (strings.join('').includes('FROM "MiniAppSubmission"')) {
            const existing = submissions.get(String(values[0]));
            return existing ? [existing] : [];
          }
          return [];
        },
      ),
      telegramGroup: { upsert: vi.fn().mockResolvedValue({}) },
      member: { upsert: vi.fn().mockResolvedValue({}) },
      smartPoll: {
        create: vi.fn().mockResolvedValue({ id: 'poll-id' }),
      },
      budgetVote: {
        create: vi.fn().mockResolvedValue({ id: 'budget-id' }),
      },
    };
    const database = {
      $transaction: vi.fn(async (run: (tx: typeof transaction) => unknown) =>
        run(transaction),
      ),
    } as unknown as PrismaClient;
    const telegram = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    } as unknown as Telegram;
    const server = createMiniAppServer(
      { ...config, miniAppPort: port },
      database,
      telegram,
      createLogger('silent'),
    );
    await server.listen();

    try {
      const post = (
        path: string,
        userId: number,
        body: Record<string, unknown>,
      ) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `tma ${signedInitData(userId)}`,
            Origin: `http://127.0.0.1:${port}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

      const pollBody = {
        requestId: '4c4a8f4b-7d6a-4c24-ae93-7a581a9ac542',
        question: 'Where should we go?',
        options: ['Cafe', 'Park', 'Museum'],
      };
      const firstPoll = await post('/api/smart-polls', 42, pollBody);
      const duplicatePoll = await post('/api/smart-polls', 42, pollBody);
      expect(firstPoll.status).toBe(201);
      expect(duplicatePoll.status).toBe(200);
      expect(transaction.smartPoll.create).toHaveBeenCalledOnce();
      expect(transaction.smartPoll.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PRELAUNCH_PREVIEW',
            isPrelaunchTest: true,
            options: {
              create: [
                { position: 0, text: 'Cafe' },
                { position: 1, text: 'Park' },
                { position: 2, text: 'Museum' },
              ],
            },
          }),
        }),
      );

      const budgetBody = {
        requestId: '0d1b50cc-5fe2-4ed0-9e86-6e77b73eaee4',
        question: 'How much should we budget?',
        amounts: ['10000', '20000', '30000'],
      };
      const firstBudget = await post('/api/budget-votes', 42, budgetBody);
      const duplicateBudget = await post('/api/budget-votes', 42, budgetBody);
      expect(firstBudget.status).toBe(201);
      expect(duplicateBudget.status).toBe(200);
      expect(transaction.budgetVote.create).toHaveBeenCalledOnce();
      expect(transaction.$executeRaw).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      expect(telegram.sendMessage).not.toHaveBeenCalled();

      const denied = await post('/api/smart-polls', 84, {
        ...pollBody,
        requestId: '48701db2-18f8-4421-97b8-ad9ca0fd3dde',
      });
      expect(denied.status).toBe(403);
      expect(database.$transaction).toHaveBeenCalledTimes(4);
    } finally {
      await server.close();
    }
  });
});

const boardTestUrl = process.env.BOARD_TEST_DATABASE_URL;
if (boardTestUrl) {
  const target = new URL(boardTestUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.pathname !== '/board_unified_test') {
    throw new Error('Board integration tests require the isolated local board_unified_test database.');
  }
}

describe.skipIf(!boardTestUrl)('shared Telegram and Mini App activity on isolated PostgreSQL', () => {
  it('publishes once, shares ballots in both directions, and edits the original group message', async () => {
    const db = new PrismaClient({ datasourceUrl: boardTestUrl! });
    const groupId = -BigInt(Date.now());
    const live = { ...config, groupId, accessMode: 'LIVE' as const, miniAppPort: await getFreePort() };
    const logger = createLogger('silent');
    const bot = createBot(live, db, 'test_bot', logger);
    let messageId = 300;
    const calls = vi.spyOn(Telegram.prototype, 'callApi').mockImplementation(async (method, payload) =>
      (method === 'getChatMember'
        ? { status: 'member', user: { id: (payload as { user_id: number }).user_id, first_name: 'Tester', is_bot: false } }
        : { message_id: ++messageId }) as never);
    bot.botInfo = {
      id: 123456, is_bot: true, first_name: 'Test', username: 'test_bot',
      can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    };
    const server = createMiniAppServer(live, db, bot.telegram, logger, 'test_bot');
    const callback = (data: string, mid?: number): Update => ({
      update_id: ++messageId,
      callback_query: {
        id: String(messageId), chat_instance: 'fixture', data,
        from: { id: mid === undefined ? 42 : 73, first_name: 'Tester', is_bot: false },
        message: {
          message_id: mid ?? 1, date: 1, text: 'Fixture',
          chat: mid === undefined ? { id: 42, type: 'private', first_name: 'Tester' }
            : { id: Number(groupId), type: 'supergroup', title: 'Isolated fixture' },
        },
      },
    });
    const post = (path: string, body: unknown, actor = 42) => fetch(`http://127.0.0.1:${live.miniAppPort}/api/${path}`, {
      method: 'POST',
      headers: { Authorization: `tma ${signedInitData(actor)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const groupSends = () => calls.mock.calls.filter(([method, payload]) =>
      method === 'sendMessage' && (payload as { chat_id: string }).chat_id === String(groupId));
    const identity = bot.botInfo;
    const preview = createBot({ ...live, accessMode: 'PRELAUNCH' }, db, 'test_bot', logger);
    preview.botInfo = identity;
    try {
      await server.listen();
      for (const [kind, endpoint, key, options] of [
        ['poll', 'smart-polls', 'options', ['Tea', 'Coffee']],
        ['bv', 'budget-votes', 'amounts', ['10000', '9007199254740993']],
      ] as const) {
        calls.mockClear();
        const draft = { requestId: randomUUID(), question: `Fixture ${kind}`, [key]: options };
        const created = await post(endpoint, draft);
        expect(created.status).toBe(201);
        const { id } = await created.json();
        expect(await (await post(endpoint, draft)).json()).toMatchObject({ id, created: false });
        expect(groupSends()).toHaveLength(0);
        await bot.handleUpdate(callback(`vote:${kind}:mine:0`));
        expect(calls).toHaveBeenCalledWith('editMessageText', expect.objectContaining({
          reply_markup: expect.objectContaining({ inline_keyboard: expect.arrayContaining([
            [expect.objectContaining({ text: draft.question, callback_data: `vote:${kind}:owner:${id}:0` })],
          ]) }),
        }));
        await preview.handleUpdate(callback(`vote:${kind}:owner:${id}:0:g`));
        expect(calls).toHaveBeenCalledWith('editMessageText', expect.objectContaining({
          chat_id: 42, text: expect.stringContaining('Group Publishing Preview'),
        }));
        await preview.handleUpdate(callback(`${kind}:publish:${id}`));
        expect(groupSends()).toHaveLength(0);

        await Promise.all([bot.handleUpdate(callback(`${kind}:publish:${id}`)), bot.handleUpdate(callback(`${kind}:publish:${id}`))]);
        expect(groupSends()).toHaveLength(1);
        const record = kind === 'poll' ? await db.smartPoll.findUniqueOrThrow({ where: { id } })
          : await db.budgetVote.findUniqueOrThrow({ where: { id } });
        const mid = record.telegramMessageId!;
        await preview.handleUpdate(callback(`gv:${kind}:${id}:0`, mid));
        await bot.handleUpdate(callback(`gv:${kind}:${id}:0`, mid + 99));
        const detail = () => post('votes', { action: 'detail', kind, id }, 73).then((response) => response.json());
        expect(await detail()).toMatchObject({ mask: 0, total: 0 });
        await Promise.all(Array.from({ length: 2 }, () => bot.handleUpdate(callback(`gv:${kind}:${id}:0`, mid))));
        expect(await detail()).toMatchObject({ mask: 1, total: 1, choices: [{ count: 1 }, { count: 0 }] });
        expect((await post('votes', { action: 'submit', kind, id, mask: 2 }, 73)).status).toBe(200);
        expect(await detail()).toMatchObject({ mask: 2, total: 1, choices: [{ count: 0 }, { count: 1 }] });
        await Promise.all(Array.from({ length: 2 }, () => refreshGroupMessages(db, bot.telegram, live, 'test_bot')));
        await vi.waitFor(() => expect(calls.mock.calls.filter(([method, payload]) =>
          method === 'editMessageText' && (payload as { message_id: number }).message_id === mid)).toHaveLength(1));
        expect(groupSends()).toHaveLength(1);
        await bot.handleUpdate(callback(`vote:${kind}:owner:${id}:0:r`));
        expect(calls).toHaveBeenCalledWith('editMessageText', expect.objectContaining({
          chat_id: 42, text: expect.stringContaining('Total voters: 1'),
        }));
        if (kind === 'bv') expect((await detail()).choices[1].label).toBe('9,007,199,254,740,993 MMK');
      }
      const dashboard = await (await post('dashboard', undefined, 73)).json();
      expect(dashboard.polls).toEqual([expect.objectContaining({ title: 'Fixture poll' })]);
      expect(dashboard.budgets).toEqual([expect.objectContaining({ title: 'Fixture bv' })]);
    } finally {
      await server.close();
      await db.$disconnect();
      vi.restoreAllMocks();
    }
  }, 30_000);
});

describe.skipIf(!boardTestUrl)('Render test group on isolated PostgreSQL', () => {
  it('runs all six features and keeps original records, queues and destinations out of test mode', async () => {
    const db = new PrismaClient({ datasourceUrl: boardTestUrl! });
    const groupId = -BigInt(randomInt(1_000_000, 1_000_000_000));
    const originalGroupId = groupId - 1_000_000_000n;
    const original = { ...config, groupId: originalGroupId, accessMode: 'LIVE' as const, miniAppPort: await getFreePort() };
    const test = { ...config, groupId, testGroup: { id: groupId, originalGroupId }, miniAppPort: await getFreePort() };
    const logger = createLogger('silent');
    const bot = createBot(test, db, 'test_bot', logger);
    const disabled = createBot({ ...config, groupId: originalGroupId }, db, 'test_bot', logger);
    let messageId = 100;
    let updateId = 1000;
    const groupMembers = new Set([42, 73, 84, 85, 86]);
    const calls = vi.spyOn(Telegram.prototype, 'callApi').mockImplementation(async (method, payload) => {
      if (method === 'getChatMember') {
        const { chat_id, user_id } = payload as { chat_id: string; user_id: number };
        return {
          status: chat_id === String(originalGroupId) || groupMembers.has(user_id) ? 'member' : 'left',
          user: { id: user_id, first_name: `Member ${user_id}`, is_bot: false },
        } as never;
      }
      return { message_id: ++messageId, date: Math.floor(Date.now() / 1000) } as never;
    });
    bot.botInfo = disabled.botInfo = {
      id: 123456, is_bot: true, first_name: 'Test', username: 'test_bot',
      can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    };
    const server = createMiniAppServer(test, db, bot.telegram, logger);
    const originalServer = createMiniAppServer(original, db, bot.telegram, logger);
    const from = (id: number) => ({ id, first_name: `Member ${id}`, is_bot: false as const });
    const group = (id: bigint) => ({ id: Number(id), type: 'supergroup' as const, title: 'Fixture group' });
    const privateChat = (id: number) => ({ id, type: 'private' as const, first_name: 'Test member' });
    const command = (text: string, user = 42, chatId?: bigint): Update => ({
      update_id: ++updateId,
      message: {
        message_id: ++messageId, date: 1, from: from(user), text,
        chat: chatId === undefined ? privateChat(user) : group(chatId),
        entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }],
      },
    });
    const callback = (data: string, user = 42, message = 1, chatId?: bigint): Update => ({
      update_id: ++updateId,
      callback_query: {
        id: String(updateId), chat_instance: 'test', data, from: from(user),
        message: { message_id: message, date: 1, text: 'Fixture',
          chat: chatId === undefined ? privateChat(user) : group(chatId) },
      },
    });
    const post = (feature: string, input: unknown, user = 42, target: AppConfig = test) =>
      fetch(`http://127.0.0.1:${target.miniAppPort}/api/${feature}`, {
        method: 'POST', headers: { Authorization: `tma ${signedInitData(user)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
    const messagesTo = (chat: string | number, method: 'sendMessage' | 'editMessageText') =>
      calls.mock.calls.filter(([name, data]) => name === method && String((data as { chat_id: unknown }).chat_id) === String(chat));
    const future = { date: '2090-01-02', time: '13:30', timeZone: 'Asia/Yangon' };
    const before = () => new Date('2090-01-01T01:00:00.000Z');
    const birthday = (scope: bigint) => ({ groupId: scope, memberId: 42n, preview: false });
    try {
      await verifyDatabaseScope(db, test);
      await registerTestScope(db, bot.telegram, test);
      await expect(verifyDatabaseScope(db, { ...original, groupId })).rejects.toMatchObject({ code: 'ORIGINAL_GROUP_IS_TEST_ONLY' });

      await server.listen();
      await originalServer.listen();
      expect((await post('dashboard', undefined, 86, original)).status).toBe(200);
      for (const user of [42, 73, 84]) expect((await post('dashboard', undefined, user, original)).status).toBe(200);

      const oldBillInput = createBillInput.parse({
        requestId: randomUUID(), title: 'Original bill', total: '10000',
        receiverId: '86', method: 'EQUAL', participants: [{ memberId: '73' }, { memberId: '86' }],
      });
      const oldBill = await createBill(db, bot.telegram, originalGroupId, 42n, oldBillInput);
      const oldShare = await db.groupBillShare.findFirstOrThrow({ where: { billId: oldBill.id, memberId: 73n } });
      const oldPayment = await submitPayment(db, originalGroupId, 73n, oldShare.id, { requestId: randomUUID(), method: 'CASH' });
      await db.birthday.create({ data: { ...birthday(originalGroupId), month: 2, day: 28 } });
      const oldPlan = (await handleCountdownAction({
        action: 'create', ...future, requestId: randomUUID(), title: 'Original plan',
      }, 42n, original, db, before)).body;
      const oldHangout = (await handleHangoutAction({
        action: 'create', ...future, requestId: randomUUID(), title: 'Original hangout', place: 'Park',
      }, { id: 42n, name: 'Owner', receivedAt: before() }, original, db, before)).body;
      if (!('plan' in oldPlan) || !oldPlan.plan || !('hangout' in oldHangout) || !oldHangout.hangout) {
        throw new Error('Original fixtures did not save.');
      }

      calls.mockClear();
      expect((await post('dashboard', undefined, 73)).status).toBe(403);
      await bot.handleUpdate(command('/test_allow 73', 84));
      await bot.handleUpdate(command('/test_allow 73', 42, originalGroupId));
      await bot.handleUpdate(command('/test_group', 42, originalGroupId));
      await bot.handleUpdate(command('/start', 42, originalGroupId));
      await bot.handleUpdate(command('/start', 85, groupId));
      await disabled.handleUpdate(command('/test_group', 42, groupId));
      expect(calls).not.toHaveBeenCalled();
      for (const id of [73, 84, 85]) await bot.handleUpdate(command(`/test_allow ${id}`));
      groupMembers.delete(85);
      expect((await post('dashboard', undefined, 85)).status).toBe(403);
      expect((await post('dashboard', undefined, 86)).status).toBe(403);
      await bot.handleUpdate(command('/test_group', 73, groupId));
      expect(messagesTo(String(groupId), 'sendMessage')).toHaveLength(0);
      await bot.handleUpdate(command('/test_group', 42, groupId));
      await bot.handleUpdate(command('/start', 73, groupId));
      const entryMessages = messagesTo(String(groupId), 'sendMessage');
      expect(entryMessages.map(([, payload]) => payload)).toEqual([
        expect.objectContaining({ text: expect.stringContaining('PRELAUNCH') }),
        expect.objectContaining({ text: 'Open the private bot chat to access the group dashboard.' }),
      ]);
      expect(await (await post('dashboard', undefined, 73)).json()).toMatchObject({ preview: false, testGroup: true });
      const roster = await (await post('bills', { action: 'roster' })).json();
      expect(roster.roster.map(({ id }: { id: string }) => id)).toEqual(['42', '73', '84']);

      for (const [kind, endpoint, key, options] of [
        ['poll', 'smart-polls', 'options', ['Tea', 'Coffee']],
        ['bv', 'budget-votes', 'amounts', ['10000', '9007199254740993']],
      ] as const) {
        const saved = { requestId: randomUUID(), question: `Test ${kind}`, [key]: options };
        const originalResponse = await post(endpoint, { ...saved, question: `Original ${kind}` }, 42, original);
        expect(originalResponse.status).toBe(201);
        const oldId = (await originalResponse.json()).id;
        calls.mockClear();
        await bot.handleUpdate(callback(`${kind}:publish:${oldId}`));
        expect(messagesTo(String(groupId), 'sendMessage')).toHaveLength(0);
        const first = await post(endpoint, saved);
        expect(first.status).toBe(201);
        const { id } = await first.json();
        expect(id).not.toBe(oldId);
        expect(await (await post(endpoint, saved)).json()).toMatchObject({ id, created: false });
        await bot.handleUpdate(callback(`vote:${kind}:mine:0`));
        expect(messagesTo(42, 'editMessageText')[0]?.[1]).toMatchObject({ reply_markup: {
          inline_keyboard: expect.arrayContaining([[expect.objectContaining({ text: saved.question })]]),
        } });
        expect(JSON.stringify(messagesTo(42, 'editMessageText'))).not.toContain(`Original ${kind}`);
        await disabled.handleUpdate(callback(`${kind}:publish:${id}`));
        expect(messagesTo(String(groupId), 'sendMessage')).toHaveLength(0);
        await Promise.all([bot.handleUpdate(callback(`${kind}:publish:${id}`)), bot.handleUpdate(callback(`${kind}:publish:${id}`))]);
        expect(messagesTo(String(groupId), 'sendMessage')).toHaveLength(1);
        const found = kind === 'poll' ? await db.smartPoll.findUniqueOrThrow({ where: { id } }) :
          await db.budgetVote.findUniqueOrThrow({ where: { id } });
        expect(found.groupId).toBe(groupId);
        const originalDraft = kind === 'poll' ? await db.smartPoll.findUnique({ where: { id: oldId } }) :
          await db.budgetVote.findUnique({ where: { id: oldId } });
        expect(originalDraft).toMatchObject({ groupId: originalGroupId, status: 'DRAFT', telegramMessageId: null });
        const mid = found.telegramMessageId!;
        const detail = () => post('votes', { action: 'detail', kind, id }, 73).then((response) => response.json());
        await bot.handleUpdate(callback(`gv:${kind}:${id}:0`, 73, mid, originalGroupId));
        expect(await detail()).toMatchObject({ total: 0 });
        await bot.handleUpdate(callback(`gv:${kind}:${id}:0`, 73, mid, groupId));
        expect(await detail()).toMatchObject({ mask: 1, total: 1 });
        expect((await post('votes', { action: 'submit', kind, id, mask: 2 }, 73)).status).toBe(200);
        await refreshGroupMessages(db, bot.telegram, test, 'test_bot');
        expect(messagesTo(String(groupId), 'editMessageText').at(-1)?.[1]).toMatchObject({ message_id: mid });
        const result = await detail();
        expect(result).toMatchObject({ mask: 2, total: 1 });
        if (kind === 'bv') expect(result.choices[1].label).toBe('9,007,199,254,740,993 MMK');
        expect(calls.mock.calls.some(([, data]) => String((data as { chat_id?: string })?.chat_id) === String(originalGroupId))).toBe(false);
      }

      const billResponse = await post('bills', { action: 'create', bill: {
        ...oldBillInput, title: 'Test bill', requestId: randomUUID(), receiverId: '84', total: '10000',
        participants: [{ memberId: '73' }, { memberId: '84' }],
      } });
      expect(billResponse.status).toBe(200);
      const { id: billId } = await billResponse.json();
      expect((await post('bills', { action: 'bill', id: oldBill.id }, 73)).status).toBe(404);
      await deliverBills(db, bot.telegram, test, 'test_bot');
      const billDelivery = await db.billDelivery.findUniqueOrThrow({ where: { billId } });
      expect(billDelivery.status).toBe('SENT');
      const share = await db.groupBillShare.findFirstOrThrow({ where: { billId, memberId: 73n } });
      expect((await post('bills', { action: 'later', share: share.id }, 73)).status).toBe(200);
      const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'teal' } }).png().toBuffer();
      const paymentResponse = await post('bills', {
        action: 'submit', share: share.id, requestId: randomUUID(), method: 'TRANSFER', image: image.toString('base64'),
      }, 73);
      expect(paymentResponse.status).toBe(200);
      const { id: payment } = await paymentResponse.json();
      expect((await post('bills', { action: 'proof', payment }, 42)).status).toBe(404);
      expect((await post('bills', { action: 'proof', payment }, 85)).status).toBe(403);
      expect((await post('bills', { action: 'proof', payment }, 84)).headers.get('content-type')).toBe('image/jpeg');
      await bot.handleUpdate(command('/test_revoke 84'));
      await deliverBills(db, bot.telegram, test, 'test_bot');
      expect(messagesTo(84, 'sendMessage')).toHaveLength(0);
      expect((await post('bills', { action: 'proof', payment }, 84)).status).toBe(403);
      await bot.handleUpdate(command('/test_allow 84'));
      expect((await post('bills', { action: 'review', payment, share: share.id, decision: 'CONFIRMED' }, 84)).status).toBe(200);
      await refreshGroupMessages(db, bot.telegram, test, 'test_bot');
      expect(messagesTo(String(groupId), 'editMessageText').at(-1)?.[1]).toMatchObject({
        message_id: billDelivery.telegramMessageId, text: expect.stringContaining('Paid'),
      });
      expect((await db.billDelivery.findUnique({ where: { billId: oldBill.id } }))?.status).toBe('QUEUED');
      expect((await db.billDelivery.findUnique({ where: { paymentId: oldPayment.id } }))?.status).toBe('QUEUED');

      for (const day of [28, 29]) expect((await post('birthdays', { action: 'save', month: 2, day })).status).toBe(200);
      expect(await (await post('birthdays', { action: 'upcoming' })).json()).toMatchObject({
        items: [expect.objectContaining({ name: 'Member 42' })],
      });
      const birthClock = () => new Date('2027-02-28T02:30:00Z');
      const beforeBirths = messagesTo(String(groupId), 'sendMessage').length;
      await Promise.all([deliverBirthdays(db, bot.telegram, test, birthClock), deliverBirthdays(db, bot.telegram, test, birthClock)]);
      expect(messagesTo(String(groupId), 'sendMessage')).toHaveLength(beforeBirths + 1);
      expect(await db.birthdayDelivery.count({ where: { groupId: originalGroupId } })).toBe(0);
      expect((await db.birthday.findUnique({ where: { groupId_memberId_preview: birthday(originalGroupId) } }))?.day).toBe(28);

      const createPlan = async (title: string) => (await (await post('countdowns', {
        action: 'create', ...future, title, requestId: randomUUID(),
      })).json()).plan;
      const plan = await createPlan('Test plan');
      const cancelled = await createPlan('Cancel this plan');
      expect((await post('countdowns', { action: 'detail', id: oldPlan.plan.id })).status).toBe(404);
      expect((await post('countdowns', { action: 'edit', ...future, title: 'Updated plan', id: plan.id, version: 1 })).status).toBe(200);
      expect((await post('countdowns', { action: 'cancel', id: cancelled.id, version: 1 })).status).toBe(200);
      const planJobs = await db.planCountdownDelivery.findMany({ where: { countdownId: plan.id, kind: { not: 'ANNOUNCEMENT' } } });
      expect(planJobs.map(({ kind }) => kind).sort()).toEqual(['AT_START', 'DAY_BEFORE', 'HOUR_BEFORE', 'SIX_HOURS_BEFORE']);
      for (const { scheduledAt } of planJobs.sort((a, b) => +a.scheduledAt - +b.scheduledAt)) {
        await deliverCountdowns(db, bot.telegram, test, 'test_bot', () => scheduledAt);
      }
      expect(await db.planCountdownDelivery.count({ where: { countdownId: plan.id, status: 'SENT' } })).toBe(5);
      expect(await db.planCountdownDelivery.count({ where: { countdownId: cancelled.id, status: 'SENT' } })).toBe(0);
      expect(await db.planCountdownDelivery.count({ where: { countdownId: oldPlan.plan.id, status: 'QUEUED' } })).toBe(5);

      const hangoutResponse = await post('hangouts', {
        action: 'create', ...future, title: 'Test hangout', place: 'Park', requestId: randomUUID(),
      });
      expect(hangoutResponse.status).toBe(201);
      const { hangout } = await hangoutResponse.json();
      await deliverHangouts(db, bot.telegram, test, 'test_bot');
      const invitation = await db.hangoutInvitation.findUniqueOrThrow({ where: { hangoutId: hangout.id } });
      expect(invitation.status).toBe('SENT');
      expect((await post('hangouts', { action: 'detail', id: oldHangout.hangout.id })).status).toBe(404);
      await bot.handleUpdate(callback(`ho:g:${hangout.id}`, 73, invitation.messageId!, groupId));
      expect((await (await post('hangouts', { action: 'detail', id: hangout.id }, 73)).json()).hangout.myRsvp).toBe('GOING');
      expect((await post('hangouts', { action: 'rsvp', id: hangout.id, response: 'MAYBE' }, 84)).status).toBe(200);
      expect((await post('hangouts', { action: 'rsvp', id: hangout.id, response: 'CANT' })).status).toBe(200);
      await deliverHangouts(db, bot.telegram, test, 'test_bot');
      expect(messagesTo(String(groupId), 'editMessageText').at(-1)?.[1]).toMatchObject({
        message_id: invitation.messageId, text: expect.stringMatching(/Going: 1[\s\S]*Maybe: 1[\s\S]*: 1/),
      });
      expect((await db.hangoutInvitation.findUnique({ where: { hangoutId: oldHangout.hangout.id } }))?.status).toBe('QUEUED');
      expect(messagesTo(String(originalGroupId), 'sendMessage')).toHaveLength(0);
      expect(messagesTo(String(originalGroupId), 'editMessageText')).toHaveLength(0);
      expect(messagesTo(86, 'sendMessage')).toHaveLength(0);
      expect(JSON.stringify(await (await post('dashboard', undefined, 73)).json())).not.toContain('Original ');
    } finally {
      await server.close();
      await originalServer.close();
      await db.$disconnect();
      vi.restoreAllMocks();
    }
  }, 30_000);
});
