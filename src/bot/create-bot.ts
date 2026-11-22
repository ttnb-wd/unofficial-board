import type { PrismaClient } from '@prisma/client';
import { Markup, Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { AppConfig } from '../config.js';
import { isAuthorizedFeatureContext } from '../access/authorization.js';
import { verifyAndRecordMembership } from '../access/membership.js';
import { hasPrelaunchAccess } from '../access/policy.js';
import { registerBudgetVoteHandlers } from '../features/group-budget-vote/bot.js';
import { findFeature, features } from '../features/index.js';
import { registerSmartPollHandlers } from '../features/smart-poll/bot.js';
import type { createLogger } from '../logger.js';
import { registerBirthdayMenu } from '../features/birthday-reminder/bot.js';
import { registerBillMenus } from '../features/bill-splitter/bot.js';
import { registerVoting } from './voting.js';
import {
  dashboardKeyboard,
  featureKeyboard,
  showScreen,
} from './navigation.js';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function dashboardText(): string {
  return `The Unofficial Board\n\nChoose a feature to get started. Smart Poll, Group Budget Vote, Bill Splitter, and Birthday Reminder are available.\n\n${features.map((feature) => `• ${feature.title}`).join('\n')}`;
}

export function createBot(
  config: AppConfig,
  database: PrismaClient,
  botUsername: string,
  logger: ReturnType<typeof createLogger>,
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

  bot.use(async (ctx, next) => {
    if (config.accessMode === 'PRELAUNCH' && ctx.chat?.type !== 'private') {
      return;
    }
    await next();
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
      await ctx.reply(dashboardText(), dashboardKeyboard());
      return;
    }

    if (
      config.accessMode !== 'LIVE' ||
      BigInt(ctx.chat.id) !== config.groupId ||
      !ctx.from
    ) {
      return;
    }

    try {
      const active = await verifyAndRecordMembership(
        ctx.telegram,
        database,
        config.groupId,
        BigInt(ctx.from.id),
      );
      if (!active) {
        return;
      }
    } catch (error) {
      logger.warn(
        { errorName: errorName(error), operation: 'group-menu-membership-check' },
        'Group member verification failed',
      );
      return;
    }

    await ctx.reply(
      'Open the private bot chat to access the group dashboard.',
      Markup.inlineKeyboard([
        [
          Markup.button.url(
            'Open private dashboard',
            `https://t.me/${botUsername}?start=dashboard`,
          ),
        ],
      ]),
    );
  });

  registerBillMenus(bot, config, authorize);
  registerBirthdayMenu(bot, config, database, authorize);
  registerVoting(bot, config, database, botUsername, authorize);

  bot.start(async (ctx) => {
    if (ctx.chat.type !== 'private' || !ctx.from) {
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

    await ctx.reply(
      dashboardText(),
      dashboardKeyboard(),
    );
  });

  registerSmartPollHandlers(bot, config, database, logger, authorize);
  registerBudgetVoteHandlers(bot, config, database, logger, authorize);

  bot.action(/^draft:cancel:(poll|budget):[a-z0-9]+$/, async (ctx) => {
    if (!await authorize(ctx)) {
      await ctx.answerCbQuery('Private, authorized access is required.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    await showScreen(ctx, 'Switch cancelled. Your draft is unchanged.', dashboardKeyboard());
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
        where: { creatorId, status: 'DRAFT', draftStep: { not: 'SAVED' } },
        data: { status: 'CANCELLED' },
      }),
      database.budgetVote.updateMany({
        where: { creatorId, status: 'DRAFT', draftStep: { not: 'SAVED' } },
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
    await showScreen(ctx, dashboardText(), dashboardKeyboard());
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
    if (
      hasPrelaunchAccess(
        config.accessMode,
        config.prelaunchOwnerId,
        BigInt(ctx.from.id),
      )
    ) {
      return 'active';
    }
    if (config.accessMode !== 'LIVE') {
      return 'inactive';
    }

    const active = await verifyAndRecordMembership(
      ctx.telegram,
      database,
      config.groupId,
      BigInt(ctx.from.id),
    );
    return active ? 'active' : 'inactive';
  } catch (error) {
    logger.warn(
      { errorName: errorName(error), operation: 'private-membership-check' },
      'Private-chat member verification failed',
    );
    return 'unavailable';
  }
}
