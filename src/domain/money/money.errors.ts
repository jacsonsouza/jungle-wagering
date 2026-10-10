import { FailureCode } from '../failures/failure-code.js';
import { DomainError } from '../shared/domain-error.js';

export class InvalidMoneyError extends DomainError {
  readonly code = FailureCode.InvalidMoneyInput;
}

export class CurrencyMismatchError extends DomainError {
  readonly code = FailureCode.CurrencyMismatch;
}
