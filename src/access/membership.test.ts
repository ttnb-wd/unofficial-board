import { describe, expect, it } from 'vitest';
import { hasActiveMembership } from './membership.js';

describe('hasActiveMembership', () => {
  it.each(['creator', 'administrator', 'member'])(
    'allows active status %s',
    (status) => {
      expect(hasActiveMembership({ status })).toBe(true);
    },
  );

  it('allows restricted users only while Telegram marks them as members', () => {
    expect(hasActiveMembership({ status: 'restricted', is_member: true })).toBe(true);
    expect(hasActiveMembership({ status: 'restricted', is_member: false })).toBe(false);
    expect(hasActiveMembership({ status: 'restricted' })).toBe(false);
  });

  it.each(['left', 'kicked', 'unknown'])('denies status %s', (status) => {
    expect(hasActiveMembership({ status })).toBe(false);
  });
});
