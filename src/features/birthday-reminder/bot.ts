import { isOwnerPreview } from '../../access/policy.js';
import type { PrismaClient } from '@prisma/client';
import { Markup } from 'telegraf';
import type { Context, Telegraf } from 'telegraf';
import { navigationRow, showScreen } from '../../bot/navigation.js';
import type { AppConfig } from '../../config.js';

export function registerBirthdayMenu(bot: Telegraf, config: AppConfig, db: PrismaClient, authorize: (ctx: Context) => Promise<boolean>) {
  bot.action('feature:birthday-reminder', async (ctx) => {
    if (ctx.chat?.type !== 'private' || !ctx.from || !await authorize(ctx)) {
      await ctx.answerCbQuery('Private, authorized access is required.', { show_alert: true });
      return;
    }

    await ctx.answerCbQuery();
    const url = config.miniAppUrl ? new URL('/mini-app/birthday', config.miniAppUrl) : null;
    const ready = url?.protocol === 'https:';
    const preview = isOwnerPreview(config);
    const rows = [];
    if (ready) {
      const saved = await db.birthday.findUnique({
        where: { groupId_memberId_preview: { groupId: config.groupId, memberId: BigInt(ctx.from.id), preview } },
        select: { day: true },
      });
      const launch = (label: string, view: string) => {
        const target = new URL(url);
        target.searchParams.set('view', view);
        return Markup.button.webApp(label, target.href);
      };
      rows.push(
        [launch(saved ? 'Edit My Birthday' : 'Add My Birthday', 'form')],
        [launch('Upcoming Birthdays', 'upcoming')],
      );
      if (preview) rows.push([launch('Preview Group Announcement', 'preview')]);
    }

    await showScreen(ctx, ready ? 'Birthday Reminder' : 'Birthday Reminder\n\nA public HTTPS MINI_APP_URL is required.',
      Markup.inlineKeyboard([...rows, navigationRow('nav:home')]));
  });
}
