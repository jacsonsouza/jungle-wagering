import { FailureCode } from '../failures/failure-code.js';
import { DomainError } from './domain-error.js';

/**
 * "The resource you asked for does not exist."
 *
 * These live in the domain not because lookup is a business rule, but because
 * the HTTP boundary speaks exactly one error channel: `DomainError`. Keeping
 * them here means the exception filter needs no special cases, and the caller
 * gets the same structured body for a missing wallet and for a broken payload.
 */
export class WalletNotFoundError extends DomainError {
  readonly code = FailureCode.WalletNotFound;
}

export class TransactionNotFoundError extends DomainError {
  readonly code = FailureCode.TransactionNotFound;
}
