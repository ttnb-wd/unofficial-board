import { allowsGroupWorkflows, isOwnerPreview } from '../../access/policy.js';
import type { PrismaClient } from '@prisma/client';
import { Markup } from 'telegraf';
import type { Context, Telegraf } from 'telegraf';
import type { AppConfig } from '../../config.js';
import { navigationRow, showScreen } from '../../bot/navigation.js';
import { choices, displayName, hangoutIdPattern, labels } from './rules.js';
import { respondToHangout } from './store.js';

export function hangoutKeyboard(config: AppConfig, id?: string) {
  const base = config.miniAppUrl ? new URL('/mini-app/hangout', config.miniAppUrl) : null;
  const rows = [];
  if (base?.protocol === 'https:') {
    const launch = (text: string, view: string) => {
      const url = new URL(base);
      url.searchParams.set('view', view);
      if (id) url.searchParams.set('id', id);
      return [Markup.button.webApp(text, url.href)];
    };
    if (id) rows.push(launch('View Details', 'detail'), [Markup.button.callback('View and RSVP in chat', 'eh:view:' + id)]);
    else {
      rows.push(launch('Create Hangout', 'create'), launch('Active Hangouts', 'active'),
        launch('My Hangouts', 'mine'), launch('Completed Hangouts', 'completed'));
      if (isOwnerPreview(config)) {
        rows.push(launch('Preview Group Invitation', 'preview'), launch('Preview Member View', 'member'));
      }
    }
  }
  return Markup.inlineKeyboard([...rows, navigationRow(id ? 'feature:one-tap-hangout' : 'nav:home')]);
}

export function registerHangoutMenu(
  bot: Telegraf, config: AppConfig, db: PrismaClient,
  authorize: (ctx: Context, allowGroup?: boolean) => Promise<boolean>, wake: () => void,
) {
  bot.action('feature:one-tap-hangout', async (ctx) => {
    if (ctx.chat?.type !== 'private' || !await authorize(ctx)) {
      await ctx.answerCbQuery('Private, authorized access is required.', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    await showScreen(ctx, config.miniAppUrl ? 'One Tap Hangout' : 'One Tap Hangout\n\nA public HTTPS MINI_APP_URL is required.',
      hangoutKeyboard(config));
  });

  bot.action(new RegExp(`^ho:([gmc]):(${hangoutIdPattern})$`), async (ctx) => {
    const receivedAt = new Date();
    const message = ctx.callbackQuery.message;
    if (!allowsGroupWorkflows(config) || !ctx.chat || ctx.chat.type === 'private' ||
        BigInt(ctx.chat.id) !== config.groupId || !ctx.from || !message ||
        !await authorize(ctx, true)) {
      await ctx.answerCbQuery('Current group membership is required.', { show_alert: true });
      return;
    }
    const choice = choices[ctx.match[1] as keyof typeof choices];
    const id = ctx.match[2];
    if (!id) return;
    const result = await respondToHangout(db, config, id, {
      id: BigInt(ctx.from.id), name: displayName(ctx.from), receivedAt,
    }, choice, { messageId: message.message_id, updateId: BigInt(ctx.update.update_id) });
    if ('hangout' in result && result.hangout?.myRsvp) {
      wake();
      await ctx.answerCbQuery(`Your RSVP: ${labels[result.hangout.myRsvp]}`);
    } else {
      await ctx.answerCbQuery(result.error ?? 'RSVP unavailable.', { show_alert: true });
    }
  });
}
