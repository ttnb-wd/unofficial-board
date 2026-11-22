import { randomUUID, randomInt } from 'node:crypto';
import process from 'node:process';
import { URL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { TelegramError } from 'telegraf';
import { describe, expect, it, afterAll } from 'vitest';
import { handleCountdownAction } from './api.js';
import { deliverCountdowns } from './delivery.js';
import { startExamples } from './rules.js';

const databaseUrl = process.env.COUNTDOWN_TEST_DATABASE_URL;
if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname) || !/^\/countdown_[a-z_]*test$/.test(target.pathname)) {
    throw new Error('Countdown integration tests require an isolated local countdown test database.');
  }
}
const db = databaseUrl ? new PrismaClient({ datasourceUrl: databaseUrl }) : null;
const owner = 42n;
const member = 73n;

function harness() {
  const config = { groupId: BigInt(-randomInt(1_000_000, 2_000_000_000)), prelaunchOwnerId: owner, accessMode: 'LIVE' };
  let time = new Date('2030-11-23T00:00:00Z');
  const clock = () => time;
  const request = (action, payload = {}, user = owner) => handleCountdownAction({ action, ...payload }, user, config, db, clock);
  const queue = (title, extra = {}) => request('create', {
    title, date: '2030-11-25', time: '13:30', timeZone: 'Asia/Yangon', requestId: randomUUID(), ...extra,
  });
  const sent = [];
  const telegram = { callApi: async (_method, payload) => {
    sent.push(payload);
    return { message_id: sent.length, date: Math.floor(+time / 1000) };
  } };
  return {
    config, queue, request, sent, telegram,
    at: (iso) => { time = new Date(iso); },
    job: (countdownId, kind) => db.planCountdownDelivery.findUniqueOrThrow({ where: { countdownId_kind: { countdownId, kind } } }),
    run: (client = db, api = telegram) => deliverCountdowns(client, api, config, 'fixture_bot', clock),
  };
}

describe.skipIf(!db)('Plan Countdown with isolated PostgreSQL', () => {
  afterAll(async () => { await db?.$disconnect(); });

  it('pages same-time events, processes all milestones independently, and persists the selected start message across retries and restart', async () => {
    const h = harness();
    const key = randomUUID();
    const disputed = await Promise.all([h.queue('Beach Trip', { requestId: key }), h.queue('Beach Trip', { requestId: key })]);
    expect(disputed.map(({ status }) => status).sort()).toEqual([200, 201]);
    const first = disputed[0].body.plan;
    const second = (await h.queue('Dinner')).body.plan;
    const archive = await Promise.all(Array.from({ length: 7 }, (_, i) => h.queue(`Fixture ${i}`)));
    const page = (await h.request('upcoming', {}, member)).body;
    const next = (await h.request('upcoming', { cursor: { ...page.nextCursor, startsAt: page.nextCursor.startsAt.toISOString() } }, member)).body;
    expect(page.plans).toHaveLength(8);
    expect(next.plans).toHaveLength(1);
    expect(new Set([...page.plans, ...next.plans].map(({ id }) => id)).size).toBe(9);
    expect(page.plans.every((plan) => !plan.owned)).toBe(true);
    for (const { body: { plan } } of archive) await h.request('cancel', { id: plan.id, version: 1 });

    await Promise.all([h.run(), h.run()]);
    expect(h.sent).toHaveLength(2);
    for (const [kind, at] of [
      ['DAY_BEFORE', '2030-11-24T07:00:00Z'],
      ['SIX_HOURS_BEFORE', '2030-11-25T01:00:00Z'],
      ['HOUR_BEFORE', '2030-11-25T06:00:00Z'],
    ]) {
      h.at(at);
      await Promise.all([h.run(), h.run()]);
      for (const plan of [first, second]) {
        const job = await h.job(plan.id, kind);
        expect(job.status).toBe('SENT');
        expect(job.scheduledAt).toEqual(new Date(at));
        expect(job.deliveredAt).toEqual(new Date(at));
        expect(h.sent[job.telegramMessageId - 1].text).toContain(plan.title);
      }
    }
    const start = await h.job(first.id, 'AT_START');
    expect(start.scheduledAt).toEqual(first.startsAt);
    expect(start.startVariant).toBeGreaterThanOrEqual(0);
    expect(start.startVariant).toBeLessThan(5);
    h.at('2030-11-25T06:59:59Z');
    await h.run();
    expect(h.sent).toHaveLength(8);
    h.at('2030-11-25T07:00:00Z');
    let firstAttempt;
    await h.run(db, { callApi: async (method, payload) => {
      if (payload.text.includes(first.title)) {
        firstAttempt = payload.text;
        throw new TelegramError({ error_code: 429, description: 'Fixture rate limit', parameters: { retry_after: 30 } });
      }
      return h.telegram.callApi(method, payload);
    } });
    const retry = await h.job(first.id, 'AT_START');
    expect(retry.status).toBe('QUEUED');
    expect(retry.nextAttemptAt).toEqual(new Date('2030-11-25T07:00:30Z'));
    expect(firstAttempt).toBe(startExamples(first.title)[start.startVariant]);
    const restarted = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      h.at('2030-11-25T07:00:30Z');
      await Promise.all([h.run(restarted), h.run()]);
    } finally {
      await restarted.$disconnect();
    }
    expect(h.sent.filter(({ text }) => text === firstAttempt)).toHaveLength(1);
    expect((await h.job(first.id, 'AT_START')).deliveredAt).toEqual(new Date('2030-11-25T07:00:30Z'));
    const completed = (await h.request('completed', {}, member)).body.plans;
    expect(completed.map(({ id }) => id).sort()).toEqual([first.id, second.id].sort());
  }, 30_000);

  it('serializes edits with a claim, preserves sent and ambiguous history, and suppresses cancelled and missed sends', async () => {
    const h = harness();
    const plan = (await h.queue('Morning hike')).body.plan;
    const edit = { id: plan.id, version: 1, title: plan.title, date: '2030-11-26', time: '13:30', timeZone: 'Asia/Yangon' };
    expect((await h.request('edit', edit, member)).status).toBe(403);
    expect((await h.request('cancel', { id: plan.id, version: 1 }, member)).status).toBe(403);
    await h.run();

    h.at('2030-11-24T07:00:00Z');
    let release;
    let claimed;
    const gate = new Promise((resolve) => { release = resolve; });
    const claim = new Promise((resolve) => { claimed = resolve; });
    const pass = h.run(db, { callApi: async (...args) => {
      claimed();
      await gate;
      return h.telegram.callApi(...args);
    } });
    await claim;
    const pendingEdit = h.request('edit', edit);
    try {
      expect((await h.job(plan.id, 'DAY_BEFORE')).status).toBe('SENDING');
    } finally {
      release();
    }
    await pass;
    expect((await pendingEdit).status).toBe(200);
    expect((await h.job(plan.id, 'DAY_BEFORE')).status).toBe('SENT');
    expect((await h.job(plan.id, 'SIX_HOURS_BEFORE')).scheduledAt).toEqual(new Date('2030-11-26T01:00:00Z'));
    expect((await h.job(plan.id, 'AT_START')).scheduledAt).toEqual(new Date('2030-11-26T07:00:00Z'));

    const near = (await h.queue('Quick coffee', { date: '2030-11-24', time: '14:00' })).body.plan;
    expect((await h.job(near.id, 'HOUR_BEFORE')).status).toBe('MISSED');
    await h.request('cancel', { id: plan.id, version: 2 });
    expect((await h.job(plan.id, 'AT_START')).status).toBe('SKIPPED');
    const ambiguous = (await h.queue('Park walk')).body.plan;
    await db.planCountdownDelivery.update({
      where: { countdownId_kind: { countdownId: ambiguous.id, kind: 'ANNOUNCEMENT' } },
      data: { status: 'SENDING', attemptAt: new Date('2030-11-24T06:00:00Z') },
    });
    h.at('2030-11-26T07:11:00Z');
    await h.run();
    expect((await h.job(near.id, 'AT_START')).status).toBe('MISSED');
    expect((await h.job(ambiguous.id, 'ANNOUNCEMENT')).status).toBe('UNKNOWN');
    expect(h.sent).toHaveLength(2);
    expect((await h.request('mine')).body.plans.find(({ id }) => id === plan.id).cancelledAt).toBeTruthy();
  }, 30_000);
});
