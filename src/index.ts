import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { createBot } from './bot/create-bot.js';
import { EnvironmentValidationError, parseEnvironment } from './config.js';
import { createDatabase } from './database.js';
import { createLogger } from './logger.js';
import { createMiniAppServer } from './mini-app/server.js';
import { registerTestScope, startPolling, StartupError, startupErrorCode, verifyDatabaseScope, verifyGroup } from './startup.js';

async function main(): Promise<void> {
  const config = Object.freeze(parseEnvironment(process.env));
  const logger = createLogger(config.logLevel);
  const database = createDatabase(config.databaseUrl);
  let miniAppServer: ReturnType<typeof createMiniAppServer> | undefined;
  let bot: ReturnType<typeof createBot> | undefined;
  let phase = 'database-connect';
  let stopping = false;
  let pollingRequested = false;

  function stopPolling(signal: NodeJS.Signals | 'startup-failure') {
    if (!pollingRequested) return;
    // A signal can arrive while Telegraf is still deleting the webhook.
    try {
      bot?.stop(signal);
    } catch {
      logger.debug('Telegram polling has not entered its loop');
    }
  }
  const onSignal = (signal: NodeJS.Signals) => {
    stopping = true;
    stopPolling(signal);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await database.$connect();
    phase = 'database-scope';
    await verifyDatabaseScope(database, config);
    phase = 'telegram-identity';
    const telegram = new Telegraf(config.botToken).telegram;
    const identity = await telegram.getMe();
    phase = 'telegram-group';
    await verifyGroup(telegram, config, identity.id);
    phase = 'test-scope-registration';
    await registerTestScope(database, telegram, config);
    if (stopping) return;

    bot = createBot(config, database, identity.username, logger, () => miniAppServer?.wakeHangouts(),
      () => miniAppServer?.wakeGroupUpdates());
    bot.botInfo = identity;
    miniAppServer = createMiniAppServer(config, database, bot.telegram, logger, identity.username);
    pollingRequested = true;
    const polling = startPolling(bot, (current) => { phase = current; });
    await polling.started;
    if (stopping) {
      stopPolling('SIGTERM');
      await polling.done;
      return;
    }

    phase = 'http-listen';
    await miniAppServer.listen();
    phase = 'telegram-polling';
    logger.info({ mode: config.accessMode, testGroupEnabled: Boolean(config.testGroup),
      port: config.miniAppPort ?? 3000 }, 'Telegram polling and Mini App ready');
    await polling.done;
  } catch (error) {
    if (!stopping) {
      logger.fatal({
        phase,
        code: startupErrorCode(error),
        ...(error instanceof StartupError && error.scopeReason ? { scopeReason: error.scopeReason } : {}),
      }, 'Application failed');
      process.exitCode = 1;
    }
    stopPolling('startup-failure');
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try {
      await miniAppServer?.close();
    } finally {
      await database.$disconnect();
    }
  }
}

main().catch((error: unknown) => {
  if (error instanceof EnvironmentValidationError) {
    process.stderr.write(`ENVIRONMENT_INVALID ${error.message}\n`);
  } else {
    process.stderr.write(`Application exited (${startupErrorCode(error)}).\n`);
  }
  process.exitCode = 1;
});
