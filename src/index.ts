import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { createBot } from './bot/create-bot.js';
import { parseEnvironment } from './config.js';
import { createDatabase } from './database.js';
import { createLogger } from './logger.js';
import { createMiniAppServer } from './mini-app/server.js';

async function main(): Promise<void> {
  const config = parseEnvironment(process.env);
  const logger = createLogger(config.logLevel);
  const database = createDatabase(config.databaseUrl);
  let miniAppServer: ReturnType<typeof createMiniAppServer> | undefined;

  try {
    await database.$connect();
    const identity = await new Telegraf(config.botToken).telegram.getMe();
    const bot = createBot(config, database, identity.username, logger);
    miniAppServer = createMiniAppServer(
      config,
      database,
      bot.telegram,
      logger,
    );
    await miniAppServer.listen();
    logger.info(
      { port: config.miniAppPort ?? 3000 },
      'Mini App server started',
    );

    let stopping = false;
    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      if (stopping) {
        return;
      }
      stopping = true;
      logger.info({ signal }, 'Shutting down');
      bot.stop(signal);
      try {
        await miniAppServer?.close();
      } finally {
        await database.$disconnect();
      }
    };
    const handleSignal = (signal: NodeJS.Signals): void => {
      void shutdown(signal).catch((error: unknown) => {
        logger.error(
          { errorName: error instanceof Error ? error.name : 'UnknownError' },
          'Graceful shutdown failed',
        );
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', () => handleSignal('SIGINT'));
    process.once('SIGTERM', () => handleSignal('SIGTERM'));

    await bot.launch();
    logger.info('Bot started');
  } catch (error) {
    logger.fatal(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'Bot startup failed',
    );
    try {
      await miniAppServer?.close();
    } finally {
      await database.$disconnect();
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error && error.name === 'EnvironmentValidationError') {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(
      `Application exited during startup (${error instanceof Error ? error.name : 'UnknownError'}).\n`,
    );
  }
  process.exitCode = 1;
});
