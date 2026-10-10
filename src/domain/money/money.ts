import { Decimal } from 'decimal.js';
import { CurrencyCode } from '../shared/currency.js';
import { MoneyProps } from './money-props.js';
import { CurrencyMismatchError, InvalidMoneyError } from './money.errors.js';
import { D } from './decimal-config.js';

const MONEY_PATTERN = /^-?\d+(\.\d{1,2})?$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: CurrencyCode,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    return new Money(parseAmount(props.amount), props.currency);
  }

  static rehydrate(props: MoneyProps): Money {
    return Money.from(props);
  }

  static zero(currency: CurrencyCode): Money {
    return new Money(new D(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.equals(other.value);
  }

  props(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  toJSON(): MoneyProps {
    return this.props();
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        'money operations require the same currency',
        {
          left: this.currency,
          right: other.currency,
        },
      );
    }
  }
}

function parseAmount(input: unknown): Decimal {
  if (typeof input !== 'string') {
    throw new InvalidMoneyError('amount must be a decimal string', {
      type: typeof input,
    });
  }

  if (input.trim() === '') {
    throw new InvalidMoneyError('amount must not be empty');
  }

  if (!MONEY_PATTERN.test(input)) {
    throw new InvalidMoneyError(
      'amount must be a plain decimal with at most 2 places',
      { input },
    );
  }

  const value = D(input);

  // The regex above only accepts digits with at most 2 decimal places, so the
  // value is finite by construction — no defensive check needed here.
  if (value.isNegative()) {
    throw new InvalidMoneyError(
      'negative amounts are not allowed in entry contracts',
      { input },
    );
  }

  return value;
}
