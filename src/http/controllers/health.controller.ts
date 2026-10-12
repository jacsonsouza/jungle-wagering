import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { HealthCheckPort } from '../../ports/health.port.js';
import { PORTS } from '../../ports/tokens.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(PORTS.healthChecks)
    private readonly checks: readonly HealthCheckPort[],
  ) {}

  /**
   * Liveness: is the process running? Never touches the network (§12) — a
   * slow database must not make an orchestrator restart a healthy process.
   */
  @Get('live')
  live(): unknown {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /** Readiness: is the process able to serve traffic? 503 when any dependency is down (§12). */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<unknown> {
    const dependencies = await Promise.all(
      this.checks.map((check) => check.check()),
    );

    const isReady = dependencies.every(
      (dependency) => dependency.status === 'UP',
    );

    if (!isReady) res.status(503);

    return { status: isReady ? 'ok' : 'unavailable', dependencies };
  }
}
