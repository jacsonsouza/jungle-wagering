import { FailureCode } from '../failures/failure-code.js';
import { DomainError } from '../shared/domain-error.js';
import {
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../shared/enums.js';

export const AFFECTS_BALANCE: Readonly<Record<WagerTransactionKind, boolean>> =
  {
    OPENING: true,
    BET: true,
    LOSS: false,
    REFUND: true,
    ROLLBACK: true,
    WIN: true,
  };

export const BASE_DIRECTION: Readonly<
  Record<WagerTransactionKind, LedgerDirection | null>
> = {
  OPENING: LedgerDirection.Credit,
  BET: LedgerDirection.Debit,
  WIN: LedgerDirection.Credit,
  LOSS: null,
  REFUND: LedgerDirection.Credit,
  ROLLBACK: null,
};

export const KINDS_REQUIRING_REFERENCE: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export const REFUNDABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
];

export const ROLLBACKABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
];

export function requiresReferenceFor(kind: WagerTransactionKind): boolean {
  return KINDS_REQUIRING_REFERENCE.includes(kind);
}

export function isInternalKind(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Opening;
}

class ReferenceRequiredError extends DomainError {
  readonly code = FailureCode.ReferenceRequired;
}

export function directionFor(
  kind: WagerTransactionKind,
  status: WagerTransactionStatus,
  reference?: {
    readonly kind: WagerTransactionKind;
    readonly status: WagerTransactionStatus;
  },
): LedgerDirection | null {
  if (status !== WagerTransactionStatus.Processed) return null;

  if (!AFFECTS_BALANCE[kind]) return null;

  if (kind === WagerTransactionKind.Rollback) {
    if (!reference) {
      throw new ReferenceRequiredError(
        'ROLLBACK direction requires a resolved reference',
      );
    }

    const referenceDirection = directionFor(reference.kind, reference.status);

    if (referenceDirection === null) {
      throw new ReferenceRequiredError(
        'ROLLBACK reference has no ledger direction to invert',
      );
    }

    return referenceDirection === LedgerDirection.Credit
      ? LedgerDirection.Debit
      : LedgerDirection.Credit;
  }

  return BASE_DIRECTION[kind];
}
