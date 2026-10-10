import { FailureCode } from '../failures/failure-code.js';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry.js';
import { MoneyProps } from '../money/money-props.js';
import { CurrencyMismatchError } from '../money/money.errors.js';
import { Money } from '../money/money.js';
import { CurrencyCode } from '../shared/currency.js';
import { LedgerDirection } from '../shared/enums.js';
import {
  InsufficientFundsError,
  InvalidAmountError,
  InvalidWalletStateError,
  ReversalInsufficientFundsError,
} from './wallet.errors.js';

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly openedAt: Date;
}

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: CurrencyCode;
  readonly balance: MoneyProps;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WalletMovementProps {
  readonly entryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly at: Date;
  readonly insufficientFundsCode?: FailureCode;
}

export class Wallet {
  private _balance: Money;
  private _version: number;
  private _updatedAt: Date;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: CurrencyCode,
    balance: Money,
    version: number,
    updatedAt: Date,
  ) {
    this._balance = balance;
    this._version = version;
    this._updatedAt = updatedAt;
  }

  static open(props: OpenWalletProps): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(props.openedAt.getTime()),
    );
  }

  static rehydrate(state: WalletState): Wallet {
    const balance = Money.rehydrate(state.balance);

    if (balance.currency !== state.currency) {
      throw new CurrencyMismatchError(
        'persisted balance currency differs from wallet currency',
        {
          wallet: state.currency,
          balance: balance.currency,
        },
      );
    }

    if (!Number.isInteger(state.version) || state.version < 1) {
      throw new InvalidWalletStateError(
        'persisted version must be an integer >= 1',
        {
          version: state.version,
        },
      );
    }

    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      balance,
      state.version,
      new Date(state.updatedAt.getTime()),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    return this.move(LedgerDirection.Debit, props);
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    return this.move(LedgerDirection.Credit, props);
  }

  private move(
    direction: LedgerDirection,
    props: WalletMovementProps,
  ): WalletLedgerEntry {
    this.assertSameCurrency(props.money);

    if (!props.money.isPositive()) {
      throw new InvalidAmountError('movement amount must be positive', {
        amount: props.money.toString(),
      });
    }

    const balanceBefore = this._balance;

    const balanceAfter =
      direction === LedgerDirection.Debit
        ? balanceBefore.subtract(props.money)
        : balanceBefore.add(props.money);

    if (direction === LedgerDirection.Debit && balanceAfter.isNegative()) {
      const code = props.insufficientFundsCode ?? FailureCode.InsufficientFunds;

      const ErrorCtor =
        code === FailureCode.ReversalInsufficientFunds
          ? ReversalInsufficientFundsError
          : InsufficientFundsError;

      throw new ErrorCtor('wallet balance would become negative', {
        balance: balanceBefore.toString(),
        amount: props.money.toString(),
      });
    }

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date(props.at.getTime());

    return WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: props.at,
    });
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        'movement currency differs from wallet currency',
        {
          wallet: this.currency,
          movement: money.currency,
        },
      );
    }
  }
}
