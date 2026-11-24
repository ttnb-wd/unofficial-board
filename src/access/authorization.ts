import type { PrismaClient } from '@prisma/client';
import type { Context } from 'telegraf';
import type { AppConfig } from '../config.js';
import type { createLogger } from '../logger.js';
import { canAccessBoard } from './membership.js';

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

  const privateChat = ctx.chat.type === 'private';
  if (!privateChat && (!allowGroupChat || BigInt(ctx.chat.id) !== config.groupId)) return false;

  try {
    return await canAccessBoard(ctx.telegram, database, config, BigInt(ctx.from.id), privateChat);
  } catch (error) {
    logger.warn(
      { errorName: errorName(error), operation: 'feature-membership-check' },
      'Feature member verification failed',
    );
    return false;
  }
}
