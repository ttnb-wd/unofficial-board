import { createHmac } from 'node:crypto';
import { createServer } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { TelegramError } from 'telegraf';
import type { Telegram } from 'telegraf';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createMiniAppServer } from '../../mini-app/server.js';
import { handleBirthdayAction } from './api.js';
import { deliverBirthdays } from './delivery.js';
import { birthdayRequest, nextOccurrence, occurrence, yangonDate } from './rules.js';

const testUrl = process.env.BIRTHDAY_TEST_DATABASE_URL;
if (testUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(testUrl).hostname)) {
  throw new Error('Birthday integration tests require an isolated local PostgreSQL database.');
}
const config: AppConfig = {
  botToken: '12345:local-token',
  groupId: -54321n,
  prelaunchOwnerId: 42n,
  accessMode: 'PRELAUNCH',
  databaseUrl: testUrl ?? '',
  logLevel: 'silent',
};
const live: AppConfig = { ...config, accessMode: 'LIVE' };

function fakeTelegram() {
  const getChatMember = vi.fn(async (_group: string, id: number) => ({
    status: id === 99 ? 'left' : 'member',
    user: { id, first_name: id === 42 ? '<Alex & Co>' : `Fixture ${id}`, is_bot: false },
  }));
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 123 });
  return { telegram: { getChatMember, sendMessage } as unknown as Telegram, getChatMember, sendMessage };
}

function sign(id: number) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id }) });
  const secret = createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  params.set('hash', createHmac('sha256', secret).update([...params].map(([key, value]) => `${key}=${value}`).join('\n')).digest('hex'));
  return params.toString();
}

async function localPort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Test port unavailable.');
  return address.port;
}

describe('birthday dates', () => {
  it('accepts real month/day pairs and rejects year or unauthorized identity fields', () => {
    for (const [month, day] of [[2, 29], [1, 31], [12, 31]]) {
      expect(birthdayRequest.safeParse({ action: 'save', month, day }).success).toBe(true);
    }
    for (const [month, day] of [[2, 30], [4, 31], [13, 1], [1, 0], [1, 1.2], ['2', 28]]) {
      expect(birthdayRequest.safeParse({ action: 'save', month, day }).success).toBe(false);
    }
    expect(birthdayRequest.safeParse({ action: 'save', month: 4, day: 3, memberId: '99' }).success).toBe(false);
    expect(birthdayRequest.safeParse({ action: 'remove', memberId: '99' }).success).toBe(false);
  });

  it('uses February 28 in non-leap years and rolls into the next Yangon year', () => {
    expect(occurrence({ month: 2, day: 29 }, 2027)).toEqual({ year: 2027, month: 2, day: 28 });
    expect(occurrence({ month: 2, day: 29 }, 2028)).toEqual({ year: 2028, month: 2, day: 29 });
    expect(occurrence({ month: 2, day: 29 }, 2100).day).toBe(28);
    const before = yangonDate(new Date('2026-12-31T17:29:00Z'));
    const after = yangonDate(new Date('2026-12-31T17:30:00Z'));
    expect(before).toEqual({ year: 2026, month: 12, day: 31, hour: 23 });
    expect(after).toEqual({ year: 2027, month: 1, day: 1, hour: 0 });
    expect(nextOccurrence({ month: 1, day: 1 }, before)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(nextOccurrence({ month: 1, day: 1 }, after)).toEqual({ year: 2027, month: 1, day: 1 });
  });
});

describe.skipIf(!testUrl)('birthday flow on isolated PostgreSQL', () => {
  it('enforces signed identity, membership, ownership, and PRELAUNCH isolation over HTTP', async () => {
    const db = new PrismaClient({ datasourceUrl: testUrl! });
    const { telegram, getChatMember, sendMessage } = fakeTelegram();
    const port = await localPort();
    const preview = createMiniAppServer({ ...config, miniAppPort: port }, db, telegram, createLogger('silent'));
    const livePort = await localPort();
    const production = createMiniAppServer({ ...live, miniAppPort: livePort }, db, telegram, createLogger('silent'));
    const request = async (target: number, user: number, input: object, auth = sign(user)) => {
      const response = await fetch(`http://127.0.0.1:${target}/api/birthdays`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `tma ${auth}` },
        body: JSON.stringify(input),
      });
      return { status: response.status, data: await response.json() };
    };
    const save = { action: 'save', month: 2, day: 29 };
    try {
      await preview.listen();
      expect((await request(port, 42, save, 'invalid')).status).toBe(403);
      expect((await request(port, 73, save)).status).toBe(403);
      expect((await request(port, 42, save)).data).toEqual({ birthday: { month: 2, day: 29 } });
      expect((await request(port, 42, { action: 'preview' })).data.message).toContain('Alex (example)');
      expect((await request(port, 42, { action: 'upcoming' })).data.items).toHaveLength(3);
      expect(getChatMember).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();

      await production.listen();
      expect((await request(livePort, 99, save)).status).toBe(403);
      expect((await request(livePort, 42, { action: 'session' })).data).toEqual({ preview: false, birthday: null });
      expect((await request(livePort, 42, { action: 'preview' })).status).toBe(403);
      expect((await request(livePort, 42, { ...save, month: 4, day: 31 })).status).toBe(400);
      expect((await request(livePort, 42, save)).status).toBe(200);
      expect((await request(livePort, 42, { ...save, day: 28 })).data.birthday.day).toBe(28);
      expect((await request(livePort, 73, { ...save, memberId: '42' })).status).toBe(400);
      expect((await request(livePort, 73, { action: 'remove', memberId: '42' })).status).toBe(400);
      expect((await request(livePort, 73, { action: 'remove' })).status).toBe(200);
      expect((await request(livePort, 42, { action: 'session' })).data.birthday.day).toBe(28);
      expect((await request(livePort, 73, { ...save, month: 1, day: 1 })).status).toBe(200);
      const upcoming = await handleBirthdayAction({ action: 'upcoming' }, 42n, live, db, telegram, new Date('2026-12-31T16:00:00Z'));
      expect(upcoming.body).toEqual({ items: [
        { name: 'Fixture 73', month: 1, day: 1, year: 2027 },
        { name: '<Alex & Co>', month: 2, day: 28, year: 2027 },
      ] });
      expect((await request(livePort, 42, { action: 'remove' })).data.birthday).toBeNull();
      expect((await request(port, 42, { action: 'session' })).data.birthday.day).toBe(29);
    } finally {
      await preview.close();
      await production.close();
      await db.birthdayDelivery.deleteMany({ where: { groupId: config.groupId } });
      await db.birthday.deleteMany({ where: { groupId: config.groupId } });
      await db.$disconnect();
    }
  });

  it('deduplicates concurrent workers, retries a rejected send after restart, and preserves uncertain claims', async () => {
    const db = new PrismaClient({ datasourceUrl: testUrl! });
    const { telegram, getChatMember, sendMessage } = fakeTelegram();
    const groupId = -65432n;
    const scheduler = { ...live, groupId };
    const today = () => new Date('2027-02-28T02:30:00Z');
    const after = () => new Date('2027-02-28T02:36:00Z');
    const key = (memberId: bigint) => ({ where: { groupId_memberId_year: { groupId, memberId, year: 2027 } } });
    try {
      await db.birthday.createMany({ data: [
        { groupId, memberId: 42n, preview: false, month: 2, day: 29 },
        { groupId, memberId: 73n, preview: true, month: 2, day: 28 },
        { groupId, memberId: 99n, preview: false, month: 2, day: 28 },
        { groupId, memberId: 84n, preview: false, month: 2, day: 28 },
      ] });
      await db.birthdayDelivery.create({ data: {
        groupId, memberId: 84n, year: 2027, status: 'SENDING', attemptAt: new Date('2027-02-28T02:15:00Z'),
      } });
      await deliverBirthdays(db, telegram, { ...scheduler, accessMode: 'PRELAUNCH' }, today);
      await deliverBirthdays(db, telegram, scheduler, () => new Date('2027-02-28T02:29:59Z'));
      expect(getChatMember).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();

      sendMessage.mockRejectedValueOnce(new TelegramError({ error_code: 429, description: 'rate limited', parameters: { retry_after: 120 } }));
      await Promise.all([deliverBirthdays(db, telegram, scheduler, today), deliverBirthdays(db, telegram, scheduler, today)]);
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(await db.birthdayDelivery.findUnique(key(42n))).toMatchObject({ status: 'QUEUED', attempts: 1 });
      expect(await db.birthdayDelivery.findUnique(key(84n))).toMatchObject({ status: 'UNKNOWN' });
      expect(await db.birthdayDelivery.findUnique(key(73n))).toBeNull();
      await deliverBirthdays(db, telegram, scheduler, today);
      expect(sendMessage).toHaveBeenCalledOnce();

      const restarted = new PrismaClient({ datasourceUrl: testUrl! });
      try {
        await deliverBirthdays(restarted, telegram, scheduler, after);
      } finally {
        await restarted.$disconnect();
      }
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage).toHaveBeenLastCalledWith(String(groupId),
        expect.stringContaining('<a href="tg://user?id=42">&lt;Alex &amp; Co&gt;</a>'), { parse_mode: 'HTML' });
      expect(await db.birthdayDelivery.findUnique(key(42n))).toMatchObject({ status: 'SENT', attempts: 2, telegramMessageId: 123 });

      const owner = { groupId, memberId: 42n, preview: false };
      await db.birthday.deleteMany({ where: owner });
      await db.birthday.create({ data: { ...owner, month: 2, day: 28 } });
      await deliverBirthdays(db, telegram, scheduler, after);
      expect(sendMessage).toHaveBeenCalledTimes(2);
      await deliverBirthdays(db, telegram, scheduler, () => new Date('2027-03-01T03:00:00Z'));
      expect(sendMessage).toHaveBeenCalledTimes(2);
      await deliverBirthdays(db, telegram, scheduler, () => new Date('2028-02-28T02:30:00Z'));
      expect(sendMessage).toHaveBeenCalledTimes(4);
      expect(await db.birthdayDelivery.findUnique(key(42n))).toMatchObject({ status: 'SENT', attempts: 2 });
      expect(await db.birthdayDelivery.count({ where: { groupId, memberId: 42n, status: 'SENT' } })).toBe(2);
    } finally {
      await db.birthdayDelivery.deleteMany({ where: { groupId } });
      await db.birthday.deleteMany({ where: { groupId } });
      await db.$disconnect();
    }
  });
});
