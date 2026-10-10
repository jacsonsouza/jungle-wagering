import {
  FailureCategory,
  FailureCode,
  FAILURE_CATEGORY,
  failureCategory,
} from './failure-code.js';
import { DomainError, isDomainError } from '../shared/domain-error.js';

class SampleError extends DomainError {
  readonly code = FailureCode.InsufficientFunds;

  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message, details);
  }
}

describe('failure taxonomy', () => {
  it('assigns a category to every failure code', () => {
    expect(Object.keys(FAILURE_CATEGORY).sort()).toEqual(
      Object.values(FailureCode).sort(),
    );
  });

  it('maps each code to its category', () => {
    expect(failureCategory(FailureCode.PayloadMismatch)).toBe(
      FailureCategory.Conflict,
    );
    expect(failureCategory(FailureCode.MaxRetriesExceeded)).toBe(
      FailureCategory.Exhausted,
    );
    expect(failureCategory(FailureCode.ReferenceNotFound)).toBe(
      FailureCategory.NotFound,
    );
    expect(failureCategory(FailureCode.InvalidStateTransition)).toBe(
      FailureCategory.State,
    );
  });
});

describe('DomainError', () => {
  it('keeps the concrete class name and the failure code', () => {
    const error = new SampleError('boom', { walletId: 'wallet-1' });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SampleError');
    expect(error.code).toBe(FailureCode.InsufficientFunds);
    expect(error.category).toBe(FailureCategory.Validation);
    expect(error.message).toBe('boom');
  });

  it('freezes details and exposes a serializable payload', () => {
    const error = new SampleError('boom', { walletId: 'wallet-1' });

    expect(Object.isFrozen(error.details)).toBe(true);
    expect(error.toJSON()).toEqual({
      name: 'SampleError',
      code: 'INSUFFICIENT_FUNDS',
      category: 'VALIDATION',
      message: 'boom',
      details: { walletId: 'wallet-1' },
    });
  });

  it('supports instanceof and the type guard', () => {
    expect(isDomainError(new SampleError('x'))).toBe(true);
    expect(isDomainError(new Error('x'))).toBe(false);
    expect(isDomainError(undefined)).toBe(false);
  });
});
