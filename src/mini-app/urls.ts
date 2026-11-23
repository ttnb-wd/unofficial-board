import type { AppConfig } from '../config.js';

export type MiniAppFeature = 'poll' | 'budget';

export function buildMiniAppUrl(
  config: AppConfig,
  feature?: MiniAppFeature,
): string | null {
  if (!config.miniAppUrl) {
    return null;
  }
  const baseUrl = new URL(config.miniAppUrl);
  if (baseUrl.protocol !== 'https:') {
    return null;
  }
  const url = new URL('/mini-app', baseUrl);
  if (feature) url.searchParams.set('feature', feature);
  return url.toString();
}

export function buildBoardMenuButton(config: AppConfig) {
  const url = buildMiniAppUrl(config);
  return url ? { type: 'web_app' as const, text: 'The Board', web_app: { url } } : null;
}
