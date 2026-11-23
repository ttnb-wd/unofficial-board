import type { PrismaClient } from '@prisma/client';
import type { Telegram } from 'telegraf';
import type { AppConfig } from '../config.js';
import { handleBirthdayAction } from '../features/birthday-reminder/api.js';
import { ledger, myBills } from '../features/bill-splitter/ledger.js';
import { publishedVotes } from '../features/vote-store.js';
import { handleHangoutAction } from '../features/one-tap-hangout/api.js';
import { handleCountdownAction } from '../features/plan-countdown/api.js';

async function section<T>(read: () => Promise<T>, onError: (error: unknown) => void) {
  try {
    return await read();
  } catch (error) {
    onError(error);
    return null;
  }
}

export async function readDashboard(
  actor: { userId: bigint; name: string },
  config: AppConfig,
  db: PrismaClient,
  telegram: Telegram,
  onError: (error: unknown) => void,
) {
  const preview = config.accessMode === 'PRELAUNCH';
  const scope = { groupId: config.groupId, creatorId: actor.userId, isPrelaunchTest: preview };
  const voteScope = preview ? scope : publishedVotes(config.groupId);
  const recent = { orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }], take: 5 };

  const [polls, budgets, birthday, plans, hangouts, birthdays, bills, debts] = await Promise.all([
    section(() => db.smartPoll.findMany({
      ...recent, where: { ...voteScope, question: { not: null } },
      select: { id: true, question: true, status: true, createdAt: true },
    }), onError),
    section(() => db.budgetVote.findMany({
      ...recent, where: { ...voteScope, title: { not: null } },
      select: { id: true, title: true, status: true, createdAt: true },
    }), onError),
    section(async () => {
      const { body } = await handleBirthdayAction({ action: 'session' }, actor.userId, config, db, telegram);
      return 'birthday' in body ? { date: body.birthday } : null;
    }, onError),
    preview ? null : section(async () => {
      const { body } = await handleCountdownAction({ action: 'upcoming' }, actor.userId, config, db);
      return 'plans' in body && body.plans
        ? body.plans.slice(0, 3).map(({ id, title, startsAt }) => ({ id, title, startsAt })) : null;
    }, onError),
    preview ? null : section(async () => {
      const { body } = await handleHangoutAction({ action: 'active' },
        { id: actor.userId, name: actor.name, receivedAt: new Date() }, config, db);
      return 'hangouts' in body && body.hangouts
        ? body.hangouts.slice(0, 3).map(({ id, title, startsAt }) => ({ id, title, startsAt })) : null;
    }, onError),
    preview ? null : section(async () => {
      const { body } = await handleBirthdayAction({ action: 'upcoming' }, actor.userId, config, db, telegram, new Date(), 3);
      return 'items' in body ? body.items ?? null : null;
    }, onError),
    preview ? null : section(async () => {
      const { items, next } = await myBills(db, config.groupId, actor.userId);
      return { count: items.length, more: Boolean(next), recent: items.slice(0, 3).map(({ id, title, total }) => ({ id, title, total })) };
    }, onError),
    preview ? null : section(async () => {
      const { items, next } = await ledger(db, config.groupId, actor.userId, 'debts');
      return { count: items.length, more: Boolean(next) };
    }, onError),
  ]);

  return {
    preview, name: actor.name, birthday, plans, hangouts, birthdays, bills, debts,
    polls: polls?.map(({ question, ...poll }) => ({ ...poll, title: question })) ?? null,
    budgets,
  };
}
