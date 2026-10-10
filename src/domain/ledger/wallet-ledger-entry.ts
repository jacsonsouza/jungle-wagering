import { FailureCode } from '../failures/failure-code.js';
import { Money } from '../money/money.js';
import { DomainError } from '../shared/domain-error.js';
import { LedgerDirection } from '../shared/enums.js';

export type CreateWalletLedgerEntryProps = {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
};

class InvalidLedgerEntryError extends DomainError {
  readonly code = FailureCode.InvalidLedgerEntry;
}

export class WalletLedgerEntry {
  private constructor(
    private readonly id: string,
    private readonly walletId: string,
    private readonly transactionId: string,
    private readonly direction: LedgerDirection,
    private readonly money: Money,
    private readonly balanceBefore: Money,
    private readonly balanceAfter: Money,
    private readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateWalletLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('ledger amount must be positive', {
        amount: props.money.toString(),
      });
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(props.createdAt.getTime()), // copy: mutating the source Date can't corrupt the record
    );

    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        'balanceBefore ± money must equal balanceAfter',
        {
          direction: entry.direction,
          balanceBefore: entry.balanceBefore,
          money: entry.money,
          balanceAfter: entry.balanceAfter,
        },
      );
    }

    return entry;
  }

  /** Rehydration validates the SAME invariant: corrupted history fails loudly. */
  static rehydrate(props: CreateWalletLedgerEntryProps): WalletLedgerEntry {
    return WalletLedgerEntry.create(props);
  }

  props(): CreateWalletLedgerEntryProps {
    return {
      id: this.id,
      walletId: this.walletId,
      transactionId: this.transactionId,
      direction: this.direction,
      money: this.money,
      balanceBefore: this.balanceBefore,
      balanceAfter: this.balanceAfter,
      createdAt: new Date(this.createdAt.getTime()),
    };
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);

    return expected.equals(this.balanceAfter);
  }
}
