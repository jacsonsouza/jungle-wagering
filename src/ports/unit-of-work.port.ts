import type { EntityManager } from '@mikro-orm/core';

/**
 * Boundary of "one atomic unit of work".
 *
 * Every use case opens exactly one transaction and passes the resulting
 * EntityManager down to the repositories. Repositories never open their own
 * transactions — that is what makes "wallet + ledger + transaction + outbox
 * all-or-nothing" verifiable by reading the code top to bottom.
 *
 * Both methods also promise ISOLATION: the callback must see the database as
 * it is committed, never another in-flight call's half-built entities. That is
 * not a detail of the implementation — "the database decides idempotency"
 * stops being true the moment two callers share an identity map.
 */
export interface UnitOfWorkPort {
  transaction<T>(fn: (tx: EntityManager) => Promise<T>): Promise<T>;

  /** Read-only path, used to answer "what actually happened?" after a race. */
  read<T>(fn: (em: EntityManager) => Promise<T>): Promise<T>;
}

/**
 * Runs unit of work against the EntityManager it was handed.
 *
 * `clear: true` is load-bearing. The NestJS module injects the process-wide
 * root `orm.em` (its default scope), so every request shares one identity map.
 * Left alone, two concurrent submissions would read each other's managed
 * entities — and "the database decides idempotency" would quietly become "the
 * identity map decides". MikroORM's own concurrency note prescribes exactly
 * this: each handler runs in its own clear fork, on its own connection.
 */
export class MikroOrmUnitOfWork implements UnitOfWorkPort {
  constructor(private readonly em: EntityManager) {}

  transaction<T>(fn: (tx: EntityManager) => Promise<T>): Promise<T> {
    return this.em.transactional(fn, { clear: true });
  }

  read<T>(fn: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.em.transactional(fn, { readOnly: true, clear: true });
  }
}
