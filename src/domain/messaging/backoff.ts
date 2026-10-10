import { FailureCode } from '../failures/failure-code.js';
import { DomainError } from '../shared/domain-error.js';

export interface BackoffPolicy {
  readonly baseMs: number;
  readonly factor: number;
  readonly maxMs: number;
}

export const DEFAULT_BACKOFF_POLICY: BackoffPolicy = {
  baseMs: 1_000,
  factor: 2,
  maxMs: 300_000,
};

/** Deterministic, no jitter (jitter is a consumer/infra decision). `attempt` is 1-based. */
export function computeBackoff(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF_POLICY,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new InvalidMessageStateError('attempt must be an integer >= 1', {
      attempt,
    });
  }

  return Math.min(policy.maxMs, policy.baseMs * policy.factor ** (attempt - 1));
}

class InvalidMessageStateError extends DomainError {
  readonly code = FailureCode.InvalidMessageState;
}
