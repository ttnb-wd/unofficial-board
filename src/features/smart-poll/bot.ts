import { allowsGroupWorkflows, groupDestination } from '../../access/policy.js';
import type { PrismaClient } from '@prisma/client';
import type { Telegraf } from 'telegraf';
import { navigationRow, showScreen } from '../../bot/navigation.js';
import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import type { AppConfig } from '../../config.js';
import { canAccessBoard } from '../../access/membership.js';
import type { createLogger } from '../../logger.js';
import { registerSmartPollMiniAppLaunch } from './native-form.js';

type Authorize = (ctx: Context, allowGroupChat?: boolean) => Promise<boolean>;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export function registerSmartPollHandlers(
  bot: Telegraf,
  config: AppConfig,
  database: PrismaClient,
  logger: ReturnType<typeof createLogger>,
  authorize: Authorize,
): void {
  registerSmartPollMiniAppLaunch(bot, config, authorize);

  bot.action(/^poll:close:([a-z0-9]+)$/, async (ctx) => {
    if (!allowsGroupWorkflows(config) || !(await authorize(ctx)) || !ctx.from) {
      await ctx.answerCbQuery('Authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const pollId = ctx.match[1];
    if (!pollId) {
      await ctx.answerCbQuery('This poll reference is invalid.', { show_alert: true });
      return;
    }
    const poll = await database.smartPoll.findFirst({
      where: { id: pollId, creatorId: BigInt(ctx.from.id), groupId: config.groupId },
    });
    if (!poll) {
      await ctx.answerCbQuery('Only the poll creator can close it.', {
        show_alert: true,
      });
      return;
    }
    if (poll.status === 'CLOSED' || poll.status === 'CANCELLED') {
      await ctx.answerCbQuery('This poll is already closed.');
      return;
    }
    if (
      poll.telegramPollId !== null &&
      !poll.isPrelaunchTest &&
      poll.status === 'OPEN' &&
      poll.telegramMessageId !== null
    ) {
      const claimed = await database.smartPoll.updateMany({
        where: { id: poll.id, creatorId: poll.creatorId, status: 'OPEN' },
        data: { status: 'CLOSING' },
      });
      if (claimed.count !== 1) {
        await ctx.answerCbQuery('This poll is already being closed.', {
          show_alert: true,
        });
        return;
      }
      try {
        await ctx.telegram.stopPoll(
          groupDestination(config, poll.groupId),
          poll.telegramMessageId,
        );
      } catch (error) {
        await database.smartPoll.updateMany({
          where: { id: poll.id, status: 'CLOSING' },
          data: { status: 'OPEN' },
        });
        throw error;
      }
    } else {
      await ctx.answerCbQuery('This poll cannot be closed in its current state.', {
        show_alert: true,
      });
      return;
    }
    await database.smartPoll.update({
      where: { id: poll.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    await ctx.answerCbQuery('Poll closed.');
    await showScreen(ctx, 'Poll closed.', Markup.inlineKeyboard([navigationRow('poll:list')]));
  });

  bot.on('poll_answer', async (ctx) => {
    if (!allowsGroupWorkflows(config)) return;
    const answer = ctx.update.poll_answer;
    const user = answer.user;
    if (!user) {
      return;
    }
    const poll = await database.smartPoll.findUnique({
      where: { telegramPollId: answer.poll_id, groupId: config.groupId },
      include: { options: { orderBy: { position: 'asc' } } },
    });
    if (!poll || poll.groupId !== config.groupId || poll.isPrelaunchTest || poll.status !== 'OPEN' || poll.isAnonymous) {
      return;
    }
    try {
      const active = await canAccessBoard(
        ctx.telegram,
        database,
        config,
        BigInt(user.id),
        false,
      );
      if (!active) {
        return;
      }
      const selectedOptions = answer.option_ids
        .map((index) => poll.options[index])
        .filter((option) => option !== undefined);
      if (selectedOptions.length !== answer.option_ids.length) {
        return;
      }
      await database.$transaction(async (transaction) => {
        const locked = await transaction.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "SmartPoll"
          WHERE "id" = ${poll.id} AND "groupId" = ${config.groupId} AND "status" = 'OPEN' FOR UPDATE
        `;
        if (!locked.length) return;
        await transaction.smartPollVote.deleteMany({
          where: { pollId: poll.id, memberId: BigInt(user.id) },
        });
        if (selectedOptions.length > 0) {
          await transaction.smartPollVote.createMany({
            data: selectedOptions.map((option) => ({
              pollId: poll.id,
              memberId: BigInt(user.id),
              optionId: option.id,
            })),
          });
        }
      });
    } catch (error) {
      logger.warn(
        {
          errorName: errorName(error),
          operation: 'record-visible-poll-vote',
          pollId: poll.id,
        },
        'Could not record a poll vote',
      );
    }
  });

  bot.on('poll', async (ctx) => {
    if (!allowsGroupWorkflows(config)) return;
    const incoming = ctx.update.poll;
    const poll = await database.smartPoll.findUnique({
      where: { telegramPollId: incoming.id, groupId: config.groupId },
    });
    if (!poll || poll.groupId !== config.groupId || poll.isPrelaunchTest) {
      return;
    }
    await database.smartPoll.update({
      where: { id: poll.id },
      data: {
        totalVoterCount: incoming.total_voter_count,
        ...(incoming.is_closed
          ? { status: 'CLOSED', closedAt: new Date() }
          : {}),
      },
    });
  });
}

