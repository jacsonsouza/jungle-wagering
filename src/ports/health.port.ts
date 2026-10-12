export type DependencyStatus = 'UP' | 'DOWN';

export interface DependencyHealth {
  readonly name: string;
  readonly status: DependencyStatus;
  readonly latencyMs: number;
  readonly detail?: string;
}

/**
 * One probe per external dependency. §12 requires liveness and readiness to be
 * separate, so `/health/live` never consults these — a slow database must not
 * make an orchestrator restart a process that is perfectly alive.
 */
export interface HealthCheckPort {
  check(): Promise<DependencyHealth>;
}
