import { Markup } from 'telegraf';
import type { Context, Telegraf } from 'telegraf';
import type { AppConfig } from '../../config.js';
import { navigationRow, showScreen } from '../../bot/navigation.js';
import { recordId } from './rules.js';

export function registerBillMenus(bot: Telegraf, config: AppConfig, authorize: (ctx: Context) => Promise<boolean>) {
  function launch(label: string, view: string) {
    const url = new URL('/mini-app/bills', config.miniAppUrl!);
    url.searchParams.set('view', view);
    return Markup.button.webApp(label, url.href);
  }
  async function menu(ctx: Context, view?: string) {
    if (!await authorize(ctx) || ctx.chat?.type !== 'private') {
      if (ctx.callbackQuery) await ctx.answerCbQuery('Private, authorized access is required.', { show_alert: true });
      return;
    }
    const ready = Boolean(config.miniAppUrl?.startsWith('https://'));
    if (ctx.callbackQuery) await ctx.answerCbQuery();
    await showScreen(ctx, ready ? 'Bill Splitter' : 'Bill Splitter\n\nA public HTTPS MINI_APP_URL is required.', Markup.inlineKeyboard([
      ...(ready ? [
        ...(view ? [[launch(view === 'ledger' ? 'Open Debt Status' : 'Open Bill', view)]] : []),
        [launch('Create Bill', 'create')],
        [launch('My Bills', 'mine'), launch('My Debts', 'debts')],
        [launch('Group Debt Ledger', 'ledger')],
      ] : []),
      navigationRow(view ? 'feature:bill-splitter' : 'nav:home'),
    ]));
  }
  bot.action('feature:bill-splitter', (ctx) => menu(ctx));
  bot.start(async (ctx, next) => {
    if (!ctx.payload.startsWith('bill_')) return next();
    if (config.accessMode !== 'LIVE') return;
    const view = ctx.payload.slice(5);
    if (view === 'ledger' || recordId.safeParse(view).success) {
      await menu(ctx, view === 'ledger' ? view : `bill:${view}`);
    }
  });
}

