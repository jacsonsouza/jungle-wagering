import { WagerTransactionStatus } from '../shared/enums.js';

export const ALLOWED_TRANSITIONS: Readonly<
  Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>
> = {
  PENDING: ['PROCESSED', 'REJECTED', 'FAILED', 'PENDING_REFERENCE'],
  PENDING_REFERENCE: ['PROCESSED', 'REJECTED', 'FAILED'],
  PROCESSED: [],
  REJECTED: [],
  FAILED: [],
};

export const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];

export function canTransition(
  from: WagerTransactionStatus,
  to: WagerTransactionStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: WagerTransactionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
