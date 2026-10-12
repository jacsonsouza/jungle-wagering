import { config as loadDotenv } from 'dotenv';

// Bun reads `.env` into its own process, but it does NOT export those values
// to Node child processes spawned by `bun run` (vitest, `nest start`,
// `node dist/main`). Relying on the runtime made `start:dev` work while every
// other entry point silently booted with `DATABASE_URL === undefined`, so the
// file is loaded explicitly here instead.
loadDotenv({ quiet: true });

export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface Env {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly databaseUrl: string;
  readonly logLevel: LogLevel;
  readonly sqs: SqsEnv;
}

/**
 * §10 queue endpoints. Every value is overridable so the same binary runs
 * against LocalStack in development and real AWS in production — nothing about
 * the topology is hardcoded in the workers.
 */
export interface SqsEnv {
  readonly endpoint: string;
  readonly region: string;
  readonly queueUrl: string;
  readonly dlqUrl: string;
  /** In-flight messages per receive call; SQS caps this at 10. */
  readonly maxMessages: number;
  /** Long-poll window, so an idle consumer costs one request, not a spin. */
  readonly waitTimeSeconds: number;
  /** How long SQS hides a message the consumer is working on. */
  readonly visibilityTimeoutSeconds: number;
  /**
   * Credentials are read here rather than by the SQS client so that every
   * environment variable goes through one validated loader. Leaving them to be
   * read at the call site is how a developer's real AWS keys end up pointed at
   * LocalStack — silently, and only in production.
   */
  readonly credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
}

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];
const LOG_LEVELS: readonly LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const DEFAULT_PORT = 3000;
const DEFAULT_LOG_LEVEL: LogLevel = 'INFO';
const DATABASE_SCHEMES: readonly string[] = ['postgresql:', 'postgres:'];

const DEFAULT_SQS_ENDPOINT = 'http://localhost:4566';
const DEFAULT_SQS_REGION = 'us-east-1';
const LOCALSTACK_ACCOUNT = '000000000000';
const DEFAULT_SQS_MAX_MESSAGES = 10;
const DEFAULT_SQS_WAIT_SECONDS = 10;
const DEFAULT_SQS_VISIBILITY_SECONDS = 60;

/**
 * Thrown before Nest boots so a misconfigured deployment fails immediately
 * with a readable message instead of surfacing as a connection error later.
 */
export class EnvironmentError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(
      [
        'Invalid environment configuration:',
        ...issues.map((issue) => `  - ${issue}`),
        '',
        'Copy .env.example to .env and fill in the missing values.',
      ].join('\n'),
    );
    this.name = 'EnvironmentError';
  }
}

function readRaw(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readNodeEnv(issues: string[]): NodeEnv {
  const raw = readRaw('NODE_ENV') ?? 'development';
  if (!NODE_ENVS.includes(raw as NodeEnv)) {
    issues.push(
      `NODE_ENV must be one of ${NODE_ENVS.join(', ')} — received "${raw}"`,
    );
    return 'development';
  }
  return raw as NodeEnv;
}

function readPort(issues: string[]): number {
  const raw = readRaw('PORT');
  if (raw === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(raw)) {
    issues.push(
      `PORT must be an integer between 1 and 65535 — received "${raw}"`,
    );
    return DEFAULT_PORT;
  }
  const port = Number.parseInt(raw, 10);
  if (port < 1 || port > 65535) {
    issues.push(`PORT must be between 1 and 65535 — received "${raw}"`);
    return DEFAULT_PORT;
  }
  return port;
}

function readDatabaseUrl(issues: string[]): string {
  const name = 'DATABASE_URL';
  const raw = readRaw(name);
  if (!raw) {
    issues.push(`${name} is required`);
    return '';
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    issues.push(`${name} is not a valid URL — received "${raw}"`);
    return raw;
  }
  if (!DATABASE_SCHEMES.includes(parsed.protocol)) {
    issues.push(
      `${name} must use ${DATABASE_SCHEMES.join(' or ')} — received "${parsed.protocol}"`,
    );
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    issues.push(`${name} must include a database name`);
  }
  return raw;
}

function readLogLevel(issues: string[]): LogLevel {
  const raw = readRaw('LOG_LEVEL')?.toUpperCase();
  if (raw === undefined) return DEFAULT_LOG_LEVEL;
  if (!LOG_LEVELS.includes(raw as LogLevel)) {
    issues.push(
      `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} — received "${raw}"`,
    );
    return DEFAULT_LOG_LEVEL;
  }
  return raw as LogLevel;
}

function readPositiveInt(
  issues: string[],
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = readRaw(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    issues.push(`${name} must be a positive integer — received "${raw}"`);
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (value < 1 || value > max) {
    issues.push(`${name} must be between 1 and ${max} — received "${raw}"`);
    return fallback;
  }
  return value;
}

/**
 * Defaults point at LocalStack so `bun run start:dev` works with nothing but
 * `infra:up`. Production sets the real ARN-derived URLs instead; the workers
 * never inspect the host, they only ever see a URL.
 */
function readSqs(issues: string[]): SqsEnv {
  const endpoint = readRaw('SQS_ENDPOINT') ?? DEFAULT_SQS_ENDPOINT;
  const region = readRaw('SQS_REGION') ?? DEFAULT_SQS_REGION;
  const queueUrl =
    readRaw('SQS_QUEUE_URL') ?? `${endpoint}/${LOCALSTACK_ACCOUNT}/wager-transactions.fifo`;
  const dlqUrl =
    readRaw('SQS_DLQ_URL') ?? `${endpoint}/${LOCALSTACK_ACCOUNT}/wager-transactions-dlq.fifo`;

  for (const [name, value] of [
    ['SQS_ENDPOINT', endpoint],
    ['SQS_QUEUE_URL', queueUrl],
    ['SQS_DLQ_URL', dlqUrl],
  ] as const) {
    try {
      new URL(value);
    } catch {
      issues.push(`${name} is not a valid URL — received "${value}"`);
    }
  }

  return Object.freeze({
    endpoint,
    region,
    queueUrl,
    dlqUrl,
    maxMessages: readPositiveInt(
      issues,
      'SQS_MAX_MESSAGES',
      DEFAULT_SQS_MAX_MESSAGES,
      10,
    ),
    waitTimeSeconds: readPositiveInt(
      issues,
      'SQS_WAIT_TIME_SECONDS',
      DEFAULT_SQS_WAIT_SECONDS,
      20,
    ),
    visibilityTimeoutSeconds: readPositiveInt(
      issues,
      'SQS_VISIBILITY_TIMEOUT_SECONDS',
      DEFAULT_SQS_VISIBILITY_SECONDS,
      43200,
    ),
    credentials: readSqsCredentials(),
  });
}

/**
 * LocalStack accepts any credential, and defaults keep `start:dev` working
 * with nothing but `infra:up`. Production overrides both with real keys —
 * never with a role, because a long-running worker inside ECS/EKS should take
 * its credentials from the task role instead of the environment.
 */
function readSqsCredentials(): SqsEnv['credentials'] {
  return Object.freeze({
    accessKeyId: readRaw('AWS_ACCESS_KEY_ID') ?? 'test',
    secretAccessKey: readRaw('AWS_SECRET_ACCESS_KEY') ?? 'test',
  });
}

function load(): Env {
  const issues: string[] = [];

  const nodeEnv = readNodeEnv(issues);
  const port = readPort(issues);
  const databaseUrl = readDatabaseUrl(issues);
  const logLevel = readLogLevel(issues);
  const sqs = readSqs(issues);

  if (issues.length > 0) throw new EnvironmentError(issues);

  return Object.freeze({ nodeEnv, port, databaseUrl, logLevel, sqs });
}

export const env: Env = load();
