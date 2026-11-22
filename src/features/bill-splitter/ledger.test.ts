import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { TelegramError } from 'telegraf';
import type { Telegram } from 'telegraf';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createMiniAppServer } from '../../mini-app/server.js';
import { handleBillAction } from './api.js';
import { deliverBills, retryAnnouncement } from './delivery.js';
import { createBill, getBill, getProof, ledger, normalizeProof, payLater, reviewPayment, roster, submitPayment } from './ledger.js';
import { announcement, calculateShares, createBillInput } from './rules.js';

const config: AppConfig = {
  accessMode: 'PRELAUNCH', botToken: '123:test', groupId: -123n, prelaunchOwnerId: 42n,
  databaseUrl: 'postgresql://postgres@127.0.0.1:55438/postgres', logLevel: 'silent',
};
const billInput = (extra: Record<string, unknown> = {}) => createBillInput.parse({
  requestId: randomUUID(), title: 'Dinner & rides', total: '10001', receiverId: '42', method: 'EQUAL',
  participants: [{ memberId: '84' }, { memberId: '42' }, { memberId: '73' }], ...extra,
});

it('assigns integer remainder in stable ID order and marks the receiver share covered', () => {
  expect(calculateShares(billInput()).map(({ memberId, amount, status }) => [memberId, amount, status])).toEqual([
    [42n, 3334n, 'PAID'], [73n, 3334n, 'UNPAID'], [84n, 3333n, 'UNPAID'],
  ]);
  const outside = calculateShares(billInput({ receiverId: '55' }));
  expect(outside.every(({ status }) => status === 'UNPAID')).toBe(true);
  expect(calculateShares(billInput({ total: '1' })).map(({ amount }) => amount)).toEqual([1n, 0n, 0n]);
});

it('validates custom sums, duplicates, and integer bounds', () => {
  const custom = { method: 'CUSTOM', participants: [{ memberId: '84', share: '10000' }, { memberId: '42', share: '1' }] };
  expect(calculateShares(billInput(custom)).map(({ amount }) => amount)).toEqual([1n, 10000n]);
  expect(() => calculateShares(billInput({ ...custom, total: '10000' }))).toThrow('add up');
  expect(() => calculateShares(billInput({ participants: [{ memberId: '84' }, { memberId: '84' }] }))).toThrow('only once');
  expect(() => billInput({ total: '-1' })).toThrow();
  expect(() => billInput({ total: '1.75' })).toThrow();
});

it('targets only participants in the group announcement and escapes markup', () => {
  const text = announcement({
    title: '<Dinner>', totalMmk: 5000n, receiverName: 'Receiver & Co',
    shares: [{ memberId: 84n, memberName: '<Debtor>', amountMmk: 5000n, status: 'UNPAID' }],
  });
  expect(text.match(/tg:\/\/user\?id=[0-9]+/g)).toEqual(['tg://user?id=84']);
  expect(text).toContain('&lt;Debtor&gt;');
  expect(text).toContain('Receiver &amp; Co');
  expect(text).not.toContain('@all');
});

it('keeps PRELAUNCH fixtures owner-only with no database or delivery calls', async () => {
  const db = {} as PrismaClient;
  const telegram = { sendMessage: vi.fn(), getChatMember: vi.fn() };
  const bot = telegram as unknown as Telegram;
  const kick = vi.fn();
  await expect(handleBillAction({ action: 'session' }, 42n, config, db, bot, kick)).resolves.toMatchObject({ preview: true });
  await expect(handleBillAction({ action: 'session' }, 84n, config, db, bot, kick)).rejects.toMatchObject({ status: 403 });
  await expect(handleBillAction({ action: 'cash', share: 'sample1', requestId: randomUUID() }, 42n, config, db, bot, kick)).rejects.toMatchObject({ status: 403 });
  await expect(deliverBills(db, bot, config, 'fixture_bot')).resolves.toBeUndefined();
  expect(kick).not.toHaveBeenCalled();
  expect(telegram.sendMessage).not.toHaveBeenCalled();
  expect(telegram.getChatMember).not.toHaveBeenCalled();
});

async function screenshot() {
  return sharp({ create: { width: 120, height: 80, channels: 3, background: '#fff' } }).png().toBuffer();
}

it('rejects forged or oversized images and normalizes an actual PNG', async () => {
  await expect(normalizeProof(Buffer.from('not a PNG').toString('base64'))).rejects.toMatchObject({ status: 400 });
  await expect(normalizeProof(Buffer.alloc(1_500_001).toString('base64'))).rejects.toMatchObject({ status: 400 });
  const image = await normalizeProof((await screenshot()).toString('base64'));
  expect((await sharp(image).metadata()).format).toBe('jpeg');
});

const dbUrl = process.env.BILL_TEST_DATABASE_URL;
if (dbUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(dbUrl).hostname)) {
  throw new Error('Bill integration tests require isolated loopback PostgreSQL.');
}

function signedInitData(userId: number) {
  const fields = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId }) });
  const data = [...fields].map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  fields.set('hash', createHmac('sha256', secret).update(data).digest('hex'));
  return fields.toString();
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

describe.skipIf(!dbUrl)('isolated PostgreSQL bill flow', () => {
  it('protects proofs and handles concurrent creates, reviews, balances, and delivery recovery', async () => {
    const db = new PrismaClient({ datasourceUrl: dbUrl! });
    const groupId = -BigInt(Date.now());
    const live = { ...config, groupId, accessMode: 'LIVE' as const, miniAppPort: await localPort() };
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 123 });
    const getChatMember = vi.fn(async (_group: string, id: number) => ({
      status: id === 99 ? 'left' : 'member', user: { id, first_name: `Fixture ${id}`, is_bot: false },
    }));
    const telegram = { getChatMember, sendMessage } as unknown as Telegram;
    const api = createMiniAppServer(live, db, telegram, createLogger('silent'));
    try {
      await db.telegramGroup.create({ data: { telegramId: groupId } });
      for (const id of [42n, 73n, 84n, 99n]) {
        await db.member.upsert({ where: { telegramId: id }, create: { telegramId: id }, update: {} });
        await db.groupMembership.create({ data: { groupId, memberId: id, status: 'MEMBER' } });
      }
      expect((await roster(db, telegram, groupId)).map(({ id }) => id)).toEqual(['42', '73', '84']);
      await expect(createBill(db, telegram, groupId, 42n, billInput({ receiverId: '99' }))).rejects.toMatchObject({ status: 400 });
      await expect(createBill(db, telegram, groupId, 42n, billInput({ receiverId: '55' }))).rejects.toMatchObject({ status: 400 });

      const draft = billInput({ receiverId: '73' });
      const [one, two] = await Promise.all([createBill(db, telegram, groupId, 42n, draft), createBill(db, telegram, groupId, 42n, draft)]);
      expect(one.id).toBe(two.id);
      expect([one.created, two.created].filter(Boolean)).toHaveLength(1);
      await expect(createBill(db, telegram, groupId, 84n, draft)).rejects.toMatchObject({ status: 409 });
      const detail = await getBill(db, groupId, 84n, one.id);
      const share = detail.shares.find((item) => item.role === 'debtor')!;
      const ownShare = detail.shares.find((item) => item.debtorId === '73')!;
      expect(ownShare.outstanding).toBe('0');
      expect(detail.shares.reduce((total, item) => total + BigInt(item.amount), 0n)).toBe(10001n);
      await expect(payLater(db, groupId, 42n, share.id)).rejects.toMatchObject({ status: 404 });
      await payLater(db, groupId, 84n, share.id);

      const payload = { requestId: randomUUID(), method: 'TRANSFER' as const, image: (await screenshot()).toString('base64') };
      const payment = await submitPayment(db, groupId, 84n, share.id, payload);
      expect(await submitPayment(db, groupId, 84n, share.id, payload)).toEqual(payment);
      await expect(getProof(db, groupId, 42n, payment.id)).rejects.toMatchObject({ status: 404 });
      await expect(getProof(db, groupId - 1n, 84n, payment.id)).rejects.toMatchObject({ status: 404 });
      expect((await getProof(db, groupId, 84n, payment.id)).byteLength).toBeGreaterThan(0);
      expect((await getBill(db, groupId, 42n, one.id)).shares.find((item) => item.id === share.id)?.payments).toEqual([]);
      expect((await ledger(db, groupId, 84n, 'debts')).items[0]?.outstanding).toBe(share.amount);

      await api.listen();
      const apiCall = (actor: number, data: unknown, invalid = false) => fetch(`http://127.0.0.1:${live.miniAppPort}/api/bills`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `tma ${invalid ? 'invalid' : signedInitData(actor)}` },
        body: JSON.stringify(data),
      });
      const proofAction = { action: 'proof', payment: payment.id };
      expect((await apiCall(84, proofAction, true)).status).toBe(403);
      expect((await apiCall(42, proofAction)).status).toBe(404);
      expect((await apiCall(99, proofAction)).status).toBe(403);
      const proof = await apiCall(73, proofAction);
      expect(proof.status).toBe(200);
      expect(proof.headers.get('content-type')).toBe('image/jpeg');
      expect(proof.headers.get('cache-control')).toBe('no-store');

      await expect(reviewPayment(db, groupId, 84n, share.id, payment.id, 'CONFIRMED')).rejects.toMatchObject({ status: 404 });
      await reviewPayment(db, groupId, 73n, share.id, payment.id, 'REJECTED');
      expect((await ledger(db, groupId, 84n, 'debts')).items[0]?.status).toBe('PAY_LATER');
      const cash = await submitPayment(db, groupId, 84n, share.id, { method: 'CASH', requestId: randomUUID() });
      await Promise.all([
        reviewPayment(db, groupId, 73n, share.id, cash.id, 'CONFIRMED'),
        reviewPayment(db, groupId, 73n, share.id, cash.id, 'CONFIRMED'),
      ]);
      await expect(reviewPayment(db, groupId, 73n, share.id, cash.id, 'REJECTED')).rejects.toMatchObject({ status: 409 });
      expect((await ledger(db, groupId, 84n, 'debts')).items).toEqual([]);
      expect((await ledger(db, groupId, 42n, 'settled')).items).toMatchObject([{ id: share.id, outstanding: '0', status: 'PAID' }]);
      expect((await ledger(db, groupId, 73n, 'received')).items).toHaveLength(1);
      const secondShare = detail.shares.find((item) => item.debtorId === '42')!;
      await submitPayment(db, groupId, 73n, secondShare.id, { method: 'CASH', requestId: randomUUID() }, true);
      expect((await ledger(db, groupId, 42n, 'all')).items).toHaveLength(2);
      expect((await ledger(db, groupId, 73n, 'received')).items).toEqual([]);

      sendMessage.mockImplementation(async (chat: string) => {
        if (chat === String(groupId)) throw new TelegramError({ error_code: 400, description: 'Fixture rejected' });
        throw new TelegramError({ error_code: 403, description: 'Fixture never started the bot' });
      });
      await deliverBills(db, telegram, live, 'fixture_bot');
      expect(await db.billDelivery.findUnique({ where: { billId: one.id } })).toMatchObject({ status: 'FAILED' });
      expect(sendMessage.mock.calls.filter(([chat]) => chat !== String(groupId)).every(([chat]) => chat === '73')).toBe(true);
      await expect(retryAnnouncement(db, groupId, 84n, one.id)).rejects.toMatchObject({ status: 409 });
      await retryAnnouncement(db, groupId, 42n, one.id);
      sendMessage.mockResolvedValue({ message_id: 800 });
      sendMessage.mockClear();
      await Promise.all([deliverBills(db, telegram, live, 'fixture_bot'), deliverBills(db, telegram, live, 'fixture_bot')]);
      await deliverBills(db, telegram, live, 'fixture_bot');
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(await db.billDelivery.findUnique({ where: { billId: one.id } })).toMatchObject({ status: 'SENT', telegramMessageId: 800 });

      const ambiguous = await createBill(db, telegram, groupId, 42n, billInput());
      await db.billDelivery.update({ where: { billId: ambiguous.id }, data: { status: 'SENDING', attemptAt: new Date(0) } });
      sendMessage.mockClear();
      await deliverBills(db, telegram, live, 'fixture_bot');
      expect(sendMessage).not.toHaveBeenCalled();
      expect(await db.billDelivery.findUnique({ where: { billId: ambiguous.id } })).toMatchObject({ status: 'UNKNOWN' });
      await expect(retryAnnouncement(db, groupId, 42n, ambiguous.id)).rejects.toMatchObject({ status: 409 });
    } finally {
      await api.close();
      await db.$disconnect();
    }
  }, 30_000);
});

