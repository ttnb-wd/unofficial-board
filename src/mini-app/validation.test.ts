import { describe, expect, it } from 'vitest';
import {
  budgetVoteSubmissionSchema,
  smartPollSubmissionSchema,
} from './validation.js';

describe('Mini App form validation', () => {
  it('accepts Telegram-sized polls with at least two answers', () => {
    expect(
      smartPollSubmissionSchema.safeParse({
        requestId: '4c4a8f4b-7d6a-4c24-ae93-7a581a9ac542',
        question: 'Where should we go?',
        options: ['Cafe', 'Park', 'Museum'],
      }).success,
    ).toBe(true);
    expect(
      smartPollSubmissionSchema.safeParse({
        requestId: '4c4a8f4b-7d6a-4c24-ae93-7a581a9ac542',
        question: 'Pick one',
        options: ['Only one'],
      }).success,
    ).toBe(false);
  });

  it('preserves exact MMK amounts as bigint and rejects duplicates or ranges', () => {
    const parsed = budgetVoteSubmissionSchema.safeParse({
      requestId: '4c4a8f4b-7d6a-4c24-ae93-7a581a9ac542',
      question: 'How much should we budget?',
      amounts: ['10000', '20000', '30000'],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.amounts).toEqual([10_000n, 20_000n, 30_000n]);
    }

    expect(
      budgetVoteSubmissionSchema.safeParse({
        requestId: '4c4a8f4b-7d6a-4c24-ae93-7a581a9ac542',
        question: 'Budget?',
        amounts: ['10000', '10000'],
      }).success,
    ).toBe(false);
    expect(
      budgetVoteSubmissionSchema.safeParse({
        requestId: '4c4a8f4b-7d6a-4c24-ae93-7a581a9ac542',
        question: 'Budget?',
        amounts: ['10000-20000', '30000'],
      }).success,
    ).toBe(false);
  });
});
