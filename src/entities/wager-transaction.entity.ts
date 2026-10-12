import {
  Check,
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { WalletEntity } from './wallet.entity.js';

@Entity({ tableName: 'wager_transactions' })
@Check({
  name: 'ck_wager_tx_kind_valid',
  expression: "kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')",
})
@Check({
  name: 'ck_wager_tx_status_valid',
  expression:
    "status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')",
})
@Index({
  name: 'uq_wager_tx_single_reversal',
  expression:
    "create unique index uq_wager_tx_single_reversal on wager_transactions (reference_transaction_id) where kind in ('REFUND', 'ROLLBACK')",
})
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'varchar', length: 64, fieldName: 'provider_id' })
  providerId!: string;

  @Property({
    type: 'varchar',
    length: 128,
    fieldName: 'external_transaction_id',
  })
  externalTransactionId!: string;

  @Property({ type: 'varchar', length: 255, fieldName: 'idempotency_key' })
  idempotencyKey!: string;

  @Property({ type: 'varchar', length: 64, fieldName: 'payload_hash' })
  payloadHash!: string;

  @ManyToOne(() => WalletEntity, {
    type: 'uuid',
    fieldName: 'wallet_id',
    deleteRule: 'RESTRICT',
  })
  wallet!: WalletEntity;

  @Property({ type: 'varchar', length: 64, fieldName: 'player_id' })
  playerId!: string;

  @Property({ type: 'varchar', length: 128, fieldName: 'round_id' })
  roundId!: string;

  @Property({ type: 'varchar', length: 64, fieldName: 'game_id' })
  gameId!: string;

  @Property({ type: 'varchar', length: 16 })
  kind!: string;

  @Property({ type: 'numeric', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'varchar', length: 3 })
  currency!: string;

  @Property({
    type: 'varchar',
    length: 128,
    fieldName: 'reference_external_transaction_id',
    nullable: true,
  })
  referenceExternalTransactionId?: string;

  @Property({ type: 'varchar', length: 20 })
  status!: string;

  @Property({
    type: 'uuid',
    fieldName: 'reference_transaction_id',
    nullable: true,
  })
  referenceTransactionId?: string;

  @Property({
    type: 'varchar',
    length: 64,
    fieldName: 'failure_code',
    nullable: true,
  })
  failureCode?: string;

  @Property({ type: 'timestamptz', fieldName: 'processed_at', nullable: true })
  processedAt?: Date;

  /**
   * Balance the wallet showed when this transaction was answered — the source
   * of truth for a replay (§7.7). It cannot be reconstructed from the ledger:
   * LOSS and REJECTED produce no entry, and for everything else the ledger
   * row would cost an extra join on the hottest path of the system.
   *
   * Kept as a raw string because numeric(20,2) never round-trips through a
   * float. The pair is kept consistent by `ck_wager_tx_result_balance`.
   */
  @Property({
    type: 'numeric',
    precision: 20,
    scale: 2,
    fieldName: 'result_balance_amount',
    nullable: true,
  })
  resultBalanceAmount?: string;

  @Property({
    type: 'varchar',
    length: 3,
    fieldName: 'result_balance_currency',
    nullable: true,
  })
  resultBalanceCurrency?: string;

  /** Backoff bookkeeping for the PENDING_REFERENCE worker (§7.1). */
  @Property({ type: 'integer', fieldName: 'pending_attempts', default: 0 })
  pendingAttempts!: number;

  @Property({
    type: 'timestamptz',
    fieldName: 'pending_next_attempt_at',
    nullable: true,
  })
  pendingNextAttemptAt?: Date;

  @Property({ type: 'timestamptz', fieldName: 'created_at' })
  createdAt!: Date;
}
