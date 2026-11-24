import { randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config.js';
import { isOwnerPreview } from '../access/policy.js';

export type SavedSubmission = {
  id: string;
  created: boolean;
};

export class SubmissionConflictError extends Error {}

export class MiniAppPersistenceError extends Error {
  constructor(
    readonly operation: string,
    readonly original: unknown,
  ) {
    super('Mini App persistence failed');
  }
}

type SubmissionRow = {
  creatorId: bigint;
  feature: 'SMART_POLL' | 'BUDGET_VOTE';
  resourceId: string;
  groupId: bigint | null;
};

async function findExistingSubmission(
  transaction: Prisma.TransactionClient,
  requestId: string,
  userId: bigint,
  groupId: bigint,
  feature: SubmissionRow['feature'],
): Promise<SavedSubmission | null> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${requestId}, 0))
  `;
  const rows = await transaction.$queryRaw<SubmissionRow[]>`
    SELECT s."creatorId", s."feature", s."resourceId", COALESCE(p."groupId", b."groupId") AS "groupId"
    FROM "MiniAppSubmission" s
    LEFT JOIN "SmartPoll" p ON s."feature" = 'SMART_POLL' AND p."id" = s."resourceId" AND p."creatorId" = s."creatorId"
    LEFT JOIN "BudgetVote" b ON s."feature" = 'BUDGET_VOTE' AND b."id" = s."resourceId" AND b."creatorId" = s."creatorId"
    WHERE s."requestId" = ${requestId}
    FOR UPDATE OF s
  `;
  const existing = rows[0];
  if (!existing) {
    return null;
  }
  if (existing.creatorId !== userId || existing.feature !== feature || existing.groupId !== groupId) {
    throw new SubmissionConflictError();
  }
  return { id: existing.resourceId, created: false };
}

export async function savePoll(
  database: PrismaClient,
  config: AppConfig,
  userId: bigint,
  submission: {
    requestId: string;
    question: string;
    options: string[];
    multiple?: boolean | undefined;
  },
): Promise<SavedSubmission> {
  let operation = 'idempotency-lock-and-lookup';
  try {
    return await database.$transaction(async (transaction) => {
      const requestId = config.testGroup ? `test:${config.groupId}:${submission.requestId}` : submission.requestId;
      const existing = await findExistingSubmission(
        transaction,
        requestId,
        userId,
        config.groupId,
        'SMART_POLL',
      );
      if (existing) {
        return existing;
      }
      operation = 'upsert-configured-group';
      await transaction.telegramGroup.upsert({
        where: { telegramId: config.groupId },
        create: {
          telegramId: config.groupId,
          isPrelaunchTest: isOwnerPreview(config),
        },
        update: {},
      });
      operation = 'upsert-owner-record';
      await transaction.member.upsert({
        where: { telegramId: userId },
        create: {
          telegramId: userId,
          isPrelaunchTest: isOwnerPreview(config),
        },
        update: {},
      });
      operation = 'create-poll-and-options';
      const poll = await transaction.smartPoll.create({
        data: {
          groupId: config.groupId,
          creatorId: userId,
          question: submission.question,
          ...(submission.multiple ? { allowsMultipleAnswers: true } : {}),
          draftStep: 'SAVED',
          status:
            isOwnerPreview(config)
              ? 'PRELAUNCH_PREVIEW'
              : 'DRAFT',
          isPrelaunchTest: isOwnerPreview(config),
          options: {
            create: submission.options.map((text, position) => ({
              position,
              text,
            })),
          },
        },
        select: { id: true },
      });
      operation = 'record-idempotency-key';
      await transaction.$executeRaw`
        INSERT INTO "MiniAppSubmission" ("requestId", "feature", "creatorId", "resourceId")
        VALUES (${requestId}, 'SMART_POLL'::"MiniAppSubmissionFeature", ${userId}, ${poll.id})
      `;
      return { id: poll.id, created: true };
    }, { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 30_000 });
  } catch (error) {
    if (error instanceof SubmissionConflictError) {
      throw error;
    }
    throw new MiniAppPersistenceError(operation, error);
  }
}

type SavedBudgetVote = SavedSubmission & {
  options: { id: string; amountMmk: bigint }[];
};

export async function saveBudgetVote(
  database: PrismaClient,
  config: AppConfig,
  userId: bigint,
  submission: {
    requestId: string;
    question: string;
    amounts: bigint[];
  },
): Promise<SavedBudgetVote> {
  let operation = 'idempotency-lock-and-lookup';
  try {
    return await database.$transaction(async (transaction) => {
      const requestId = config.testGroup ? `test:${config.groupId}:${submission.requestId}` : submission.requestId;
      const existing = await findExistingSubmission(
        transaction,
        requestId,
        userId,
        config.groupId,
        'BUDGET_VOTE',
      );
      if (existing) {
        operation = 'load-existing-budget-options';
        const options = await transaction.$queryRaw<
          { id: string; amountMmk: bigint }[]
        >`
          SELECT "id", "amountMmk"
          FROM "BudgetVoteOption"
          WHERE "budgetVoteId" = ${existing.id}
          ORDER BY "position" ASC
        `;
        return { ...existing, options };
      }
      operation = 'upsert-configured-group';
      await transaction.telegramGroup.upsert({
        where: { telegramId: config.groupId },
        create: {
          telegramId: config.groupId,
          isPrelaunchTest: isOwnerPreview(config),
        },
        update: {},
      });
      operation = 'upsert-owner-record';
      await transaction.member.upsert({
        where: { telegramId: userId },
        create: {
          telegramId: userId,
          isPrelaunchTest: isOwnerPreview(config),
        },
        update: {},
      });
      operation = 'create-budget-vote';
      const vote = await transaction.budgetVote.create({
        data: {
          groupId: config.groupId,
          creatorId: userId,
          title: submission.question,
          status:
            isOwnerPreview(config)
              ? 'PRELAUNCH_OPEN'
              : 'DRAFT',
          draftStep: 'SAVED',
          isPrelaunchTest: isOwnerPreview(config),
        },
        select: { id: true },
      });
      const options: { id: string; amountMmk: bigint }[] = [];
      operation = 'insert-exact-budget-options';
      for (const [position, amountMmk] of submission.amounts.entries()) {
        const id = randomBytes(12).toString('base64url');
        await transaction.$executeRaw`
          INSERT INTO "BudgetVoteOption" ("id", "budgetVoteId", "position", "amountMmk")
          VALUES (${id}, ${vote.id}, ${position}, ${amountMmk})
        `;
        options.push({ id, amountMmk });
      }
      operation = 'record-idempotency-key';
      await transaction.$executeRaw`
        INSERT INTO "MiniAppSubmission" ("requestId", "feature", "creatorId", "resourceId")
        VALUES (${requestId}, 'BUDGET_VOTE'::"MiniAppSubmissionFeature", ${userId}, ${vote.id})
      `;
      return { id: vote.id, created: true, options };
    }, { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 30_000 });
  } catch (error) {
    if (error instanceof SubmissionConflictError) {
      throw error;
    }
    throw new MiniAppPersistenceError(operation, error);
  }
}
