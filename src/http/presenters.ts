import type { MoneyProps, WalletState, WagerTransactionState } from '../domain/index.js';
import type { SubmitTransactionResult } from '../use-cases/submit-transaction.use-case.js';

/**
 * §9 defines the response bodies literally. Presenters keep those shapes in
 * one place so a controller cannot drift from the spec by accident — and so
 * the wire format never leaks domain internals like `payloadHash`.
 */
export function presentWallet(state: WalletState): unknown {
  return {
    id: state.id,
    playerId: state.playerId,
    balance: state.balance,
    version: state.version,
  };
}

export function presentTransaction(state: WagerTransactionState): unknown {
  return {
    transactionId: state.id,
    status: state.status,
    // §7.7: a replay must return the balance the transaction saw, which is
    // not necessarily today's balance. `resultBalance` is that snapshot.
    balance: state.resultBalance ?? state.money,
    failureCode: state.failureCode,
  };
}

export function presentSubmitResult(result: SubmitTransactionResult): unknown {
  return {
    transactionId: result.transactionId,
    status: result.status,
    balance: result.balance,
    idempotentReplay: result.idempotentReplay,
    failureCode: result.failureCode,
  };
}

export function presentMoney(money: MoneyProps): MoneyProps {
  return money;
}
