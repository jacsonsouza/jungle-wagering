import {
  DeadlockException,
  DriverException,
  LockWaitTimeoutException,
} from '@mikro-orm/core';

/**
 * SQLSTATEs that mean "PostgreSQL could not hand out a lock".
 *
 * `40001` serialization failure, `40P01` deadlock detected, `55P03` lock wait
 * timeout. The first cannot occur under READ COMMITTED, but it is listed so
 * the predicate stays correct if the isolation level ever changes.
 */
const LOCK_CONFLICT_CODES: ReadonlySet<string> = new Set([
  '40001',
  '40P01',
  '55P03',
]);

/**
 * True when an error is PostgreSQL refusing a lock, rather than a bug or a
 * business refusal.
 *
 * This exists to feed `lock_conflicts_total` (§12). Under pessimistic
 * locking a contended wallet row normally BLOCKS — which is invisible from
 * the outside — so the metric has to be built from the cases where waiting
 * did not work: a deadlock, or a wait that outlived `lock_timeout`.
 *
 * Deliberately narrow. Over-counting would make a healthy system look
 * contended, and a lock conflict is never something to act on by itself — it
 * is a signal about contention, not a failure.
 *
 * Lives outside `domain/` because it inspects infrastructure exceptions, and
 * the domain must stay free of any knowledge of the driver.
 */
export function isLockConflict(error: unknown): boolean {
  if (
    error instanceof DeadlockException ||
    error instanceof LockWaitTimeoutException
  ) {
    return true;
  }

  return (
    error instanceof DriverException &&
    error.code !== undefined &&
    LOCK_CONFLICT_CODES.has(error.code)
  );
}
