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
