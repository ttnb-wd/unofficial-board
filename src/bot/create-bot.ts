import type { PrismaClient } from '@prisma/client';
import { Markup, Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { AppConfig } from '../config.js';
import { isAuthorizedFeatureContext } from '../access/authorization.js';
import { canAccessBoard, verifyAndRecordMembership } from '../access/membership.js';
import { allowsGroupWorkflows, groupDestination, isOwnerPreview } from '../access/policy.js';
import { registerBudgetVoteHandlers } from '../features/group-budget-vote/bot.js';
import { findFeature, features } from '../features/index.js';
import { registerSmartPollHandlers } from '../features/smart-poll/bot.js';
import type { createLogger } from '../logger.js';
import { registerBirthdayMenu } from '../features/birthday-reminder/bot.js';
import { registerBillMenus } from '../features/bill-splitter/bot.js';
import { countdownKeyboard, registerCountdownMenu } from '../features/plan-countdown/bot.js';
import { hangoutKeyboard, registerHangoutMenu } from '../features/one-tap-hangout/bot.js';
import { registerVoting } from './voting.js';
import {
  dashboardKeyboard,
  featureEntryButton,
  featureKeyboard,
  featureOptionRows,
  optionsKeyboard,
  showScreen,
} from './navigation.js';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function dashboardText(): string {
  return `The Unofficial Board\n\nChoose a feature to get started. Smart Poll, Group Budget Vote, Bill Splitter, Birthday Reminder, Plan Countdown, and One Tap Hangout are available.\n\n${features.map((feature) => `• ${feature.title}`).join('\n')}`;
}

export function createBot(
  config: AppConfig,
  database: PrismaClient,
  botUsername: string,
  logger: ReturnType<typeof createLogger>,
  wakeHangouts = () => {},
): Telegraf {
  const bot = new Telegraf(config.botToken);
  const authorize = (ctx: Context, allowGroupChat = false) =>
    isAuthorizedFeatureContext(
      ctx,
      config,
      database,
      logger,
      allowGroupChat,
    );

  async function showPrivateDashboard(ctx: Context) {
    await ctx.reply(dashboardText(), dashboardKeyboard(config));
    await ctx.reply('Use the keyboard icon to switch between bot options and typing.', optionsKeyboard());
  }

  bot.use(async (ctx, next) => {
    if (isOwnerPreview(config) && ctx.chat?.type !== 'private') return;
    if (config.testGroup && ctx.chat && ctx.chat.type !== 'private' &&
        (!['group', 'supergroup'].includes(ctx.chat.type) || BigInt(ctx.chat.id) !== config.groupId)) return;
    await next();
  });

  async function showGroupEntry(ctx: Context) {
    if (!await authorize(ctx, true)) return;
    groupDestination(config, BigInt(ctx.chat!.id));
    await ctx.reply(
      'Open the private bot chat to access the group dashboard.',
      Markup.inlineKeyboard([[
        Markup.button.url('Open private dashboard', `https://t.me/${botUsername}?start=dashboard`),
      ]]),
    );
  }

  bot.command('test_group', async (ctx) => {
    if (!config.testGroup || BigInt(ctx.from.id) !== config.prelaunchOwnerId ||
        ctx.chat.type === 'private' || !await authorize(ctx, true)) return;
    const destination = groupDestination(config, BigInt(ctx.chat.id));
    await ctx.reply(`Test group active (${destination}). Access mode is ${config.accessMode}.`);
  });

  bot.command(['test_allow', 'test_revoke'], async (ctx) => {
    if (!config.testGroup || ctx.chat.type !== 'private' || BigInt(ctx.from.id) !== config.prelaunchOwnerId) return;
    const memberId = /^[1-9]\d{0,15}$/.test(ctx.payload) ? BigInt(ctx.payload) : 0n;
    if (memberId === 0n || memberId > BigInt(Number.MAX_SAFE_INTEGER) || memberId === config.prelaunchOwnerId) {
      await ctx.reply('Enter a participant’s numeric Telegram user ID after the command.');
      return;
    }
    const groupId = config.groupId;
    groupDestination(config, groupId);
    const allow = ctx.command === 'test_allow';
    if (allow && !await verifyAndRecordMembership(ctx.telegram, database, groupId, memberId, true)) {
      await ctx.reply('This user must be a current test group member.');
      return;
    }
    const result = await database.groupMembership.updateMany({
      where: { groupId, memberId }, data: { testAuthorized: allow },
    });
    await ctx.reply(allow && result.count === 1 ? 'Test access granted.' : 'Test access is off for this user.');
  });

  bot.command('menu', async (ctx) => {
    if (ctx.chat.type === 'private') {
      const access = await checkPrivateAccess(ctx, config, database, logger);
      if (access === 'inactive') {
        await ctx.reply('This bot is available to current members of its group.');
        return;
      }
      if (access === 'unavailable') {
        await ctx.reply('I could not verify your group access. Please try again later.');
        return;
      }
      await showPrivateDashboard(ctx);
      return;
    }

    await showGroupEntry(ctx);
  });

  registerBillMenus(bot, config, authorize);
  registerBirthdayMenu(bot, config, database, authorize);
  registerCountdownMenu(bot, config, authorize);
  registerHangoutMenu(bot, config, database, authorize, wakeHangouts);
  registerVoting(bot, config, database, botUsername, authorize);

  bot.start(async (ctx) => {
    if (ctx.chat.type !== 'private') {
      if (config.testGroup) await showGroupEntry(ctx);
      return;
    }

    const access = await checkPrivateAccess(ctx, config, database, logger);
    if (access === 'inactive') {
      await ctx.reply('This bot is available to current members of its group.');
      return;
    }
    if (access === 'unavailable') {
      await ctx.reply('I could not verify your group access. Please try again later.');
      return;
    }

    const hangoutId = /^hangout_([A-Za-z0-9_-]{1,48})$/.exec(ctx.startPayload)?.[1];
    if (hangoutId && allowsGroupWorkflows(config)) {
      await ctx.reply('Hangout Details', hangoutKeyboard(config, hangoutId));
      return;
    }

    const countdownId = /^countdown_([0-9a-f-]{36})$/.exec(ctx.startPayload)?.[1];
    if (countdownId && allowsGroupWorkflows(config)) {
      await ctx.reply('Plan Countdown', countdownKeyboard(config, countdownId));
      return;
    }

    await showPrivateDashboard(ctx);
  });

  for (const { id, text } of featureOptionRows.flat()) {
    bot.hears(text, async (ctx, next) => {
      if (ctx.chat.type !== 'private') return next();
      if (await checkPrivateAccess(ctx, config, database, logger) !== 'active') return;
      await ctx.reply('Open this feature in The Board.', Markup.inlineKeyboard([featureEntryButton(config, id, text)]));
    });
  }

  registerSmartPollHandlers(bot, config, database, logger, authorize);
  registerBudgetVoteHandlers(bot, config, database, authorize);

  bot.action(/^draft:cancel:(poll|budget):[a-z0-9]+$/, async (ctx) => {
    if (!await authorize(ctx)) {
      await ctx.answerCbQuery('Private, authorized access is required.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    await showScreen(ctx, 'Switch cancelled. Your draft is unchanged.', dashboardKeyboard(config));
  });

  bot.command('cancel', async (ctx) => {
    if (
      !(await authorize(ctx)) ||
      ctx.chat.type !== 'private' ||
      !ctx.from
    ) {
      return;
    }
    const creatorId = BigInt(ctx.from.id);
    const [polls, votes] = await database.$transaction([
      database.smartPoll.updateMany({
        where: { groupId: config.groupId, creatorId, status: 'DRAFT', draftStep: { not: 'SAVED' } },
        data: { status: 'CANCELLED' },
      }),
      database.budgetVote.updateMany({
        where: { groupId: config.groupId, creatorId, status: 'DRAFT', draftStep: { not: 'SAVED' } },
        data: { status: 'CANCELLED' },
      }),
    ]);
    await ctx.reply(
      polls.count + votes.count > 0
        ? 'Draft cancelled. It was not published to the group.'
        : 'There is no active draft to cancel.',
      featureKeyboard(),
    );
  });

  bot.action(/^feature:([a-z-]+)$/, async (ctx) => {
    const access = await checkPrivateAccess(ctx, config, database, logger);
    if (access !== 'active') {
      await ctx.answerCbQuery(
        access === 'inactive'
          ? 'Current group membership is required.'
          : 'Unable to verify access. Try again later.',
        { show_alert: true },
      );
      return;
    }

    const feature = findFeature(ctx.match[1] ?? '');
    if (!feature) {
      await ctx.answerCbQuery('This feature is unavailable.');
      return;
    }

    await ctx.answerCbQuery();
    await showScreen(ctx,
      `${feature.title}\n\n${feature.description}\n\nThis feature is a Step 01 scaffold.`,
      featureKeyboard(),
    );
  });

  bot.action(/^nav:(back|home|cancel)$/, async (ctx) => {
    const access = await checkPrivateAccess(ctx, config, database, logger);
    if (access !== 'active') {
      await ctx.answerCbQuery(
        access === 'inactive'
          ? 'Current group membership is required.'
          : 'Unable to verify access. Try again later.',
        { show_alert: true },
      );
      return;
    }

    await ctx.answerCbQuery();
    await showScreen(ctx, dashboardText(), dashboardKeyboard(config));
  });

  bot.on('callback_query', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      await ctx.answerCbQuery('This button has expired. Use /menu to reopen the dashboard.');
    }
  });

  bot.catch((error, ctx) => {
    logger.error(
      { errorName: errorName(error), updateType: ctx.updateType },
      'Telegram update failed',
    );
  });

  return bot;
}

async function checkPrivateAccess(
  ctx: Context,
  config: AppConfig,
  database: PrismaClient,
  logger: ReturnType<typeof createLogger>,
): Promise<'active' | 'inactive' | 'unavailable'> {
  if (ctx.chat?.type !== 'private' || !ctx.from) {
    return 'inactive';
  }

  try {
    const active = await canAccessBoard(ctx.telegram, database, config, BigInt(ctx.from.id), true);
    return active ? 'active' : 'inactive';
  } catch (error) {
    logger.warn(
      { errorName: errorName(error), operation: 'private-membership-check' },
      'Private-chat member verification failed',
    );
    return 'unavailable';
  }
}
