import type { EntityManager } from '@mikro-orm/core';
import type {
  CurrencyCode,
  LedgerCursor,
  Wallet,
  WalletLedgerEntry,
} from '../domain/index.js';

export interface WalletRepositoryPort {
  /**
   * Read-only lookup (no lock) for the query endpoints.
   *
   * Deliberately separate from `findByIdForUpdate`: a GET must not take a row
   * lock, or a read-only dashboard could stall a wallet's whole betting stream.
   */
  findById(tx: EntityManager, walletId: string): Promise<Wallet | null>;

  findByPlayer(
    tx: EntityManager,
    playerId: string,
    currency: CurrencyCode,
  ): Promise<Wallet | null>;

  /**
   * Same lookup, but the row comes back holding a pessimistic write lock
   * (SELECT ... FOR UPDATE) for the rest of the transaction.
   *
   * This is THE concurrency control of the whole system: two concurrent bets
   * on the same wallet serialize here, so the second one always sees the
   * balance the first one left behind and can be rejected instead of racing
   * past it. Optimistic versioning would work too, but it turns a rejected
   * bet into a retried one — and the spec wants a clean rejection.
   *
   * Keyed by walletId, not (playerId, currency), because §8 defines the
   * walletId as the unit of concurrency: submissions carry it in the payload,
   * and locking on anything else would serialize the wrong rows.
   */
  findByIdForUpdate(
    tx: EntityManager,
    walletId: string,
  ): Promise<Wallet | null>;

  /**
   * One keyset page of the append-only ledger, ordered by (created_at, id).
   *
   * Keyset, not OFFSET: an entry appended while a client is paging must never
   * make the next page skip a row or repeat one. OFFSET does both.
   */
  listEntries(
    tx: EntityManager,
    walletId: string,
    page: { readonly after?: LedgerCursor; readonly limit: number },
  ): Promise<WalletLedgerEntry[]>;

  /**
   * Credits, debits and row count summed by PostgreSQL.
   *
   * Aggregated in the database and returned as strings: folding thousands of
   * amounts through JS would reintroduce the exact float risk `Money` exists
   * to prevent, and reconciliation is the one place that must be beyond doubt.
   */
  sumEntries(
    tx: EntityManager,
    walletId: string,
  ): Promise<{
    readonly creditTotal: string;
    readonly debitTotal: string;
    readonly entryCount: number;
  }>;

  insert(tx: EntityManager, wallet: Wallet): Promise<void>;
  update(tx: EntityManager, wallet: Wallet): Promise<void>;

  /**
   * Appends one immutable ledger entry. There is no "update entry" on purpose:
   * the table is append-only, enforced by a database trigger.
   */
  insertEntry(tx: EntityManager, entry: WalletLedgerEntry): Promise<void>;
}
