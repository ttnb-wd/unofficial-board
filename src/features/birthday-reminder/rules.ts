import { z } from 'zod';

export type BirthdayDate = { month: number; day: number };

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Yangon', calendar: 'gregory', numberingSystem: 'latn',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23',
});

export function yangonDate(now: Date) {
  const { year, month, day, hour } = Object.fromEntries(
    formatter.formatToParts(now).map(({ type, value }) => [type, Number(value)]),
  );
  if (year === undefined || month === undefined || day === undefined || hour === undefined) {
    throw new Error('Asia/Yangon date could not be read.');
  }
  return { year, month, day, hour };
}

function leapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

const saveBirthday = z.strictObject({
  action: z.literal('save'),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
}).refine(({ month, day }) => day <= new Date(Date.UTC(2000, month, 0)).getUTCDate());

export const birthdayRequest = z.union([
  saveBirthday,
  z.strictObject({ action: z.enum(['session', 'upcoming', 'remove', 'preview']) }),
]);

export function occurrence(birthday: BirthdayDate, year: number) {
  const day = birthday.month === 2 && birthday.day === 29 && !leapYear(year) ? 28 : birthday.day;
  return { year, month: birthday.month, day };
}

export function dateKey(date: BirthdayDate & { year: number }) {
  return date.year * 10000 + date.month * 100 + date.day;
}

export function nextOccurrence(birthday: BirthdayDate, today: BirthdayDate & { year: number }) {
  const thisYear = occurrence(birthday, today.year);
  return dateKey(thisYear) >= dateKey(today) ? thisYear : occurrence(birthday, today.year + 1);
}

export function announcement(name: string) {
  return `Happy birthday, ${name}! 🎉 Wishing you a wonderful day from all of us at The Unofficial Board.`;
}
