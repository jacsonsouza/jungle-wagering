import type { EntityManager, FilterQuery } from '@mikro-orm/core';
import { LockMode } from '@mikro-orm/core';
import type {
  CurrencyCode,
  LedgerCursor,
  Wallet,
  WalletLedgerEntry,
} from '../domain/index.js';
import type { WalletRepositoryPort } from '../ports/wallet-repository.port.js';
import { WalletEntity } from '../entities/wallet.entity.js';
import { WalletMapper } from '../mappers/wallet.mapper.js';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity.js';
import { WalletLedgerEntryMapper } from '../mappers/wallet-ledger-entry.mapper.js';

export class MikroOrmWalletRepository implements WalletRepositoryPort {
  async findById(tx: EntityManager, walletId: string): Promise<Wallet | null> {
    const entity = await tx.findOne(WalletEntity, { id: walletId });

    return entity ? WalletMapper.toDomain(entity) : null;
  }

  async findByPlayer(
    tx: EntityManager,
    playerId: string,
    currency: CurrencyCode,
  ): Promise<Wallet | null> {
    const entity = await tx.findOne(WalletEntity, { playerId, currency });

    return entity ? WalletMapper.toDomain(entity) : null;
  }

  async findByIdForUpdate(
    tx: EntityManager,
    walletId: string,
  ): Promise<Wallet | null> {
    // `find` + destructure (instead of `findOne`) keeps the lock on the row
    // without MikroORM adding a LIMIT clause to a FOR UPDATE statement.
    const [entity] = await tx.find(
      WalletEntity,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    return entity ? WalletMapper.toDomain(entity) : null;
  }

  async listEntries(
    tx: EntityManager,
    walletId: string,
    page: { readonly after?: LedgerCursor; readonly limit: number },
  ): Promise<WalletLedgerEntry[]> {
    const where: FilterQuery<WalletLedgerEntryEntity> = { wallet: walletId };

    if (page.after) {
      // Keyset ("seek") pagination. `(created_at, id) > (a, b)` is exactly
      // `created_at > a OR (created_at = a AND id > b)`, so the id tie-break
      // keeps the page boundary stable even when several entries share a
      // timestamp — which they routinely do inside one bet.
      //
      // Expressed with the query builder rather than raw SQL so the ORM can
      // still type the parameters; a raw fragment here would be opaque to
      // every tool that reads this query.
      where.$or = [
        { createdAt: { $gt: page.after.createdAt } },
        { createdAt: page.after.createdAt, id: { $gt: page.after.id } },
      ];
    }

    const entities = await tx.find(WalletLedgerEntryEntity, where, {
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      limit: page.limit,
    });

    return entities.map((entity) => WalletLedgerEntryMapper.toDomain(entity));
  }

  async insert(tx: EntityManager, wallet: Wallet): Promise<void> {
    const entity = new WalletEntity();

    WalletMapper.toPersistence(wallet, entity);

    await tx.persist(entity).flush();
  }

  async update(tx: EntityManager, wallet: Wallet): Promise<void> {
    // The caller already holds the row lock, so the SELECT is skipped: a reference
    // carries only the primary key, and the mapper then writes every column,
    // producing a single UPDATE on flush.
    const entity = tx.getReference(WalletEntity, wallet.id);

    WalletMapper.toPersistence(wallet, entity);

    await tx.flush();
  }

  async insertEntry(
    tx: EntityManager,
    entry: WalletLedgerEntry,
  ): Promise<void> {
    const entity = new WalletLedgerEntryEntity();

    WalletLedgerEntryMapper.toPersistence(entry, entity);

    entity.wallet = tx.getReference(WalletEntity, entry.props().walletId);

    await tx.persist(entity).flush();
  }

  async sumEntries(
    tx: EntityManager,
    walletId: string,
  ): Promise<{
    readonly creditTotal: string;
    readonly debitTotal: string;
    readonly entryCount: number;
  }> {
    const [row] = await tx.getConnection().execute<{
      credit_total: string;
      debit_total: string;
      entry_count: number | string;
    }>(
      `select
         coalesce(sum(case when direction = 'CREDIT' then amount else 0 end), 0)::text as credit_total,
         coalesce(sum(case when direction = 'DEBIT'  then amount else 0 end), 0)::text as debit_total,
         count(*)::int as entry_count
       from wallet_ledger_entries
       where wallet_id = ?`,
      [walletId],
      'all',
    );

    return {
      creditTotal: row.credit_total,
      debitTotal: row.debit_total,
      entryCount: Number(row.entry_count),
    };
  }
}
