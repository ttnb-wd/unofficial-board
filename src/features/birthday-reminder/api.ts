import type { PrismaClient } from '@prisma/client';
import type { Telegram } from 'telegraf';
import { hasActiveMembership } from '../../access/membership.js';
import type { AppConfig } from '../../config.js';
import { announcement, birthdayRequest, dateKey, nextOccurrence, yangonDate } from './rules.js';

export async function birthdayMember(telegram: Telegram, groupId: bigint, memberId: bigint) {
  const result = await telegram.getChatMember(String(groupId), Number(memberId));
  return hasActiveMembership(result) && !result.user.is_bot ? result.user : null;
}

export async function handleBirthdayAction(
  body: unknown, actorId: bigint, config: AppConfig, db: PrismaClient, telegram: Telegram, now = new Date(),
  upcomingLimit = Infinity,
) {
  const preview = config.accessMode === 'PRELAUNCH';
  if (preview && actorId !== config.prelaunchOwnerId) {
    return { status: 403, body: { error: 'Owner preview only.' } };
  }
  const parsed = birthdayRequest.safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: 'Choose a valid month and day.' } };

  const input = parsed.data;
  const scope = { groupId: config.groupId, preview };
  const owner = { ...scope, memberId: actorId };
  const where = { groupId_memberId_preview: owner };
  const select = { month: true, day: true } as const;

  switch (input.action) {
    case 'session':
      return { status: 200, body: { preview, birthday: await db.birthday.findUnique({ where, select }) } };
    case 'save': {
      const date = { month: input.month, day: input.day };
      const birthday = await db.birthday.upsert({ where, create: { ...owner, ...date }, update: date, select });
      return { status: 200, body: { birthday } };
    }
    case 'remove':
      await db.birthday.deleteMany({ where: owner });
      return { status: 200, body: { birthday: null } };
    case 'preview':
      return preview
        ? { status: 200, body: { message: announcement('Alex (example)') } }
        : { status: 403, body: { error: 'Announcement preview is only available in PRELAUNCH.' } };
    case 'upcoming': {
      const today = yangonDate(now);
      if (preview) {
        const fixtures = [{ name: 'Alex (example)', month: 2, day: 29 }, { name: 'Sam (example)', month: 12, day: 31 }];
        const mine = await db.birthday.findUnique({ where, select });
        if (mine) fixtures.push({ name: 'You (preview)', ...mine });
        const items = fixtures.map((item) => ({ name: item.name, ...nextOccurrence(item, today) }))
          .sort((a, b) => dateKey(a) - dateKey(b));
        return { status: 200, body: { items } };
      }

      const dates = (await db.birthday.findMany({ where: scope, select: { ...select, memberId: true } }))
        .map((record) => ({ memberId: record.memberId, ...nextOccurrence(record, today) }))
        .sort((a, b) => dateKey(a) - dateKey(b));
      const items = [];
      for (let offset = 0; offset < dates.length && items.length < upcomingLimit; offset += 5) {
        const verified = await Promise.all(dates.slice(offset, offset + 5).map(async ({ memberId, ...date }) => {
          const member = await birthdayMember(telegram, config.groupId, memberId);
          return member ? { name: member.first_name, ...date } : null;
        }));
        items.push(...verified.filter((item) => item !== null));
      }
      return { status: 200, body: { items: items.slice(0, upcomingLimit) } };
    }
  }
}
