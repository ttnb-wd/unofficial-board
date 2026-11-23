import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import { buildBoardMenuButton, buildMiniAppUrl } from './urls.js';

const config: AppConfig = {
  botToken: 'test-token',
  groupId: -1001234567890n,
  prelaunchOwnerId: 42n,
  accessMode: 'PRELAUNCH',
  databaseUrl: 'postgresql://user:pass@localhost:5432/board',
  miniAppUrl: 'https://forms.example.com',
  logLevel: 'silent',
};

describe('buildMiniAppUrl', () => {
  it.each(['poll', 'budget'] as const)(
    'builds the Telegram launch URL for %s',
    (feature) => {
      expect(buildMiniAppUrl(config, feature)).toBe(
        `https://forms.example.com/mini-app?feature=${feature}`,
      );
    },
  );

  it('does not create Telegram launch URLs without HTTPS hosting', () => {
    const configWithoutMiniApp = { ...config };
    delete configWithoutMiniApp.miniAppUrl;
    expect(
      buildMiniAppUrl(configWithoutMiniApp, 'poll'),
    ).toBeNull();
    expect(
      buildMiniAppUrl({ ...config, miniAppUrl: 'http://localhost:3000' }, 'poll'),
    ).toBeNull();
  });
});

it('prepares The Board menu button for Home and requires HTTPS', () => {
  expect(buildBoardMenuButton({ ...config, miniAppUrl: 'https://forms.example.com/mini-app?feature=poll' })).toEqual({
    type: 'web_app',
    text: 'The Board',
    web_app: { url: 'https://forms.example.com/mini-app' },
  });
  expect(buildBoardMenuButton({ ...config, miniAppUrl: 'http://localhost:3000' })).toBeNull();
});
