import {
  Check,
  Entity,
  ManyToOne,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { WalletEntity } from './wallet.entity.js';

@Entity({ tableName: 'wallet_ledger_entries' })
@Check({
  name: 'ck_ledger_amount_positive',
  expression: 'amount > 0',
})
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => WalletEntity, {
    type: 'uuid',
    fieldName: 'wallet_id',
    deleteRule: 'RESTRICT',
  })
  wallet!: WalletEntity;

  /**
   * Deliberately a plain uuid, not a `ManyToOne`: the aggregate only needs the
   * id, and turning it into an entity reference would make every ledger read
   * depend on MikroORM's identity map for no benefit.
   *
   * The referential guarantee itself lives in the database — FK added by
   * `Migration20261011000001_SubmissionHardening`, named so it can be reversed.
   * Nothing in the application can insert an entry for a transaction that
   * does not exist.
   */
  @Property({ type: 'uuid', fieldName: 'transaction_id' })
  transactionId!: string;

  @Property({ type: 'varchar', length: 6 })
  direction!: 'DEBIT' | 'CREDIT';

  @Property({ type: 'numeric', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'varchar', length: 3 })
  currency!: string;

  @Property({
    type: 'numeric',
    precision: 20,
    scale: 2,
    fieldName: 'balance_before',
  })
  balanceBefore!: string;

  @Property({
    type: 'numeric',
    precision: 20,
    scale: 2,
    fieldName: 'balance_after',
  })
  balanceAfter!: string;

  @Property({ type: 'timestamptz' })
  createdAt!: Date;
}
