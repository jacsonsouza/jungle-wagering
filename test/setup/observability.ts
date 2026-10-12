import type { LoggerPort, LogFields } from '../../src/ports/logger.port.js';
import type {
  MetricLabels,
  MetricsPort,
} from '../../src/ports/metrics.port.js';

/**
 * Shared observability doubles.
 *
 * Every construction site of `SubmitTransactionUseCase` and of the messaging
 * workers needs somewhere for `logger` and `metrics` to go. Defining them
 * per file would let two suites drift into different ideas of what "recorded"
 * means — the same reason the SQS helpers live in one place.
 */

/**
 * A logger that discards everything.
 *
 * Tests assert behaviour, not output — and a use case that logs one line per
 * answered submission would otherwise print a line per assertion.
 */
export const quietLogger: LoggerPort = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** One emitted line, kept whole so a test can assert on its fields. */
export interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields?: LogFields;
}

/**
 * A logger that keeps what it is given instead of printing it.
 *
 * Used when the fields of a line ARE the behaviour under test — §12 names
 * `correlationId`, `messageId`, `transactionId`, `walletId` and `providerId`,
 * and a test is what stops one of them silently disappearing.
 */
export function recordingLogger(): LoggerPort & {
  readonly lines: LoggedLine[];
} {
  const lines: LoggedLine[] = [];

  return {
    lines,
    debug: (message, fields) =>
      void lines.push({ level: 'debug', message, fields }),
    info: (message, fields) =>
      void lines.push({ level: 'info', message, fields }),
    warn: (message, fields) =>
      void lines.push({ level: 'warn', message, fields }),
    error: (message, fields) =>
      void lines.push({ level: 'error', message, fields }),
  };
}

/** One emission, kept whole so a test can assert on either part of it. */
export interface RecordedMetric {
  readonly name: string;
  readonly labels?: MetricLabels;
  readonly seconds?: number;
}

/**
 * A metrics sink that records instead of exporting.
 *
 * `seen` holds everything, unfiltered: a test that cares about one metric
 * filters it, and one that cares about the shape of a whole emission — "did
 * this call both count and time it?" — reads it directly. `count` is the
 * common case, so it does not need a filter at every call site.
 */
export function recordingMetrics(): MetricsPort & {
  readonly seen: RecordedMetric[];
  count(name: string): number;
} {
  const seen: RecordedMetric[] = [];

  return {
    seen,
    count: (name) => seen.filter((metric) => metric.name === name).length,
    increment: (name, labels) => void seen.push({ name, labels }),
    observe: (name, seconds, labels) =>
      void seen.push({ name, labels, seconds }),
  };
}
