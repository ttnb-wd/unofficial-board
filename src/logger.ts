import pino from 'pino';

export function createLogger(level: string) {
  return pino({
    level,
    redact: {
      paths: ['*.token', 'token', '*.password', 'password', '*.authorization', 'authorization'],
      censor: '[REDACTED]',
    },
  });
}
