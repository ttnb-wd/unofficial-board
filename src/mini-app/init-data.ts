import { createHmac, timingSafeEqual } from 'node:crypto';

export type TelegramMiniAppUser = {
  id: bigint;
};

const MAX_INIT_DATA_AGE_SECONDS = 300;
const MAX_FUTURE_SKEW_SECONDS = 30;

export function validateTelegramInitData(
  initData: string,
  botToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): TelegramMiniAppUser | null {
  if (initData.length === 0 || initData.length > 4096) {
    return null;
  }

  const params = new URLSearchParams(initData);
  const entries = [...params.entries()];
  if (
    entries.length === 0 ||
    params.getAll('hash').length !== 1 ||
    new Set(entries.map(([key]) => key)).size !== entries.length
  ) {
    return null;
  }

  const hash = params.get('hash');
  const authDate = params.get('auth_date');
  const userJson = params.get('user');
  if (
    !hash ||
    !/^[a-f\d]{64}$/i.test(hash) ||
    !authDate ||
    !/^\d+$/.test(authDate) ||
    !userJson
  ) {
    return null;
  }

  const timestamp = Number(authDate);
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp > nowSeconds + MAX_FUTURE_SKEW_SECONDS ||
    nowSeconds - timestamp > MAX_INIT_DATA_AGE_SECONDS
  ) {
    return null;
  }

  const dataCheckString = entries
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const expectedHash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest();
  const receivedHash = Buffer.from(hash, 'hex');
  if (
    receivedHash.length !== expectedHash.length ||
    !timingSafeEqual(receivedHash, expectedHash)
  ) {
    return null;
  }

  try {
    const user: unknown = JSON.parse(userJson);
    if (
      typeof user !== 'object' ||
      user === null ||
      !('id' in user) ||
      typeof user.id !== 'number' ||
      !Number.isSafeInteger(user.id) ||
      user.id <= 0
    ) {
      return null;
    }
    return { id: BigInt(user.id) };
  } catch {
    return null;
  }
}
