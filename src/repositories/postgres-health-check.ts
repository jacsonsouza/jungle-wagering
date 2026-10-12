import type { EntityManager } from '@mikro-orm/core';
import type { DependencyHealth, HealthCheckPort } from '../ports/health.port.js';

/**
 * Readiness probe for PostgreSQL: a cheap `select 1` with the round-trip timed.
 *
 * Any failure is DOWN, never an exception — a probe that threw would surface
 * as a 500 and hide which dependency is actually broken.
 */
export class PostgresHealthCheck implements HealthCheckPort {
  constructor(private readonly em: EntityManager) {}

  async check(): Promise<DependencyHealth> {
    const startedAt = performance.now();

    try {
      await this.em.getConnection().execute('select 1', [], 'all');

      return {
        name: 'postgresql',
        status: 'UP',
        latencyMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      return {
        name: 'postgresql',
        status: 'DOWN',
        latencyMs: Math.round(performance.now() - startedAt),
        detail: error instanceof Error ? error.name : 'unknown',
      };
    }
  }
}
