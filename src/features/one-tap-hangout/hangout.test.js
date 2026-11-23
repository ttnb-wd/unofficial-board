import { randomInt, randomUUID } from 'node:crypto';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { Telegram, TelegramError } from 'telegraf';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../../bot/create-bot.js';
import { createLogger } from '../../logger.js';
import { handleHangoutAction } from './api.js';
import { deliverHangouts } from './delivery.js';
import { respondToHangout } from './store.js';
import { displayName, eventTime, fields } from './rules.js';

const url = process.env.HANGOUT_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.pathname !== '/hangout_test') {
    throw new Error('The Hangout tests require the isolated loopback database hangout_test.');
  }
}
const db = url ? new PrismaClient({ datasourceUrl: url }) : null;
const owner = 42n;
const member = 73n;
const other = 74n;

describe('Hangout validation', () => {
  it('normalizes signed display names and validates Yangon event input', () => {
    expect(displayName({ first_name: 'Ava\u202e', last_name: '  Lin  ' })).toBe('Ava Lin');
    expect(displayName({ first_name: 42 })).toBe('Group member');
    expect(fields.safeParse({ title: ' ', date: '', time: '', timeZone: 'Asia/Yangon' }).success).toBe(false);
    expect(fields.safeParse({ title: 'Plan', date: '', time: '', timeZone: 'UTC' }).success).toBe(false);
    const values = fields.parse({ title: '  Pizza Night ', date: '2030-11-25', time: '19:30', timeZone: 'Asia/Yangon' });
    expect(values.title).toBe('Pizza Night');
    expect(eventTime(values, new Date('2030-11-25T12:00:00Z')).toISOString()).toBe('2030-11-25T13:00:00.000Z');
    expect(eventTime(values, new Date('2030-11-25T13:00:00Z'))).toBeNull();
    expect(eventTime({ ...values, date: '2030-02-30' }, new Date('2029-11-25'))).toBeNull();
  });
});

async function harness() {
  const groupId = BigInt(-randomInt(1_000_000, 2_000_000_000));
  const config = { groupId, prelaunchOwnerId: owner, botToken: '111:test-only', accessMode: 'LIVE', miniAppUrl: 'https://mini.example' };
  let now = new Date('2030-11-23T00:00:00Z');
  const clock = () => now;
  await db.telegramGroup.create({ data: { telegramId: groupId } });
  for (const id of [owner, member, other]) {
    await db.member.upsert({ where: { telegramId: id }, create: { telegramId: id }, update: {} });
    await db.groupMembership.create({ data: { groupId, memberId: id, status: 'MEMBER' } });
  }
  const requests = (id, name, receivedAt = now) => ({ id, name, receivedAt });
  const request = (action, data, actor = requests(owner, 'Creator')) => handleHangoutAction({ action, ...data }, actor, config, db, clock);
  const fields = { date: '2030-11-25', time: '19:30', timeZone: 'Asia/Yangon', title: 'Pizza Night', place: 'Pizza Place', description: 'Big table' };
  const create = (data = {}) => request('create', { ...fields, requestId: randomUUID(), ...data });
  let nextMessage = 0;
  const calls = [];
  const telegram = { callApi: async (method, payload) => {
    calls.push({ method, ...payload });
    return { message_id: ++nextMessage, date: Math.floor(+now / 1000) };
  } };
  return {
    config, request, create, fields, requests, calls, telegram,
    tick: (ms = 1000) => { now = new Date(+now + ms); },
    at: (iso) => { now = new Date(iso); },
    run: (api = telegram, client = db) => deliverHangouts(client, api, config, 'fixture_bot', clock),
    invite: (id) => db.hangoutInvitation.findUniqueOrThrow({ where: { hangoutId: id } }),
    respond: (id, actor, choice, callback) => respondToHangout(db, config, id, actor, choice, callback, clock),
  };
}

describe.skipIf(!db)('One Tap Hangout with isolated PostgreSQL', () => {
  afterAll(async () => { await db?.$disconnect(); });
  afterEach(() => vi.restoreAllMocks());

  it('publishes simultaneous hangouts once and updates the original invitation after concurrent RSVPs, edits and cancellation', async () => {
    const h = await harness();
    const requestId = randomUUID();
    expect((await h.create({ date: '2029-11-25' })).status).toBe(400);
    const created = await Promise.all([h.create({ requestId }), h.create({ requestId })]);
    expect(created.map(({ status }) => status).sort()).toEqual([200, 201]);
    const first = created[0].body.hangout;
    const second = (await h.create({ title: 'Arcade' })).body.hangout;
    expect(first.id).not.toBe(second.id);
    expect(first.startsAt).toEqual(second.startsAt);
    const others = await Promise.all(Array.from({ length: 7 }, (_, i) => h.create({ title: `Demo ${i}` })));
    const page = (await h.request('active', {}, h.requests(member, 'Member'))).body;
    expect(page.hangouts).toHaveLength(8);
    const next = (await h.request('active', { cursor: { ...page.nextCursor, startsAt: page.nextCursor.startsAt.toISOString() } })).body;
    expect(next.hangouts).toHaveLength(1);
    expect(new Set([...page.hangouts, ...next.hangouts].map(({ id }) => id)).size).toBe(9);
    for (const { body: { hangout } } of others) await h.request('cancel', { id: hangout.id, version: 1 });

    await Promise.all([h.run(), h.run()]);
    expect(h.calls.filter(({ method }) => method === 'sendMessage')).toHaveLength(2);
    const original = await h.invite(first.id);
    const invite = h.calls.find(({ text }) => text.includes('Pizza Night'));
    expect(invite.chat_id).toBe(String(h.config.groupId));
    expect(invite.text).toContain('Pizza Place');
    expect(invite.text).toContain('Going: 0');
    for (const entry of invite.reply_markup.inline_keyboard[0]) expect(Buffer.byteLength(entry.callback_data)).toBeLessThanOrEqual(64);
    expect(invite.reply_markup.inline_keyboard[1][0].url).toContain(`start=hangout_${first.id}`);

    const old = h.requests(member, 'Old name');
    h.tick();
    const latest = h.requests(member, 'New name');
    await Promise.all([
      h.respond(first.id, latest, 'MAYBE', { messageId: original.messageId, updateId: 110n }),
      h.respond(first.id, old, 'GOING', { messageId: original.messageId, updateId: 109n }),
      h.respond(first.id, h.requests(other, 'Guest'), 'CANT'),
      h.respond(first.id, h.requests(owner, 'Creator'), 'GOING'),
    ]);
    expect((await h.respond(first.id, latest, 'CANT', { messageId: 9999, updateId: 111n })).status).toBe(404);
    const detail = (await h.request('detail', { id: first.id }, latest)).body.hangout;
    expect(detail.counts).toEqual({ GOING: 1, MAYBE: 1, CANT: 1 });
    expect(detail.myRsvp).toBe('MAYBE');
    expect(detail.participants).toContainEqual({ response: 'MAYBE', displayName: 'New name' });
    expect((await h.request('detail', { id: second.id })).body.hangout.counts).toEqual({ GOING: 0, MAYBE: 0, CANT: 0 });
    expect(await db.hangoutResponse.count({ where: { hangoutId: first.id } })).toBe(3);
    await Promise.all([h.run(), h.run()]);
    expect(h.calls.filter(({ method }) => method === 'editMessageText')).toHaveLength(1);
    expect(h.calls.at(-1)).toMatchObject({ method: 'editMessageText', message_id: original.messageId });
    expect(h.calls.at(-1).text).toContain('Maybe: 1');

    const edit = { ...h.fields, id: first.id, version: 1, title: 'Pizza at the park', place: 'Park' };
    expect((await h.request('edit', edit, latest)).status).toBe(403);
    expect((await h.request('cancel', { id: first.id, version: 1 }, latest)).status).toBe(403);
    expect((await h.request('edit', edit)).status).toBe(200);
    expect((await h.request('edit', edit)).status).toBe(409);
    await h.run();
    expect(h.calls.at(-1).text).toContain('Pizza at the park');
    expect(h.calls.at(-1).text).toContain('Maybe: 1');
    const cancelled = (await h.request('cancel', { id: first.id, version: 2 })).body.hangout;
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.participants).toHaveLength(3);
    expect((await h.respond(first.id, latest, 'GOING')).status).toBe(409);
    await h.run();
    expect(h.calls.at(-1).text).toContain('Cancelled');
    expect(h.calls.at(-1).reply_markup.inline_keyboard).toHaveLength(1);
    expect(h.calls.at(-1).message_id).toBe(original.messageId);
    h.at('2030-11-25T13:00:00Z');
    expect((await h.respond(second.id, latest, 'GOING')).status).toBe(409);
    await h.run();
    expect(h.calls.at(-1).text).toContain('RSVP closed');
    expect((await h.request('completed', {})).body.hangouts.map(({ id }) => id)).toEqual([second.id]);
  }, 30_000);

  it('authenticates real callback structure and membership with a stub Telegram client', async () => {
    const h = await harness();
    const event = (await h.create()).body.hangout;
    await h.run();
    const invitation = await h.invite(event.id);
    const wake = vi.fn();
    const bot = createBot(h.config, db, 'fixture_bot', createLogger('silent'), wake);
    bot.botInfo = { id: 111, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' };
    const telegram = vi.spyOn(Telegram.prototype, 'callApi').mockImplementation(async (method, payload) => {
      if (method === 'getChatMember') return { status: payload.user_id === 99 ? 'left' : 'member' };
      if (method === 'answerCallbackQuery') return true;
      if (method === 'sendMessage') return { message_id: 1 };
      throw new Error(`Unexpected Telegram method ${method}`);
    });
    const update = (user, group, id, data = `ho:g:${event.id}`) => ({
      update_id: id,
      callback_query: {
        id: String(id), data, chat_instance: 'fixture',
        from: { id: user, is_bot: false, first_name: 'Fixture', last_name: 'Guest' },
        message: { message_id: invitation.messageId, date: 1, chat: { id: Number(group), type: 'supergroup', title: 'Fixture group' }, text: 'Invitation' },
      },
    });
    await bot.handleUpdate(update(73, h.config.groupId - 1n, 10));
    await bot.handleUpdate(update(99, h.config.groupId, 11));
    await bot.handleUpdate(update(73, h.config.groupId, 12));
    await bot.handleUpdate(update(73, h.config.groupId, 13, `ho:m:${event.id}`));
    await bot.handleUpdate(update(73, h.config.groupId, 12));
    const rows = await db.hangoutResponse.findMany({ where: { hangoutId: event.id } });
    expect(rows.map(({ memberId, response, displayName }) => ({ memberId, response, displayName }))).toEqual([
      { memberId: 73n, response: 'MAYBE', displayName: 'Fixture Guest' },
    ]);
    expect(wake).toHaveBeenCalledTimes(3);
    expect(telegram.mock.calls.filter(([method]) => method === 'getChatMember')).toHaveLength(4);
    expect(telegram.mock.calls.some(([method]) => method === 'sendMessage')).toBe(false);
  }, 30_000);

  it('retries rate limits, reconciles edits, and holds ambiguous sends without duplicating invitations', async () => {
    const h = await harness();
    const a = (await h.create({ title: 'Rate-limited' })).body.hangout;
    const b = (await h.create({ title: 'Ambiguous' })).body.hangout;
    await h.run({ callApi: async (_method, data) => {
      if (data.text.includes('Rate-limited')) throw new TelegramError({ error_code: 429, description: 'retry', parameters: { retry_after: 30 } });
      throw new Error('Transport outcome unknown');
    } });
    expect((await h.invite(a.id)).status).toBe('QUEUED');
    expect((await h.invite(b.id)).status).toBe('UNKNOWN');
    await h.run();
    expect(h.calls).toHaveLength(0);
    h.tick(30_000);
    const restarted = new PrismaClient({ datasourceUrl: url });
    try { await h.run(h.telegram, restarted); } finally { await restarted.$disconnect(); }
    expect(h.calls).toHaveLength(1);
    await h.respond(a.id, h.requests(member, 'Guest'), 'MAYBE');
    await h.run({ callApi: async () => { throw new Error('Transient edit timeout'); } });
    await h.respond(a.id, h.requests(member, 'Guest'), 'GOING');
    const retry = await h.invite(a.id);
    expect(retry.syncAttempts).toBe(1);
    h.tick(30_000);
    await h.run();
    expect(h.calls.at(-1).text).toContain('Going: 1');
    h.tick();
    await h.respond(a.id, h.requests(member, 'Guest'), 'CANT');
    await h.run({ callApi: async () => { throw new TelegramError({ error_code: 400, description: 'message to edit not found' }); } });
    expect((await h.invite(a.id)).unavailableAt).toBeTruthy();
    await h.run();
    expect(h.calls.filter(({ method }) => method === 'sendMessage')).toHaveLength(1);
  }, 30_000);
});
