import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { PrometheusMetrics } from '../../observability/metrics.js';
import { PORTS } from '../../ports/tokens.js';

@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(PORTS.metrics) private readonly metrics: PrometheusMetrics,
  ) {}

  @Get()
  async scrape(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.header('content-type', this.metrics.registry.contentType);

    return this.metrics.registry.metrics();
  }
}
