import { allowsGroupWorkflows, isOwnerPreview } from '../access/policy.js';
import { Markup } from 'telegraf';
import type { Context, Telegraf } from 'telegraf';
import type { PrismaClient } from '@prisma/client';
import { voteMessage } from '../features/group-message.js';
import type { AppConfig } from '../config.js';
import { navigationRow, showScreen } from './navigation.js';

import { canViewPublished, loadVote, publishedVotes, saveBallot, validSelection } from '../features/vote-store.js';
import { closePublishedVote, editBudgetDraft, publicationMessage, publishVote } from '../features/vote-publication.js';
import { requestFor } from './shared-event-chat.js';
import { saveBudgetVote, savePoll } from '../features/vote-submission.js';
import { budgetVoteSubmissionSchema, smartPollSubmissionSchema } from '../mini-app/validation.js';
import type { Choice, Kind, VoteRecord } from '../features/vote-store.js';

type View = 'mine' | 'group' | 'samples';
type Mode = 'owner' | 'live' | 'preview' | 'sample';
const pageSize = 10;
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
  authorize: (ctx: Context, allowGroup?: boolean) => Promise<boolean>,
  wake = () => {},
) {
  const load = (kind: Kind, id: string) => loadVote(database, config.groupId, kind, id);

  async function allowed(ctx: Context) {
    if (ctx.chat?.type === 'private' && ctx.from && await authorize(ctx)) return true;
    if (ctx.callbackQuery) await ctx.answerCbQuery('Private, authorized access is required.', { show_alert: true });
    return false;
  }

  async function showList(ctx: Context, kind: Kind, view: View, page: number) {
    if (!await allowed(ctx) || !ctx.from) return;
    if ((view === 'group' && !allowsGroupWorkflows(config)) ||
        (view === 'samples' && (!isOwnerPreview(config) || BigInt(ctx.from.id) !== config.prelaunchOwnerId))) {
      await ctx.answerCbQuery('This view is unavailable.');
      return;
    }
    const where = view === 'group'
      ? publishedVotes(config.groupId)
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
      Markup.inlineKeyboard([...rows, ...(pages.length ? [pages] : []),
        ...(allowsGroupWorkflows(config) ? [[button('Create in chat', 'vcreate:' + kind), button('Refresh', listRoute(kind, view, page))]] : []),
        navigationRow(featureRoute(kind))]));
  }

  function canView(ctx: Context, mode: Mode, record: VoteRecord) {
    if (mode === 'owner') return record.creatorId === BigInt(ctx.from!.id);
    if (mode === 'preview' || mode === 'sample') {
      return isOwnerPreview(config) && BigInt(ctx.from!.id) === config.prelaunchOwnerId &&
        record.creatorId === config.prelaunchOwnerId && record.ready;
    }
    return canViewPublished(config, record);
  }

  function draw(ctx: Context, kind: Kind, mode: Mode, record: VoteRecord, page: number, action = '', mask = 0, notice = '') {
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
      if (isOwnerPreview(config) && BigInt(ctx.from!.id) === config.prelaunchOwnerId && record.ready) {
        rows.push([button('Group Publishing Preview', `${route}:g`)]);
        rows.push([button('Member View Preview', detailRoute(kind, 'preview', record.id, page))]);
      }
      if (allowsGroupWorkflows(config) && !record.isPrelaunchTest && record.ready && record.status === 'DRAFT' && record.draftStep === 'SAVED') {
        rows.push([button('Publish to group', `${route}:p`)]);
      }
      if (allowsGroupWorkflows(config) && published && record.status === 'OPEN') {
        rows.push([button('Close voting', kind === 'poll' && !record.custom ? `poll:close:${record.id}` : `${route}:c`)]);
      }
      return showScreen(ctx, [notice, text, statusLabel(record.status, published),
        ...(kind === 'bv' && record.status === 'DRAFT' && record.draftStep === 'SAVED' && !record.isPrelaunchTest && allowsGroupWorkflows(config)
          ? ['Edit with /budgetedit ' + record.id + ' | title | 10000,20000,30000'] : []), ...record.choices.map((choice) => choice.label)].filter(Boolean).join('\n'),
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

  const createUsage = (kind: Kind) => kind === 'poll'
    ? '/pollcreate Question | Option 1 | Option 2\nOptional first part: draft, multiple, or draft multiple.'
    : '/budgetcreate Title | 10000 | 20000 | 30000\nAdd draft as the first part to save privately.';

  bot.action(/^vcreate:(poll|bv)$/, async (ctx) => {
    if (!await allowed(ctx) || !allowsGroupWorkflows(config)) return;
    await ctx.answerCbQuery();
    await ctx.reply(createUsage(ctx.match[1] as Kind));
  });
  bot.command(['pollcreate', 'budgetcreate'], async (ctx) => {
    if (!await allowed(ctx) || !ctx.from || !allowsGroupWorkflows(config)) return;
    const kind: Kind = ctx.command === 'pollcreate' ? 'poll' : 'bv';
    const parts = ctx.payload.split('|').map((part) => part.trim());
    const mode = parts.length >= 4 && /^(draft|multiple|draft multiple)$/i.test(parts[0]!) ? parts.shift()!.toLowerCase() : '';
    const [question, ...options] = parts;
    const requestId = requestFor(ctx);
    const owner = BigInt(ctx.from.id);
    let saved;
    if (kind === 'poll') {
      const input = smartPollSubmissionSchema.safeParse({ requestId, question, options, multiple: mode.includes('multiple') });
      if (!input.success) { await ctx.reply(createUsage(kind)); return; }
      saved = await savePoll(database, config, owner, input.data);
    } else {
      const input = budgetVoteSubmissionSchema.safeParse({ requestId, question, amounts: options });
      if (!input.success || mode.includes('multiple')) { await ctx.reply(createUsage(kind)); return; }
      saved = await saveBudgetVote(database, config, owner, input.data);
    }
    const notice = mode.startsWith('draft') ? 'Draft saved.' : publicationMessage(
      await publishVote(database, ctx.telegram, config, botUsername, kind, saved.id, owner)
        .catch(() => 'unconfirmed' as const),
    );
    const record = await load(kind, saved.id);
    if (record) await draw(ctx, kind, 'owner', record, 0, '', 0, notice);
  });

  bot.command('budgetedit', async (ctx) => {
    if (!await allowed(ctx) || !ctx.from || !allowsGroupWorkflows(config)) return;
    const [id, question, amounts, ...extra] = ctx.payload.split('|').map((part) => part.trim());
    const input = budgetVoteSubmissionSchema.safeParse({ requestId: '00000000-0000-4000-8000-000000000000',
      question, amounts: amounts?.split(',') });
    if (!id || !/^[a-z0-9]{1,30}$/.test(id) || extra.length || !input.success) {
      await ctx.reply('Use /budgetedit ID | title | 10000,20000,30000');
      return;
    }
    const owner = BigInt(ctx.from.id);
    const changed = await editBudgetDraft(database, config, id, owner, input.data.question, input.data.amounts);
    const record = changed && await load('bv', id);
    if (record) await draw(ctx, 'bv', 'owner', record, 0);
    else await ctx.reply('This draft is unavailable or already published.');
  });

  bot.action(/^gv:(poll|bv):([a-z0-9]{1,30}):([0-9])$/, async (ctx) => {
    const message = ctx.callbackQuery.message;
    if (!allowsGroupWorkflows(config) || !message || !ctx.from ||
        !ctx.chat || ctx.chat.type === 'private' || BigInt(ctx.chat.id) !== config.groupId ||
        !await authorize(ctx, true)) {
      await ctx.answerCbQuery('Current group membership is required.', { show_alert: true });
      return;
    }
    const kind = ctx.match[1] as Kind;
    const record = await load(kind, ctx.match[2]!);
    const saved = record && !record.multiple && record.telegramMessageId === message.message_id &&
      await saveBallot(database, config, kind, record, BigInt(ctx.from.id), 1 << Number(ctx.match[3]));
    if (saved) wake();
    await ctx.answerCbQuery(saved ? 'Vote saved.' : 'This ballot is unavailable.');
  });

  bot.command('polls', (ctx) => showList(ctx, 'poll', 'mine', 0));
  bot.command('budgets', (ctx) => showList(ctx, 'bv', 'mine', 0));
  bot.action(/^(poll|bv):list$/, (ctx) => showList(ctx, ctx.match[1] as Kind, 'mine', 0));
  bot.action(/^vote:(poll|bv):(mine|group|samples)(?::(\d{1,6}))?$/, (ctx) =>
    showList(ctx, ctx.match[1] as Kind, ctx.match[2] as View, Number(ctx.match[3] ?? 0)));

  bot.start(async (ctx, next) => {
    if (ctx.payload === 'polls' || ctx.payload === 'budgets') {
      return showList(ctx, ctx.payload === 'polls' ? 'poll' : 'bv', 'mine', 0);
    }
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

  bot.action(/^(?:(poll|bv):publish:([a-z0-9]{1,30})|vote:(poll|bv):(owner|live|preview|sample):([a-z0-9]{1,30}):(\d{1,6})(?::([orspcg])(\d{0,4}))?)$/, async (ctx) => {
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

    if (action === 'g') {
      const allowed = mode === 'owner' && isOwnerPreview(config) &&
        BigInt(ctx.from.id) === config.prelaunchOwnerId && record.ready;
      await ctx.answerCbQuery(allowed ? undefined : 'Preview unavailable.');
      if (allowed) {
        const sample = { ...record, status: 'OPEN' as const, total: 0,
          choices: record.choices.map((choice) => ({ ...choice, count: 0 })) };
        await showScreen(ctx, `Group Publishing Preview · Simulation\n\n${voteMessage(kind, sample, botUsername).text}`,
          Markup.inlineKeyboard([navigationRow(detailRoute(kind, 'owner', id, page))]));
      }
      return;
    }

    let notice: string | undefined;
    if (action === 'p' || action === 'c') {
      if (mode !== 'owner' || !allowsGroupWorkflows(config) || record.isPrelaunchTest ||
          (action === 'p' && !record.ready) || (action === 'c' && ((kind === 'poll' && !record.custom) || record.telegramMessageId === null))) {
        await ctx.answerCbQuery('This action is unavailable.');
        return;
      }
      try {
        notice = action === 'p'
          ? publicationMessage(await publishVote(database, ctx.telegram, config, botUsername, kind, id, record.creatorId))
          : (await closePublishedVote(database, config, kind, id, record.creatorId)).count === 1 ? 'Voting closed.' : 'This action is no longer available.';
      } catch (error) {
        await ctx.answerCbQuery('Could not confirm the action. Reopen the detail to check its status.', { show_alert: true });
        throw error;
      }
      if (action === 'c') wake();
      record = await load(kind, id) ?? record;
    } else if (action === 'o' || action === 's' || mask > 0) {
      if (mode === 'owner' || !validSelection(record, mask, action === 's') ||
          (mode === 'live' && action !== 'r' && (record.status !== 'OPEN' || !record.custom))) {
        await ctx.answerCbQuery('This selection is unavailable.');
        return;
      }
      if (action === 's' && mode === 'live') {
        let saved: boolean;
        try {
          saved = await saveBallot(database, config, kind, record, BigInt(ctx.from.id), mask);
        } catch (error) {
          await ctx.answerCbQuery('Could not confirm your vote. You can safely submit again.', { show_alert: true });
          throw error;
        }
        if (!saved) {
          await ctx.answerCbQuery('Voting has closed.');
          return;
        }
        wake();
        record = await load(kind, id) ?? record;
      }
    }
    await ctx.answerCbQuery(notice);
    await draw(ctx, kind, mode, record, page, action, mask);
  });
}
