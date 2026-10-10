export const FailureCategory = {
  Validation: 'VALIDATION',
  Conflict: 'CONFLICT',
  State: 'STATE',
  NotFound: 'NOT_FOUND',
  Exhausted: 'EXHAUSTED',
} as const;
export type FailureCategory =
  (typeof FailureCategory)[keyof typeof FailureCategory];

export const FailureCode = {
  InvalidMoneyInput: 'INVALID_MONEY_INPUT',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  InvalidAmount: 'INVALID_AMOUNT',
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds: 'REVERSAL_INSUFFICIENT_FUNDS',
  InvalidLedgerEntry: 'INVALID_LEDGER_ENTRY',
  InvalidWalletState: 'INVALID_WALLET_STATE',
  InvalidStateTransition: 'INVALID_STATE_TRANSITION',
  ReferenceRequired: 'REFERENCE_REQUIRED',
  ReferenceScopeMismatch: 'REFERENCE_SCOPE_MISMATCH',
  ReferenceKindNotAllowed: 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceValueMismatch: 'REFERENCE_VALUE_MISMATCH',
  ReferenceNotProcessable: 'REFERENCE_NOT_PROCESSABLE',
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  PayloadMismatch: 'PAYLOAD_MISMATCH',
  AlreadyReversed: 'ALREADY_REVERSED',
  InvalidMessageState: 'INVALID_MESSAGE_STATE',
  MaxRetriesExceeded: 'MAX_RETRIES_EXCEEDED',
  CanonicalJsonUnsupported: 'CANONICAL_JSON_UNSUPPORTED',
} as const;
export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export const FAILURE_CATEGORY: Readonly<Record<FailureCode, FailureCategory>> =
  {
    INVALID_MONEY_INPUT: FailureCategory.Validation,
    CURRENCY_MISMATCH: FailureCategory.Validation,
    INVALID_AMOUNT: FailureCategory.Validation,
    INSUFFICIENT_FUNDS: FailureCategory.Validation,
    REVERSAL_INSUFFICIENT_FUNDS: FailureCategory.Validation,
    INVALID_LEDGER_ENTRY: FailureCategory.Validation,
    INVALID_WALLET_STATE: FailureCategory.Validation,
    CANONICAL_JSON_UNSUPPORTED: FailureCategory.Validation,
    INVALID_STATE_TRANSITION: FailureCategory.State,
    REFERENCE_REQUIRED: FailureCategory.Validation,
    REFERENCE_SCOPE_MISMATCH: FailureCategory.Validation,
    REFERENCE_KIND_NOT_ALLOWED: FailureCategory.Validation,
    REFERENCE_VALUE_MISMATCH: FailureCategory.Validation,
    REFERENCE_NOT_PROCESSABLE: FailureCategory.Validation,
    PAYLOAD_MISMATCH: FailureCategory.Conflict,
    ALREADY_REVERSED: FailureCategory.Conflict,
    REFERENCE_NOT_FOUND: FailureCategory.NotFound,
    INVALID_MESSAGE_STATE: FailureCategory.State,
    MAX_RETRIES_EXCEEDED: FailureCategory.Exhausted,
  };

export function failureCategory(code: FailureCode): FailureCategory {
  return FAILURE_CATEGORY[code];
}
