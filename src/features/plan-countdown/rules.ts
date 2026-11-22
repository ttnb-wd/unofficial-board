import { randomInt } from 'node:crypto';
import type { CountdownDeliveryKind } from '@prisma/client';

export const yangon = 'Asia/Yangon';
const minute = 60_000;
const hour = 60 * minute;

export function parseYangonTime(date: string, time: string): Date | null {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || time >= '24:00') return null;
  const timestamp = new Date(`${date}T${time}:00+06:30`);
  if (!Number.isFinite(timestamp.getTime())) return null;
  return new Date(+timestamp + 6.5 * hour).toISOString().slice(0, 16) === `${date}T${time}` ? timestamp : null;
}

const milestones = [
  ['DAY_BEFORE', 24 * hour, 15 * minute],
  ['SIX_HOURS_BEFORE', 6 * hour, 10 * minute],
  ['HOUR_BEFORE', hour, 5 * minute],
  ['AT_START', 0, 10 * minute],
] as const;

export function deliveryWindows(startsAt: Date, now: Date) {
  return [
    { kind: 'ANNOUNCEMENT' as const, scheduledAt: now, expiresAt: startsAt },
    ...milestones.map(([kind, lead, grace]) => ({
      kind, scheduledAt: new Date(+startsAt - lead), expiresAt: new Date(+startsAt - lead + grace),
    })),
  ];
}

const celebrations = [
  '🎉 {event} စပြီဟေ့! Enjoy & have fun! 🥳',
  "🚀 It's time for {event}! ပျော်ပျော်ပါးပါး သွားကြစို့!",
  '🥳 {event} အချိန်ရောက်ပြီ! Make some memories!',
  '🎊 Finally! {event} starts now! Have an amazing time!',
  '✨ {event} is happening now! Enjoy every moment!',
];

export const chooseStartVariant = () => randomInt(celebrations.length);
export const startExamples = (title: string) => celebrations.map((text) => text.replace('{event}', () => title));

export function notification(kind: CountdownDeliveryKind, title: string, startsAt: Date, now: Date, startVariant: number | null = null): string {
  if (kind === 'AT_START') return (celebrations[startVariant ?? 0] ?? celebrations[0]!).replace('{event}', () => title);
  const minutes = Math.max(1, Math.ceil((+startsAt - +now) / minute));
  const hours = Math.floor(minutes / 60);
  if (kind === 'DAY_BEFORE' && minutes === 1440) return `🌴 ${title} is tomorrow! Only 1 day left! 🎉`;
  if (kind === 'SIX_HOURS_BEFORE' && minutes === 360) return `⏳ ${title} is getting close! 6 hours remaining!`;
  if (kind === 'HOUR_BEFORE' && minutes === 60) return `🚀 Just 1 hour until ${title}! Get ready!`;
  const parts = [Math.floor(hours / 24), hours % 24, minutes % 60];
  const remaining = parts.map((part, index) => part ? `${part}${['d', 'h', 'm'][index]}` : '').filter(Boolean).join(' ');
  if (kind !== 'ANNOUNCEMENT') return `⏳ ${title} is getting close! ${remaining} to go!`;
  const date = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: yangon,
  }).format(startsAt);
  return `New plan · ${title}\n${date} (Yangon) · ${remaining} to go`;
}
