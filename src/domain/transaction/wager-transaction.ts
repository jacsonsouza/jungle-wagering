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
  ReferenceRequiredError,
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
  /**
   * Balance the wallet showed when this transaction was answered (§7.7). Null
   * only while the transaction is still PENDING.
   */
  readonly resultBalance?: MoneyProps;
  readonly createdAt: Date;
}

/**
 * Business fields that go into the payloadHash (§9). The Idempotency-Key
 * header and transport metadata are deliberately excluded.
 *
 * `referenceExternalTransactionId` IS included, unlike what a first reading
 * might suggest: it is a business field of the payload, and leaving it out
 * would let the same Idempotency-Key point at two different references while
 * hashing identically — a silent replay where §9 demands a conflict.
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
  'referenceExternalTransactionId',
] as const;

class InvalidTransactionStateError extends DomainError {
  readonly code = FailureCode.InvalidStateTransition;
}

/**
 * §9: the same Idempotency-Key arriving with a divergent payload is a CONFLICT,
 * never a replay. Answering with the stored result would hand the provider an
 * answer to a question it did not ask — and worse, would let two different
 * operations share one audit trail.
 */
export class PayloadMismatchError extends DomainError {
  readonly code = FailureCode.PayloadMismatch;
}

export class WagerTransaction {
  private _status: WagerTransactionStatus;
  private _referenceTransactionId?: string;
  private _failureCode?: FailureCode;
  private _processedAt?: Date;
  private _resultBalance?: Money;

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
    resultBalance?: Money,
  ) {
    this._status = status;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = failureCode;
    this._processedAt = processedAt;
    this._resultBalance = resultBalance;
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
      wagerTransactionPayloadHash(props),
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
   *
   * It DOES validate the enums, for the same reason `Wallet.rehydrate`
   * validates the version: the mapper casts varchar columns to enum types, and
   * that cast is only honest if persisted garbage throws here instead of
   * surfacing later as a `TypeError` from the transition table.
   */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    assertPersistedEnum(
      state.kind,
      WagerTransactionKind,
      'persisted kind is not a known transaction kind',
    );
    assertPersistedEnum(
      state.status,
      WagerTransactionStatus,
      'persisted status is not a known transaction status',
    );
    if (state.failureCode !== undefined) {
      assertPersistedEnum(
        state.failureCode,
        FailureCode,
        'persisted failureCode is not a known failure code',
      );
    }

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
      state.resultBalance ? Money.rehydrate(state.resultBalance) : undefined,
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

  /**
   * The balance this transaction's owner saw when it was answered — what a
   * replay has to return (§7.7). Undefined while the transaction is still
   * PENDING: nobody has seen a balance yet.
   */
  get resultBalance(): Money | undefined {
    return this._resultBalance
      ? Money.rehydrate(this._resultBalance.props())
      : undefined;
  }

  /**
   * Records the balance observed at answer time. Separate from the transition
   * methods because the transaction cannot compute it: the wallet owns the
   * balance, and only the use case holding both can read it.
   *
   * Fails loud if called on a PENDING transaction — a balance for a question
   * that was never answered would be a lie a replay would repeat.
   */
  recordResultBalance(balance: Money): void {
    if (this._status === WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        'result balance can only be recorded once the transaction is answered',
        { status: this._status },
      );
    }

    this._resultBalance = balance;
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

  /**
   * The inverse of `rehydrate` — same contract `Wallet` offers. Handy for
   * round-tripping an aggregate through persistence in one expression.
   */
  state(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money.props(),
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: this.processedAt,
      resultBalance: this._resultBalance?.props(),
      createdAt: new Date(this.createdAt.getTime()),
    };
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

/**
 * Guards a cast from a persisted varchar to a domain enum. The tables use
 * varchar + CHECK rather than native enums (they survive migrations and seed
 * scripts untouched), so the application is the second line of defense.
 */
function assertPersistedEnum<T extends string>(
  value: string,
  allowed: Readonly<Record<string, T>>,
  message: string,
): asserts value is T {
  // Values, not keys: these const objects map PascalCase keys to SCREAMING
  // values, and the database stores the values.
  if (!(Object.values(allowed) as readonly string[]).includes(value)) {
    throw new InvalidTransactionStateError(message, { value });
  }
}

/**
 * The public hash contract (§9). `create` uses it to sign the payload, and
 * `SubmitTransactionUseCase` uses the very same function to compare an
 * incoming payload against a stored one — two implementations here would be
 * two definitions of "identical", which is exactly the bug idempotency exists
 * to prevent.
 *
 * `id`, `idempotencyKey` and `createdAt` are excluded on purpose: they are
 * transport/identity concerns, not business fields.
 */
export function wagerTransactionPayloadHash(
  props: Pick<
    CreateWagerTransactionProps,
    | 'providerId'
    | 'externalTransactionId'
    | 'playerId'
    | 'walletId'
    | 'roundId'
    | 'gameId'
    | 'kind'
    | 'money'
    | 'referenceExternalTransactionId'
  >,
): string {
  return payloadHash(businessSubset(props));
}

/**
 * Derived from BUSINESS_PAYLOAD_FIELDS: change the list and the hash follows.
 *
 * `undefined` fields are OMITTED, not serialized: a BET has no reference, and
 * `"referenceExternalTransactionId": undefined` is not canonicalizable. The
 * distinction still survives — a REFUND pointing at "a" and one pointing at
 * "b" produce different subsets and therefore different hashes.
 */
function businessSubset(
  props: Pick<CreateWagerTransactionProps, 'money'> & Record<string, unknown>,
): Record<string, unknown> {
  const subset: Record<string, unknown> = {};

  for (const field of BUSINESS_PAYLOAD_FIELDS) {
    const value = field === 'money' ? props.money.props() : props[field];

    if (value !== undefined) {
      subset[field] = value;
    }
  }

  return subset;
}
