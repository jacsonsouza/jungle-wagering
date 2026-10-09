import { config as loadDotenv } from 'dotenv';

// Bun reads `.env` into its own process, but it does NOT export those values
// to Node child processes spawned by `bun run` (vitest, `nest start`,
// `node dist/main`). Relying on the runtime made `start:dev` work while every
// other entry point silently booted with `DATABASE_URL === undefined`, so the
// file is loaded explicitly here instead.
loadDotenv({ quiet: true });

export type NodeEnv = 'development' | 'test' | 'production';

export interface Env {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly databaseUrl: string;
}

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];
const DEFAULT_PORT = 3000;
const DATABASE_SCHEMES: readonly string[] = ['postgresql:', 'postgres:'];

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

function load(): Env {
  const issues: string[] = [];

  const nodeEnv = readNodeEnv(issues);
  const port = readPort(issues);
  const databaseUrl = readDatabaseUrl(issues);

  if (issues.length > 0) throw new EnvironmentError(issues);

  return Object.freeze({ nodeEnv, port, databaseUrl });
}

export const env: Env = load();
