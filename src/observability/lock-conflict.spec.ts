import {
  DeadlockException,
  DriverException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { describe, expect, it } from 'vitest';
import { InvalidAmountError } from '../domain/index.js';
import { isLockConflict } from './lock-conflict.js';

/** A driver error carrying an arbitrary SQLSTATE, the way `pg` delivers one. */
function driverError(code: string): DriverException {
  return new DriverException(Object.assign(new Error('db said no'), { code }));
}

describe('isLockConflict', () => {
  it('recognises the two lock failures PostgreSQL raises by name', () => {
    expect(
      isLockConflict(new DeadlockException(new Error('deadlock detected'))),
    ).toBe(true);
    expect(
      isLockConflict(new LockWaitTimeoutException(new Error('timeout'))),
    ).toBe(true);
  });

  it('falls back to the SQLSTATE when no dedicated class was raised', () => {
    expect(isLockConflict(driverError('40P01'))).toBe(true);
    expect(isLockConflict(driverError('55P03'))).toBe(true);
    // Impossible under READ COMMITTED, and listed only so a future change of
    // isolation level does not quietly stop being counted.
    expect(isLockConflict(driverError('40001'))).toBe(true);
  });

  it('does not mistake other driver failures for contention', () => {
    expect(isLockConflict(driverError('23505'))).toBe(false); // unique violation
    expect(
      isLockConflict(new UniqueConstraintViolationException(new Error('dup'))),
    ).toBe(false);
  });

  it('does not classify refusals, bugs, or look-alike objects as conflicts', () => {
    expect(isLockConflict(new InvalidAmountError('nope'))).toBe(false);
    expect(isLockConflict(new Error('connection refused'))).toBe(false);
    expect(isLockConflict(undefined)).toBe(false);

    // An SQLSTATE on a non-driver error says nothing about what failed: the
    // guard is the type, not the string.
    expect(isLockConflict({ code: '40P01' })).toBe(false);
  });
});
