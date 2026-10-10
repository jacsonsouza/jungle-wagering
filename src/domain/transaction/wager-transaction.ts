import { FailureCode } from '../failures/failure-code.js';
import { MoneyProps } from '../money/money-props.js';
import { Money } from '../money/money.js';
import { DomainError } from '../shared/domain-error.js';
import {
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../shared/enums.js';
import { payloadHash } from '../shared/payload-hash.js';
import {
  directionFor,
  isInternalKind,
  requiresReferenceFor,
} from './transaction-rules.js';
import { canTransition, isTerminal } from './transaction-table.js';

export interface ReferenceScope {
  readonly providerId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
}

export interface CreateWagerTransactionProps extends ReferenceScope {
  readonly id: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  /** Required only for REFUND/ROLLBACK (validated in `create`). */
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
}

export interface WagerTransactionState extends Omit<
  CreateWagerTransactionProps,
  'money' | 'createdAt'
> {
  readonly money: MoneyProps;
  readonly payloadHash: string;
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  /** Timestamp of the last state transition (including PENDING_REFERENCE). */
  readonly processedAt?: Date;
  readonly createdAt: Date;
}

/**
 * Business fields that go into the payloadHash (§9). The Idempotency-Key
 * header and transport metadata are deliberately excluded.
 */
export const BUSINESS_PAYLOAD_FIELDS = [
  'providerId',
  'externalTransactionId',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'money',
] as const;

class InvalidTransactionStateError extends DomainError {
  readonly code = FailureCode.InvalidStateTransition;
}

class ReferenceRequiredError extends DomainError {
  readonly code = FailureCode.ReferenceRequired;
}

export class WagerTransaction {
  private _status: WagerTransactionStatus;
  private _referenceTransactionId?: string;
  private _failureCode?: FailureCode;
  private _processedAt?: Date;

  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    status: WagerTransactionStatus,
    referenceTransactionId?: string,
    failureCode?: FailureCode,
    processedAt?: Date,
  ) {
    this._status = status;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = failureCode;
    this._processedAt = processedAt;
  }

  /** Born in PENDING; signs the payload at creation time. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (isInternalKind(props.kind)) {
      throw new InvalidTransactionStateError(
        'OPENING is internal and cannot be submitted',
        {
          kind: props.kind,
        },
      );
    }

    if (
      requiresReferenceFor(props.kind) &&
      !props.referenceExternalTransactionId
    ) {
      throw new ReferenceRequiredError(
        `${props.kind} requires a referenceExternalTransactionId`,
        {
          kind: props.kind,
        },
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      payloadHash(businessSubset(props)),
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(props.createdAt.getTime()),
      WagerTransactionStatus.Pending,
    );
  }

  /**
   * Rehydration does NOT recompute the payloadHash: it is the contract signed
   * at creation time — recomputing it would hide data corruption.
   */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.rehydrate(state.money),
      state.referenceExternalTransactionId,
      new Date(state.createdAt.getTime()),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt ? new Date(state.processedAt.getTime()) : undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  /** Timestamp of the last state transition. */
  get processedAt(): Date | undefined {
    return this._processedAt
      ? new Date(this._processedAt.getTime())
      : undefined;
  }

  // ---- transitions (forbidden pairs throw InvalidTransactionStateError) ----

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = new Date(at.getTime());
  }

  markPendingReference(at: Date): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
    this._processedAt = new Date(at.getTime());
  }

  reject(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._processedAt = new Date(at.getTime());
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._processedAt = new Date(at.getTime());
  }

  // ---- domain queries ----

  isTerminal(): boolean {
    return isTerminal(this._status);
  }

  affectsBalance(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed &&
      requiresKindBalance(this.kind)
    );
  }

  requiresReference(): boolean {
    return requiresReferenceFor(this.kind);
  }

  matchesPayload(otherPayloadHash: string): boolean {
    return this.payloadHash === otherPayloadHash;
  }

  ledgerDirectionFor(reference?: {
    readonly kind: WagerTransactionKind;
    readonly status: WagerTransactionStatus;
  }): LedgerDirection | null {
    return directionFor(this.kind, this._status, reference);
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!canTransition(this._status, next)) {
      throw new InvalidTransactionStateError(
        'transaction status cannot move to the target status',
        {
          from: this._status,
          to: next,
        },
      );
    }

    this._status = next;
  }
}

function requiresKindBalance(kind: WagerTransactionKind): boolean {
  return kind !== WagerTransactionKind.Loss;
}

/** Derived from BUSINESS_PAYLOAD_FIELDS: change the list and the hash follows. */
function businessSubset(
  props: CreateWagerTransactionProps,
): Record<string, unknown> {
  const source = props as unknown as Record<string, unknown>;
  const subset: Record<string, unknown> = {};

  for (const field of BUSINESS_PAYLOAD_FIELDS) {
    subset[field] = field === 'money' ? props.money.props() : source[field];
  }

  return subset;
}
