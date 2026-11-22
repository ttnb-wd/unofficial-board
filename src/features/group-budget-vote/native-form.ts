import { randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Markup, Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { AppConfig } from '../../config.js';
import type { createLogger } from '../../logger.js';
import { buildMiniAppUrl } from '../../mini-app/urls.js';
import { navigationRow, showScreen } from '../../bot/navigation.js';
import {
  isDraftMoreRecent,
} from '../../bot/draft-switch.js';

type Authorize = (ctx: Context, allowGroupChat?: boolean) => Promise<boolean>;

const DEFAULT_AMOUNTS = [10_000n, 20_000n, 30_000n];
const MAX_OPTIONS = 10;

function isPrivate(ctx: Context): boolean {
  return ctx.chat?.type === 'private' && Boolean(ctx.from);
}

function formatMmk(amount: bigint): string {
  return new Intl.NumberFormat('en-US').format(amount);
}

function createKeyboard(config: AppConfig) {
  const miniAppUrl = buildMiniAppUrl(config, 'budget');
  return Markup.inlineKeyboard([
    ...(miniAppUrl ? [[Markup.button.webApp('Create Budget Vote', miniAppUrl)]] : []),
    [Markup.button.callback('My budget votes', 'bv:list')],
    ...(config.accessMode === 'LIVE'
      ? [[Markup.button.callback('Published votes', 'vote:bv:group')]]
      : [[Markup.button.callback('Member View Preview', 'vote:bv:samples')]]),
    navigationRow('nav:home'),
  ]);
}

function menuText(config: AppConfig): string {
  return buildMiniAppUrl(config, 'budget')
    ? 'Group Budget Vote'
    : 'Group Budget Vote\n\nA public HTTPS MINI_APP_URL is required to open the form.';
}

function promptKeyboard(voteId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Back', `bv:back:${voteId}`)],
    [Markup.button.callback('Cancel', `bv:cancel:${voteId}`)],
  ]);
}

function previewKeyboard(voteId: string, saved = false) {
  if (saved) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('Publish to group', `bv:publish:${voteId}`)],
      [Markup.button.callback('Cancel', `bv:cancel:${voteId}`)],
    ]);
  }
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Edit Title', `bv:edit-title:${voteId}`),
      Markup.button.callback('Edit Amounts', `bv:edit-amounts:${voteId}`),
    ],
    [
      Markup.button.callback('Done', `bv:done:${voteId}`),
      Markup.button.callback('Cancel', `bv:cancel:${voteId}`),
    ],
    [Markup.button.callback('Back', `bv:back:${voteId}`)],
  ]);
}

function renderPreview(
  title: string | null,
  options: { amountMmk: bigint }[],
): string {
  return [
    'Budget vote preview',
    '',
    title ?? '',
    ...options.map((option) => `${formatMmk(option.amountMmk)} MMK`),
  ].join('\n');
}

function parseTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0 || title.length > 200) {
    throw new FormInputError('Please send a title.');
  }
  return title;
}

function parseAmounts(value: string): bigint[] {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/(?:\s*MMK)$/i, '').replaceAll(',', ''))
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new FormInputError('Send at least two amounts, one per line.');
  }
  if (lines.length > MAX_OPTIONS) {
    throw new FormInputError(`A vote can have up to ${MAX_OPTIONS} amounts.`);
  }
  if (lines.some((line) => !/^\d{1,15}$/.test(line))) {
    throw new FormInputError('Please send whole-number MMK amounts.');
  }
  const amounts = lines.map((line) => BigInt(line));
  if (amounts.some((amount) => amount <= 0n)) {
    throw new FormInputError('Amounts must be greater than zero.');
  }
  if (new Set(amounts).size !== amounts.length) {
    throw new FormInputError('Please use different amounts.');
  }
  return amounts;
}

class FormInputError extends Error {}

async function loadVote(
  database: PrismaClient,
  voteId: string,
  creatorId: bigint,
) {
  return database.budgetVote.findFirst({
    where: { id: voteId, creatorId },
    include: {
      options: { orderBy: { position: 'asc' } },
      ranges: { orderBy: { position: 'asc' } },
    },
  });
}

async function createOptions(
  transaction: Prisma.TransactionClient,
  voteId: string,
  amounts: bigint[],
): Promise<void> {
  for (const [position, amountMmk] of amounts.entries()) {
    await transaction.budgetVoteOption.create({
      data: {
        id: randomBytes(12).toString('base64url'),
        budgetVoteId: voteId,
        position,
        amountMmk,
      },
    });
  }
}

async function showPrompt(
  ctx: Context,
  database: PrismaClient,
  voteId: string,
  creatorId: bigint,
  text: string,
): Promise<void> {
  const vote = await loadVote(database, voteId, creatorId);
  if (!vote || vote.status !== 'DRAFT') {
    await ctx.reply('This budget vote draft is no longer available.');
    return;
  }
  const callbackMessageId =
    ctx.callbackQuery && 'message' in ctx.callbackQuery
      ? ctx.callbackQuery.message.message_id
      : null;
  const messageId = callbackMessageId ?? vote.promptMessageId;
  if (messageId !== null) {
    if (!ctx.chat) {
      throw new Error('Private budget form has no chat context.');
    }
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      messageId,
      undefined,
      text,
      promptKeyboard(vote.id),
    );
  } else {
    const message = await ctx.reply(text, promptKeyboard(vote.id));
    await database.budgetVote.updateMany({
      where: { id: vote.id, creatorId, status: 'DRAFT' },
      data: { promptMessageId: message.message_id },
    });
    return;
  }
  await database.budgetVote.updateMany({
    where: { id: vote.id, creatorId, status: 'DRAFT' },
    data: { promptMessageId: messageId },
  });
}

async function showPreview(
  ctx: Context,
  database: PrismaClient,
  voteId: string,
  creatorId: bigint,
): Promise<void> {
  const vote = await loadVote(database, voteId, creatorId);
  if (!vote) {
    await ctx.reply('This budget vote draft is no longer available.');
    return;
  }
  const text =
    vote.status === 'PRELAUNCH_OPEN'
      ? `Saved privately. This vote has not been sent to the group.\n\n${renderPreview(vote.title, vote.options)}`
      : renderPreview(vote.title, vote.options);
  const callbackMessageId =
    ctx.callbackQuery && 'message' in ctx.callbackQuery
      ? ctx.callbackQuery.message.message_id
      : null;
  const messageId = callbackMessageId ?? vote.promptMessageId;
  if (messageId !== null) {
    if (!ctx.chat) {
      throw new Error('Private budget form has no chat context.');
    }
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      messageId,
      undefined,
      text,
      previewKeyboard(vote.id, vote.draftStep === 'SAVED'),
    );
  } else {
    const message = await ctx.reply(
      text,
      previewKeyboard(vote.id, vote.draftStep === 'SAVED'),
    );
    await database.budgetVote.updateMany({
      where: { id: vote.id, creatorId, status: vote.status },
      data: { promptMessageId: message.message_id },
    });
    return;
  }
  await database.budgetVote.updateMany({
    where: { id: vote.id, creatorId, status: vote.status },
    data: { promptMessageId: messageId },
  });
}

async function createOrResumeDraft(
  database: PrismaClient,
  config: AppConfig,
  creatorId: bigint,
) {
  return database.$transaction(async (transaction) => {
    const lockKey = `native-form:${creatorId}`;
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `;
    const existing = await transaction.budgetVote.findFirst({
      where: { creatorId, status: 'DRAFT' },
      include: {
        options: { orderBy: { position: 'asc' } },
        ranges: { orderBy: { position: 'asc' } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (existing) {
      return existing;
    }
    await transaction.telegramGroup.upsert({
      where: { telegramId: config.groupId },
      create: {
        telegramId: config.groupId,
        isPrelaunchTest: config.accessMode === 'PRELAUNCH',
      },
      update: {},
    });
    await transaction.member.upsert({
      where: { telegramId: creatorId },
      create: {
        telegramId: creatorId,
        isPrelaunchTest: config.accessMode === 'PRELAUNCH',
      },
      update: {},
    });
    return transaction.budgetVote.create({
      data: {
        groupId: config.groupId,
        creatorId,
        isPrelaunchTest: config.accessMode === 'PRELAUNCH',
      },
      include: {
        options: { orderBy: { position: 'asc' } },
        ranges: { orderBy: { position: 'asc' } },
      },
    });
  });
}

async function showCurrentDraft(
  ctx: Context,
  database: PrismaClient,
  vote: NonNullable<Awaited<ReturnType<typeof loadVote>>>,
  creatorId: bigint,
): Promise<void> {
  if (vote.draftStep === 'SAVED' || vote.draftStep === 'READY') {
    await showPreview(ctx, database, vote.id, creatorId);
  } else {
    await showPrompt(
      ctx,
      database,
      vote.id,
      creatorId,
      vote.draftStep === 'TITLE'
        ? 'What’s the budget vote title?'
        : 'Send the amounts, one per line.',
    );
  }
}

async function openBudgetDraft(
  ctx: Context,
  config: AppConfig,
  database: PrismaClient,
  creatorId: bigint,
): Promise<void> {
  const vote = await createOrResumeDraft(database, config, creatorId);
  await showCurrentDraft(ctx, database, vote, creatorId);
}

async function showStaleDraftNotice(ctx: Context): Promise<void> {
  await ctx.answerCbQuery('This draft is no longer active.', {
    show_alert: true,
  });
  await ctx.editMessageText(
    'This draft is no longer active. Your other drafts are unchanged.',
    Markup.inlineKeyboard([
      [Markup.button.callback('Main Menu', 'nav:home')],
    ]),
  );
}

export function registerBudgetMiniAppLaunch(
  bot: Telegraf,
  config: AppConfig,
  authorize: Authorize,
): void {
  bot.action(/^feature:group-budget-vote$/, async (ctx) => {
    if (!(await authorize(ctx)) || ctx.chat?.type !== 'private') {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery();
    await showScreen(ctx, menuText(config), createKeyboard(config));
  });

  bot.command('budget', async (ctx) => {
    if (!(await authorize(ctx)) || !isPrivate(ctx)) {
      return;
    }
    await ctx.reply(menuText(config), createKeyboard(config));
  });

  bot.action('bv:create', async (ctx) => {
    if (!(await authorize(ctx)) || !isPrivate(ctx) || !ctx.from) {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery('Menu refreshed.');
    await showScreen(ctx, menuText(config), createKeyboard(config));
  });
}

export function registerNativeBudgetFormHandlers(
  bot: Telegraf,
  config: AppConfig,
  database: PrismaClient,
  logger: ReturnType<typeof createLogger>,
  authorize: Authorize,
): void {
  registerBudgetMiniAppLaunch(bot, config, authorize);

  bot.action(
    /^draft:switch:budget:poll:([a-z0-9]+)$/,
    async (ctx) => {
      if (!(await authorize(ctx)) || !isPrivate(ctx) || !ctx.from) {
        await ctx.answerCbQuery('Private, authorized access is required.', {
          show_alert: true,
        });
        return;
      }
      const sourceId = ctx.match[1];
      const source = sourceId
        ? await database.smartPoll.findFirst({
            where: {
              id: sourceId,
              creatorId: BigInt(ctx.from.id),
              status: 'DRAFT',
            },
            select: { id: true },
          })
        : null;
      if (!source) {
        await showStaleDraftNotice(ctx);
        return;
      }
      await ctx.answerCbQuery();
      await openBudgetDraft(ctx, config, database, BigInt(ctx.from.id));
    },
  );

  bot.action(/^draft:continue:budget:([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || !isPrivate(ctx) || !ctx.from) {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const voteId = ctx.match[1];
    const vote = voteId
      ? await loadVote(database, voteId, BigInt(ctx.from.id))
      : null;
    if (!vote || vote.status !== 'DRAFT') {
      await showStaleDraftNotice(ctx);
      return;
    }
    await ctx.answerCbQuery();
    await showCurrentDraft(ctx, database, vote, BigInt(ctx.from.id));
  });

  bot.action(/^bv:(edit-title|edit-amounts):([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || !isPrivate(ctx) || !ctx.from) {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const action = ctx.match[1];
    const voteId = ctx.match[2];
    if (!action || !voteId) {
      await ctx.answerCbQuery('This budget vote draft is invalid.', {
        show_alert: true,
      });
      return;
    }
    const draftStep = action === 'edit-title' ? 'TITLE' : 'RANGES';
    const claimed = await database.budgetVote.updateMany({
      where: {
        id: voteId,
        creatorId: BigInt(ctx.from.id),
        status: 'DRAFT',
        draftStep: 'READY',
      },
      data: { draftStep },
    });
    if (claimed.count !== 1) {
      await ctx.answerCbQuery('This budget vote draft is no longer editable.', {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery();
    await showPrompt(
      ctx,
      database,
      voteId,
      BigInt(ctx.from.id),
      action === 'edit-title'
        ? 'What’s the new title?'
        : 'Send the amounts, one per line. Defaults: 10000, 20000, 30000.',
    );
  });

  bot.action(/^bv:back:([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || !isPrivate(ctx) || !ctx.from) {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const voteId = ctx.match[1];
    const vote = voteId
      ? await loadVote(database, voteId, BigInt(ctx.from.id))
      : null;
    if (!vote || vote.status !== 'DRAFT') {
      await ctx.answerCbQuery('This budget vote draft is no longer available.', {
        show_alert: true,
      });
      return;
    }
    if (vote.draftStep === 'TITLE' && !vote.title) {
      await ctx.answerCbQuery();
      await showScreen(ctx, menuText(config), createKeyboard(config));
      return;
    }
    await database.budgetVote.updateMany({
      where: { id: vote.id, creatorId: BigInt(ctx.from.id), status: 'DRAFT' },
      data: { draftStep: 'READY' },
    });
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      renderPreview(vote.title, vote.options),
      previewKeyboard(vote.id),
    );
  });

  bot.action(/^bv:done:([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || !isPrivate(ctx) || !ctx.from) {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const voteId = ctx.match[1];
    const vote = voteId
      ? await loadVote(database, voteId, BigInt(ctx.from.id))
      : null;
    if (
      !vote ||
      vote.status !== 'DRAFT' ||
      vote.draftStep !== 'READY' ||
      !vote.title ||
      vote.options.length < 2
    ) {
      await ctx.answerCbQuery('Add a title and at least two amounts first.', {
        show_alert: true,
      });
      return;
    }
    const status = config.accessMode === 'PRELAUNCH' ? 'PRELAUNCH_OPEN' : 'DRAFT';
    const claimed = await database.budgetVote.updateMany({
      where: {
        id: vote.id,
        creatorId: BigInt(ctx.from.id),
        status: 'DRAFT',
        draftStep: 'READY',
      },
      data: { status, draftStep: 'SAVED' },
    });
    if (claimed.count !== 1) {
      await ctx.answerCbQuery('This budget vote has already been saved.', {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery('Budget vote saved.');
    if (config.accessMode === 'PRELAUNCH') {
      const text = renderPreview(vote.title, vote.options);
      await ctx.editMessageText(
        `Saved privately. This vote has not been sent to the group.\n\n${text}`,
        Markup.inlineKeyboard([
          ...vote.options.map((option) => [
            Markup.button.callback(
              `${formatMmk(option.amountMmk)} MMK`,
              `bv:amount:${vote.id}:${option.id}`,
            ),
          ]),
          [Markup.button.callback('Close vote', `bv:close:${vote.id}`)],
        ]),
      );
    } else {
      await ctx.editMessageText(
        `Budget vote saved.\n\n${renderPreview(vote.title, vote.options)}`,
        Markup.inlineKeyboard([
          [Markup.button.callback('Publish to group', `bv:publish:${vote.id}`)],
        ]),
      );
    }
  });

  bot.action(/^bv:cancel:([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || !isPrivate(ctx) || !ctx.from) {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const voteId = ctx.match[1];
    const cancelled = voteId
      ? await database.budgetVote.updateMany({
          where: {
            id: voteId,
            creatorId: BigInt(ctx.from.id),
            status: 'DRAFT',
          },
          data: { status: 'CANCELLED' },
        })
      : { count: 0 };
    if (cancelled.count !== 1) {
      await ctx.answerCbQuery('This draft is already closed.', {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery('Draft cancelled.');
    await ctx.editMessageText(
      'Budget vote draft cancelled.',
      createKeyboard(config),
    );
  });

  bot.on('text', async (ctx, next) => {
    if (
      !isPrivate(ctx) ||
      !ctx.from ||
      ctx.message.text.startsWith('/') ||
      !(await authorize(ctx))
    ) {
      await next();
      return;
    }
    const creatorId = BigInt(ctx.from.id);
    const vote = await database.budgetVote.findFirst({
      where: {
        creatorId,
        status: 'DRAFT',
        draftStep: { in: ['TITLE', 'RANGES'] },
      },
      orderBy: { updatedAt: 'desc' },
      include: { options: { orderBy: { position: 'asc' } } },
    });
    const poll = await database.smartPoll.findFirst({
      where: {
        creatorId,
        status: 'DRAFT',
        draftStep: {
          in: ['QUESTION', 'OPTIONS', 'EDIT_QUESTION', 'EDIT_OPTIONS', 'ADD_OPTION'],
        },
      },
      select: { promptMessageId: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (!vote || (poll && isDraftMoreRecent(poll, vote))) {
      await next();
      return;
    }
    try {
      const text = ctx.message.text;
      if (vote.draftStep === 'TITLE') {
        const title = parseTitle(text);
        const updated = await database.$transaction(async (transaction) => {
          const claimed = await transaction.budgetVote.updateMany({
            where: {
              id: vote.id,
              creatorId,
              status: 'DRAFT',
              draftStep: 'TITLE',
            },
            data: { title, draftStep: 'READY' },
          });
          if (claimed.count !== 1) {
            return false;
          }
          const existingOptions = await transaction.budgetVoteOption.count({
            where: { budgetVoteId: vote.id },
          });
          if (existingOptions === 0) {
            await createOptions(transaction, vote.id, DEFAULT_AMOUNTS);
          }
          return true;
        });
        if (!updated) {
          await ctx.reply('This budget vote step has already been completed.');
          return;
        }
        await showPreview(ctx, database, vote.id, creatorId);
        return;
      }

      const amounts = parseAmounts(text);
      const updated = await database.$transaction(async (transaction) => {
        const claimed = await transaction.budgetVote.updateMany({
          where: {
            id: vote.id,
            creatorId,
            status: 'DRAFT',
            draftStep: 'RANGES',
          },
          data: { draftStep: 'READY' },
        });
        if (claimed.count !== 1) {
          return false;
        }
        await transaction.budgetVoteOption.deleteMany({
          where: { budgetVoteId: vote.id },
        });
        await createOptions(transaction, vote.id, amounts);
        return true;
      });
      if (!updated) {
        await ctx.reply('This budget vote step has already been completed.');
        return;
      }
      await showPreview(ctx, database, vote.id, creatorId);
    } catch (error) {
      if (error instanceof FormInputError) {
        await ctx.reply(error.message, promptKeyboard(vote.id));
        return;
      }
      logger.error(
        {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          operation: 'native-budget-draft-input',
          budgetVoteId: vote.id,
        },
        'Could not save budget vote draft input',
      );
      throw error;
    }
  });
}
