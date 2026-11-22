import { describe, expect, it } from 'vitest';
import { countdownParts, yangonTimestamp } from '../../../public/mini-app/countdown-clock.js';
import { deliveryWindows, notification, parseYangonTime } from './rules.js';

describe('Plan Countdown clock', () => {
  it('calculates each tile from the target and stops at zero', () => {
    const now = Date.UTC(2026, 10, 23, 23, 59, 59);
    const target = now + (2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000;

    expect(countdownParts(target, now)).toEqual([2, 3, 4, 5]);
    expect(countdownParts(target, now + 65_000)).toEqual([2, 3, 3, 0]);
    expect(countdownParts(target, target - 1)).toEqual([0, 0, 0, 1]);
    expect(countdownParts(target, target)).toEqual([0, 0, 0, 0]);
    expect(countdownParts(target, target + 86_400_000)).toEqual([0, 0, 0, 0]);
  });

  it('converts Yangon wall time across midnight and rejects invalid input on both sides', () => {
    expect(yangonTimestamp('2026-11-24', '00:15')).toBe(Date.UTC(2026, 10, 23, 17, 45));
    expect(parseYangonTime('2026-11-24', '00:15')?.toISOString()).toBe('2026-11-23T17:45:00.000Z');
    for (const [date, time] of [['2027-02-29', '08:00'], ['2026-11-24', '24:00'], ['2026-11-24', '09:60']]) {
      expect(yangonTimestamp(date, time)).toBeNaN();
      expect(parseYangonTime(date, time)).toBeNull();
    }
  });

  it('sets distinct durable reminder windows and shows the time remaining at send time', () => {
    const now = new Date('2026-11-23T00:00:00Z');
    const startsAt = new Date('2026-11-25T10:00:00Z');
    const jobs = deliveryWindows(startsAt, now);
    expect(jobs.map(({ kind, scheduledAt }) => [kind, scheduledAt.toISOString()])).toEqual([
      ['ANNOUNCEMENT', '2026-11-23T00:00:00.000Z'],
      ['DAY_BEFORE', '2026-11-24T10:00:00.000Z'],
      ['SIX_HOURS_BEFORE', '2026-11-25T04:00:00.000Z'],
      ['HOUR_BEFORE', '2026-11-25T09:00:00.000Z'],
      ['AT_START', '2026-11-25T10:00:00.000Z'],
    ]);
    expect(jobs.slice(1).map(({ scheduledAt, expiresAt }) => (+expiresAt - +scheduledAt) / 60_000)).toEqual([15, 10, 5, 10]);
    expect(notification('ANNOUNCEMENT', 'Picnic', startsAt, now)).toContain('16:30 (Yangon) · 2d 10h to go');
    expect(notification('HOUR_BEFORE', 'Picnic', startsAt, new Date('2026-11-25T09:04:00Z'))).toContain('56m to go');
  });
});
