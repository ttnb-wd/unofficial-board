import { allowsGroupWorkflows } from '../../access/policy.js';
import { loadVote, saveBallot } from '../vote-store.js';
import type { PrismaClient } from '@prisma/client';
import { Markup, Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { AppConfig } from '../../config.js';
import { navigationRow, showScreen } from '../../bot/navigation.js';
import { registerBudgetMiniAppLaunch } from './native-form.js';

type Authorize = (ctx: Context, allowGroupChat?: boolean) => Promise<boolean>;

function formatMmk(amount: bigint): string {
  return new Intl.NumberFormat('en-US').format(amount);
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
  authorize: Authorize,
): void {
  registerBudgetMiniAppLaunch(bot, config, authorize);
  const legacyGroupAccess = (ctx: Context) =>
    allowsGroupWorkflows(config) &&
    (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') &&
    authorize(ctx, true);

  bot.action(/^bv:(?:vote|amount):([a-z0-9]+):([a-zA-Z0-9_-]+)$/, async (ctx) => {
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
    const record = await loadVote(database, config.groupId, 'bv', voteId);
    const index = record?.choices.findIndex(({ id }) => id === optionId) ?? -1;
    if (!record || index < 0 || record.telegramMessageId !== ctx.callbackQuery.message?.message_id ||
        !await saveBallot(database, config, 'bv', record, BigInt(ctx.from.id), 1 << index)) {
      await ctx.answerCbQuery('This vote is closed or the option is invalid.', { show_alert: true });
      return;
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
    if (!allowsGroupWorkflows(config) || !(await authorize(ctx)) || ctx.chat?.type !== 'private' || !ctx.from) {
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
      data: { status: 'CLOSED', closedAt: new Date(), groupSyncAt: new Date() },
    });
    if (!closed.count) {
      await ctx.answerCbQuery('This vote is already closed.');
      return;
    }
    await ctx.answerCbQuery('Vote closed.');
    await showScreen(ctx, 'Voting closed.', Markup.inlineKeyboard([navigationRow('bv:list')]));
  });
}
