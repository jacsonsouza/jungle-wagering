import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ConcJob, ConcResult } from './worker.js';
import { db } from '../setup/orm.js';

/**
 * The worker is TypeScript with `.js` specifiers that resolve to `.ts` files —
 * the codebase's convention. `bun` understands both natively; `node` (which is
 * what `process.execPath` points at under vitest) understands neither, so the
 * child is spawned through bun explicitly rather than through the current
 * runtime.
 */
const WORKER_PATH = new URL('./worker.ts', import.meta.url).pathname;

/**
 * How long the parent waits for every worker to report ready before giving up.
 *
 * Long enough for a cold bun boot plus a MikroORM init plus a database
 * connection on a loaded machine; short enough that a worker which crashed on
 * startup fails the suite with a legible error instead of hanging it.
 */
const READY_TIMEOUT_MS = 30_000;

interface Spawned {
  readonly child: ChildProcessWithoutNullStreams;
  /** Resolves when this worker says it is booted and connected. */
  readonly ready: Promise<void>;
  /** Resolves with this worker's verdict once it finishes. */
  readonly done: Promise<ConcResult>;
}

/**
 * Starts one worker and wires up its two-phase conversation.
 *
 * The child prints `ready` once its database pool is live, then blocks reading
 * stdin until it receives `go`. That ordering is what makes "simultaneous"
 * true rather than aspirational: every process is confirmed connected before
 * any of them is allowed to touch a row, so the race cannot quietly degrade
 * into a queue while still passing every assertion.
 */
function spawnWorker(request: unknown): Spawned {
  const child = spawn('bun', [WORKER_PATH, JSON.stringify(request)], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  const lines: string[] = [];
  const pending: Array<(line: string) => void> = [];

  const onLine = (line: string): void => {
    const waiter = pending.shift();
    if (waiter !== undefined) waiter(line);
    else lines.push(line);
  };

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  let resolveDone!: (result: ConcResult) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<ConcResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  let readySettled = false;
  let doneSettled = false;

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();

    let newline = stdout.indexOf('\n');
    while (newline !== -1) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);

      if (line.length > 0) onLine(line);

      newline = stdout.indexOf('\n');
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  child.on('error', (error) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (!doneSettled) {
      doneSettled = true;
      rejectDone(error);
    }
  });

  child.on('close', (code) => {
    if (!doneSettled) {
      doneSettled = true;
      rejectDone(
        new Error(
          `worker exited with code ${code} before reporting a result.\n` +
            `stderr:\n${stderr || '(empty)'}`,
        ),
      );
    }
    if (!readySettled) {
      readySettled = true;
      rejectReady(
        new Error(
          `worker exited with code ${code} before signalling ready.\n` +
            `stderr:\n${stderr || '(empty)'}`,
        ),
      );
    }
  });

  // First line is the readiness signal; the second is the verdict.
  void (async () => {
    try {
      const first = await nextLine(lines, pending);

      const parsed = JSON.parse(first) as ConcResult;

      if (parsed.phase !== 'ready') {
        throw new Error(`expected a ready signal, got: ${first}`);
      }

      if (!readySettled) {
        readySettled = true;
        resolveReady();
      }

      const second = await nextLine(lines, pending);
      const result = JSON.parse(second) as ConcResult;

      if (result.phase !== 'done') {
        throw new Error(`expected a done signal, got: ${second}`);
      }

      if (result.ok !== true) {
        throw new Error(`worker failed: ${result.error ?? 'unknown error'}`);
      }

      if (!doneSettled) {
        doneSettled = true;
        resolveDone(result);
      }
    } catch (error) {
      if (!readySettled) {
        readySettled = true;
        rejectReady(error instanceof Error ? error : new Error(String(error)));
      }
      if (!doneSettled) {
        doneSettled = true;
        rejectDone(error instanceof Error ? error : new Error(String(error)));
      }
    }
  })();

  return { child, ready, done };
}

/** Takes the next line, whether it already arrived or is still in flight. */
function nextLine(
  lines: string[],
  pending: Array<(line: string) => void>,
): Promise<string> {
  const buffered = lines.shift();
  if (buffered !== undefined) return Promise.resolve(buffered);

  return new Promise((resolve) => pending.push(resolve));
}

/**
 * Runs one job in its own process and returns its verdict.
 *
 * A single worker needs no barrier — it is the only participant — so it is
 * released as soon as it reports ready.
 */
export async function runWorker(job: ConcJob): Promise<ConcResult> {
  const spawned = spawnWorker({ job });

  await spawned.ready;
  spawned.child.stdin.write('go\n');

  return spawned.done;
}

/**
 * Spawns `count` workers and releases them all at the same instant.
 *
 * Every child is confirmed booted and connected before ANY of them starts
 * work. A shared `startAt` timestamp would have been a guess: boot times vary
 * by hundreds of milliseconds, and one straggler arriving late would quietly
 * serialize the run — leaving every assertion green while the race it claims
 * to test never happened. The handshake makes the simultaneity a fact instead
 * of a hope.
 */
export async function runWorkers(
  count: number,
  jobFor: (index: number) => ConcJob,
): Promise<ConcResult[]> {
  const workers = Array.from({ length: count }, (_, index) =>
    spawnWorker({ job: jobFor(index) }),
  );

  // Wait for the whole cohort before releasing any of them. `Promise.all`
  // rejects fast, but the siblings must still be told to stop rather than left
  // holding database connections — hence the release in `finally`.
  try {
    await withTimeout(
      Promise.all(workers.map((worker) => worker.ready)),
      READY_TIMEOUT_MS,
      `only ${count} worker(s) never signalled ready`,
    );

    for (const worker of workers) {
      worker.child.stdin.write('go\n');
    }

    return await Promise.all(workers.map((worker) => worker.done));
  } finally {
    for (const worker of workers) {
      worker.child.stdin.end();
      if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
    }
  }
}

/** Rejects if `promise` has not settled within `ms`. */
async function withTimeout(
  promise: Promise<unknown>,
  ms: number,
  message: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${message} within ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The invariant every §13 scenario ends with:
 *
 *     wallet.balance == saldo reconstruído pelo ledger
 *
 * Money that does not add up is the one bug with no recovery path — it means
 * value was created or destroyed without a trace. Checking it after EVERY
 * scenario (not just the financial ones) is deliberate: a concurrency bug in
 * the outbox or the inbox shows up as duplicated effects, and duplicated
 * effects show up here first.
 */
export async function assertWalletMatchesLedger(walletId: string): Promise<void> {
  const [wallet] = await db<{ balance: string }>(
    `select balance::text as balance from "wallets" where id = '${walletId}'`,
  );

  const [ledger] = await db<{ rebuilt: string }>(
    `select coalesce(
              sum(case when direction = 'CREDIT' then amount else -amount end),
              0.00
            )::text as rebuilt
       from "wallet_ledger_entries"
      where wallet_id = '${walletId}'`,
  );

  if (wallet === undefined) {
    throw new Error(`wallet ${walletId} does not exist`);
  }

  if (wallet.balance !== ledger.rebuilt) {
    throw new Error(
      `wallet ${walletId} claims ${wallet.balance} but its ledger rebuilds to ` +
        `${ledger.rebuilt} — value was created or destroyed`,
    );
  }
}

/** How many times a given transaction is recorded in the ledger. */
export async function ledgerRowsFor(
  transactionId: string,
): Promise<number> {
  const rows = await db<{ count: string }>(
    `select count(*)::text as count from "wallet_ledger_entries"
      where transaction_id = '${transactionId}'`,
  );

  return Number(rows[0].count);
}
