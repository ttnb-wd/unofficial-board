import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Telegram } from 'telegraf';
import type { AppConfig } from '../config.js';
import { verifyAndRecordMembership } from '../access/membership.js';
import { hasPrelaunchAccess } from '../access/policy.js';
import type { createLogger } from '../logger.js';
import { handleBillAction } from '../features/bill-splitter/api.js';
import { deliverBills } from '../features/bill-splitter/delivery.js';
import { handleBirthdayAction } from '../features/birthday-reminder/api.js';
import { deliverBirthdays } from '../features/birthday-reminder/delivery.js';
import { BillError, maxProofBytes } from '../features/bill-splitter/rules.js';
import { handleCountdownAction } from '../features/plan-countdown/api.js';
import { deliverCountdowns } from '../features/plan-countdown/delivery.js';
import { handleHangoutAction } from '../features/one-tap-hangout/api.js';
import { deliverHangouts } from '../features/one-tap-hangout/delivery.js';
import { displayName } from '../features/one-tap-hangout/rules.js';
import { validateTelegramInitData } from './init-data.js';
import {
  budgetVoteSubmissionSchema,
  smartPollSubmissionSchema,
} from './validation.js';

const ASSET_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../public/mini-app',
);
const MAX_BODY_BYTES = 16_384;

type RequestIdentity = {
  userId: bigint;
  name: string;
};

type SavedSubmission = {
  id: string;
  created: boolean;
};

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function prismaErrorMetadata(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') {
    return {};
  }
  const metadata =
    'meta' in error &&
    typeof error.meta === 'object' &&
    error.meta !== null
      ? error.meta
      : {};
  return {
    ...('code' in error && typeof error.code === 'string'
      ? { prismaCode: error.code }
      : {}),
    ...('code' in metadata && typeof metadata.code === 'string'
      ? { databaseCode: metadata.code }
      : {}),
    ...('modelName' in metadata && typeof metadata.modelName === 'string'
      ? { modelName: metadata.modelName }
      : {}),
    ...('constraint' in metadata && typeof metadata.constraint === 'string'
      ? { constraint: metadata.constraint }
      : {}),
    ...('target' in metadata &&
    Array.isArray(metadata.target) &&
    metadata.target.every((value) => typeof value === 'string')
      ? { target: metadata.target }
      : {}),
  };
}

function setHeaders(response: ServerResponse, contentType: string): void {
  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:",
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:",
  });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const contentLength = Number(request.headers['content-length'] ?? 0);
  if (contentLength > maxBytes) {
    throw new RangeError('Request body is too large.');
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new RangeError('Request body is too large.');
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function authorizeRequest(
  request: IncomingMessage,
  config: AppConfig,
  database: PrismaClient,
  telegram: Telegram,
): Promise<RequestIdentity | null> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('tma ')) {
    return null;
  }
  const user = validateTelegramInitData(
    authorization.slice(4),
    config.botToken,
  );
  if (!user) {
    return null;
  }

  if (config.accessMode === 'PRELAUNCH') {
    return hasPrelaunchAccess(
      config.accessMode,
      config.prelaunchOwnerId,
      user.id,
    )
      ? { userId: user.id, name: displayName(user) }
      : null;
  }

  const isMember = await verifyAndRecordMembership(
    telegram,
    database,
    config.groupId,
    user.id,
  );
  return isMember ? { userId: user.id, name: displayName(user) } : null;
}

async function createSubmission(
  request: IncomingMessage,
  response: ServerResponse,
  config: AppConfig,
  database: PrismaClient,
  telegram: Telegram,
  logger: ReturnType<typeof createLogger>,
  feature: 'poll' | 'budget',
): Promise<void> {
  const identity = await authorizeRequest(request, config, database, telegram);
  if (!identity) {
    sendJson(response, 403, {
      error: 'Access could not be verified. Reopen the form in the bot’s private chat.',
    });
    return;
  }
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    sendJson(response, 415, { error: 'JSON is required.' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(
      response,
      error instanceof RangeError ? 413 : 400,
      { error: 'The form data could not be read.' },
    );
    return;
  }

  if (feature === 'poll') {
    const parsed = smartPollSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(response, 400, { error: 'Check the question and answer options.' });
      return;
    }
    try {
      const saved = await savePoll(database, config, identity.userId, parsed.data);
      sendJson(response, saved.created ? 201 : 200, {
        id: saved.id,
        created: saved.created,
        status:
          config.accessMode === 'PRELAUNCH'
            ? 'PRELAUNCH_PREVIEW'
            : 'DRAFT',
        message: 'Poll saved privately. Open My polls in the bot.',
      });
    } catch (error) {
      if (error instanceof SubmissionConflictError) {
        sendJson(response, 409, { error: 'This form was already submitted.' });
        return;
      }
      logger.error(
        {
          errorName: errorName(
            error instanceof MiniAppPersistenceError ? error.original : error,
          ),
          ...(error instanceof MiniAppPersistenceError
            ? { databaseOperation: error.operation }
            : {}),
          ...prismaErrorMetadata(
            error instanceof MiniAppPersistenceError ? error.original : error,
          ),
          operation: 'mini-app-save-poll',
        },
        'Could not save Mini App poll',
      );
      sendJson(response, 500, { error: 'Could not save the poll. Try again.' });
    }
    return;
  }

  const parsed = budgetVoteSubmissionSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(response, 400, { error: 'Check the question and MMK amounts.' });
    return;
  }
  try {
    const saved = await saveBudgetVote(
      database,
      config,
      identity.userId,
      parsed.data,
    );
    sendJson(response, saved.created ? 201 : 200, {
      id: saved.id,
      created: saved.created,
      status:
        config.accessMode === 'PRELAUNCH'
          ? 'PRELAUNCH_OPEN'
          : 'DRAFT',
      message: 'Budget vote saved privately. Open My budget votes in the bot.',
    });
  } catch (error) {
    if (error instanceof SubmissionConflictError) {
      sendJson(response, 409, { error: 'This form was already submitted.' });
      return;
    }
    logger.error(
      {
        errorName: errorName(
          error instanceof MiniAppPersistenceError ? error.original : error,
        ),
        ...(error instanceof MiniAppPersistenceError
          ? { databaseOperation: error.operation }
          : {}),
        ...prismaErrorMetadata(
          error instanceof MiniAppPersistenceError ? error.original : error,
        ),
        operation: 'mini-app-save-budget-vote',
      },
      'Could not save Mini App budget vote',
    );
    sendJson(response, 500, { error: 'Could not save the budget vote. Try again.' });
  }
}

class SubmissionConflictError extends Error {}

class MiniAppPersistenceError extends Error {
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
};

async function findExistingSubmission(
  transaction: Prisma.TransactionClient,
  requestId: string,
  userId: bigint,
  feature: SubmissionRow['feature'],
): Promise<SavedSubmission | null> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${requestId}, 0))
  `;
  const rows = await transaction.$queryRaw<SubmissionRow[]>`
    SELECT "creatorId", "feature", "resourceId"
    FROM "MiniAppSubmission"
    WHERE "requestId" = ${requestId}
    FOR UPDATE
  `;
  const existing = rows[0];
  if (!existing) {
    return null;
  }
  if (existing.creatorId !== userId || existing.feature !== feature) {
    throw new SubmissionConflictError();
  }
  return { id: existing.resourceId, created: false };
}

async function savePoll(
  database: PrismaClient,
  config: AppConfig,
  userId: bigint,
  submission: {
    requestId: string;
    question: string;
    options: string[];
  },
): Promise<SavedSubmission> {
  let operation = 'idempotency-lock-and-lookup';
  try {
    return await database.$transaction(async (transaction) => {
      const existing = await findExistingSubmission(
        transaction,
        submission.requestId,
        userId,
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
          isPrelaunchTest: config.accessMode === 'PRELAUNCH',
        },
        update: {},
      });
      operation = 'upsert-owner-record';
      await transaction.member.upsert({
        where: { telegramId: userId },
        create: {
          telegramId: userId,
          isPrelaunchTest: config.accessMode === 'PRELAUNCH',
        },
        update: {},
      });
      operation = 'create-poll-and-options';
      const poll = await transaction.smartPoll.create({
        data: {
          groupId: config.groupId,
          creatorId: userId,
          question: submission.question,
          draftStep: 'SAVED',
          status:
            config.accessMode === 'PRELAUNCH'
              ? 'PRELAUNCH_PREVIEW'
              : 'DRAFT',
          isPrelaunchTest: config.accessMode === 'PRELAUNCH',
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
        VALUES (${submission.requestId}, 'SMART_POLL'::"MiniAppSubmissionFeature", ${userId}, ${poll.id})
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

async function saveBudgetVote(
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
      const existing = await findExistingSubmission(
        transaction,
        submission.requestId,
        userId,
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
          isPrelaunchTest: config.accessMode === 'PRELAUNCH',
        },
        update: {},
      });
      operation = 'upsert-owner-record';
      await transaction.member.upsert({
        where: { telegramId: userId },
        create: {
          telegramId: userId,
          isPrelaunchTest: config.accessMode === 'PRELAUNCH',
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
            config.accessMode === 'PRELAUNCH'
              ? 'PRELAUNCH_OPEN'
              : 'DRAFT',
          draftStep: 'SAVED',
          isPrelaunchTest: config.accessMode === 'PRELAUNCH',
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
        VALUES (${submission.requestId}, 'BUDGET_VOTE'::"MiniAppSubmissionFeature", ${userId}, ${vote.id})
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

async function serveAsset(
  response: ServerResponse,
  fileName: 'index.html' | 'app.css' | 'app.js' | 'config.js' | 'bills.html' | 'bills.js' | 'birthday.html' | 'birthday.js' | 'countdown.html' | 'countdown.js' | 'countdown-clock.js' | 'event-time.js' | 'hangout.html' | 'hangout.js' | 'hangout-launch.js',
): Promise<void> {
  const contentTypes = {
    'index.html': 'text/html; charset=utf-8',
    'bills.html': 'text/html; charset=utf-8',
    'bills.js': 'text/javascript; charset=utf-8',
    'birthday.html': 'text/html; charset=utf-8',
    'hangout.html': 'text/html; charset=utf-8',
    'hangout.js': 'text/javascript; charset=utf-8',
    'hangout-launch.js': 'text/javascript; charset=utf-8',
    'countdown.html': 'text/html; charset=utf-8',
    'countdown.js': 'text/javascript; charset=utf-8',
    'countdown-clock.js': 'text/javascript; charset=utf-8',
    'event-time.js': 'text/javascript; charset=utf-8',
    'birthday.js': 'text/javascript; charset=utf-8',
    'app.css': 'text/css; charset=utf-8',
    'app.js': 'text/javascript; charset=utf-8',
    'config.js': 'text/javascript; charset=utf-8',
  };
  const content = await readFile(resolve(ASSET_DIRECTORY, fileName));
  setHeaders(response, contentTypes[fileName]);
  response.end(content);
}

function allowApiOrigin(
  request: IncomingMessage,
  response: ServerResponse,
  frontendOrigin: string | undefined,
): boolean {
  response.setHeader('Vary', 'Origin');
  const origin = request.headers.origin;
  if (!origin) return request.method !== 'OPTIONS';
  if (origin === frontendOrigin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    return true;
  }
  // With no public frontend configured, the development server serves both sides.
  const host = request.headers.host;
  return !frontendOrigin && request.method !== 'OPTIONS' && Boolean(
    host && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) &&
    origin === `http://${host}`,
  );
}

export function createMiniAppServer(
  config: AppConfig,
  database: PrismaClient,
  telegram: Telegram,
  logger: ReturnType<typeof createLogger>,
  botUsername?: string,
): {
  listen: () => Promise<void>;
  wakeHangouts: () => void;
  close: () => Promise<void>;
} {
  const frontendOrigin = config.miniAppUrl ? new URL(config.miniAppUrl).origin : undefined;
  let pendingDelivery: Promise<void> | undefined;
  let deliveryTimer: NodeJS.Timeout | undefined;
  let pendingBirthdayDelivery: Promise<void> | undefined;
  let birthdayTimer: NodeJS.Timeout | undefined;
  let pendingCountdownDelivery: Promise<void> | undefined;
  let pendingHangoutDelivery: Promise<void> | undefined;
  let closing = false;
  const wakeHangouts = () => {
    if (closing || pendingHangoutDelivery || !botUsername || config.accessMode !== 'LIVE') return;
    pendingHangoutDelivery = deliverHangouts(database, telegram, config, botUsername)
      .catch((error: unknown) => logger.warn({ errorName: errorName(error) }, 'Hangout delivery worker failed'))
      .finally(() => { pendingHangoutDelivery = undefined; });
  };
  const kickCountdowns = () => {
    if (closing || pendingCountdownDelivery || !botUsername || config.accessMode !== 'LIVE') return;
    pendingCountdownDelivery = deliverCountdowns(database, telegram, config, botUsername)
      .catch((error: unknown) => logger.warn({ errorName: errorName(error) }, 'Countdown delivery worker failed'))
      .finally(() => { pendingCountdownDelivery = undefined; });
  };
  const kick = () => {
    if (closing || pendingDelivery || !botUsername || config.accessMode !== 'LIVE') return;
    pendingDelivery = deliverBills(database, telegram, config, botUsername)
      .catch((error: unknown) => logger.warn({ errorName: errorName(error) }, 'Bill delivery worker failed'))
      .finally(() => { pendingDelivery = undefined; });
  };
  const kickBirthdays = () => {
    if (closing || pendingBirthdayDelivery || config.accessMode !== 'LIVE') return;
    pendingBirthdayDelivery = deliverBirthdays(database, telegram, config)
      .catch((error: unknown) => logger.warn({ errorName: errorName(error) }, 'Birthday delivery worker failed'))
      .finally(() => { pendingBirthdayDelivery = undefined; });
  };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const feature = url.pathname === '/api/smart-polls' ? 'poll'
        : url.pathname === '/api/budget-votes' ? 'budget' : null;
      const isBill = url.pathname === '/api/bills';
      const isBirthday = url.pathname === '/api/birthdays';
      const isCountdown = url.pathname === '/api/countdowns';
      const isHangout = url.pathname === '/api/hangouts';
      const isHealth = url.pathname === '/healthz';
      if ((feature || isBill || isBirthday || isCountdown || isHangout || isHealth) && !allowApiOrigin(request, response, frontendOrigin)) {
        sendJson(response, 403, { error: 'Origin is not allowed.' });
        return;
      }
      if (request.method === 'OPTIONS' && (feature || isBill || isBirthday || isCountdown || isHangout)) {
        if (request.headers['access-control-request-method'] !== 'POST') {
          sendJson(response, 405, { error: 'Method is not allowed.' });
          return;
        }
        response.writeHead(204, {
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
        });
        response.end();
        return;
      }
      if (request.method === 'GET' && isHealth) {
        kickCountdowns();
        wakeHangouts();
        sendJson(response, 200, { status: 'ok' });
        return;
      }
      if (request.method === 'GET' && config.serveMiniApp !== false) {
        switch (url.pathname) {
          case '/mini-app':
            await serveAsset(response, 'index.html');
            return;
          case '/mini-app/bills':
            await serveAsset(response, 'bills.html');
            return;
          case '/mini-app/bills.js':
            await serveAsset(response, 'bills.js');
            return;
          case '/mini-app/hangout':
            await serveAsset(response, 'hangout.html');
            return;
          case '/mini-app/hangout.js':
            await serveAsset(response, 'hangout.js');
            return;
          case '/mini-app/hangout-launch.js':
            await serveAsset(response, 'hangout-launch.js');
            return;
          case '/mini-app/countdown':
            await serveAsset(response, 'countdown.html');
            return;
          case '/mini-app/countdown.js':
            await serveAsset(response, 'countdown.js');
            return;
          case '/mini-app/countdown-clock.js':
            await serveAsset(response, 'countdown-clock.js');
            return;
          case '/mini-app/event-time.js':
            await serveAsset(response, 'event-time.js');
            return;
          case '/mini-app/birthday':
            await serveAsset(response, 'birthday.html');
            return;
          case '/mini-app/birthday.js':
            await serveAsset(response, 'birthday.js');
            return;
          case '/mini-app/app.css':
            await serveAsset(response, 'app.css');
            return;
          case '/mini-app/app.js':
            await serveAsset(response, 'app.js');
            return;
          case '/mini-app/config.js':
            await serveAsset(response, 'config.js');
            return;
        }
      }
      if (request.method === 'POST' && isHangout) {
        const receivedAt = new Date();
        const identity = await authorizeRequest(request, config, database, telegram);
        if (!identity) {
          sendJson(response, 403, { error: 'Access could not be verified. Reopen One Tap Hangout from the private bot chat.' });
          return;
        }
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
          sendJson(response, 415, { error: 'JSON is required.' });
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(request);
        } catch (error) {
          sendJson(response, error instanceof RangeError ? 413 : 400, { error: 'The request could not be read.' });
          return;
        }
        const result = await handleHangoutAction(body, { id: identity.userId, name: identity.name, receivedAt }, config, database);
        sendJson(response, result.status, {
          ...result.body,
          ...(result.status === 200 && botUsername && /^[a-zA-Z0-9_]+$/.test(botUsername)
            ? { dashboardUrl: `https://t.me/${botUsername}?start=dashboard` }
            : {}),
        });
        if ('wake' in result && result.wake) wakeHangouts();
        return;
      }
      if (request.method === 'POST' && isCountdown) {
        const identity = await authorizeRequest(request, config, database, telegram);
        if (!identity) {
          sendJson(response, 403, { error: 'Access could not be verified. Reopen Plan Countdown from the private bot chat.' });
          return;
        }
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
          sendJson(response, 415, { error: 'JSON is required.' });
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(request);
        } catch (error) {
          sendJson(response, error instanceof RangeError ? 413 : 400, { error: 'The request could not be read.' });
          return;
        }
        const result = await handleCountdownAction(body, identity.userId, config, database);
        sendJson(response, result.status, {
          ...result.body,
          ...(result.status === 200 && botUsername && /^[a-zA-Z0-9_]+$/.test(botUsername)
            ? { dashboardUrl: `https://t.me/${botUsername}?start=dashboard` }
            : {}),
        });
        if (result.status === 201) kickCountdowns();
        return;
      }
      if (request.method === 'POST' && isBirthday) {
        const identity = await authorizeRequest(request, config, database, telegram);
        if (!identity) {
          sendJson(response, 403, { error: 'Access could not be verified. Reopen Birthday Reminder from the private bot chat.' });
          return;
        }
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
          sendJson(response, 415, { error: 'JSON is required.' });
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(request);
        } catch (error) {
          sendJson(response, error instanceof RangeError ? 413 : 400, { error: 'The request could not be read.' });
          return;
        }
        const result = await handleBirthdayAction(body, identity.userId, config, database, telegram);
        sendJson(response, result.status, result.body);
        return;
      }
      if (request.method === 'POST' && isBill) {
        const identity = await authorizeRequest(request, config, database, telegram);
        if (!identity) {
          sendJson(response, 403, { error: 'Access could not be verified. Reopen Bill Splitter in the private bot chat.' });
          return;
        }
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
          sendJson(response, 415, { error: 'JSON is required.' });
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(request, Math.ceil(maxProofBytes / 3) * 4 + MAX_BODY_BYTES);
        } catch (error) {
          sendJson(response, error instanceof RangeError ? 413 : 400, { error: 'The request could not be read.' });
          return;
        }
        try {
          const result = await handleBillAction(body, identity.userId, config, database, telegram, kick);
          if (result instanceof Uint8Array) {
            response.setHeader('Content-Disposition', 'inline; filename="payment-proof.jpg"');
            response.setHeader('X-Robots-Tag', 'noindex, nofollow');
            setHeaders(response, 'image/jpeg');
            response.end(result);
          } else {
            sendJson(response, 200, result);
          }
        } catch (error) {
          if (!(error instanceof BillError)) throw error;
          sendJson(response, error.status, { error: error.message });
        }
        return;
      }
      if (request.method === 'POST' && feature) {
        await createSubmission(request, response, config, database, telegram, logger, feature);
        return;
      }
      sendJson(response, 404, { error: 'Not found.' });
    })().catch((error: unknown) => {
      logger.error(
        { errorName: errorName(error), operation: 'mini-app-http-request' },
        'Mini App request failed',
      );
      if (!response.headersSent) {
        sendJson(response, 500, { error: 'The request could not be completed.' });
      } else {
        response.destroy();
      }
    });
  });

  return {
    wakeHangouts,
    listen: () =>
      new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(config.miniAppPort ?? 3000, '0.0.0.0', () => {
          server.off('error', rejectListen);
          closing = false;
          if (botUsername && config.accessMode === 'LIVE') {
            kick();
            wakeHangouts();
            deliveryTimer = setInterval(() => {
              kick();
              wakeHangouts();
            }, 15_000);
            deliveryTimer.unref();
          }
          if (config.accessMode === 'LIVE') {
            kickBirthdays();
            kickCountdowns();
            birthdayTimer = setInterval(() => {
              kickBirthdays();
              kickCountdowns();
            }, 60_000);
            birthdayTimer.unref();
          }
          resolveListen();
        });
      }),
    close: async () => {
      closing = true;
      clearInterval(deliveryTimer);
      clearInterval(birthdayTimer);
      await new Promise<void>((resolveClose, rejectClose) => {
        if (!server.listening) {
          resolveClose();
          return;
        }
        server.close((error) => {
          if (error) {
            rejectClose(error);
          } else {
            resolveClose();
          }
        });
      });
      await pendingDelivery;
      await pendingBirthdayDelivery;
      await pendingCountdownDelivery;
      await pendingHangoutDelivery;
    },
  };
}
