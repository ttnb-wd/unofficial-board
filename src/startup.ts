import type { PrismaClient } from '@prisma/client';
import { TelegramError } from 'telegraf';
import type { Telegraf, Telegram } from 'telegraf';
import { verifyAndRecordMembership } from './access/membership.js';
import { allowsGroupWorkflows, groupDestination } from './access/policy.js';
import type { AppConfig } from './config.js';

export class StartupError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'StartupError';
  }
}

export function startupErrorCode(error: unknown): string {
  if (error instanceof StartupError) return error.code;
  if (error instanceof TelegramError) return `TELEGRAM_${error.code}`;
  if (typeof error !== 'object' || error === null) return 'UNKNOWN';
  const code = 'errorCode' in error ? error.errorCode : 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && /^(P\d{4}|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EADDRINUSE|EACCES)$/.test(code)) {
    return code;
  }
  return error instanceof Error && error.name === 'FetchError' ? 'NETWORK_ERROR' : 'UNKNOWN';
}

export async function verifyGroup(telegram: Telegram, config: AppConfig, botId: number) {
  if (!allowsGroupWorkflows(config)) return;
  const destination = groupDestination(config, config.groupId);
  const chat = await telegram.getChat(destination);
  if (BigInt(chat.id) !== config.groupId || (chat.type !== 'group' && chat.type !== 'supergroup')) {
    throw new StartupError('GROUP_IDENTITY_MISMATCH');
  }
  const botMembership = await telegram.getChatMember(destination, botId);
  const memberStatuses = config.testGroup ? ['creator', 'administrator'] : ['creator', 'administrator', 'member'];
  if (botMembership.user?.id !== botId || botMembership.user.is_bot !== true ||
      !memberStatuses.includes(botMembership.status)) {
    throw new StartupError(config.testGroup ? 'TEST_GROUP_BOT_ADMIN_REQUIRED' : 'BOT_GROUP_MEMBERSHIP_REQUIRED');
  }
}

export async function verifyDatabaseScope(db: PrismaClient, config: AppConfig) {
  const originalId = config.testGroup?.originalGroupId ?? config.groupId;
  const original = await db.telegramGroup.findUnique({ where: { telegramId: originalId }, select: { testOnly: true } });
  if (original?.testOnly) throw new StartupError('ORIGINAL_GROUP_IS_TEST_ONLY');
  if (!config.testGroup) return;
  groupDestination(config, config.groupId);
  // Some older features do not have a Group foreign key. Reject their orphaned legacy ownership.
  const groupId = config.groupId;
  const existing = await db.telegramGroup.findUnique({ where: { telegramId: groupId }, select: { testOnly: true } });
  if (existing) {
    if (!existing.testOnly) throw new StartupError('TEST_GROUP_SCOPE_ALREADY_IN_USE');
    return;
  }
  const legacy = await Promise.all([
    db.birthday.findFirst({ where: { groupId }, select: { groupId: true } }),
    db.birthdayDelivery.findFirst({ where: { groupId }, select: { groupId: true } }),
    db.planCountdown.findFirst({ where: { groupId }, select: { groupId: true } }),
  ]);
  if (legacy.some(Boolean)) throw new StartupError('TEST_GROUP_SCOPE_ALREADY_IN_USE');
}

export async function registerTestScope(db: PrismaClient, telegram: Telegram, config: AppConfig) {
  if (!config.testGroup) return;
  groupDestination(config, config.groupId);
  const group = await db.telegramGroup.upsert({
    where: { telegramId: config.groupId }, create: { telegramId: config.groupId, testOnly: true }, update: {},
    select: { testOnly: true },
  });
  if (!group.testOnly) throw new StartupError('TEST_GROUP_SCOPE_ALREADY_IN_USE');
  await db.member.upsert({ where: { telegramId: config.prelaunchOwnerId }, create: { telegramId: config.prelaunchOwnerId }, update: {} });
  await verifyAndRecordMembership(telegram, db, config.groupId, config.prelaunchOwnerId, true);
}

/** Telegraf launch settles when polling stops. Gate readiness on the first accepted getUpdates. */
export function startPolling(bot: Telegraf, onPhase: (phase: string) => void) {
  const call = bot.telegram.callApi.bind(bot.telegram);
  let ready = false;
  let resolveReady!: () => void;
  const pollingReady = new Promise<void>((resolve) => { resolveReady = resolve; });
  bot.telegram.callApi = async (method, payload, options) => {
    // Telegraf also calls getUpdates without a timeout to flush its offset on exit.
    if (method !== 'getUpdates' || ready || !payload || !('timeout' in payload)) {
      return call(method, payload, options);
    }
    onPhase('telegram-polling-initialize');
    const result = await call(method, { ...payload, timeout: 0 }, options);
    ready = true;
    bot.telegram.callApi = call;
    resolveReady();
    return result;
  };
  onPhase('telegram-webhook-cleanup');
  const done = bot.launch({ allowedUpdates: ['message', 'callback_query', 'poll', 'poll_answer'] });
  const started = Promise.race([pollingReady, done.then(() => {
    if (!ready) throw new StartupError('POLLING_STOPPED_BEFORE_READY');
  })]);
  return { started, done };
}
