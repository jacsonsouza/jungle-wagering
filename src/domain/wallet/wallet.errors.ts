import { FailureCode } from '../failures/failure-code.js';
import { DomainError } from '../shared/domain-error.js';

export class InsufficientFundsError extends DomainError {
  readonly code = FailureCode.InsufficientFunds;
}

export class ReversalInsufficientFundsError extends DomainError {
  readonly code = FailureCode.ReversalInsufficientFunds;
}

export class InvalidAmountError extends DomainError {
  readonly code = FailureCode.InvalidAmount;
}

export class InvalidWalletStateError extends DomainError {
  readonly code = FailureCode.InvalidWalletState;
}

/**
 * The wallet exists but belongs to another player.
 *
 * Categorized NOT_FOUND, not VALIDATION: an attacker must not be able to use
 * this endpoint as an oracle to probe which wallet ids exist. Callers get the
 * same answer whether the wallet is missing or simply not theirs.
 */
export class WalletScopeMismatchError extends DomainError {
  readonly code = FailureCode.WalletScopeMismatch;
}
