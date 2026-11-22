import { describe, expect, it } from 'vitest';
import { features, findFeature } from './index.js';

describe('feature registry', () => {
  it('contains exactly the seven confirmed feature scaffolds', () => {
    expect(features.map((feature) => feature.title)).toEqual([
      'Smart Poll',
      'Bill Splitter',
      'Birthday Reminder',
      'Shared Memory Vault',
      'Plan Countdown',
      'One Tap Hangout',
      'Group Budget Vote',
    ]);
    expect(new Set(features.map((feature) => feature.id)).size).toBe(7);
    expect(features.some((feature) => feature.title.toLowerCase().includes('ai'))).toBe(false);
  });

  it('looks up scaffold routes by feature id', () => {
    expect(findFeature('shared-memory-vault')?.title).toBe('Shared Memory Vault');
    expect(findFeature('not-a-feature')).toBeUndefined();
  });
});
