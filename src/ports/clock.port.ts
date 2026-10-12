/**
 * Time is an input, not a global.
 *
 * Injecting the clock is what lets tests assert on `createdAt`/`processedAt`
 * without sleeping or freezing the process clock.
 */
export interface ClockPort {
  now(): Date;
}

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}

/**
 * Elapsed seconds between two instants, floored at zero.
 *
 * The floor is not cosmetic: a clock stepped backwards mid-operation would
 * otherwise publish a negative latency into a histogram, which has no bucket
 * below zero — and a metric that can lie about its own range is worse than
 * no metric at all.
 *
 * It lives beside the clock because it is the only arithmetic these values
 * are ever asked to do: the port defines how time is READ, this defines how
 * time is MEASURED.
 */
export function secondsBetween(from: Date, to: Date): number {
  return Math.max(0, to.getTime() - from.getTime()) / 1000;
}
