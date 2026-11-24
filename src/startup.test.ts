import type { PrismaClient } from '@prisma/client';
import { Telegraf, TelegramError } from 'telegraf';
import type { Telegram } from 'telegraf';
import { describe, expect, it, vi } from 'vitest';
import { groupDestination } from './access/policy.js';
import type { AppConfig } from './config.js';
import { startPolling, startupErrorCode, verifyDatabaseScope, verifyGroup } from './startup.js';

const base: AppConfig = {
  accessMode: 'PRELAUNCH', groupId: -10n, prelaunchOwnerId: 42n, botToken: 'fixture',
  databaseUrl: 'postgresql://postgres@127.0.0.1/fixture', logLevel: 'silent',
};
const test = { ...base, groupId: -20n, testGroup: { id: -20n, originalGroupId: -10n } };

describe('startup safety', () => {
  it('verifies the exact group and bot administrator for test mode', async () => {
    const bot = { id: 123, is_bot: true };
    const getChat = vi.fn().mockResolvedValue({ id: -20, type: 'supergroup' });
    const getChatMember = vi.fn().mockResolvedValue({ status: 'administrator', user: bot });
    const telegram = { getChat, getChatMember } as unknown as Telegram;
    await verifyGroup(telegram, base, bot.id);
    expect(getChat).not.toHaveBeenCalled();
    await verifyGroup(telegram, test, bot.id);
    expect(getChat).toHaveBeenCalledExactlyOnceWith('-20');
    expect(getChatMember).toHaveBeenCalledExactlyOnceWith('-20', 123);
    getChat.mockResolvedValueOnce({ id: -10, type: 'supergroup' });
    await expect(verifyGroup(telegram, test, 123)).rejects.toMatchObject({ code: 'GROUP_IDENTITY_MISMATCH' });
    getChat.mockResolvedValueOnce({ id: -20, type: 'channel' });
    await expect(verifyGroup(telegram, test, 123)).rejects.toMatchObject({ code: 'GROUP_IDENTITY_MISMATCH' });
    getChatMember.mockResolvedValueOnce({ status: 'member', user: bot });
    await expect(verifyGroup(telegram, test, 123)).rejects.toMatchObject({ code: 'TEST_GROUP_BOT_ADMIN_REQUIRED' });
  });

  it('blocks ambiguous legacy scope and rejects group calls outside the selected scope', async () => {
    const findUnique = vi.fn().mockResolvedValue({ testOnly: false });
    const db = { telegramGroup: { findUnique } } as unknown as PrismaClient;
    await expect(verifyDatabaseScope(db, test)).rejects.toMatchObject({ code: 'TEST_GROUP_SCOPE_ALREADY_IN_USE' });
    const orphaned = {
      telegramGroup: { findUnique: vi.fn().mockResolvedValue(null) },
      birthday: { findFirst: vi.fn().mockResolvedValue({ groupId: -20n }) },
      birthdayDelivery: { findFirst: vi.fn().mockResolvedValue(null) },
      planCountdown: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    await expect(verifyDatabaseScope(orphaned, test)).rejects.toMatchObject({ code: 'TEST_GROUP_SCOPE_ALREADY_IN_USE' });
    expect(groupDestination(test, -20n)).toBe('-20');
    expect(() => groupDestination(test, -10n)).toThrow();
    expect(() => groupDestination({ ...test, groupId: -10n }, -10n)).toThrow();
    expect(() => groupDestination(base, -10n)).toThrow();
  });

  it('waits for the first poll and reports a masked conflict by phase and code', async () => {
    const bot = new Telegraf('fixture');
    bot.botInfo = { id: 123, first_name: 'Fixture', is_bot: true, username: 'test_bot',
      can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
    const call = vi.spyOn(bot.telegram, 'callApi').mockImplementation(async (method) => {
      if (method === 'deleteWebhook') return true as never;
      throw new TelegramError({ error_code: 409, description: 'Sensitive fixture details' });
    });
    const phase = vi.fn();
    const polling = startPolling(bot, phase);
    const code = await polling.started.catch(startupErrorCode);
    expect(code).toBe('TELEGRAM_409');
    expect(phase.mock.calls.flat()).toEqual(['telegram-webhook-cleanup', 'telegram-polling-initialize']);
    expect(call).toHaveBeenCalledWith('getUpdates', expect.objectContaining({ timeout: 0 }), expect.anything());
    await expect(polling.done).rejects.toBeInstanceOf(TelegramError);
    expect(startupErrorCode({ errorCode: 'P1001', message: 'postgresql://user:password@fixture' })).toBe('P1001');
    expect(startupErrorCode({ code: 'secret-token' })).toBe('UNKNOWN');
  });

  it('becomes ready after an accepted getUpdates while polling remains active', async () => {
    const bot = new Telegraf('fixture');
    bot.botInfo = { id: 123, first_name: 'Fixture', is_bot: true, username: 'test_bot',
      can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
    const call = vi.spyOn(bot.telegram, 'callApi').mockImplementation(async (method) => {
      if (method === 'deleteWebhook') return true as never;
      return [] as never;
    });
    const polling = startPolling(bot, vi.fn());
    await polling.started;
    bot.stop();
    await polling.done;
    expect(call.mock.calls[1]?.[0]).toBe('getUpdates');
  });
});
