import type { PrismaClient } from '@prisma/client';
import { Markup, Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { AppConfig } from '../../config.js';
import { verifyAndRecordMembership } from '../../access/membership.js';
import type { createLogger } from '../../logger.js';
import { registerSmartPollMiniAppLaunch } from './native-form.js';

type Authorize = (ctx: Context, allowGroupChat?: boolean) => Promise<boolean>;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function settingsKeyboard(
  pollId: string,
  allowsMultipleAnswers: boolean,
  isAnonymous: boolean,
  accessMode: AppConfig['accessMode'],
) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `Multiple answers: ${allowsMultipleAnswers ? 'On' : 'Off'}`,
        `poll:multi:${pollId}`,
      ),
      Markup.button.callback(
        `Anonymous: ${isAnonymous ? 'On' : 'Off'}`,
        `poll:anon:${pollId}`,
      ),
    ],
    [
      Markup.button.callback(
        accessMode === 'PRELAUNCH' ? 'Preview privately' : 'Publish to group',
        `poll:publish:${pollId}`,
      ),
    ],
  ]);
}

function pollSettingsText(
  poll: {
    question: string | null;
    allowsMultipleAnswers: boolean;
    isAnonymous: boolean;
    options: { text: string }[];
  },
): string {
  return [
    'Review your poll',
    '',
    poll.question,
    ...poll.options.map((option, index) => `${index + 1}. ${option.text}`),
    '',
    `Multiple answers: ${poll.allowsMultipleAnswers ? 'Yes' : 'No'}`,
    `Anonymous: ${poll.isAnonymous ? 'Yes' : 'No'}`,
  ].join('\n');
}

export function registerSmartPollHandlers(
  bot: Telegraf,
  config: AppConfig,
  database: PrismaClient,
  logger: ReturnType<typeof createLogger>,
  authorize: Authorize,
): void {
  registerSmartPollMiniAppLaunch(bot, config, authorize);

  async function listPolls(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const polls = await database.smartPoll.findMany({
      where: { creatorId: BigInt(ctx.from.id) },
      include: { options: { orderBy: { position: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    if (polls.length === 0) {
      await ctx.reply('You have no saved polls. Send /poll to create one.');
      return;
    }

    for (const poll of polls) {
      const canClose = poll.status === 'PRELAUNCH_PREVIEW' ||
        (config.accessMode === 'LIVE' && poll.status === 'OPEN');
      const actions = canClose
          ? Markup.inlineKeyboard([
              [Markup.button.callback('Close poll', `poll:close:${poll.id}`)],
            ])
          : undefined;
      await ctx.reply(
        [
          poll.question ?? 'Untitled poll',
          ...poll.options.map(({ text }) => text),
          `Status: ${poll.status}`,
        ].join('\n'),
        actions,
      );
    }
  }

  bot.action('poll:list', async (ctx) => {
    if (!(await authorize(ctx))) {
      await ctx.answerCbQuery('Private, authorized access is required.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    await listPolls(ctx);
  });

  bot.command('polls', async (ctx) => {
    if (await authorize(ctx)) await listPolls(ctx);
  });

  bot.action(/^poll:(multi|anon):([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || ctx.chat?.type !== 'private' || !ctx.from) {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const setting = ctx.match[1];
    const pollId = ctx.match[2];
    if (!setting || !pollId) {
      await ctx.answerCbQuery('This poll setting is invalid.', { show_alert: true });
      return;
    }
    const poll = await database.smartPoll.findFirst({
      where: {
        id: pollId,
        creatorId: BigInt(ctx.from.id),
        status: 'DRAFT',
      },
      include: { options: { orderBy: { position: 'asc' } } },
    });
    if (!poll) {
      await ctx.answerCbQuery('This poll draft is no longer available.', {
        show_alert: true,
      });
      return;
    }
    const data =
      setting === 'multi'
        ? { allowsMultipleAnswers: !poll.allowsMultipleAnswers }
        : { isAnonymous: !poll.isAnonymous };
    const updated = await database.smartPoll.update({
      where: { id: poll.id },
      data,
      include: { options: { orderBy: { position: 'asc' } } },
    });
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      pollSettingsText(updated),
      settingsKeyboard(
        updated.id,
        updated.allowsMultipleAnswers,
        updated.isAnonymous,
        config.accessMode,
      ),
    );
  });

  bot.action(/^poll:publish:([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || ctx.chat?.type !== 'private' || !ctx.from) {
      await ctx.answerCbQuery('Private, authorized access is required.', {
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
      where: {
        id: pollId,
        creatorId: BigInt(ctx.from.id),
        status: 'DRAFT',
      },
      include: { options: { orderBy: { position: 'asc' } } },
    });
    if (!poll?.question || poll.options.length < 2) {
      await ctx.answerCbQuery('A poll needs a question and at least two answers.', {
        show_alert: true,
      });
      return;
    }

    if (config.accessMode === 'PRELAUNCH') {
      const claimed = await database.smartPoll.updateMany({
        where: { id: poll.id, creatorId: poll.creatorId, status: 'DRAFT' },
        data: { status: 'PRELAUNCH_PREVIEW' },
      });
      if (claimed.count !== 1) {
        await ctx.answerCbQuery('This poll has already been processed.', {
          show_alert: true,
        });
        return;
      }
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        [
          'Private poll preview (not sent to the group)',
          '',
          pollSettingsText(poll),
          '',
          'Native Telegram group poll delivery requires LIVE mode.',
        ].join('\n'),
        Markup.inlineKeyboard([
          [Markup.button.callback('Close preview', `poll:close:${poll.id}`)],
        ]),
      );
      return;
    }

    const claimed = await database.smartPoll.updateMany({
      where: { id: poll.id, creatorId: poll.creatorId, status: 'DRAFT' },
      data: { status: 'PUBLISHING' },
    });
    if (claimed.count !== 1) {
      await ctx.answerCbQuery('This poll has already been processed.', {
        show_alert: true,
      });
      return;
    }

    let sentMessage: Awaited<ReturnType<typeof ctx.telegram.sendPoll>> | undefined;
    try {
      sentMessage = await ctx.telegram.sendPoll(
        config.groupId.toString(),
        poll.question,
        poll.options.map((option) => option.text),
        {
          is_anonymous: poll.isAnonymous,
          allows_multiple_answers: poll.allowsMultipleAnswers,
        },
      );
      await database.smartPoll.update({
        where: { id: poll.id },
        data: {
          status: 'OPEN',
          telegramPollId: sentMessage.poll.id,
          telegramMessageId: sentMessage.message_id,
        },
      });
    } catch (error) {
      if (sentMessage) {
        try {
          await ctx.telegram.stopPoll(
            config.groupId.toString(),
            sentMessage.message_id,
          );
        } catch (stopError) {
          logger.error(
            {
              errorName: errorName(stopError),
              operation: 'compensate-failed-poll-publish',
              pollId: poll.id,
            },
            'Could not stop a poll whose database update failed',
          );
        }
      }
      await database.smartPoll.updateMany({
        where: { id: poll.id, status: 'PUBLISHING' },
        data: { status: 'DRAFT' },
      });
      throw error;
    }
    await ctx.answerCbQuery('Poll published.');
    await ctx.editMessageText(
      'Your poll is live in the configured group.',
      Markup.inlineKeyboard([
        [Markup.button.callback('Close poll', `poll:close:${poll.id}`)],
      ]),
    );
  });

  bot.action(/^poll:close:([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || !ctx.from) {
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
      where: { id: pollId, creatorId: BigInt(ctx.from.id) },
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
      config.accessMode === 'LIVE' &&
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
          config.groupId.toString(),
          poll.telegramMessageId,
        );
      } catch (error) {
        await database.smartPoll.updateMany({
          where: { id: poll.id, status: 'CLOSING' },
          data: { status: 'OPEN' },
        });
        throw error;
      }
    } else if (poll.status !== 'PRELAUNCH_PREVIEW') {
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
  });

  bot.on('poll_answer', async (ctx) => {
    const answer = ctx.update.poll_answer;
    const user = answer.user;
    if (!user) {
      return;
    }
    const poll = await database.smartPoll.findUnique({
      where: { telegramPollId: answer.poll_id },
      include: { options: { orderBy: { position: 'asc' } } },
    });
    if (!poll || poll.status !== 'OPEN' || poll.isAnonymous) {
      return;
    }
    try {
      const active = await verifyAndRecordMembership(
        ctx.telegram,
        database,
        config.groupId,
        BigInt(user.id),
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
    const incoming = ctx.update.poll;
    const poll = await database.smartPoll.findUnique({
      where: { telegramPollId: incoming.id },
    });
    if (!poll) {
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

