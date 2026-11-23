import { billSplitter } from './bill-splitter/index.js';
import { birthdayReminder } from './birthday-reminder/index.js';
import { groupBudgetVote } from './group-budget-vote/index.js';
import { oneTapHangout } from './one-tap-hangout/index.js';
import { planCountdown } from './plan-countdown/index.js';
import { smartPoll } from './smart-poll/index.js';

export const features = [
  smartPoll,
  billSplitter,
  birthdayReminder,
  planCountdown,
  oneTapHangout,
  groupBudgetVote,
] as const;

export function findFeature(featureId: string) {
  return features.find((feature) => feature.id === featureId);
}
