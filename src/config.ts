import { z } from 'zod';

const requiredEnvironment = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_GROUP_ID',
  'PRELAUNCH_OWNER_TELEGRAM_ID',
  'DATABASE_URL',
] as const;

const environmentSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_GROUP_ID: z
    .string()
    .regex(/^-?\d+$/)
    .transform((value) => BigInt(value))
    .refine((value) => value !== 0n),
  PRELAUNCH_OWNER_TELEGRAM_ID: z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform((value) => BigInt(value))
    .refine((value) => value <= BigInt(Number.MAX_SAFE_INTEGER)),
  TEST_GROUP_ENABLED: z.enum(['true', 'false']).default('false'),
  TEST_GROUP_ID: z.preprocess((value) => value === '' ? undefined : value, z
    .string().regex(/^-[1-9]\d*$/).transform(BigInt)
    .refine((id) => id >= -BigInt(Number.MAX_SAFE_INTEGER)).optional()),
  ACCESS_MODE: z.enum(['PRELAUNCH', 'LIVE']).default('PRELAUNCH'),
  DATABASE_URL: z
    .string()
    .url()
    .refine(
      (value) =>
        value.startsWith('postgres://') ||
        value.startsWith('postgresql://'),
    ),
  MINI_APP_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .url()
      .refine((value) => {
        const url = URL.parse(value);
        return Boolean(
          url?.protocol === 'https:' && !url.username && !url.password &&
          value.replace(/\/$/, '') === url.origin,
        );
      })
      .optional(),
  ),
  SERVE_MINI_APP: z.enum(['true', 'false']).default('true'),
  MINI_APP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
}).refine(({ MINI_APP_URL, SERVE_MINI_APP, TEST_GROUP_ENABLED }) => {
  if (!MINI_APP_URL) return SERVE_MINI_APP === 'true' && TEST_GROUP_ENABLED === 'false';
  if (SERVE_MINI_APP === 'true' && TEST_GROUP_ENABLED === 'false') return true;
  const host = URL.parse(MINI_APP_URL)?.hostname;
  return Boolean(host && host !== 'localhost' && !host.endsWith('.localhost') && !host.startsWith('127.') &&
    host !== '[::1]' && host !== 'trycloudflare.com' && !host.endsWith('.trycloudflare.com'));
}, { path: ['MINI_APP_URL'] })
  .refine((env) => env.TEST_GROUP_ID === undefined || env.TEST_GROUP_ID !== env.TELEGRAM_GROUP_ID,
    { path: ['TEST_GROUP_ID'] })
  .refine((env) => env.TEST_GROUP_ENABLED === 'false' || env.TEST_GROUP_ID !== undefined,
    { path: ['TEST_GROUP_ID'] })
  .refine((env) => env.TEST_GROUP_ENABLED === 'false' || env.ACCESS_MODE === 'PRELAUNCH',
    { path: ['TEST_GROUP_ENABLED'] });

export type AppConfig = {
  botToken: string;
  /** Active group for every feature and queue. */
  groupId: bigint;
  testGroup?: Readonly<{ id: bigint; originalGroupId: bigint }>;
  prelaunchOwnerId: bigint;
  accessMode: z.infer<typeof environmentSchema>['ACCESS_MODE'];
  databaseUrl: string;
  miniAppUrl?: string;
  miniAppPort?: number;
  serveMiniApp?: boolean;
  logLevel: z.infer<typeof environmentSchema>['LOG_LEVEL'];
};

export class EnvironmentValidationError extends Error {
  constructor(
    public readonly missingVariables: string[],
    public readonly invalidVariables: string[],
  ) {
    const problems = [
      ...(missingVariables.length > 0
        ? [`missing: ${missingVariables.join(', ')}`]
        : []),
      ...(invalidVariables.length > 0
        ? [`invalid: ${invalidVariables.join(', ')}`]
        : []),
    ];
    super(`Invalid environment configuration (${problems.join('; ')})`);
    this.name = 'EnvironmentValidationError';
  }
}

export function parseEnvironment(environment: NodeJS.ProcessEnv): AppConfig {
  const parsed = environmentSchema.safeParse({
    ...environment,
    MINI_APP_PORT: environment.MINI_APP_PORT ?? environment.PORT,
  });
  if (!parsed.success) {
    const missingVariables = requiredEnvironment.filter(
      (key) => environment[key] === undefined || environment[key] === '',
    );
    const missingVariableSet = new Set<string>(missingVariables);
    const invalidVariables = [
      ...new Set(
        parsed.error.issues
          .map((issue) => issue.path[0])
          .filter((key): key is string => typeof key === 'string')
          .filter((key) => !missingVariableSet.has(key)),
      ),
    ];
    throw new EnvironmentValidationError(missingVariables, invalidVariables);
  }

  const testId = parsed.data.TEST_GROUP_ENABLED === 'true' ? parsed.data.TEST_GROUP_ID : undefined;
  return {
    botToken: parsed.data.TELEGRAM_BOT_TOKEN,
    groupId: testId ?? parsed.data.TELEGRAM_GROUP_ID,
    ...(testId === undefined ? {} : {
      testGroup: Object.freeze({ id: testId, originalGroupId: parsed.data.TELEGRAM_GROUP_ID }),
    }),
    prelaunchOwnerId: parsed.data.PRELAUNCH_OWNER_TELEGRAM_ID,
    accessMode: parsed.data.ACCESS_MODE,
    databaseUrl: parsed.data.DATABASE_URL,
    ...(parsed.data.MINI_APP_URL
      ? { miniAppUrl: parsed.data.MINI_APP_URL }
      : {}),
    miniAppPort: parsed.data.MINI_APP_PORT,
    ...(parsed.data.SERVE_MINI_APP === 'false' ? { serveMiniApp: false } : {}),
    logLevel: parsed.data.LOG_LEVEL,
  };
}
