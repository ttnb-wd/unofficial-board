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
