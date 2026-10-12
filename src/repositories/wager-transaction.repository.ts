import type { EntityManager } from '@mikro-orm/core';
import { LockMode } from '@mikro-orm/core';
import type { WagerTransaction } from '../domain/index.js';
import type {
  PendingReferenceDue,
  WagerTransactionRepositoryPort,
} from '../ports/wager-transaction-repository.port.js';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity.js';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper.js';
import { WalletEntity } from '../entities/wallet.entity.js';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepositoryPort {
  async insert(
    tx: EntityManager,
    transaction: WagerTransaction,
    walletId: string,
  ): Promise<void> {
    const entity = new WagerTransactionEntity();

    WagerTransactionMapper.toPersistence(transaction, entity);

    entity.wallet = tx.getReference(WalletEntity, walletId);

    await tx.persist(entity).flush();
  }

  async update(
    tx: EntityManager,
    transaction: WagerTransaction,
  ): Promise<void> {
    // The caller already holds the wallet lock, so the row cannot have moved:
    // a reference (PK only) plus a full write produces one UPDATE.
    const entity = tx.getReference(WagerTransactionEntity, transaction.id);

    WagerTransactionMapper.toPersistence(transaction, entity);

    await tx.flush();
  }

  async findByIdempotencyKey(
    tx: EntityManager,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    const entity = await tx.findOne(WagerTransactionEntity, {
      idempotencyKey,
    });

    return entity ? WagerTransactionMapper.toDomain(entity) : null;
  }

  async findById(
    tx: EntityManager,
    transactionId: string,
  ): Promise<WagerTransaction | null> {
    const entity = await tx.findOne(WagerTransactionEntity, {
      id: transactionId,
    });

    return entity ? WagerTransactionMapper.toDomain(entity) : null;
  }

  async findByProviderExternal(
    tx: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const entity = await tx.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });

    return entity ? WagerTransactionMapper.toDomain(entity) : null;
  }

  async findReversalForReference(
    tx: EntityManager,
    referenceTransactionId: string,
  ): Promise<WagerTransaction | null> {
    // Only REFUND and ROLLBACK carry a reference; filtering on kind too keeps
    // the query on the same predicate as the partial unique index.
    const entity = await tx.findOne(WagerTransactionEntity, {
      referenceTransactionId,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });

    return entity ? WagerTransactionMapper.toDomain(entity) : null;
  }

  async schedulePendingAttempt(
    tx: EntityManager,
    transactionId: string,
    attempts: number,
    dueAt: Date,
  ): Promise<void> {
    // nativeUpdate, not `update`: the two columns are intentionally absent
    // from the mapper, so going through it would silently drop the schedule.
    await tx
      .getRepository(WagerTransactionEntity)
      .nativeUpdate(
        { id: transactionId },
        { pendingAttempts: attempts, pendingNextAttemptAt: dueAt },
      );
  }

  async findDueForPendingReference(
    tx: EntityManager,
    now: Date,
    limit: number,
  ): Promise<readonly PendingReferenceDue[]> {
    // `PESSIMISTIC_PARTIAL_WRITE` is MikroORM's spelling of FOR UPDATE SKIP
    // LOCKED (§7.1): several workers may drain the same backlog, and each walks
    // away with a disjoint slice instead of queueing behind the others.
    //
    // Ordered by due time so the oldest deferral is retried first — a backlog
    // should drain oldest-first, or a stuck transaction starves behind newer
    // ones that keep resolving.
    //
    // `refresh` forces a real read: these rows may have been touched by the
    // mapper-less update that armed the attempt, and a cached entity would
    // hand the worker a stale schedule.
    const entities = await tx.find(
      WagerTransactionEntity,
      {
        status: 'PENDING_REFERENCE',
        pendingNextAttemptAt: { $lte: now },
      },
      {
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        orderBy: [{ pendingNextAttemptAt: 'asc' }],
        limit,
        refresh: true,
      },
    );

    return entities.map((entity) => ({
      transaction: WagerTransactionMapper.toDomain(entity),
      attempts: entity.pendingAttempts,
    }));
  }

  async clearPendingSchedule(
    tx: EntityManager,
    transactionId: string,
  ): Promise<void> {
    // Nulling the due time is what removes the row from the worker's queue:
    // `idx_wager_tx_pending_due` is partial on status and keyed on this column,
    // so a resolved transaction with a stale schedule would be retried forever.
    await tx
      .getRepository(WagerTransactionEntity)
      .nativeUpdate({ id: transactionId }, { pendingNextAttemptAt: null });
  }
}
