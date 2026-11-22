import { z } from 'zod';

const MAX_MMK = 9_223_372_036_854_775_807n;

const requestIdSchema = z.string().uuid();

export const smartPollSubmissionSchema = z.object({
  requestId: requestIdSchema,
  question: z.string().trim().min(1).max(300),
  options: z.array(z.string().trim().min(1).max(100)).min(2).max(10),
});

const amountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,19}$/)
  .transform((value) => BigInt(value))
  .refine((value) => value > 0n && value <= MAX_MMK);

export const budgetVoteSubmissionSchema = z
  .object({
    requestId: requestIdSchema,
    question: z.string().trim().min(1).max(200),
    amounts: z.array(amountSchema).min(2).max(10),
  })
  .superRefine(({ amounts }, context) => {
    if (new Set(amounts).size !== amounts.length) {
      context.addIssue({
        code: 'custom',
        path: ['amounts'],
        message: 'Amounts must be unique.',
      });
    }
  });

export type SmartPollSubmission = z.infer<typeof smartPollSubmissionSchema>;
export type BudgetVoteSubmission = z.infer<typeof budgetVoteSubmissionSchema>;
