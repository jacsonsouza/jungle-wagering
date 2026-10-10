import { FailureCode } from '../failures/failure-code.js';
import { DomainError } from '../shared/domain-error.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../shared/enums.js';
import { REFUNDABLE_KINDS, ROLLBACKABLE_KINDS } from './transaction-rules.js';
import type { ReferenceScope } from './wager-transaction.js';

class ReferenceScopeMismatchError extends DomainError {
  readonly code = FailureCode.ReferenceScopeMismatch;
}

class ReferenceKindNotAllowedError extends DomainError {
  readonly code = FailureCode.ReferenceKindNotAllowed;
}

class ReferenceValueMismatchError extends DomainError {
  readonly code = FailureCode.ReferenceValueMismatch;
}

class ReferenceNotProcessableError extends DomainError {
  readonly code = FailureCode.ReferenceNotProcessable;
}

export function assertReferenceIsValid(args: {
  readonly incoming: ReferenceScope & {
    kind: WagerTransactionKind;
    amount: string;
    currency: string;
  };
  readonly reference: ReferenceScope & {
    kind: WagerTransactionKind;
    status: WagerTransactionStatus;
    amount: string;
    currency: string;
  };
}): void {
  const { incoming, reference } = args;

  const divergent = (
    ['providerId', 'playerId', 'walletId', 'roundId'] as const
  ).find((field) => incoming[field] !== reference[field]);

  if (divergent) {
    throw new ReferenceScopeMismatchError(
      'reference must belong to the same scope',
      { field: divergent },
    );
  }

  if (incoming.currency !== reference.currency) {
    throw new ReferenceScopeMismatchError(
      'reference must share the same currency',
      {
        incoming: incoming.currency,
        reference: reference.currency,
      },
    );
  }

  if (reference.status !== WagerTransactionStatus.Processed) {
    throw new ReferenceNotProcessableError(
      'only PROCESSED transactions can be referenced',
      {
        referenceStatus: reference.status,
      },
    );
  }

  const allowed =
    incoming.kind === WagerTransactionKind.Refund
      ? REFUNDABLE_KINDS
      : ROLLBACKABLE_KINDS;

  if (!allowed.includes(reference.kind)) {
    throw new ReferenceKindNotAllowedError(
      'reference kind is not allowed for this operation',
      {
        operation: incoming.kind,
        referenceKind: reference.kind,
      },
    );
  }

  if (incoming.amount !== reference.amount) {
    throw new ReferenceValueMismatchError(
      'reversal value must equal the referenced value',
      {
        incoming: incoming.amount,
        reference: reference.amount,
      },
    );
  }
}
