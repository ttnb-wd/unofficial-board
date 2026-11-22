import type { PrismaClient } from '@prisma/client';
import { Markup, Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { AppConfig } from '../../config.js';
import type { createLogger } from '../../logger.js';
import { navigationRow, showScreen } from '../../bot/navigation.js';
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
  const legacyGroupAccess = (ctx: Context) =>
    config.accessMode === 'LIVE' &&
    (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') &&
    authorize(ctx, true);

  bot.action(/^bv:vote:([a-z0-9]+):([a-z0-9]+)$/, async (ctx) => {
    const allowed = await legacyGroupAccess(ctx);
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
    const vote = await database
      .$transaction(async (transaction) => {
        const locked = await transaction.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "BudgetVote"
          WHERE "id" = ${voteId}
            AND "status" = 'OPEN'
          AND "groupId" = ${config.groupId} AND NOT "isPrelaunchTest" AND "telegramMessageId" IS NOT NULL
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
          },
          update: {
            rangeId: selectedRange.id,
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
    if (vote.telegramMessageId !== null) {
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
    if (!(await legacyGroupAccess(ctx)) || !ctx.from) {
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
    const saved = await database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "BudgetVote"
        WHERE "id" = ${voteId}
          AND "status" = 'OPEN'
          AND "groupId" = ${config.groupId} AND NOT "isPrelaunchTest" AND "telegramMessageId" IS NOT NULL
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
           false, CURRENT_TIMESTAMP)
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
    if (saved.telegramMessageId !== null) {
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
    if (!(await legacyGroupAccess(ctx))) {
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
    const votes = await database.$queryRaw<{ title: string | null }[]>`
      SELECT "title"
      FROM "BudgetVote"
      WHERE "id" = ${voteId}
        AND "status" = 'OPEN'
          AND "groupId" = ${config.groupId} AND NOT "isPrelaunchTest" AND "telegramMessageId" IS NOT NULL
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
    if (!(await legacyGroupAccess(ctx))) {
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
        status: 'OPEN', groupId: config.groupId, isPrelaunchTest: false,
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
    if (config.accessMode !== 'LIVE' || !(await authorize(ctx)) || ctx.chat?.type !== 'private' || !ctx.from) {
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
      where: { id: voteId, creatorId: BigInt(ctx.from.id), groupId: config.groupId },
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
      vote.isPrelaunchTest || vote.status !== 'OPEN' || vote.telegramMessageId === null
    ) {
      await ctx.answerCbQuery('This vote cannot be closed in its current state.', {
        show_alert: true,
      });
      return;
    }
    const closed = await database.budgetVote.updateMany({
      where: { id: vote.id, status: 'OPEN', isPrelaunchTest: false },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    if (!closed.count) {
      await ctx.answerCbQuery('This vote is already closed.');
      return;
    }
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
    await showScreen(ctx, 'Voting closed.', Markup.inlineKeyboard([navigationRow('bv:list')]));
  });
}
