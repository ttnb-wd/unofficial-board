import type { PrismaClient } from '@prisma/client';
import { Markup, Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { AppConfig } from '../../config.js';
import type { createLogger } from '../../logger.js';
import { registerBudgetMiniAppLaunch } from './native-form.js';

type Authorize = (ctx: Context, allowGroupChat?: boolean) => Promise<boolean>;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function formatMmk(amount: bigint): string {
  return new Intl.NumberFormat('en-US').format(amount);
}

function budgetVoteKeyboard(
  voteId: string,
  ranges: { id: string; minMmk: bigint; maxMmk: bigint }[],
  includeClose: boolean,
) {
  const rows = ranges.map((range) => [
    Markup.button.callback(
      `${formatMmk(range.minMmk)}-${formatMmk(range.maxMmk)} MMK`,
    `bv:vote:${voteId}:${range.id}`,
    ),
  ]);
  rows.push([
    Markup.button.callback('Results', `bv:results:${voteId}`),
  ]);
  if (includeClose) {
    rows.push([
      Markup.button.callback('Close vote', `bv:close:${voteId}`),
    ]);
  }
  return Markup.inlineKeyboard(rows);
}

function exactBudgetVoteKeyboard(
  voteId: string,
  options: { id: string; amountMmk: bigint }[],
  includeClose: boolean,
) {
  const rows = options.map((option) => [
    Markup.button.callback(
      `${formatMmk(option.amountMmk)} MMK`,
      `bv:amount:${voteId}:${option.id}`,
    ),
  ]);
  rows.push([
    Markup.button.callback('Results', `bv:amount-results:${voteId}`),
  ]);
  if (includeClose) {
    rows.push([Markup.button.callback('Close vote', `bv:close:${voteId}`)]);
  }
  return Markup.inlineKeyboard(rows);
}

async function getExactVoteCounts(
  database: PrismaClient,
  voteId: string,
): Promise<Map<string, number>> {
  const grouped = await database.$queryRaw<
    { optionId: string; count: bigint }[]
  >`
    SELECT "optionId", COUNT(*) AS "count"
    FROM "BudgetVoteOptionBallot"
    WHERE "budgetVoteId" = ${voteId}
    GROUP BY "optionId"
  `;
  return new Map(grouped.map((item) => [item.optionId, Number(item.count)]));
}

function renderBudgetVote(
  vote: {
    title: string | null;
    ranges: { id: string; position: number; minMmk: bigint; maxMmk: bigint }[];
  },
  counts: Map<string, number>,
): string {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return [
    vote.title ?? 'Group budget vote',
    '',
    ...vote.ranges.map(
      (range) =>
        `${formatMmk(range.minMmk)}-${formatMmk(range.maxMmk)} MMK: ${counts.get(range.id) ?? 0}`,
    ),
    '',
    `Total votes: ${total}`,
    'Choose a range to cast or update your vote.',
  ].join('\n');
}

function renderExactBudgetVote(
  title: string | null,
  options: { id: string; amountMmk: bigint }[],
  counts: Map<string, number>,
): string {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return [
    title ?? 'Group budget vote',
    '',
    ...options.map(
      (option) =>
        `${formatMmk(option.amountMmk)} MMK: ${counts.get(option.id) ?? 0}`,
    ),
    '',
    `Total votes: ${total}`,
    'Choose an amount to cast or update your vote.',
  ].join('\n');
}

async function getVoteCounts(
  database: PrismaClient,
  voteId: string,
): Promise<Map<string, number>> {
  const grouped = await database.budgetVoteBallot.groupBy({
    by: ['rangeId'],
    where: { budgetVoteId: voteId },
    _count: { _all: true },
  });
  return new Map(grouped.map((item) => [item.rangeId, item._count._all]));
}

export function registerBudgetVoteHandlers(
  bot: Telegraf,
  config: AppConfig,
  database: PrismaClient,
  logger: ReturnType<typeof createLogger>,
  authorize: Authorize,
): void {
  registerBudgetMiniAppLaunch(bot, config, authorize);

  async function listBudgetVotes(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const votes = await database.budgetVote.findMany({
      where: { creatorId: BigInt(ctx.from.id) },
      include: { ranges: { orderBy: { position: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    if (votes.length === 0) {
      await ctx.reply('You have no budget votes. Send /budget to create one.');
      return;
    }
    for (const vote of votes) {
      const options = await database.$queryRaw<
        { id: string; amountMmk: bigint }[]
      >`
        SELECT "id", "amountMmk"
        FROM "BudgetVoteOption"
        WHERE "budgetVoteId" = ${vote.id}
        ORDER BY "position" ASC
      `;
      const isOpen = vote.status === 'PRELAUNCH_OPEN' ||
        (config.accessMode === 'LIVE' && vote.status === 'OPEN');
      const actions =
        options.length > 0 && isOpen
          ? exactBudgetVoteKeyboard(vote.id, options, true)
          : isOpen
            ? Markup.inlineKeyboard([
                [Markup.button.callback('Close vote', `bv:close:${vote.id}`)],
              ])
            : undefined;
      const counts =
        options.length > 0
          ? await getExactVoteCounts(database, vote.id)
          : await getVoteCounts(database, vote.id);
      await ctx.reply(
        `${options.length > 0
          ? renderExactBudgetVote(vote.title, options, counts)
          : renderBudgetVote(vote, counts)}\nStatus: ${vote.status}`,
        actions,
      );
    }
  }

  bot.action('bv:list', async (ctx) => {
    if (!(await authorize(ctx))) {
      await ctx.answerCbQuery('Private, authorized access is required.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    await listBudgetVotes(ctx);
  });

  bot.command('budgets', async (ctx) => {
    if (await authorize(ctx)) await listBudgetVotes(ctx);
  });

  bot.action(/^bv:publish:([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || ctx.chat?.type !== 'private' || !ctx.from) {
      await ctx.answerCbQuery('Private, authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const voteId = ctx.match[1];
    if (!voteId) {
      await ctx.answerCbQuery('This vote reference is invalid.', { show_alert: true });
      return;
    }
    const vote = await database.budgetVote.findFirst({
      where: {
        id: voteId,
        creatorId: BigInt(ctx.from.id),
        status: 'DRAFT',
        draftStep: { in: ['READY', 'SAVED'] },
      },
      include: {
        ranges: { orderBy: { position: 'asc' } },
        options: { orderBy: { position: 'asc' } },
      },
    });
    if (
      !vote?.title ||
      (vote.options.length < 2 && vote.ranges.length < 2)
    ) {
      await ctx.answerCbQuery('Add a title and at least two choices first.', {
        show_alert: true,
      });
      return;
    }

    if (config.accessMode === 'PRELAUNCH') {
      const claimed = await database.budgetVote.updateMany({
        where: { id: vote.id, creatorId: vote.creatorId, status: 'DRAFT' },
        data: { status: 'PRELAUNCH_OPEN' },
      });
      if (claimed.count !== 1) {
        await ctx.answerCbQuery('This vote has already been processed.', {
          show_alert: true,
        });
        return;
      }
      await ctx.answerCbQuery();
      const exact = vote.options.length > 0;
      const counts = exact
        ? await getExactVoteCounts(database, vote.id)
        : await getVoteCounts(database, vote.id);
      await ctx.editMessageText(
        `Private owner-only budget vote (not sent to the group)\n\n${
          exact
            ? renderExactBudgetVote(vote.title, vote.options, counts)
            : renderBudgetVote(vote, counts)
        }`,
        exact
          ? exactBudgetVoteKeyboard(vote.id, vote.options, true)
          : budgetVoteKeyboard(vote.id, vote.ranges, true),
      );
      return;
    }

    const claimed = await database.budgetVote.updateMany({
      where: { id: vote.id, creatorId: vote.creatorId, status: 'DRAFT' },
      data: { status: 'PUBLISHING' },
    });
    if (claimed.count !== 1) {
      await ctx.answerCbQuery('This vote has already been processed.', {
        show_alert: true,
      });
      return;
    }
    let sentMessage: Awaited<ReturnType<typeof ctx.telegram.sendMessage>> | undefined;
    try {
      const exact = vote.options.length > 0;
      sentMessage = await ctx.telegram.sendMessage(
        config.groupId.toString(),
        exact
          ? renderExactBudgetVote(vote.title, vote.options, new Map())
          : renderBudgetVote(vote, new Map()),
        exact
          ? exactBudgetVoteKeyboard(vote.id, vote.options, false)
          : budgetVoteKeyboard(vote.id, vote.ranges, false),
      );
      await database.budgetVote.update({
        where: { id: vote.id },
        data: { status: 'OPEN', telegramMessageId: sentMessage.message_id },
      });
    } catch (error) {
      if (sentMessage) {
        try {
          await ctx.telegram.deleteMessage(
            config.groupId.toString(),
            sentMessage.message_id,
          );
        } catch (deleteError) {
          logger.error(
            {
              errorName: errorName(deleteError),
              operation: 'compensate-failed-budget-publish',
              budgetVoteId: vote.id,
            },
            'Could not remove a budget vote whose database update failed',
          );
        }
      }
      await database.budgetVote.updateMany({
        where: { id: vote.id, status: 'PUBLISHING' },
        data: { status: 'DRAFT' },
      });
      throw error;
    }
    await ctx.answerCbQuery('Budget vote published.');
    await ctx.editMessageText('Your budget vote is live in the configured group.');
  });

  bot.action(/^bv:vote:([a-z0-9]+):([a-z0-9]+)$/, async (ctx) => {
    const allowed = await authorize(ctx, true);
    if (!allowed || !ctx.from) {
      await ctx.answerCbQuery('Current membership in the configured group is required.', {
        show_alert: true,
      });
      return;
    }
    const voteId = ctx.match[1];
    const rangeId = ctx.match[2];
    if (!voteId || !rangeId) {
      await ctx.answerCbQuery('This vote option is invalid.', { show_alert: true });
      return;
    }
    const expectedStatus =
      config.accessMode === 'PRELAUNCH' ? 'PRELAUNCH_OPEN' : 'OPEN';
    const vote = await database
      .$transaction(async (transaction) => {
        const locked = await transaction.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "BudgetVote"
          WHERE "id" = ${voteId}
            AND "status" = ${expectedStatus}::"BudgetVoteStatus"
          FOR UPDATE
        `;
        if (locked.length !== 1) {
          throw new Error('This vote is closed.');
        }
        const currentVote = await transaction.budgetVote.findUnique({
          where: { id: voteId },
          include: { ranges: { orderBy: { position: 'asc' } } },
        });
        const selectedRange = currentVote?.ranges.find(
          (range) => range.id === rangeId,
        );
        if (!currentVote || !selectedRange) {
          throw new Error('This vote option is invalid.');
        }
        await transaction.budgetVoteBallot.upsert({
          where: {
            budgetVoteId_memberId: {
              budgetVoteId: currentVote.id,
              memberId: BigInt(ctx.from.id),
            },
          },
          create: {
            budgetVoteId: currentVote.id,
            memberId: BigInt(ctx.from.id),
            rangeId: selectedRange.id,
            isPrelaunchTest: config.accessMode === 'PRELAUNCH',
          },
          update: {
            rangeId: selectedRange.id,
            isPrelaunchTest: config.accessMode === 'PRELAUNCH',
          },
        });
        return currentVote;
      })
      .catch(async (error: unknown) => {
        if (error instanceof Error && error.name === 'Error') {
          await ctx.answerCbQuery(error.message, { show_alert: true });
          return null;
        }
        throw error;
      });
    if (!vote) {
      return;
    }

    const counts = await getVoteCounts(database, vote.id);
    const output = renderBudgetVote(vote, counts);
    if (ctx.chat?.type === 'private') {
      await ctx.editMessageText(
        `Private owner-only budget vote (not sent to the group)\n\n${output}`,
        budgetVoteKeyboard(vote.id, vote.ranges, true),
      );
    } else if (vote.telegramMessageId !== null) {
      await ctx.telegram.editMessageText(
        config.groupId.toString(),
        vote.telegramMessageId,
        undefined,
        output,
        budgetVoteKeyboard(vote.id, vote.ranges, false),
      );
    }
    await ctx.answerCbQuery('Vote saved. Results show aggregate counts only.');
  });

  bot.action(/^bv:amount:([a-z0-9]+):([a-zA-Z0-9_-]+)$/, async (ctx) => {
    if (!(await authorize(ctx, true)) || !ctx.from) {
      await ctx.answerCbQuery('Current membership in the configured group is required.', {
        show_alert: true,
      });
      return;
    }
    const voteId = ctx.match[1];
    const optionId = ctx.match[2];
    if (!voteId || !optionId) {
      await ctx.answerCbQuery('This vote option is invalid.', { show_alert: true });
      return;
    }
    const expectedStatus =
      config.accessMode === 'PRELAUNCH' ? 'PRELAUNCH_OPEN' : 'OPEN';
    const saved = await database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "BudgetVote"
        WHERE "id" = ${voteId}
          AND "status" = ${expectedStatus}::"BudgetVoteStatus"
        FOR UPDATE
      `;
      if (locked.length !== 1) {
        return null;
      }
      const votes = await transaction.$queryRaw<
        { title: string | null; telegramMessageId: number | null }[]
      >`
        SELECT "title", "telegramMessageId"
        FROM "BudgetVote"
        WHERE "id" = ${voteId}
      `;
      const options = await transaction.$queryRaw<
        { id: string; amountMmk: bigint }[]
      >`
        SELECT "id", "amountMmk"
        FROM "BudgetVoteOption"
        WHERE "budgetVoteId" = ${voteId}
        ORDER BY "position" ASC
      `;
      const selected = options.find((option) => option.id === optionId);
      const vote = votes[0];
      if (!selected || !vote) {
        return null;
      }
      await transaction.$executeRaw`
        INSERT INTO "BudgetVoteOptionBallot"
          ("budgetVoteId", "memberId", "optionId", "isPrelaunchTest", "updatedAt")
        VALUES
          (${voteId}, ${BigInt(ctx.from.id)}, ${optionId},
           ${config.accessMode === 'PRELAUNCH'}, CURRENT_TIMESTAMP)
        ON CONFLICT ("budgetVoteId", "memberId")
        DO UPDATE SET
          "optionId" = EXCLUDED."optionId",
          "isPrelaunchTest" = EXCLUDED."isPrelaunchTest",
          "updatedAt" = CURRENT_TIMESTAMP
      `;
      return {
        title: vote.title,
        telegramMessageId: vote.telegramMessageId,
        options,
      };
    });
    if (!saved) {
      await ctx.answerCbQuery('This vote is closed or the option is invalid.', {
        show_alert: true,
      });
      return;
    }

    const counts = await getExactVoteCounts(database, voteId);
    const output = renderExactBudgetVote(saved.title, saved.options, counts);
    if (ctx.chat?.type === 'private') {
      await ctx.editMessageText(
        `Private budget vote\n\n${output}`,
        exactBudgetVoteKeyboard(voteId, saved.options, true),
      );
    } else if (saved.telegramMessageId !== null) {
      await ctx.telegram.editMessageText(
        config.groupId.toString(),
        saved.telegramMessageId,
        undefined,
        output,
        exactBudgetVoteKeyboard(voteId, saved.options, false),
      );
    }
    await ctx.answerCbQuery('Vote saved. Results show aggregate counts only.');
  });

  bot.action(/^bv:amount-results:([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx, true))) {
      await ctx.answerCbQuery('Authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const voteId = ctx.match[1];
    if (!voteId) {
      await ctx.answerCbQuery('This vote reference is invalid.', { show_alert: true });
      return;
    }
    const expectedStatus =
      config.accessMode === 'PRELAUNCH' ? 'PRELAUNCH_OPEN' : 'OPEN';
    const votes = await database.$queryRaw<{ title: string | null }[]>`
      SELECT "title"
      FROM "BudgetVote"
      WHERE "id" = ${voteId}
        AND "status" = ${expectedStatus}::"BudgetVoteStatus"
    `;
    if (!votes[0]) {
      await ctx.answerCbQuery('Vote not found.', { show_alert: true });
      return;
    }
    const options = await database.$queryRaw<
      { id: string; amountMmk: bigint }[]
    >`
      SELECT "id", "amountMmk"
      FROM "BudgetVoteOption"
      WHERE "budgetVoteId" = ${voteId}
      ORDER BY "position" ASC
    `;
    const counts = await getExactVoteCounts(database, voteId);
    await ctx.answerCbQuery(
      renderExactBudgetVote(votes[0].title, options, counts).slice(0, 195),
      { show_alert: true },
    );
  });

  bot.action(/^bv:results:([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx, true))) {
      await ctx.answerCbQuery('Authorized access is required.', {
        show_alert: true,
      });
      return;
    }
    const voteId = ctx.match[1];
    if (!voteId) {
      await ctx.answerCbQuery('This vote reference is invalid.', { show_alert: true });
      return;
    }
    const vote = await database.budgetVote.findUnique({
      where: {
        id: voteId,
        status: config.accessMode === 'PRELAUNCH' ? 'PRELAUNCH_OPEN' : 'OPEN',
      },
      include: { ranges: { orderBy: { position: 'asc' } } },
    });
    if (!vote) {
      await ctx.answerCbQuery('Vote not found.', { show_alert: true });
      return;
    }
    const counts = await getVoteCounts(database, vote.id);
    const lines = [
      vote.title ?? 'Group budget vote',
      ...vote.ranges.map(
        (range) =>
          `${formatMmk(range.minMmk)}-${formatMmk(range.maxMmk)}: ${counts.get(range.id) ?? 0}`,
      ),
    ];
    await ctx.answerCbQuery(lines.join('\n').slice(0, 195), { show_alert: true });
  });

  bot.action(/^bv:close:([a-z0-9]+)$/, async (ctx) => {
    if (!(await authorize(ctx)) || ctx.chat?.type !== 'private' || !ctx.from) {
      await ctx.answerCbQuery('Only the authorized creator can close this vote.', {
        show_alert: true,
      });
      return;
    }
    const voteId = ctx.match[1];
    if (!voteId) {
      await ctx.answerCbQuery('This vote reference is invalid.', { show_alert: true });
      return;
    }
    const vote = await database.budgetVote.findFirst({
      where: { id: voteId, creatorId: BigInt(ctx.from.id) },
    });
    if (!vote) {
      await ctx.answerCbQuery('Only the vote creator can close it.', {
        show_alert: true,
      });
      return;
    }
    if (vote.status === 'CLOSED' || vote.status === 'CANCELLED') {
      await ctx.answerCbQuery('This vote is already closed.');
      return;
    }
    if (
      vote.status !== 'PRELAUNCH_OPEN' &&
      (config.accessMode !== 'LIVE' || vote.status !== 'OPEN')
    ) {
      await ctx.answerCbQuery('This vote cannot be closed in its current state.', {
        show_alert: true,
      });
      return;
    }
    await database.budgetVote.update({
      where: { id: vote.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    if (vote.status === 'OPEN' && vote.telegramMessageId !== null) {
      try {
        await ctx.telegram.editMessageReplyMarkup(
          config.groupId.toString(),
          vote.telegramMessageId,
          undefined,
          { inline_keyboard: [] },
        );
      } catch (error) {
        logger.warn(
          {
            errorName: errorName(error),
            operation: 'remove-closed-budget-keyboard',
            budgetVoteId: vote.id,
          },
          'Budget vote is closed in the database but its Telegram buttons remain visible',
        );
      }
    }
    await ctx.answerCbQuery('Vote closed.');
  });
}
