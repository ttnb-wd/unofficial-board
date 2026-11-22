import { createHmac } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import type { PrismaClient } from '@prisma/client';
import type { Telegram } from 'telegraf';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import { createLogger } from '../logger.js';
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
    query_id: 'test-query',
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
      for (const path of ['/api/smart-polls', '/api/budget-votes', '/api/countdowns']) {
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
      { creatorId: bigint; feature: string; resourceId: string }
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
            submissions.set(requestId, { creatorId, feature, resourceId });
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
