import { isOwnerPreview } from '../../access/policy.js';
import { Markup } from 'telegraf';
import type { Context, Telegraf } from 'telegraf';
import { navigationRow, showScreen } from '../../bot/navigation.js';
import type { AppConfig } from '../../config.js';

export function countdownKeyboard(config: AppConfig, id?: string) {
  const url = config.miniAppUrl ? new URL('/mini-app/countdown', config.miniAppUrl) : null;
  const rows = [];
  if (url?.protocol === 'https:') {
    const launch = (label: string, view: string) => {
      const target = new URL(url);
      target.searchParams.set('view', view);
      if (id) target.searchParams.set('id', id);
      return [Markup.button.webApp(label, target.href)];
    };
    if (id) rows.push(launch('View Countdown', 'detail'));
    else {
      rows.push(launch('Create Countdown', 'create'), launch('Upcoming Countdowns', 'upcoming'), launch('My Events', 'mine'), launch('Completed Events', 'completed'));
      if (isOwnerPreview(config)) rows.push(launch('Preview Notifications', 'preview'), launch('Preview Member View', 'member'));
    }
  }
  return Markup.inlineKeyboard([...rows, navigationRow(id ? 'feature:plan-countdown' : 'nav:home')]);
}

export function registerCountdownMenu(bot: Telegraf, config: AppConfig, authorize: (ctx: Context) => Promise<boolean>) {
  bot.action('feature:plan-countdown', async (ctx) => {
    if (ctx.chat?.type !== 'private' || !await authorize(ctx)) {
      await ctx.answerCbQuery('Private, authorized access is required.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    await showScreen(ctx, config.miniAppUrl
      ? 'Plan Countdown'
      : 'Plan Countdown\n\nA public HTTPS MINI_APP_URL is required.', countdownKeyboard(config));
  });
}
