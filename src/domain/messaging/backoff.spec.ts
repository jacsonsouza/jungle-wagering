import { computeBackoff, DEFAULT_BACKOFF_POLICY } from './backoff.js';

describe('computeBackoff', () => {
  it('grows exponentially from the first attempt', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => computeBackoff(attempt))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
  });

  it('caps at the policy maximum', () => {
    expect(computeBackoff(10)).toBe(DEFAULT_BACKOFF_POLICY.maxMs);
    expect(computeBackoff(50)).toBe(300_000);
  });

  it('honours a custom policy', () => {
    const policy = { baseMs: 500, factor: 3, maxMs: 10_000 };
    expect(computeBackoff(1, policy)).toBe(500);
    expect(computeBackoff(3, policy)).toBe(4_500);
    expect(computeBackoff(9, policy)).toBe(10_000);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid attempt %s', (attempt) => {
    expect(() => computeBackoff(attempt)).toThrow(
      'attempt must be an integer >= 1',
    );
  });

  it('is deterministic (no jitter)', () => {
    expect(computeBackoff(4)).toBe(computeBackoff(4));
  });
});
