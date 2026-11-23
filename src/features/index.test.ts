import { describe, expect, it } from 'vitest';
import { features, findFeature } from './index.js';

describe('feature registry', () => {
  it('contains exactly the six supported features', () => {
    expect(features.map((feature) => feature.title)).toEqual([
      'Smart Poll',
      'Bill Splitter',
      'Birthday Reminder',
      'Plan Countdown',
      'One Tap Hangout',
      'Group Budget Vote',
    ]);
    expect(new Set(features.map((feature) => feature.id)).size).toBe(6);
    expect(features.some((feature) => feature.title.toLowerCase().includes('ai'))).toBe(false);
  });

  it('looks up supported routes by feature id', () => {
    expect(findFeature('smart-poll')?.title).toBe('Smart Poll');
    expect(findFeature('shared-memory-vault')).toBeUndefined();
    expect(findFeature('not-a-feature')).toBeUndefined();
  });
});
