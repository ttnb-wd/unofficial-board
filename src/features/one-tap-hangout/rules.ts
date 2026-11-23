import { z } from 'zod';
import { parseYangonTime, yangon } from '../../mini-app/yangon.js';
import type { HangoutRsvp } from '@prisma/client';

export const choices = { g: 'GOING', m: 'MAYBE', c: 'CANT' } as const;
export const labels = { GOING: '🙌 Going', MAYBE: '🤔 Maybe', CANT: "😔 Can't" } satisfies Record<HangoutRsvp, string>;
export const hangoutIdPattern = '[A-Za-z0-9_-]{1,48}';
export const hangoutId = z.string().regex(new RegExp(`^${hangoutIdPattern}$`));
export const rsvp = z.enum(['GOING', 'MAYBE', 'CANT']);
export const emptyCounts = () => ({ GOING: 0, MAYBE: 0, CANT: 0 });

export const fields = z.object({
  title: z.string().trim().min(1).max(80),
  date: z.string(),
  time: z.string(),
  timeZone: z.literal(yangon),
  place: z.string().trim().max(120).default(''),
  description: z.string().trim().max(240).default(''),
});

export function eventTime(input: z.infer<typeof fields>, now: Date) {
  const startsAt = parseYangonTime(input.date, input.time);
  return startsAt && startsAt > now ? startsAt : null;
}

export function displayName(user: { first_name?: unknown; last_name?: unknown }) {
  return [user.first_name, user.last_name]
    .filter((part): part is string => typeof part === 'string')
    .join(' ').replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, 120) || 'Group member';
}

export function eventStatus(status: 'OPEN' | 'CANCELLED' | 'COMPLETED', startsAt: Date | null, now: Date) {
  if (status === 'CANCELLED') return status;
  return status === 'OPEN' && startsAt && startsAt > now ? 'OPEN' : 'COMPLETED';
}
