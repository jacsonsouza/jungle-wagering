import { InvalidMoneyError } from './money.errors.js';
import { Money } from './money.js';

describe('Money.from', () => {
  it.each([
    '',
    '   ',
    '1e5',
    '1E5',
    '1.5e-3',
    '10.505',
    '0.001',
    '-1',
    'abc',
    '10,50',
    '1.',
    '.5',
  ])('rejects invalid input %j', (amount) => {
    expect(() => Money.from({ amount: amount, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ] as const)('rejects non-finite number %s', (value) => {
    expect(() =>
      Money.from({ amount: value.toString(), currency: 'BRL' }),
    ).toThrow(InvalidMoneyError);
  });

  it('rejects non-string amounts even if cast at the call site', () => {
    const bogus = 42 as unknown as string;

    expect(() => Money.from({ amount: bogus, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  it('normalizes scale to 2', () => {
    expect(Money.from({ amount: '10', currency: 'BRL' }).toString()).toBe(
      '10.00',
    );
    expect(Money.from({ amount: '10.5', currency: 'BRL' }).toString()).toBe(
      '10.50',
    );
  });

  it('avoids float artifacts', () => {
    const sum = Money.from({ amount: '0.10', currency: 'BRL' }).add(
      Money.from({ amount: '0.20', currency: 'BRL' }),
    );

    expect(sum.toString()).toBe('0.30');
  });

  it('is immutable', () => {
    const money = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(Object.isFrozen(money)).toBe(true);
  });

  it('rejects operations between different currencies', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(
      'money operations require the same currency',
    );
    expect(() => brl.subtract(usd)).toThrow(
      'money operations require the same currency',
    );
    expect(() => brl.equals(usd)).toThrow(
      'money operations require the same currency',
    );
  });

  it('supports the comparison and arithmetic surface', () => {
    const base = Money.from({ amount: '10.00', currency: 'BRL' });
    const smaller = Money.from({ amount: '9.50', currency: 'BRL' });

    expect(base.isLessThan(smaller)).toBe(false);
    expect(smaller.isLessThan(base)).toBe(true);
    expect(base.equals(Money.from({ amount: '10.00', currency: 'BRL' }))).toBe(
      true,
    );
    expect(
      base
        .subtract(Money.from({ amount: '15.00', currency: 'BRL' }))
        .isNegative(),
    ).toBe(true);
    expect(base.negate().toString()).toBe('-10.00');
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
  });

  it('serializes to contract shape via toJSON', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
    expect(
      JSON.parse(JSON.stringify(Money.from({ amount: '25', currency: 'BRL' }))),
    ).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  it('rehydrates with the same invariants as from()', () => {
    expect(() =>
      Money.rehydrate({ amount: '10.505', currency: 'BRL' }),
    ).toThrow(InvalidMoneyError);
    expect(
      Money.rehydrate({ amount: '10.50', currency: 'BRL' }).toString(),
    ).toBe('10.50');
  });
});
