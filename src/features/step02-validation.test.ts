import { describe, expect, it } from 'vitest';
import {
  parseBudgetRange,
  validateBudgetRange,
  validateBudgetTitle,
  validateHangoutId,
} from './group-budget-vote/validation.js';
import {
  validatePollOption,
  validatePollQuestion,
} from './smart-poll/validation.js';

describe('Smart Poll input validation', () => {
  it('trims questions and rejects empty or overlong input', () => {
    expect(validatePollQuestion('  Dinner?  ')).toBe('Dinner?');
    expect(() => validatePollQuestion('   ')).toThrow();
    expect(() => validatePollQuestion('q'.repeat(301))).toThrow();
  });

  it('rejects duplicate answers without case sensitivity', () => {
    expect(validatePollOption('  Yes ', ['No'])).toBe('Yes');
    expect(() => validatePollOption('yes', ['Yes'])).toThrow(/already/);
  });
});

describe('Group Budget Vote input validation', () => {
  it('accepts integer MMK ranges and rejects invalid ranges', () => {
    expect(parseBudgetRange('1000 - 5000')).toEqual({
      minMmk: 1000n,
      maxMmk: 5000n,
    });
    expect(() => parseBudgetRange('5000-1000')).toThrow();
    expect(() => parseBudgetRange('1.5-2')).toThrow();
  });

  it('rejects overlapping inclusive ranges and accepts separated ranges', () => {
    const first = parseBudgetRange('1000-5000');
    expect(() =>
      validateBudgetRange(parseBudgetRange('5000-8000'), [first]),
    ).toThrow(/overlap/);
    expect(() =>
      validateBudgetRange(parseBudgetRange('5001-8000'), [first]),
    ).not.toThrow();
  });

  it('validates budget questions', () => {
    expect(validateBudgetTitle('  Group dinner  ')).toBe('Group dinner');
    expect(() => validateBudgetTitle('')).toThrow();
  });

  it('accepts a bounded Hangout reference or an explicit skip', () => {
    expect(validateHangoutId('c123abc')).toBe('c123abc');
    expect(validateHangoutId('skip')).toBeNull();
    expect(() => validateHangoutId('https://example.com')).toThrow();
  });
});
