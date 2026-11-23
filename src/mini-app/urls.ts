import type { AppConfig } from '../config.js';
import type { features } from '../features/index.js';

export type MiniAppFeature = 'poll' | 'budget';

type FeatureId = (typeof features)[number]['id'];

const featureHome: Partial<Record<FeatureId, string>> = {
  'smart-poll': '/mini-app?feature=poll&view=votes',
  'group-budget-vote': '/mini-app?feature=budget&view=votes',
  'bill-splitter': '/mini-app/bills?view=mine',
  'birthday-reminder': '/mini-app/birthday',
  'plan-countdown': '/mini-app/countdown',
  'one-tap-hangout': '/mini-app/hangout',
};

function hostedUrl(config: AppConfig, path: string): string | null {
  const base = URL.parse(config.miniAppUrl ?? '');
  if (base?.protocol !== 'https:' || base.username || base.password) return null;
  return new URL(path, base).href;
}

export function buildMiniAppUrl(config: AppConfig, feature?: MiniAppFeature): string | null {
  return hostedUrl(config, feature ? `/mini-app?feature=${feature}` : '/mini-app');
}

export function buildFeatureHomeUrl(config: AppConfig, feature: FeatureId): string | null {
  const path = featureHome[feature];
  return path ? hostedUrl(config, path) : null;
}

export function buildBoardMenuButton(config: AppConfig) {
  const url = buildMiniAppUrl(config);
  return url ? { type: 'web_app' as const, text: 'The Board', web_app: { url } } : null;
}
