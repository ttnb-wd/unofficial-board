import type { PrismaClient } from '@prisma/client';
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

const MAX_OPTIONS = 10;

class FormInputError extends Error {}

function isPrivate(ctx: Context): boolean {
  return ctx.chat?.type === 'private' && Boolean(ctx.from);
}

function createKeyboard(config: AppConfig) {
  const miniAppUrl = buildMiniAppUrl(config, 'poll');
  return Markup.inlineKeyboard([
    ...(miniAppUrl ? [[Markup.button.webApp('Create Poll', miniAppUrl)]] : []),
    [Markup.button.callback('My polls', 'poll:list')],
    ...(config.accessMode === 'LIVE'
      ? [[Markup.button.callback('Published votes', 'vote:poll:group')]]
      : [[Markup.button.callback('Member View Preview', 'vote:poll:samples')]]),
    navigationRow('nav:home'),
  ]);
}

function menuText(config: AppConfig): string {
  return buildMiniAppUrl(config, 'poll')
    ? 'Smart Poll'
    : 'Smart Poll\n\nA public HTTPS MINI_APP_URL is required to open the form.';
}

function promptKeyboard(pollId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Back', `poll:back:${pollId}`)],
    [Markup.button.callback('Cancel', `poll:cancel:${pollId}`)],
  ]);
}

function previewKeyboard(
  pollId: string,
  options: { id: string }[],
  saved = false,
) {
  if (saved) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('Publish to group', `poll:publish:${pollId}`)],
      [Markup.button.callback('Cancel', `poll:cancel:${pollId}`)],
    ]);
  }
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Edit Question', `poll:edit-question:${pollId}`),
      Markup.button.callback('Edit Options', `poll:edit-options:${pollId}`),
    ],
    [
      Markup.button.callback('Add Option', `poll:add-option:${pollId}`),
      Markup.button.callback('Remove Option', `poll:remove-options:${pollId}`),
    ],
    [
      Markup.button.callback('Done', `poll:done:${pollId}`),
      Markup.button.callback('Cancel', `poll:cancel:${pollId}`),
    ],
    [Markup.button.callback('Back', `poll:back:${pollId}`)],
  ]);
}

function renderPreview(
  poll: { question: string | null },
  options: { text: string }[],
): string {
  return [
    'Poll preview',
    '',
    poll.question ?? '',
    ...options.map((option, index) => `${index + 1}. ${option.text}`),
  ].join('\n');
}

function parseQuestion(value: string): string {
  const question = value.trim();
  if (question.length === 0 || question.length > 300) {
    throw new FormInputError('Please send a question.');
  }
  return question;
}

function parseOptions(value: string): string[] {
  const options = value
    .split(/\r?\n/)
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
  if (options.length < 2) {
    throw new FormInputError('Send at least two options, one per line.');
  }
  if (options.length > MAX_OPTIONS) {
    throw new FormInputError(`A poll can have up to ${MAX_OPTIONS} options.`);
  }
  if (options.some((option) => option.length > 100)) {
    throw new FormInputError('Each option must be 100 characters or fewer.');
  }
  if (new Set(options.map((option) => option.toLocaleLowerCase())).size !== options.length) {
    throw new FormInputError('Please use different options.');
  }
  return options;
}

async function loadPoll(database: PrismaClient, pollId: string, creatorId: bigint) {
  return database.smartPoll.findFirst({
    where: { id: pollId, creatorId },
    include: { options: { orderBy: { position: 'asc' } } },
  });
}

async function showPollPrompt(
  ctx: Context,
  database: PrismaClient,
  pollId: string,
  creatorId: bigint,
  text: string,
): Promise<void> {
  const poll = await loadPoll(database, pollId, creatorId);
  if (!poll || poll.status !== 'DRAFT') {
    await ctx.reply('This poll draft is no longer available.');
    return;
  }
  const callbackMessageId =
    ctx.callbackQuery && 'message' in ctx.callbackQuery
      ? ctx.callbackQuery.message.message_id
      : null;
  const messageId = callbackMessageId ?? poll.promptMessageId;
  if (messageId !== null) {
    if (!ctx.chat) {
      throw new Error('Private poll form has no chat context.');
    }
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      messageId,
      undefined,
      text,
      promptKeyboard(poll.id),
    );
  } else {
    const message = await ctx.reply(text, promptKeyboard(poll.id));
    await database.smartPoll.updateMany({
      where: { id: poll.id, creatorId, status: 'DRAFT' },
      data: { promptMessageId: message.message_id },
    });
    return;
  }
  await database.smartPoll.updateMany({
    where: { id: poll.id, creatorId, status: 'DRAFT' },
    data: { promptMessageId: messageId },
  });
}

async function showPollPreview(
  ctx: Context,
  database: PrismaClient,
  pollId: string,
  creatorId: bigint,
): Promise<void> {
  const poll = await loadPoll(database, pollId, creatorId);
  if (!poll) {
    await ctx.reply('This poll draft is no longer available.');
    return;
  }
  const saved = poll.draftStep === 'SAVED';
  const text =
    poll.status === 'PRELAUNCH_PREVIEW'
      ? `Saved privately. This poll has not been sent to the group.\n\n${renderPreview(poll, poll.options)}`
      : renderPreview(poll, poll.options);
  const callbackMessageId =
    ctx.callbackQuery && 'message' in ctx.callbackQuery
      ? ctx.callbackQuery.message.message_id
      : null;
  const messageId = callbackMessageId ?? poll.promptMessageId;
  if (messageId !== null) {
    if (!ctx.chat) {
      throw new Error('Private poll form has no chat context.');
    }
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      messageId,
      undefined,
      text,
      previewKeyboard(poll.id, poll.options, saved),
    );
  } else {
    const message = await ctx.reply(
      text,
      previewKeyboard(poll.id, poll.options, saved),
    );
    await database.smartPoll.updateMany({
      where: { id: poll.id, creatorId, status: poll.status },
      data: { promptMessageId: message.message_id },
    });
    return;
  }
  await database.smartPoll.updateMany({
    where: { id: poll.id, creatorId, status: poll.status },
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
    const existing = await transaction.smartPoll.findFirst({
      where: { creatorId, status: 'DRAFT' },
      include: { options: { orderBy: { position: 'asc' } } },
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
    return transaction.smartPoll.create({
      data: {
        groupId: config.groupId,
        creatorId,
        isPrelaunchTest: config.accessMode === 'PRELAUNCH',
      },
      include: { options: true },
    });
  });
}

async function showCurrentDraft(
  ctx: Context,
  database: PrismaClient,
  poll: NonNullable<Awaited<ReturnType<typeof loadPoll>>>,
  creatorId: bigint,
): Promise<void> {
  if (poll.draftStep === 'SAVED' || poll.draftStep === 'READY') {
    await showPollPreview(ctx, database, poll.id, creatorId);
  } else {
    const prompt =
      poll.draftStep === 'QUESTION' || poll.draftStep === 'EDIT_QUESTION'
        ? 'What’s the poll question?'
        : poll.draftStep === 'ADD_OPTION'
          ? 'Send one option.'
          : 'Send the options, one per line.';
    await showPollPrompt(ctx, database, poll.id, creatorId, prompt);
  }
}

async function openPollDraft(
  ctx: Context,
  config: AppConfig,
  database: PrismaClient,
  creatorId: bigint,
): Promise<void> {
  const poll = await createOrResumeDraft(database, config, creatorId);
  await showCurrentDraft(ctx, database, poll, creatorId);
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

export function registerSmartPollMiniAppLaunch(
  bot: Telegraf,
  config: AppConfig,
  authorize: Authorize,
): void {
  bot.action(/^feature:smart-poll$/, async (ctx) => {
    if (!(await authorize(ctx)) || ctx.chat?.type !== 'private') {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery();
    await showScreen(ctx, menuText(config), createKeyboard(config));
  });

  bot.command('poll', async (ctx) => {
    if (!(await authorize(ctx)) || !isPrivate(ctx)) {
      return;
    }
    await ctx.reply(menuText(config), createKeyboard(config));
  });

  bot.action('poll:create', async (ctx) => {
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

export function registerNativeSmartPollFormHandlers(
  bot: Telegraf,
  config: AppConfig,
  database: PrismaClient,
  logger: ReturnType<typeof createLogger>,
  authorize: Authorize,
): void {
  registerSmartPollMiniAppLaunch(bot, config, authorize);

  bot.action(
    /^draft:switch:poll:budget:([a-z0-9]+)$/,
    async (ctx) => {
      if (!(await authorize(ctx)) || !isPrivate(ctx) || !ctx.from) {
        await ctx.answerCbQuery('Private, authorized access is required.', {
          show_alert: true,
        });
        return;
      }
      const sourceId = ctx.match[1];
      const source = sourceId
        ? await database.budgetVote.findFirst({
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
      await openPollDraft(ctx, config, database, BigInt(ctx.from.id));
    },
  );

  bot.action(/^draft:continue:poll:([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || !isPrivate(ctx) || !ctx.from) {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const pollId = ctx.match[1];
    const poll = pollId
      ? await loadPoll(database, pollId, BigInt(ctx.from.id))
      : null;
    if (!poll || poll.status !== 'DRAFT') {
      await showStaleDraftNotice(ctx);
      return;
    }
    await ctx.answerCbQuery();
    await showCurrentDraft(ctx, database, poll, BigInt(ctx.from.id));
  });

  bot.action(/^poll:(edit-question|edit-options|add-option):([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || !isPrivate(ctx) || !ctx.from) {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const action = ctx.match[1];
    const pollId = ctx.match[2];
    if (!pollId || !action) {
      await ctx.answerCbQuery('This poll draft is invalid.', { show_alert: true });
      return;
    }
    const nextStep =
      action === 'edit-question'
        ? 'EDIT_QUESTION'
        : action === 'edit-options'
          ? 'EDIT_OPTIONS'
          : 'ADD_OPTION';
    const claimed = await database.smartPoll.updateMany({
      where: {
        id: pollId,
        creatorId: BigInt(ctx.from.id),
        status: 'DRAFT',
        draftStep: 'READY',
      },
      data: { draftStep: nextStep },
    });
    if (claimed.count !== 1) {
      await ctx.answerCbQuery('This poll draft is no longer editable.', {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery();
    await showPollPrompt(
      ctx,
      database,
      pollId,
      BigInt(ctx.from.id),
      action === 'edit-question'
        ? 'What’s the new question?'
        : action === 'edit-options'
          ? 'Send the options, one per line.'
          : 'Send one option.',
    );
  });

  bot.action(/^poll:remove-options:([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || !isPrivate(ctx) || !ctx.from) {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const pollId = ctx.match[1];
    const poll = pollId
      ? await loadPoll(database, pollId, BigInt(ctx.from.id))
      : null;
    if (!poll || poll.status !== 'DRAFT' || poll.draftStep !== 'READY') {
      await ctx.answerCbQuery('This poll draft is no longer editable.', {
        show_alert: true,
      });
      return;
    }
    if (poll.options.length <= 2) {
      await ctx.answerCbQuery('A poll needs at least two options.', {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      'Which option should be removed?',
      Markup.inlineKeyboard([
        ...poll.options.map((option, index) => [
          Markup.button.callback(
            `Remove ${index + 1}`,
            `poll:remove:${poll.id}:${option.id}`,
          ),
        ]),
        [Markup.button.callback('Back', `poll:back:${poll.id}`)],
        [Markup.button.callback('Cancel', `poll:cancel:${poll.id}`)],
      ]),
    );
  });

  bot.action(/^poll:remove:([a-z0-9]+):([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || !isPrivate(ctx) || !ctx.from) {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const pollId = ctx.match[1];
    const optionId = ctx.match[2];
    if (!pollId || !optionId) {
      await ctx.answerCbQuery('This poll option is invalid.', { show_alert: true });
      return;
    }
    const result = await database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "SmartPoll"
        WHERE "id" = ${pollId}
          AND "creatorId" = ${BigInt(ctx.from.id)}
          AND "status" = 'DRAFT'::"SmartPollStatus"
          AND "draftStep" = 'READY'::"SmartPollDraftStep"
        FOR UPDATE
      `;
      if (locked.length !== 1) {
        return false;
      }
      const poll = await transaction.smartPoll.findFirst({
        where: {
          id: pollId,
          creatorId: BigInt(ctx.from.id),
          status: 'DRAFT',
          draftStep: 'READY',
        },
        include: { options: { orderBy: { position: 'asc' } } },
      });
      if (!poll || poll.options.length <= 2) {
        return false;
      }
      const deleted = await transaction.smartPollOption.deleteMany({
        where: { pollId, id: optionId },
      });
      if (deleted.count !== 1) {
        return false;
      }
      const remaining = poll.options.filter((option) => option.id !== optionId);
      for (const [position, option] of remaining.entries()) {
        await transaction.smartPollOption.update({
          where: { id: option.id },
          data: { position },
        });
      }
      return true;
    });
    if (!result) {
      await ctx.answerCbQuery('That option was already removed.', {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery('Option removed.');
    const updated = await loadPoll(database, pollId, BigInt(ctx.from.id));
    if (!updated) {
      throw new Error('Poll draft could not be reloaded after removing an option.');
    }
    await ctx.editMessageText(
      renderPreview(updated, updated.options),
      previewKeyboard(pollId, updated.options),
    );
  });

  bot.action(/^poll:back:([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || !isPrivate(ctx) || !ctx.from) {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const pollId = ctx.match[1];
    if (!pollId) {
      await ctx.answerCbQuery('This poll draft is invalid.', { show_alert: true });
      return;
    }
    const poll = await loadPoll(database, pollId, BigInt(ctx.from.id));
    if (!poll || poll.status !== 'DRAFT') {
      await ctx.answerCbQuery('This poll draft is no longer available.', {
        show_alert: true,
      });
      return;
    }
    if (
      poll.draftStep === 'EDIT_QUESTION' ||
      poll.draftStep === 'EDIT_OPTIONS' ||
      poll.draftStep === 'ADD_OPTION'
    ) {
      await database.smartPoll.updateMany({
        where: { id: poll.id, creatorId: BigInt(ctx.from.id), status: 'DRAFT' },
        data: { draftStep: 'READY' },
      });
      await ctx.answerCbQuery();
      const updated = await loadPoll(database, poll.id, BigInt(ctx.from.id));
      if (updated) {
        await ctx.editMessageText(
          renderPreview(updated, updated.options),
          previewKeyboard(updated.id, updated.options),
        );
      }
      return;
    }
    if (poll.draftStep === 'READY' || poll.draftStep === 'SAVED') {
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        renderPreview(poll, poll.options),
        previewKeyboard(poll.id, poll.options, poll.draftStep === 'SAVED'),
      );
      return;
    }
    if (poll.draftStep === 'OPTIONS') {
      await database.smartPoll.updateMany({
        where: {
          id: poll.id,
          creatorId: BigInt(ctx.from.id),
          status: 'DRAFT',
          draftStep: 'OPTIONS',
        },
        data: { draftStep: 'QUESTION' },
      });
      await ctx.answerCbQuery();
      await showPollPrompt(
        ctx,
        database,
        poll.id,
        BigInt(ctx.from.id),
        'What’s the poll question?',
      );
      return;
    }
    await ctx.answerCbQuery();
    await showScreen(ctx, menuText(config), createKeyboard(config));
  });

  bot.action(/^poll:done:([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || !isPrivate(ctx) || !ctx.from) {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const pollId = ctx.match[1];
    const poll = pollId
      ? await loadPoll(database, pollId, BigInt(ctx.from.id))
      : null;
    if (
      !poll ||
      poll.status !== 'DRAFT' ||
      poll.draftStep !== 'READY' ||
      !poll.question ||
      poll.options.length < 2
    ) {
      await ctx.answerCbQuery('Add a question and at least two options first.', {
        show_alert: true,
      });
      return;
    }
    const status = config.accessMode === 'PRELAUNCH' ? 'PRELAUNCH_PREVIEW' : 'DRAFT';
    const claimed = await database.smartPoll.updateMany({
      where: {
        id: poll.id,
        creatorId: BigInt(ctx.from.id),
        status: 'DRAFT',
        draftStep: 'READY',
      },
      data: { status, draftStep: 'SAVED' },
    });
    if (claimed.count !== 1) {
      await ctx.answerCbQuery('This poll has already been saved.', {
        show_alert: true,
      });
      return;
    }
    await ctx.answerCbQuery('Poll saved.');
    if (config.accessMode === 'PRELAUNCH') {
      await ctx.editMessageText(
        `Saved privately. This poll has not been sent to the group.\n\n${renderPreview(poll, poll.options)}`,
        Markup.inlineKeyboard([
          [Markup.button.callback('Close preview', `poll:close:${poll.id}`)],
        ]),
      );
    } else {
      await ctx.editMessageText(
        `Poll saved.\n\n${renderPreview(poll, poll.options)}`,
        Markup.inlineKeyboard([
          [Markup.button.callback('Publish to group', `poll:publish:${poll.id}`)],
        ]),
      );
    }
  });

  bot.action(/^poll:cancel:([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || !isPrivate(ctx) || !ctx.from) {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const pollId = ctx.match[1];
    const cancelled = pollId
      ? await database.smartPoll.updateMany({
          where: {
            id: pollId,
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
    await ctx.editMessageText('Poll draft cancelled.', createKeyboard(config));
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
    const poll = await database.smartPoll.findFirst({
      where: {
        creatorId,
        status: 'DRAFT',
        draftStep: {
          in: ['QUESTION', 'OPTIONS', 'EDIT_QUESTION', 'EDIT_OPTIONS', 'ADD_OPTION'],
        },
      },
      orderBy: { updatedAt: 'desc' },
      include: { options: { orderBy: { position: 'asc' } } },
    });
    const budget = await database.budgetVote.findFirst({
      where: {
        creatorId,
        status: 'DRAFT',
        draftStep: { in: ['TITLE', 'RANGES'] },
      },
      select: { promptMessageId: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (!poll || (budget && isDraftMoreRecent(budget, poll))) {
      await next();
      return;
    }

    try {
      const text = ctx.message.text;
      if (poll.draftStep === 'QUESTION' || poll.draftStep === 'EDIT_QUESTION') {
        const question = parseQuestion(text);
        const nextStep = poll.draftStep === 'QUESTION' ? 'OPTIONS' : 'READY';
        const updated = await database.smartPoll.updateMany({
          where: {
            id: poll.id,
            creatorId,
            status: 'DRAFT',
            draftStep: poll.draftStep,
          },
          data: { question, draftStep: nextStep },
        });
        if (updated.count !== 1) {
          await ctx.reply('This poll step has already been completed.');
          return;
        }
        if (nextStep === 'READY') {
          await showPollPreview(ctx, database, poll.id, creatorId);
        } else {
          await showPollPrompt(
            ctx,
            database,
            poll.id,
            creatorId,
            'Send the options, one per line.',
          );
        }
        return;
      }

      if (poll.draftStep === 'ADD_OPTION') {
        const option = text.trim();
        if (option.length === 0 || option.length > 100) {
          throw new FormInputError('Send one option of up to 100 characters.');
        }
        const result = await database.$transaction(async (transaction) => {
          const claimed = await transaction.smartPoll.updateMany({
            where: {
              id: poll.id,
              creatorId,
              status: 'DRAFT',
              draftStep: 'ADD_OPTION',
            },
            data: { draftStep: 'READY' },
          });
          if (claimed.count !== 1) {
            return false;
          }
          const options = await transaction.smartPollOption.findMany({
            where: { pollId: poll.id },
            orderBy: { position: 'asc' },
          });
          if (
            options.length >= MAX_OPTIONS ||
            options.some(
              (existing) =>
                existing.text.toLocaleLowerCase() === option.toLocaleLowerCase(),
            )
          ) {
            throw new FormInputError(
              options.length >= MAX_OPTIONS
                ? `A poll can have up to ${MAX_OPTIONS} options.`
                : 'Please use a different option.',
            );
          }
          await transaction.smartPollOption.create({
            data: { pollId: poll.id, position: options.length, text: option },
          });
          return true;
        });
        if (!result) {
          await ctx.reply('This poll step has already been completed.');
          return;
        }
        await showPollPreview(ctx, database, poll.id, creatorId);
        return;
      }

      const options = parseOptions(text);
      const result = await database.$transaction(async (transaction) => {
        const claimed = await transaction.smartPoll.updateMany({
          where: {
            id: poll.id,
            creatorId,
            status: 'DRAFT',
            draftStep: poll.draftStep,
          },
          data: { draftStep: 'READY' },
        });
        if (claimed.count !== 1) {
          return false;
        }
        await transaction.smartPollOption.deleteMany({
          where: { pollId: poll.id },
        });
        await transaction.smartPollOption.createMany({
          data: options.map((option, position) => ({
            pollId: poll.id,
            position,
            text: option,
          })),
        });
        return true;
      });
      if (!result) {
        await ctx.reply('This poll step has already been completed.');
        return;
      }
      await showPollPreview(ctx, database, poll.id, creatorId);
    } catch (error) {
      if (error instanceof FormInputError) {
        await ctx.reply(error.message, promptKeyboard(poll.id));
        return;
      }
      logger.error(
        {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          operation: 'native-poll-draft-input',
          pollId: poll.id,
        },
        'Could not save poll draft input',
      );
      throw error;
    }
  });
}
