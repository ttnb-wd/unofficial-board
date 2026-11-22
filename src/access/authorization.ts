import type { PrismaClient } from '@prisma/client';
import type { Context } from 'telegraf';
import type { AppConfig } from '../config.js';
import type { createLogger } from '../logger.js';
import { verifyAndRecordMembership } from './membership.js';
import { hasPrelaunchAccess } from './policy.js';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export async function isAuthorizedFeatureContext(
  ctx: Context,
  config: AppConfig,
  database: PrismaClient,
  logger: ReturnType<typeof createLogger>,
  allowGroupChat = false,
): Promise<boolean> {
  if (!ctx.chat || !ctx.from) {
    return false;
  }

  const memberId = BigInt(ctx.from.id);
  if (ctx.chat.type === 'private') {
    if (
      hasPrelaunchAccess(
        config.accessMode,
        config.prelaunchOwnerId,
        memberId,
      )
    ) {
      return true;
    }
    if (config.accessMode !== 'LIVE') {
      return false;
    }
  } else if (
    !allowGroupChat ||
    config.accessMode !== 'LIVE' ||
    BigInt(ctx.chat.id) !== config.groupId
  ) {
    return false;
  }

  try {
    return await verifyAndRecordMembership(
      ctx.telegram,
      database,
      config.groupId,
      memberId,
    );
  } catch (error) {
    logger.warn(
      { errorName: errorName(error), operation: 'feature-membership-check' },
      'Feature member verification failed',
    );
    return false;
  }
}
