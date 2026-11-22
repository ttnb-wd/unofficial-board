import { Markup } from 'telegraf';

export type DraftFeature = 'poll' | 'budget';

export type DraftFocus = {
  promptMessageId: number | null;
  updatedAt: Date;
};

export function isDraftMoreRecent(left: DraftFocus, right: DraftFocus): boolean {
  if (
    left.promptMessageId !== null &&
    right.promptMessageId !== null &&
    left.promptMessageId !== right.promptMessageId
  ) {
    return left.promptMessageId > right.promptMessageId;
  }
  return left.updatedAt > right.updatedAt;
}

function featureLabel(feature: DraftFeature): string {
  return feature === 'poll' ? 'Smart Poll' : 'Budget Vote';
}

export function draftSwitchText(source: DraftFeature): string {
  return `You have a ${featureLabel(source)} draft in progress.`;
}

export function draftSwitchKeyboard(
  target: DraftFeature,
  source: DraftFeature,
  sourceId: string,
) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `Switch to ${featureLabel(target)}`,
        `draft:switch:${target}:${source}:${sourceId}`,
      ),
    ],
    [
      Markup.button.callback(
        `Continue ${featureLabel(source)}`,
        `draft:continue:${source}:${sourceId}`,
      ),
    ],
    [Markup.button.callback('Cancel', `draft:cancel:${source}:${sourceId}`)],
  ]);
}
