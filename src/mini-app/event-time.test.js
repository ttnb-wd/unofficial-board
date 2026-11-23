import { describe, expect, it } from 'vitest';
import { eventDateTimeParts, from24Hour, matchesEventDateTime, to24Hour } from '../../public/mini-app/event-time.js';

describe('Mini App event time picker', () => {
  it.each([
    ['12', '00', 'AM', '00:00'], ['12', '30', 'AM', '00:30'],
    ['1', '00', 'AM', '01:00'], ['11', '59', 'AM', '11:59'],
    ['12', '00', 'PM', '12:00'], ['1', '00', 'PM', '13:00'],
    ['7', '30', 'PM', '19:30'], ['11', '59', 'PM', '23:59'],
  ])('round-trips %s:%s %s to %s', (hour, minute, period, time) => {
    expect(to24Hour(hour, minute, period)).toBe(time);
    expect(from24Hour(time)).toEqual({ hour, minute, period });
  });

  it('round-trips every valid minute and rejects incomplete or invalid selections', () => {
    for (let i = 0; i < 24 * 60; i++) {
      const time = new Date(i * 60_000).toISOString().slice(11, 16);
      const { hour, minute, period } = from24Hour(time);
      expect(to24Hour(hour, minute, period)).toBe(time);
    }
    expect(to24Hour('', '00', 'AM')).toBeNull();
    expect(to24Hour('13', '00', 'AM')).toBeNull();
    expect(to24Hour('1', '60', 'AM')).toBeNull();
    expect(to24Hour('1', '30', '')).toBeNull();
    expect(from24Hour('24:00')).toBeNull();
    expect(from24Hour('12:60')).toBeNull();
  });

  it('prefills the Yangon date and time across the UTC day boundary', () => {
    const startsAt = '2099-07-30T17:30:00.000Z';
    expect(eventDateTimeParts(new Date(startsAt))).toEqual({ date: '2099-07-31', time: '00:00' });
    expect(matchesEventDateTime(startsAt, '2099-07-31', '00:00')).toBe(true);
    expect(matchesEventDateTime(startsAt, '2099-07-31', '12:00')).toBe(false);
  });
});
