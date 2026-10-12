import {
  Check,
  Entity,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
@Check({
  name: 'ck_wallets_balance_non_negative',
  expression: 'balance >= 0',
})
@Check({
  name: 'ck_wallets_version_positive',
  expression: 'version >= 1',
})
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'varchar', length: 64 })
  playerId!: string;

  @Property({ type: 'varchar', length: 3 })
  currency!: string;

  @Property({ type: 'numeric', precision: 20, scale: 2 })
  balance!: string;

  @Property({ type: 'int' })
  version!: number;

  @Property({ type: 'timestamptz' })
  createdAt!: Date;

  @Property({ type: 'timestamptz' })
  updatedAt!: Date;
}
