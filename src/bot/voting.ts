import { Markup, TelegramError } from 'telegraf';
import type { Context, Telegraf } from 'telegraf';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config.js';
import { navigationRow, showScreen } from './navigation.js';

type Kind = 'poll' | 'bv';
type View = 'mine' | 'group' | 'samples';
type Mode = 'owner' | 'live' | 'preview' | 'sample';
type Choice = { id: string; label: string; count: number };
const pageSize = 10;
const choiceOrder = { orderBy: { position: 'asc' as const } };
const withCounts = { ...choiceOrder, include: { _count: { select: { votes: true } } } };
const withBallots = { ...choiceOrder, include: { _count: { select: { ballots: true } } } };
const button = Markup.button.callback;

function featureRoute(kind: Kind) {
  return kind === 'poll' ? 'feature:smart-poll' : 'feature:group-budget-vote';
}

function label(kind: Kind) {
  return kind === 'poll' ? 'Smart Poll' : 'Group Budget Vote';
}

function listRoute(kind: Kind, view: View, page: number) {
  return `vote:${kind}:${view}:${page}`;
}

function detailRoute(kind: Kind, mode: Mode, id: string, page: number) {
  return `vote:${kind}:${mode}:${id}:${page}`;
}

function mmk(amount: bigint) {
  return new Intl.NumberFormat('en-US').format(amount);
}

function statusLabel(status: string, published: boolean) {
  switch (status) {
    case 'OPEN': return published ? 'Published · Voting open' : 'Private';
    case 'CLOSED': return published ? 'Published · Voting closed' : 'Closed';
    case 'PUBLISHING': return 'Publication pending';
    case 'CLOSING': return 'Closing';
    case 'CANCELLED': return 'Cancelled';
    default: return 'Private draft';
  }
}

export function renderVoteResults(choices: Choice[], total: number, multiple: boolean) {
  return [
    ...choices.map(({ label: option, count }) =>
      `${option} — ${count} · ${total === 0 ? '0' : (100 * count / total).toFixed(1).replace(/\.0$/, '')}%`,
    ),
    '',
    `Total voters: ${total}`,
    ...(multiple ? ['Percentages use total voters. Each voter can choose multiple answers.'] : []),
  ].join('\n');
}

export function registerVoting(
  bot: Telegraf,
  config: AppConfig,
  database: PrismaClient,
  botUsername: string,
  authorize: (ctx: Context) => Promise<boolean>,
) {
  function load(kind: Kind, id: string) {
    return database.$transaction((tx) => readRecord(tx, kind, id), { isolationLevel: 'RepeatableRead' });
  }

  async function readRecord(tx: Prisma.TransactionClient, kind: Kind, id: string) {
    const where = { id, groupId: config.groupId };
    if (kind === 'poll') {
      const poll = await tx.smartPoll.findUnique({
        where, include: { options: withCounts },
      });
      if (!poll) return null;
      return {
        ...poll,
        title: poll.question ?? 'Untitled poll',
        ready: Boolean(poll.question) && poll.options.length >= 2,
        custom: poll.telegramPollId === null,
        multiple: poll.allowsMultipleAnswers,
        choices: poll.options.map(({ id, text, _count }) => ({ id, label: text, count: _count.votes })),
        total: poll.totalVoterCount,
        countsAvailable: !poll.telegramPollId || !poll.isAnonymous,
      };
    }

    const vote = await tx.budgetVote.findUnique({
      where, include: { options: withBallots, ranges: withBallots },
    });
    if (!vote) return null;
    const choices = vote.options.length
      ? vote.options.map(({ id, amountMmk, _count }) => ({ id, label: `${mmk(amountMmk)} MMK`, count: _count.ballots }))
      : vote.ranges.map(({ id, minMmk, maxMmk, _count }) => ({
          id, label: `${mmk(minMmk)}–${mmk(maxMmk)} MMK`, count: _count.ballots,
        }));
    return {
      ...vote,
      title: vote.title ?? 'Untitled budget vote',
      ready: Boolean(vote.title) && vote.options.length >= 2,
      custom: vote.options.length >= 2,
      multiple: false,
      choices,
      total: choices.reduce((sum, choice) => sum + choice.count, 0),
      countsAvailable: true,
    };
  }

  type Record = NonNullable<Awaited<ReturnType<typeof load>>>;

  async function allowed(ctx: Context) {
    if (ctx.chat?.type === 'private' && ctx.from && await authorize(ctx)) return true;
    if (ctx.callbackQuery) await ctx.answerCbQuery('Private, authorized access is required.', { show_alert: true });
    return false;
  }

  async function showList(ctx: Context, kind: Kind, view: View, page: number) {
    if (!await allowed(ctx) || !ctx.from) return;
    if ((view === 'group' && config.accessMode !== 'LIVE') ||
        (view === 'samples' && (config.accessMode !== 'PRELAUNCH' || BigInt(ctx.from.id) !== config.prelaunchOwnerId))) {
      await ctx.answerCbQuery('This view is unavailable.');
      return;
    }
    const where = view === 'group'
      ? { groupId: config.groupId, isPrelaunchTest: false, telegramMessageId: { not: null }, status: { in: ['OPEN', 'CLOSED'] as ('OPEN' | 'CLOSED')[] } }
      : { groupId: config.groupId, creatorId: BigInt(ctx.from.id) };
    const query = {
      skip: page * pageSize,
      take: pageSize + 1,
      orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    };
    const records = kind === 'poll'
      ? (await database.smartPoll.findMany({ ...query, where: view === 'samples'
          ? { ...where, question: { not: null }, options: { some: { position: 1 } } } : where,
          select: { id: true, question: true } })).map(({ id, question }) => ({ id, title: question }))
      : await database.budgetVote.findMany({ ...query, where: view === 'samples'
          ? { ...where, title: { not: null }, options: { some: { position: 1 } } } : where,
          select: { id: true, title: true } });
    const mode = view === 'mine' ? 'owner' : view === 'samples' ? 'sample' : 'live';
    const rows = records.slice(0, pageSize).map(({ id, title }) => [
      button([...((title ?? 'Untitled').replace(/\s+/g, ' '))].slice(0, 48).join(''), detailRoute(kind, mode, id, page)),
    ]);
    const pages = [
      ...(page > 0 ? [button('Previous', listRoute(kind, view, page - 1))] : []),
      ...(records.length > pageSize ? [button('Next', listRoute(kind, view, page + 1))] : []),
    ];
    const heading = view === 'mine' ? (kind === 'poll' ? 'My polls' : 'My budget votes')
      : view === 'group' ? 'Published votes' : 'Member View Preview · Simulation';
    if (ctx.callbackQuery) await ctx.answerCbQuery();
    await showScreen(ctx, `${label(kind)} · ${heading}${records.length ? '' : '\n\nNo records on this page.'}`,
      Markup.inlineKeyboard([...rows, ...(pages.length ? [pages] : []), navigationRow(featureRoute(kind))]));
  }

  function canView(ctx: Context, mode: Mode, record: Record) {
    if (mode === 'owner') return record.creatorId === BigInt(ctx.from!.id);
    if (mode === 'preview' || mode === 'sample') {
      return config.accessMode === 'PRELAUNCH' && BigInt(ctx.from!.id) === config.prelaunchOwnerId &&
        record.creatorId === config.prelaunchOwnerId && record.ready;
    }
    return config.accessMode === 'LIVE' && !record.isPrelaunchTest &&
      record.telegramMessageId !== null && ['OPEN', 'CLOSED'].includes(record.status);
  }

  function draw(ctx: Context, kind: Kind, mode: Mode, record: Record, page: number, action = '', mask = 0) {
    const route = detailRoute(kind, mode, record.id, page);
    const view = mode === 'owner' ? 'mine' : mode === 'sample' ? 'samples' : 'group';
    const nav = navigationRow(mode === 'preview'
      ? detailRoute(kind, 'owner', record.id, page)
      : listRoute(kind, view, page));
    const results = action === 'r' || action === 's';
    const submitted = action === 's';
    const preview = mode === 'preview' || mode === 'sample';
    const heading = preview ? 'Member View Preview · Simulation\n' : '';
    const published = !record.isPrelaunchTest && record.telegramMessageId !== null;
    const text = `${heading}${record.title}`;
    const open = preview || record.status === 'OPEN';
    if (results) {
      const choices = preview
        ? record.choices.map((choice, index) => ({ ...choice, count: Number(submitted && Boolean(mask & (1 << index))) }))
        : record.choices;
      const total = preview ? Number(submitted && mask > 0) : record.total;
      const summary = preview || record.countsAvailable
        ? renderVoteResults(choices, total, record.multiple)
        : `Total voters: ${total}\nAnswer counts are shown on the original Telegram poll.`;
      const notice = action === 's' ? (preview ? 'Simulated vote submitted.' : 'Vote saved.') : '';
      return showScreen(ctx, [text, notice, summary].filter(Boolean).join('\n\n'),
        Markup.inlineKeyboard([navigationRow(mask && open ? `${route}:o${mask}` : route)]));
    }
    if (mode === 'owner') {
      const rows = [[button('Results', `${route}:r`)]];
      if (config.accessMode === 'PRELAUNCH' && BigInt(ctx.from!.id) === config.prelaunchOwnerId && record.ready) {
        rows.push([button('Member View Preview', detailRoute(kind, 'preview', record.id, page))]);
      }
      if (config.accessMode === 'LIVE' && !record.isPrelaunchTest && record.ready && record.status === 'DRAFT' && record.draftStep === 'SAVED') {
        rows.push([button('Publish to group', `${route}:p`)]);
      }
      if (config.accessMode === 'LIVE' && published && record.status === 'OPEN') {
        rows.push([button('Close voting', kind === 'poll' && !record.custom ? `poll:close:${record.id}` : `${route}:c`)]);
      }
      return showScreen(ctx, [text, statusLabel(record.status, published), ...record.choices.map((choice) => choice.label)].join('\n'),
        Markup.inlineKeyboard([...rows, nav]));
    }

    const eligible = open && (preview || record.custom);
    const choices = eligible ? record.choices.map(({ label: option }, index) => {
      const bit = 1 << index;
      const selected = Boolean(mask & bit);
      const next = record.multiple ? mask ^ bit : bit;
      return [button(`${selected ? '✓ ' : ''}${option}`, `${route}:o${next}`)];
    }) : [];
    const hint = eligible
      ? (record.multiple ? 'Select one or more answers, then submit.' : 'Select one option, then submit.')
      : open ? 'Vote using the original message in the group.' : 'Voting is closed.';
    return showScreen(ctx, `${text}\n\n${hint}${eligible && !preview ? '\nSubmitting again replaces your previous vote.' : ''}${preview ? '\nPreview actions are simulated.' : ''}`, Markup.inlineKeyboard([
      ...choices,
      ...(eligible && mask ? [[button('Submit vote', `${route}:s${mask}`)]] : []),
      [button('Results', `${route}:r${mask || ''}`)],
      nav,
    ]));
  }

  async function saveBallot(kind: Kind, record: Record, user: bigint, mask: number) {
    const selected = record.choices.filter((_, index) => mask & (1 << index));
    return database.$transaction(async (tx) => {
      const locked = kind === 'poll'
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "SmartPoll" WHERE "id" = ${record.id} AND "groupId" = ${config.groupId}
            AND "status" = 'OPEN' AND "telegramMessageId" IS NOT NULL AND NOT "isPrelaunchTest" AND "telegramPollId" IS NULL FOR UPDATE`
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "BudgetVote" WHERE "id" = ${record.id} AND "groupId" = ${config.groupId}
            AND "status" = 'OPEN' AND "telegramMessageId" IS NOT NULL AND NOT "isPrelaunchTest" FOR UPDATE`;
      if (!locked.length) return false;
      if (kind === 'poll') {
        await tx.smartPollVote.deleteMany({ where: { pollId: record.id, memberId: user } });
        await tx.smartPollVote.createMany({
          data: selected.map(({ id }) => ({ pollId: record.id, memberId: user, optionId: id })),
        });
        const voters = await tx.$queryRaw<{ total: number }[]>`
          SELECT COUNT(DISTINCT "memberId")::int AS total FROM "SmartPollVote" WHERE "pollId" = ${record.id}`;
        await tx.smartPoll.update({ where: { id: record.id }, data: { totalVoterCount: voters[0]!.total } });
      } else {
        const optionId = selected[0]!.id;
        await tx.budgetVoteOptionBallot.upsert({
          where: { budgetVoteId_memberId: { budgetVoteId: record.id, memberId: user } },
          create: { budgetVoteId: record.id, memberId: user, optionId },
          update: { optionId },
        });
      }
      return true;
    }, { isolationLevel: 'ReadCommitted' });
  }

  async function transition(kind: Kind, record: Record, action: 'publish' | 'open' | 'restore' | 'close', messageId?: number) {
    const states = {
      publish: ['DRAFT', 'PUBLISHING'],
      open: ['PUBLISHING', 'OPEN'],
      restore: ['PUBLISHING', 'DRAFT'],
      close: ['OPEN', 'CLOSED'],
    } as const;
    const [from, to] = states[action];
    const where = { id: record.id, groupId: config.groupId, creatorId: record.creatorId,
      status: from, isPrelaunchTest: false, ...(action === 'publish' ? { draftStep: 'SAVED' as const } : {}) };
    const data = { status: to, ...(messageId === undefined ? {} : { telegramMessageId: messageId }), ...(action === 'close' ? { closedAt: new Date() } : {}) };
    return kind === 'poll' ? database.smartPoll.updateMany({ where, data })
      : database.budgetVote.updateMany({ where, data });
  }

  async function publish(ctx: Context, kind: Kind, record: Record) {
    if ((await transition(kind, record, 'publish')).count !== 1) return false;
    let sent;
    try {
      sent = await ctx.telegram.sendMessage(config.groupId.toString(), `${label(kind)}\n\n${record.title}`,
        Markup.inlineKeyboard([[Markup.button.url('Vote or view results',
          `https://t.me/${botUsername}?start=vote_${kind}_${record.id}`)]]));
    } catch (error) {
      // A definite Telegram rejection permits a retry. A transport failure can have delivered the message.
      if (error instanceof TelegramError && error.code >= 400 && error.code < 500) {
        await transition(kind, record, 'restore');
      }
      throw error;
    }
    return (await transition(kind, record, 'open', sent.message_id)).count === 1;
  }

  bot.command('polls', (ctx) => showList(ctx, 'poll', 'mine', 0));
  bot.command('budgets', (ctx) => showList(ctx, 'bv', 'mine', 0));
  bot.action(/^(poll|bv):list$/, (ctx) => showList(ctx, ctx.match[1] as Kind, 'mine', 0));
  bot.action(/^vote:(poll|bv):(mine|group|samples)(?::(\d{1,6}))?$/, (ctx) =>
    showList(ctx, ctx.match[1] as Kind, ctx.match[2] as View, Number(ctx.match[3] ?? 0)));

  bot.start(async (ctx, next) => {
    const match = /^vote_(poll|bv)_([a-z0-9]{1,30})$/.exec(ctx.payload);
    if (!match) return next();
    if (!await allowed(ctx)) return;
    const kind = match[1] as Kind;
    const record = await load(kind, match[2]!);
    if (!record || !canView(ctx, 'live', record)) {
      await ctx.reply('This published vote is unavailable.', Markup.inlineKeyboard([navigationRow('nav:home')]));
      return;
    }
    await draw(ctx, kind, 'live', record, 0);
  });

  bot.action(/^(?:(poll|bv):publish:([a-z0-9]{1,30})|vote:(poll|bv):(owner|live|preview|sample):([a-z0-9]{1,30}):(\d{1,6})(?::([orspc])(\d{0,4}))?)$/, async (ctx) => {
    if (!await allowed(ctx) || !ctx.from) return;
    const [, legacyKind, legacyId, currentKind, currentMode, currentId, currentPage, currentAction, selection] = ctx.match;
    const kind = (legacyKind ?? currentKind) as Kind;
    const mode = (currentMode ?? 'owner') as Mode;
    const id = (legacyId ?? currentId)!;
    const page = Number(currentPage ?? 0);
    const action = currentAction ?? (legacyKind ? 'p' : '');
    const mask = Number(selection ?? 0);
    let record = await load(kind, id);
    if (!record || !canView(ctx, mode, record)) {
      await ctx.answerCbQuery('This vote is unavailable or the button has expired.', { show_alert: true });
      return;
    }

    let notice: string | undefined;
    if (action === 'p' || action === 'c') {
      if (mode !== 'owner' || config.accessMode !== 'LIVE' || record.isPrelaunchTest ||
          (action === 'p' && !record.ready) || (action === 'c' && ((kind === 'poll' && !record.custom) || record.telegramMessageId === null))) {
        await ctx.answerCbQuery('This action is unavailable.');
        return;
      }
      let changed: boolean;
      try {
        changed = action === 'p' ? await publish(ctx, kind, record)
          : (await transition(kind, record, 'close')).count === 1;
      } catch (error) {
        await ctx.answerCbQuery('Could not confirm the action. Reopen the detail to check its status.', { show_alert: true });
        throw error;
      }
      notice = changed ? (action === 'p' ? 'Published.' : 'Voting closed.') : 'This action is no longer available.';
      record = await load(kind, id) ?? record;
    } else if (action === 'o' || action === 's' || mask > 0) {
      if (mode === 'owner' || mask >= (1 << record.choices.length) ||
          (!record.multiple && (mask & (mask - 1)) !== 0) || (action === 's' && mask === 0) ||
          (mode === 'live' && action !== 'r' && (record.status !== 'OPEN' || !record.custom))) {
        await ctx.answerCbQuery('This selection is unavailable.');
        return;
      }
      if (action === 's' && mode === 'live') {
        let saved: boolean;
        try {
          saved = await saveBallot(kind, record, BigInt(ctx.from.id), mask);
        } catch (error) {
          await ctx.answerCbQuery('Could not confirm your vote. You can safely submit again.', { show_alert: true });
          throw error;
        }
        if (!saved) {
          await ctx.answerCbQuery('Voting has closed.');
          return;
        }
        record = await load(kind, id) ?? record;
      }
    }
    await ctx.answerCbQuery(notice);
    await draw(ctx, kind, mode, record, page, action, mask);
  });
}
