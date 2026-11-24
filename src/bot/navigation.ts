import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { features } from '../features/index.js';
import type { AppConfig } from '../config.js';
import { buildFeatureHomeUrl } from '../mini-app/urls.js';

export const featureOptionRows = [
  [{ id: 'smart-poll', text: '📊 Smart Poll' }, { id: 'group-budget-vote', text: '💰 Budget Vote' }],
  [{ id: 'bill-splitter', text: '🧾 Bill Splitter' }, { id: 'birthday-reminder', text: '🎂 Birthday' }],
  [{ id: 'plan-countdown', text: '⏳ Countdown' }, { id: 'one-tap-hangout', text: '🍕 Hangout' }],
] as const;

export function optionsKeyboard() {
  // A reply-keyboard Web App launch has no signed Telegram initData.
  return Markup.keyboard(featureOptionRows.map((row) => row.map(({ text }) => ({ text }))))
    .resize()
    .persistent(false)
    .oneTime()
    .placeholder('Select an option');
}

export function featureEntryButton(config: AppConfig, id: string, text: string) {
  const url = buildFeatureHomeUrl(config, id);
  return url ? Markup.button.webApp(text, url) : Markup.button.callback(text, `feature:${id}`);
}

export function dashboardKeyboard(config: AppConfig) {
  const featureButtons = features.map(({ id, title }) => featureEntryButton(config, id, title));
  const rows = [];
  for (let index = 0; index < featureButtons.length; index += 2) {
    rows.push(featureButtons.slice(index, index + 2));
  }
  if (config.accessMode === 'LIVE' || config.testGroup) {
    rows.push([Markup.button.callback('Manage in chat', 'native:menu')]);
  }
  return Markup.inlineKeyboard(rows);
}

export function navigationRow(parent: string) {
  return [
    Markup.button.callback('Back', parent),
    Markup.button.callback('Main Menu', 'nav:home'),
  ];
}

export function featureKeyboard() {
  return Markup.inlineKeyboard([navigationRow('nav:home')]);
}

export async function showScreen(
  ctx: Context,
  text: string,
  keyboard: ReturnType<typeof Markup.inlineKeyboard>,
) {
  if (!ctx.callbackQuery) return ctx.reply(text, keyboard);
  try {
    return await ctx.editMessageText(text, keyboard);
  } catch (error) {
    if (error instanceof Error && error.message.includes('message is not modified')) return;
    if (ctx.chat?.type === 'private' && error instanceof Error &&
        /message to edit not found|message can't be edited/.test(error.message)) {
      return ctx.reply(text, keyboard);
    }
    throw error;
  }
}
