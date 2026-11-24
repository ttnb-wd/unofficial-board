import { createHash } from 'node:crypto';
import { Markup } from 'telegraf';
import type { Context, Telegraf } from 'telegraf';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config.js';
import { allowsGroupWorkflows } from '../access/policy.js';
import { navigationRow, showScreen } from './navigation.js';
import { handleBirthdayAction } from '../features/birthday-reminder/api.js';
import { handleCountdownAction } from '../features/plan-countdown/api.js';
import { handleHangoutAction } from '../features/one-tap-hangout/api.js';
import { choices, displayName, labels } from '../features/one-tap-hangout/rules.js';
import { yangon } from '../mini-app/yangon.js';

export type PrivateAccess = (ctx: Context) => Promise<boolean>;
export const button = Markup.button.callback;

export async function privateFeature(ctx: Context, authorize: PrivateAccess) {
  if (ctx.chat?.type === 'private' && ctx.from && await authorize(ctx)) return BigInt(ctx.from.id);
  // Group commands stay silent.
  if (ctx.chat?.type === 'private' && ctx.callbackQuery) {
    await ctx.answerCbQuery('Current group membership is required.', { show_alert: true });
  }
  return null;
}

export function requestFor(ctx: Context) {
  // Telegram redelivery of the same command must resolve to the same record.
  const hash = createHash('sha256').update(String(ctx.chat?.id) + '/' + String(ctx.message?.message_id ?? ctx.update.update_id))
    .digest('hex');
  return [hash.slice(0, 8), hash.slice(8, 12), '4' + hash.slice(13, 16), '8' + hash.slice(17, 20), hash.slice(20, 32)].join('-');
}

export function privateScreen(ctx: Context, text: string, rows: ReturnType<typeof button>[][], back = 'nav:home') {
  return showScreen(ctx, text, Markup.inlineKeyboard([...rows, navigationRow(back)]));
}

const date = new Intl.DateTimeFormat('en-GB', { timeZone: yangon, dateStyle: 'medium', timeStyle: 'short', hour12: true });
const shortDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium' });
const shortTitle = (text: string) => [...text].slice(0, 48).join('');

export function registerSharedEventChat(
  bot: Telegraf, config: AppConfig, db: PrismaClient, authorize: PrivateAccess, wake: () => void,
) {
  bot.action('native:menu', async (ctx) => {
    if (await privateFeature(ctx, authorize) === null || !allowsGroupWorkflows(config)) return;
    await ctx.answerCbQuery();
    await privateScreen(ctx, 'Manage in chat', [
      [button('My polls', 'vote:poll:mine'), button('My budget votes', 'vote:bv:mine')],
      [button('Bill Splitter', 'native:bill'), button('Birthday Reminder', 'eb:own')],
      [button('Plan Countdown', 'ec:active'), button('One Tap Hangout', 'eh:active')],
    ]);
  });

  async function birthday(ctx: Context, id: bigint, input: unknown = { action: 'session' }, notice = '') {
    const result = await handleBirthdayAction(input, id, config, db, ctx.telegram);
    if ('error' in result.body && result.body.error) {
      await ctx.reply(result.body.error);
      return;
    }
    const prefix = notice ? notice + '\n\n' : '';
    if ('items' in result.body && result.body.items) {
      const items = result.body.items.slice(0, 30).map(({ name, year, month, day }) =>
        name + ' · ' + shortDate.format(new Date(Date.UTC(year, month - 1, day))));
      await privateScreen(ctx, ['Upcoming birthdays · Yangon', ...items].join('\n') + (items.length ? '' : '\nNo upcoming birthdays.'),
        [[button('Refresh', 'eb:up')]], 'eb:own');
      return;
    }
    const saved = 'birthday' in result.body ? result.body.birthday : null;
    await privateScreen(ctx, prefix + 'Birthday Reminder\n' +
      (saved ? 'Your birthday: ' + saved.month + '/' + saved.day : 'No birthday saved.') +
      '\n\nAdd or edit with /birthday MM-DD', [
      [button('Upcoming birthdays', 'eb:up'), button('Refresh', 'eb:own')],
      ...(saved ? [[button('Remove my birthday', 'eb:ask')]] : []),
    ]);
  }

  bot.command('birthday', async (ctx) => {
    const id = await privateFeature(ctx, authorize);
    if (id === null) return;
    if (!ctx.payload.trim()) return birthday(ctx, id);
    const match = /^(\d{1,2})-(\d{1,2})$/.exec(ctx.payload.trim());
    if (!match) { await ctx.reply('Use /birthday MM-DD. Example: /birthday 04-15'); return; }
    await birthday(ctx, id, { action: 'save', month: Number(match[1]), day: Number(match[2]) }, 'Birthday saved.');
  });

  bot.action(/^eb:(own|up|ask|remove)$/, async (ctx) => {
    const id = await privateFeature(ctx, authorize);
    if (id === null) return;
    await ctx.answerCbQuery();
    switch (ctx.match[1]) {
      case 'ask': await privateScreen(ctx, 'Remove your birthday from the group reminder list?',
        [[button('Remove birthday', 'eb:remove')]], 'eb:own'); return;
      case 'up': await birthday(ctx, id, { action: 'upcoming' }); return;
      case 'remove': await birthday(ctx, id, { action: 'remove' }, 'Birthday removed.'); return;
      default: await birthday(ctx, id);
    }
  });

  type Kind = 'ec' | 'eh';
  const info = {
    ec: { title: 'Plan Countdown', command: 'countdowns', create: 'countdowncreate', edit: 'countdownedit', active: 'upcoming' },
    eh: { title: 'One Tap Hangout', command: 'hangouts', create: 'hangoutcreate', edit: 'hangoutedit', active: 'active' },
  } as const;

  function call(ctx: Context, kind: Kind, actor: bigint, input: unknown, receivedAt = new Date()) {
    return kind === 'ec' ? handleCountdownAction(input, actor, config, db)
      : handleHangoutAction(input, { id: actor, name: displayName(ctx.from ?? {}), receivedAt }, config, db);
  }

  function eventParams(payload: string, kind: Kind) {
    const [title, when, third, fourth, ...extra] = payload.split('|').map((part) => part.trim());
    const match = /^(\d{4}-\d\d-\d\d) (1[0-2]|0?[1-9]):([0-5]\d)\s*(AM|PM)$/i.exec(when ?? '');
    if (!title || !match || extra.length || (kind === 'ec' && fourth !== undefined)) return null;
    const hour = Number(match[2]) % 12 + (match[4]!.toUpperCase() === 'PM' ? 12 : 0);
    return { title, date: match[1], time: String(hour).padStart(2, '0') + ':' + match[3], timeZone: yangon,
      description: (kind === 'ec' ? third : fourth) ?? '', ...(kind === 'eh' ? { place: third ?? '' } : {}) };
  }

  const usage = (kind: Kind, command: string) => '/' + command + ' Title | YYYY-MM-DD 7:30 PM | ' +
    (kind === 'ec' ? 'optional description' : 'optional place | optional description') + '\nTime is Asia/Yangon.';

  async function read(ctx: Context, kind: Kind, actor: bigint, action: 'active' | 'mine' | 'completed', after?: string) {
    const view = action === 'active' ? info[kind].active : action;
    let cursor;
    if (after) {
      const row = kind === 'ec'
        ? await db.planCountdown.findFirst({ where: { id: after, groupId: config.groupId }, select: { startsAt: true } })
        : await db.hangout.findFirst({ where: { id: after, groupId: config.groupId }, select: { startsAt: true } });
      if (row?.startsAt) cursor = { id: after, startsAt: row.startsAt.toISOString() };
    }
    const { body } = await call(ctx, kind, actor, { action: view, cursor });
    if ('error' in body && body.error) { await ctx.reply(body.error); return; }
    const events = ('plans' in body ? body.plans : 'hangouts' in body ? body.hangouts : []) ?? [];
    const next = 'nextCursor' in body ? body.nextCursor : null;
    await privateScreen(ctx, info[kind].title + ' · ' + (action === 'active' ? 'Upcoming' : action === 'mine' ? 'My events' : 'Completed') +
      (events.length ? '' : '\nNo records here.') + '\n\nCreate using /' + info[kind].create + '.',
    [
      [button('Upcoming', kind + ':active'), button('Mine', kind + ':mine'), button('Completed', kind + ':completed')],
      ...events.map((event) => [button(shortTitle(event.title) + ('cancelledAt' in event && event.cancelledAt ||
        'status' in event && event.status === 'CANCELLED' ? ' · Cancelled' : ''), kind + ':view:' + event.id)]),
      [button('Create in chat', kind + ':create'), button('Refresh', kind + ':' + action + (after ? ':' + after : ''))],
      ...(next ? [[button('Next', kind + ':' + action + ':' + next.id)]] : []),
    ]);
  }

  async function detail(ctx: Context, kind: Kind, actor: bigint, id: string, notice = '') {
    const { body } = await call(ctx, kind, actor, { action: 'detail', id });
    if ('error' in body && body.error) { await ctx.reply(body.error); return; }
    const record = 'plan' in body ? body.plan : 'hangout' in body ? body.hangout : undefined;
    if (!record) return;
    const active = 'status' in record ? record.status === 'OPEN' : !record.cancelledAt && +record.startsAt > Date.now();
    const rows: ReturnType<typeof button>[][] = [[button('Refresh', kind + ':view:' + id)]];
    const delivery = kind === 'ec' ? (await db.planCountdownDelivery.findFirst({
      where: { countdownId: id, kind: 'ANNOUNCEMENT', countdown: { groupId: config.groupId } }, select: { status: true },
    }))?.status : (await db.hangoutInvitation.findFirst({
      where: { hangoutId: id, hangout: { groupId: config.groupId } }, select: { status: true },
    }))?.status;
    const lines = [notice, record.title, record.startsAt ? date.format(record.startsAt) + ' · Yangon' : '',
      'place' in record ? record.place : '', record.description, active ? 'Open' :
        ('status' in record ? record.status === 'CANCELLED' : record.cancelledAt) ? 'Cancelled' : 'Completed',
      delivery ? 'Group announcement: ' + (delivery === 'UNKNOWN' ? 'delivery unconfirmed' : delivery.toLowerCase()) : ''];
    if ('counts' in record) {
      lines.push(...Object.entries(record.counts).map(([key, count]) => labels[key as keyof typeof labels] + ': ' + count));
      if (record.myRsvp) lines.push('Your RSVP: ' + labels[record.myRsvp]);
      if (active) rows.unshift(Object.entries(choices).map(([key, value]) => button(labels[value], kind + ':r' + key + ':' + id)));
      lines.push(...(record.participants ?? []).slice(0, 12).map(({ displayName: name, response }) =>
        [...name].slice(0, 80).join('') + ' · ' + labels[response]));
    }
    if (active && record.owned) {
      rows.push([button('Edit', kind + ':edit:' + id), button('Cancel event', kind + ':ask:' + id + ':' + record.version)]);
    }
    await privateScreen(ctx, lines.filter(Boolean).join('\n'), rows, kind + ':mine');
  }

  for (const kind of ['ec', 'eh'] as const) {
    const feature = info[kind];
    bot.command(feature.command, async (ctx) => {
      const user = await privateFeature(ctx, authorize);
      if (user !== null && allowsGroupWorkflows(config)) await read(ctx, kind, user, 'active');
    });
    bot.command([feature.create, feature.edit], async (ctx) => {
      const user = await privateFeature(ctx, authorize);
      if (user === null || !allowsGroupWorkflows(config)) return;
      const editing = ctx.command === feature.edit;
      const match = editing ? /^([a-zA-Z0-9_-]{1,48})\s+(\d+)\s+(.+)$/.exec(ctx.payload.trim()) : null;
      const fields = eventParams(editing ? match?.[3] ?? '' : ctx.payload, kind);
      if (!fields) {
        await ctx.reply(usage(kind, editing ? feature.edit + ' ID VERSION' : feature.create));
        return;
      }
      const { body } = await call(ctx, kind, user, { action: editing ? 'edit' : 'create', ...fields,
        ...(editing ? { id: match![1], version: Number(match![2]) } : { requestId: requestFor(ctx) }) });
      if ('error' in body && body.error) { await ctx.reply(body.error); return; }
      const event = 'plan' in body ? body.plan : 'hangout' in body ? body.hangout : undefined;
      if (!event) return;
      wake();
      await detail(ctx, kind, user, event.id, editing ? 'Changes saved.' : 'Saved.');
    });
  }

  bot.action(/^(ec|eh):(active|mine|completed|view|create|edit|ask|cancel|r[gmc])(?::([a-zA-Z0-9_-]{1,48}))?(?::(\d{1,8}))?$/, async (ctx) => {
    const receivedAt = new Date();
    const user = await privateFeature(ctx, authorize);
    if (user === null || !allowsGroupWorkflows(config)) return;
    await ctx.answerCbQuery();
    const kind = ctx.match[1] as Kind;
    const action = ctx.match[2]!;
    const id = ctx.match[3];
    const version = Number(ctx.match[4]);
    if (action === 'active' || action === 'mine' || action === 'completed') { await read(ctx, kind, user, action, id); return; }
    if (action === 'create') { await ctx.reply(usage(kind, info[kind].create)); return; }
    if (!id) return;
    if (action === 'view') { await detail(ctx, kind, user, id); return; }
    if (action === 'edit') {
      const { body } = await call(ctx, kind, user, { action: 'detail', id });
      const event = 'plan' in body ? body.plan : 'hangout' in body ? body.hangout : undefined;
      if (event?.owned) await ctx.reply(usage(kind, info[kind].edit + ' ' + id + ' ' + event.version));
      return;
    }
    if (action === 'ask') {
      await privateScreen(ctx, 'Cancel this event?', [[button('Confirm cancellation', kind + ':cancel:' + id + ':' + version)]], kind + ':view:' + id);
      return;
    }
    const input = action === 'cancel' ? { action, id, version }
      : { action: 'rsvp', id, response: choices[action[1] as keyof typeof choices] };
    const { body } = await call(ctx, kind, user, input, receivedAt);
    if ('error' in body && body.error) { await ctx.reply(body.error); return; }
    wake();
    await detail(ctx, kind, user, id, action === 'cancel' ? 'Event cancelled.' : 'RSVP saved.');
  });
}
