import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { features } from '../features/index.js';

export function dashboardKeyboard() {
  const featureButtons = features.map((feature) =>
    Markup.button.callback(feature.title, `feature:${feature.id}`),
  );
  const rows = [];
  for (let index = 0; index < featureButtons.length; index += 2) {
    rows.push(featureButtons.slice(index, index + 2));
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
