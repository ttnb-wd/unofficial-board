import { describe, expect, it } from 'vitest';
import { hasPrelaunchAccess, ownsResource } from './policy.js';

describe('hasPrelaunchAccess', () => {
  it('allows only the configured owner in PRELAUNCH mode', () => {
    expect(hasPrelaunchAccess('PRELAUNCH', 42n, 42n)).toBe(true);
    expect(hasPrelaunchAccess('PRELAUNCH', 42n, 84n)).toBe(false);
    expect(hasPrelaunchAccess('LIVE', 42n, 42n)).toBe(false);
  });
});

describe('ownsResource', () => {
  it('allows a member to manage their own resource only', () => {
    expect(ownsResource(42n, 42n)).toBe(true);
    expect(ownsResource(42n, 84n)).toBe(false);
  });
});
