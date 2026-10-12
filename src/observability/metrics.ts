import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry,
} from 'prom-client';
import type { MetricLabels, MetricsPort } from '../ports/metrics.port.js';

/**
 * prom-client backed metrics exposed on `/metrics` (§12).
 *
 * Metric names are built lazily on first use, so a caller can start counting
 * without registering the series up front. Label SETS are captured from that
 * first observation — prom-client requires the label names to exist before
 * the first value is recorded, and refuses any label it was not told about.
 * Every call site for a given metric must therefore use the same label keys,
 * which is what Prometheus asks for anyway.
 *
 * Label sets are deliberately kept to `status`, `code`, `outcome` and
 * `dependency` — all low cardinality by construction, so no walletId or
 * transactionId can ever inflate the registry.
 */
export class PrometheusMetrics implements MetricsPort {
  readonly registry = new Registry();

  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();

  constructor(collectDefaults = true) {
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });
  }

  increment(name: string, labels: MetricLabels = {}): void {
    this.counterFor(name, labels).inc(labels as Record<string, string>);
  }

  observe(name: string, seconds: number, labels: MetricLabels = {}): void {
    this.histogramFor(name, labels).observe(
      labels as Record<string, string>,
      seconds,
    );
  }

  private counterFor(name: string, labels: MetricLabels): Counter {
    let counter = this.counters.get(name);

    if (!counter) {
      counter = new Counter({
        name,
        help: name,
        labelNames: Object.keys(labels),
        registers: [this.registry],
      });
      this.counters.set(name, counter);
    }

    return counter;
  }

  private histogramFor(name: string, labels: MetricLabels): Histogram {
    let histogram = this.histograms.get(name);

    if (!histogram) {
      histogram = new Histogram({
        name,
        help: name,
        labelNames: Object.keys(labels),
        buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5],
        registers: [this.registry],
      });
      this.histograms.set(name, histogram);
    }

    return histogram;
  }
}
