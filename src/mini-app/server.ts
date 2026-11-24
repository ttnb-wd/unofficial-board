import { allowsGroupWorkflows, isOwnerPreview } from '../access/policy.js';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { Telegram } from 'telegraf';
import type { AppConfig } from '../config.js';
import { canAccessBoard } from '../access/membership.js';
import type { createLogger } from '../logger.js';
import { handleBillAction } from '../features/bill-splitter/api.js';
import { MiniAppPersistenceError, saveBudgetVote, savePoll, SubmissionConflictError } from '../features/vote-submission.js';
import type { SavedSubmission } from '../features/vote-submission.js';
import { publicationMessage, publishVote } from '../features/vote-publication.js';
import { refreshGroupMessages } from '../features/group-message.js';
import { deliverBills } from '../features/bill-splitter/delivery.js';
import { handleBirthdayAction } from '../features/birthday-reminder/api.js';
import { deliverBirthdays } from '../features/birthday-reminder/delivery.js';
import { BillError, maxProofBytes } from '../features/bill-splitter/rules.js';
import { handleCountdownAction } from '../features/plan-countdown/api.js';
import { deliverCountdowns } from '../features/plan-countdown/delivery.js';
import { handleHangoutAction } from '../features/one-tap-hangout/api.js';
import { deliverHangouts } from '../features/one-tap-hangout/delivery.js';
import { displayName } from '../features/one-tap-hangout/rules.js';
import { readDashboard } from './dashboard.js';
import { validateTelegramInitData } from './init-data.js';
import { handleVoteAction } from './votes.js';
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

  const isMember = await canAccessBoard(telegram, database, config, user.id, true);
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
  botUsername?: string,
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

  const userId = identity.userId;
  async function publishSaved(saved: SavedSubmission) {
    try {
      if (!botUsername) throw new Error('Telegram identity unavailable');
      const publication = await publishVote(database, telegram, config, botUsername,
        feature === 'poll' ? 'poll' : 'bv', saved.id, userId);
      return { publication, message: publicationMessage(publication) };
    } catch (error) {
      logger.error({ errorName: errorName(error), ...prismaErrorMetadata(error), operation: 'mini-app-publish-vote' },
        'Could not confirm publication of a saved ballot');
      return { publication: 'unconfirmed', message: publicationMessage('unconfirmed') };
    }
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
        ...(parsed.data.publish && allowsGroupWorkflows(config) ? await publishSaved(saved) : {
          status: isOwnerPreview(config) ? 'PRELAUNCH_PREVIEW' : 'DRAFT',
          message: 'Poll saved privately.',
        }),
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
      ...(parsed.data.publish && allowsGroupWorkflows(config) ? await publishSaved(saved) : {
        status: isOwnerPreview(config) ? 'PRELAUNCH_OPEN' : 'DRAFT',
        message: 'Budget vote saved privately.',
      }),
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

const pageAssets = new Map([
  ['/mini-app', 'index.html'],
  ['/mini-app/bills', 'bills.html'],
  ['/mini-app/birthday', 'birthday.html'],
  ['/mini-app/countdown', 'countdown.html'],
  ['/mini-app/hangout', 'hangout.html'],
]);
const scriptAssets = new Set([
  'app.js', 'config.js', 'board.js', 'home.js', 'votes.js', 'bills.js', 'birthday.js',
  'countdown.js', 'countdown-clock.js', 'event-time.js', 'hangout.js', 'hangout-launch.js',
]);
const otherAssets = new Map([
  ['app.css', 'text/css; charset=utf-8'],
  ['icons.svg', 'image/svg+xml'],
  ['board-logo.png', 'image/png'],
  ['welcome.webp', 'image/webp'],
  ['poll.webp', 'image/webp'],
  ['budget.webp', 'image/webp'],
  ['bill.webp', 'image/webp'],
]);

async function serveAsset(response: ServerResponse, path: string) {
  const page = pageAssets.get(path);
  const name = path.startsWith('/mini-app/') ? path.slice('/mini-app/'.length) : '';
  const type = page ? 'text/html; charset=utf-8' :
    scriptAssets.has(name) ? 'text/javascript; charset=utf-8' : otherAssets.get(name);
  if (!type) return false;
  const content = await readFile(resolve(ASSET_DIRECTORY, page ?? name));
  setHeaders(response, type);
  response.end(content);
  return true;
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
  wakeGroupUpdates: () => void;
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
    if (closing || pendingHangoutDelivery || !botUsername || !allowsGroupWorkflows(config)) return;
    pendingHangoutDelivery = deliverHangouts(database, telegram, config, botUsername)
      .catch((error: unknown) => logger.warn({ errorName: errorName(error) }, 'Hangout delivery worker failed'))
      .finally(() => { pendingHangoutDelivery = undefined; });
  };
  const kickCountdowns = () => {
    if (closing || pendingCountdownDelivery || !botUsername || !allowsGroupWorkflows(config)) return;
    pendingCountdownDelivery = deliverCountdowns(database, telegram, config, botUsername)
      .catch((error: unknown) => logger.warn({ errorName: errorName(error) }, 'Countdown delivery worker failed'))
      .finally(() => { pendingCountdownDelivery = undefined; });
  };
  const kick = () => {
    if (closing || pendingDelivery || !botUsername || !allowsGroupWorkflows(config)) return;
    pendingDelivery = deliverBills(database, telegram, config, botUsername)
      .then(() => refreshGroupMessages(database, telegram, config, botUsername))
      .catch((error: unknown) => logger.warn({ errorName: errorName(error) }, 'Bill delivery worker failed'))
      .finally(() => { pendingDelivery = undefined; });
  };
  const kickBirthdays = () => {
    if (closing || pendingBirthdayDelivery || !allowsGroupWorkflows(config)) return;
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
      const isDashboard = url.pathname === '/api/dashboard';
      const isVotes = url.pathname === '/api/votes';
      const isHealth = url.pathname === '/healthz';
      const isApi = feature || isBill || isBirthday || isCountdown || isHangout || isDashboard || isVotes;
      if ((isApi || isHealth) && !allowApiOrigin(request, response, frontendOrigin)) {
        sendJson(response, 403, { error: 'Origin is not allowed.' });
        return;
      }
      if (request.method === 'OPTIONS' && isApi) {
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
      if (request.method === 'GET' && config.serveMiniApp !== false && await serveAsset(response, url.pathname)) {
        return;
      }
      if (request.method === 'POST' && isDashboard) {
        const actor = await authorizeRequest(request, config, database, telegram);
        if (!actor) {
          sendJson(response, 403, { error: 'Access could not be verified. Open The Board from the private bot chat.' });
          return;
        }
        const dashboard = await readDashboard(actor, config, database, telegram, (error) => {
          logger.warn({ errorName: errorName(error) }, 'Dashboard section could not load');
        });
        const dashboardUrl = botUsername && /^[a-zA-Z0-9_]+$/.test(botUsername)
          ? `https://t.me/${botUsername}?start=dashboard` : undefined;
        sendJson(response, 200, { ...dashboard, dashboardUrl });
        return;
      }
      if (request.method === 'POST' && isVotes) {
        const actor = await authorizeRequest(request, config, database, telegram);
        if (!actor) {
          sendJson(response, 403, { error: 'Access could not be verified. Reopen The Board in Telegram.' });
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
        const result = await handleVoteAction(body, actor.userId, config, database, botUsername, telegram);
        if (result.status === 200 && typeof body === 'object' && body && 'action' in body && ['submit', 'close'].includes(String(body.action))) kick();
        sendJson(response, result.status, result.body);
        return;
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
        if (result.status < 300 && typeof body === 'object' && body && 'action' in body &&
            ['create', 'edit', 'cancel'].includes(String(body.action))) kickCountdowns();
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
        await createSubmission(request, response, config, database, telegram, logger, feature, botUsername);
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
    wakeGroupUpdates: () => { kick(); kickCountdowns(); wakeHangouts(); },
    listen: () =>
      new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(config.miniAppPort ?? 3000, '0.0.0.0', () => {
          server.off('error', rejectListen);
          closing = false;
          if (botUsername && allowsGroupWorkflows(config)) {
            kick();
            wakeHangouts();
            deliveryTimer = setInterval(() => {
              kick();
              wakeHangouts();
            }, 15_000);
            deliveryTimer.unref();
          }
          if (allowsGroupWorkflows(config)) {
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
