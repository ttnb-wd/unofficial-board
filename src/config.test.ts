import { describe, expect, it } from 'vitest';
import {
  EnvironmentValidationError,
  parseEnvironment,
} from './config.js';

describe('parseEnvironment', () => {
  it('parses the required environment variables', () => {
    expect(
      parseEnvironment({
        TELEGRAM_BOT_TOKEN: 'test-token',
        TELEGRAM_GROUP_ID: '-1001234567890',
        PRELAUNCH_OWNER_TELEGRAM_ID: '42',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/board',
      }),
    ).toEqual({
      botToken: 'test-token',
      groupId: -1001234567890n,
      prelaunchOwnerId: 42n,
      accessMode: 'PRELAUNCH',
      databaseUrl: 'postgresql://user:pass@localhost:5432/board',
      miniAppPort: 3000,
      logLevel: 'info',
    });
  });

  it('requires an explicitly configured positive owner ID', () => {
    expect(() =>
      parseEnvironment({
        TELEGRAM_BOT_TOKEN: 'test-token',
        TELEGRAM_GROUP_ID: '-1001234567890',
        PRELAUNCH_OWNER_TELEGRAM_ID: '0',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/board',
      }),
    ).toThrow(/PRELAUNCH_OWNER_TELEGRAM_ID/);
  });

  it('accepts only HTTPS Mini App URLs', () => {
    const baseEnvironment = {
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_GROUP_ID: '-1001234567890',
      PRELAUNCH_OWNER_TELEGRAM_ID: '42',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/board',
    };

    expect(
      parseEnvironment({
        ...baseEnvironment,
        MINI_APP_URL: 'https://forms.example.com',
      }).miniAppUrl,
    ).toBe('https://forms.example.com');
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        MINI_APP_URL: 'http://forms.example.com',
      }),
    ).toThrow(/MINI_APP_URL/);
  });

  it('requires an HTTPS frontend origin when static serving is disabled', () => {
    const renderEnvironment = {
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_GROUP_ID: '-1001234567890',
      PRELAUNCH_OWNER_TELEGRAM_ID: '42',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/board',
      SERVE_MINI_APP: 'false',
      PORT: '10000',
    };
    expect(() => parseEnvironment(renderEnvironment)).toThrow(/MINI_APP_URL/);
    expect(() => parseEnvironment({
      ...renderEnvironment,
      MINI_APP_URL: 'https://board.example/mini-app',
    })).toThrow(/MINI_APP_URL/);
    expect(parseEnvironment({
      ...renderEnvironment,
      MINI_APP_URL: 'https://board.example/',
    })).toMatchObject({
      accessMode: 'PRELAUNCH',
      miniAppPort: 10000,
      miniAppUrl: 'https://board.example/',
      serveMiniApp: false,
    });
  });

  it('allows LIVE only when explicitly selected', () => {
    expect(
      parseEnvironment({
        TELEGRAM_BOT_TOKEN: 'test-token',
        TELEGRAM_GROUP_ID: '-1001234567890',
        PRELAUNCH_OWNER_TELEGRAM_ID: '42',
        ACCESS_MODE: 'LIVE',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/board',
      }).accessMode,
    ).toBe('LIVE');
  });

  it('reports missing and invalid variable names without exposing values', () => {
    try {
      parseEnvironment({
        TELEGRAM_BOT_TOKEN: 'do-not-print-this',
        TELEGRAM_GROUP_ID: 'not-a-number',
        PRELAUNCH_OWNER_TELEGRAM_ID: 'also-not-valid',
        DATABASE_URL: 'not-a-database-url',
      });
      throw new Error('Expected invalid environment configuration');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect((error as Error).message).toContain('TELEGRAM_GROUP_ID');
      expect((error as Error).message).toContain('PRELAUNCH_OWNER_TELEGRAM_ID');
      expect((error as Error).message).toContain('DATABASE_URL');
      expect((error as Error).message).not.toContain('do-not-print-this');
    }
  });

  it('lists required variables that are absent', () => {
    try {
      parseEnvironment({});
      throw new Error('Expected invalid environment configuration');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect((error as EnvironmentValidationError).missingVariables).toEqual([
        'TELEGRAM_BOT_TOKEN',
        'TELEGRAM_GROUP_ID',
        'PRELAUNCH_OWNER_TELEGRAM_ID',
        'DATABASE_URL',
      ]);
    }
  });
});


describe('test group configuration', () => {
  const settings = {
    TELEGRAM_BOT_TOKEN: 'fixture',
    TELEGRAM_GROUP_ID: '-10',
    PRELAUNCH_OWNER_TELEGRAM_ID: '42',
    DATABASE_URL: 'postgresql://postgres@127.0.0.1/unused',
    MINI_APP_URL: 'https://board.example.com',
  };

  it('defaults off and keeps the original group active', () => {
    expect(parseEnvironment({ ...settings, TEST_GROUP_ID: '-20' })).toMatchObject({ groupId: -10n, accessMode: 'PRELAUNCH' });
    expect(parseEnvironment({ ...settings, TEST_GROUP_ID: '-20' }).testGroup).toBeUndefined();
    expect(parseEnvironment({ ...settings, TEST_GROUP_ID: '-20', ACCESS_MODE: 'LIVE' })).toMatchObject({ groupId: -10n, accessMode: 'LIVE' });
  });

  it('selects the test group while retaining PRELAUNCH and the original ID', () => {
    expect(parseEnvironment({ ...settings, TEST_GROUP_ENABLED: 'true', TEST_GROUP_ID: '-20' })).toMatchObject({
      accessMode: 'PRELAUNCH', groupId: -20n, testGroup: { id: -20n, originalGroupId: -10n },
    });
  });

  it.each([
    [{ TEST_GROUP_ID: '-10' }, 'TEST_GROUP_ID'],
    [{ TEST_GROUP_ENABLED: 'true' }, 'TEST_GROUP_ID'],
    [{ TEST_GROUP_ENABLED: 'yes' }, 'TEST_GROUP_ENABLED'],
    [{ TEST_GROUP_ID: '20' }, 'TEST_GROUP_ID'],
    [{ TEST_GROUP_ID: '-9007199254740992' }, 'TEST_GROUP_ID'],
    [{ ACCESS_MODE: 'LIVE', TEST_GROUP_ENABLED: 'true', TEST_GROUP_ID: '-20' }, 'TEST_GROUP_ENABLED'],
    [{ TEST_GROUP_ENABLED: 'true', TEST_GROUP_ID: '-20', MINI_APP_URL: 'https://fixture.trycloudflare.com' }, 'MINI_APP_URL'],
    [{ TEST_GROUP_ENABLED: 'true', TEST_GROUP_ID: '-20', MINI_APP_URL: 'https://localhost' }, 'MINI_APP_URL'],
  ])('rejects invalid or unsafe overrides %j', (overrides, invalid) => {
    expect(() => parseEnvironment({ ...settings, ...overrides })).toThrow(invalid);
  });
});
