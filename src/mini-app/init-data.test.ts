import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateTelegramInitData } from './init-data.js';

const BOT_TOKEN = '123456:test-token';
const NOW = 1_800_000_000;

function signedInitData(userId: number, authDate = NOW, launch: Record<string, string> = { query_id: 'test-query' }): string {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    ...launch,
    user: JSON.stringify({ id: userId, first_name: 'Owner' }),
  });
  const checkString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();
  const hash = createHmac('sha256', secretKey)
    .update(checkString)
    .digest('hex');
  params.set('hash', hash);
  return params.toString();
}

describe('Telegram Mini App initData validation', () => {
  it('accepts a current Telegram signature and extracts only the user ID', () => {
    expect(validateTelegramInitData(signedInitData(42), BOT_TOKEN, NOW)).toEqual({
      id: 42n,
      first_name: 'Owner',
    });
  });

  it('accepts signed Main Mini App identity without a query ID', () => {
    expect(validateTelegramInitData(signedInitData(42, NOW, {}), BOT_TOKEN, NOW)?.id).toBe(42n);
  });

  it('rejects altered, stale, duplicated, and malformed initData', () => {
    const signed = signedInitData(42);
    expect(
      validateTelegramInitData(`${signed}&user=%7B%22id%22%3A84%7D`, BOT_TOKEN, NOW),
    ).toBeNull();
    expect(validateTelegramInitData(signedInitData(42, NOW - 301), BOT_TOKEN, NOW))
      .toBeNull();
    expect(
      validateTelegramInitData(`${signed}&auth_date=${NOW}`, BOT_TOKEN, NOW),
    ).toBeNull();
    expect(validateTelegramInitData('not-init-data', BOT_TOKEN, NOW)).toBeNull();
  });
});
