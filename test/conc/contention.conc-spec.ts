import { FailureCode, WagerTransactionStatus } from '../../src/domain/index.js';
import { closeTestOrm, testOrm, truncateAllTables } from '../setup/orm.js';
import { drainQueues } from '../setup/sqs.js';
import {
  balanceOf,
  bet,
  givenWallet,
  pinnedBet,
  reportOf,
} from './fixtures.js';
import {
  assertWalletMatchesLedger,
  ledgerRowsFor,
  runWorkers,
} from './harness.js';

/**
 * §13 scenarios 1–3 — bets competing for the same money.
 *
 * Contention comes from spawned processes released by a handshake, never from
 * `Promise.all` over a mocked repository: a mock would answer the question
 * this suite exists to ask. Each scenario closes by rebuilding the balance
 * from the ledger, because the one bug with a thousand faces is a balance the
 * entries do not explain.
 */
describe('§13 · wallet contention (scenarios 1–3)', () => {
  beforeAll(async () => {
    await testOrm();
  });

  afterAll(async () => {
    await closeTestOrm();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await drainQueues();
  });

  it('1. applies a bet sent 50 times in parallel exactly once', async () => {
    const walletId = await givenWallet('player-1', '1000.00');

    // All fifty submissions are the SAME operation: same external id, same
    // idempotency key. Anything but one debit means the lock or the dedupe
    // store failed under real contention.
    const command = pinnedBet('player-1', walletId, 'ext-race-50', '25.00');

    const results = await runWorkers(50, () => ({ op: 'submit', command }));
    const reports = results.map((result) => reportOf(result.detail));

    // Every copy gets the same answer — that is what replay means.
    expect(reports).toHaveLength(50);
    expect(
      reports.every((r) => r.status === WagerTransactionStatus.Processed),
    ).toBe(true);

    // Exactly one copy did the work; the other 49 read the stored answer.
    const fresh = reports.filter((r) => !r.idempotentReplay);
    expect(fresh).toHaveLength(1);
    expect(reports.filter((r) => r.idempotentReplay)).toHaveLength(49);

    // And they all agree on which transaction it was.
    const transactionIds = new Set(reports.map((r) => r.transactionId));
    expect(transactionIds.size).toBe(1);

    // One debit in the ledger, not fifty.
    expect(await ledgerRowsFor(fresh[0].transactionId)).toBe(1);
    expect(await balanceOf(walletId)).toBe('975.00');

    await assertWalletMatchesLedger(walletId);
  });

  it('2. settles two simultaneous 80.00 bets against a 100.00 wallet (§8)', async () => {
    const walletId = await givenWallet('player-hot', '100.00');

    // The mandatory §8 scenario: two bets that cannot both be afforded,
    // processed at the same instant from two separate processes.
    const first = bet('player-hot', walletId, '80.00');
    const second = bet('player-hot', walletId, '80.00');

    const results = await runWorkers(2, (index) => ({
      op: 'submit',
      command: index === 0 ? first : second,
    }));

    const reports = results.map((result) => reportOf(result.detail));
    const processed = reports.filter(
      (r) => r.status === WagerTransactionStatus.Processed,
    );
    const rejected = reports.filter(
      (r) => r.status === WagerTransactionStatus.Rejected,
    );

    // Exactly one wins, and the loser is refused on the merits.
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].failureCode).toBe(FailureCode.InsufficientFunds);

    // §8 states the final balance to the cent.
    expect(await balanceOf(walletId)).toBe('20.00');

    // One debit, and none for the refusal.
    expect(await ledgerRowsFor(processed[0].transactionId)).toBe(1);
    expect(await ledgerRowsFor(rejected[0].transactionId)).toBe(0);

    await assertWalletMatchesLedger(walletId);
  });

  it('3. processes bets on distinct wallets in parallel', async () => {
    // Eight wallets, eight bets, eight processes — no two touch the same row,
    // so nothing should serialize behind a lock it does not need.
    const walletIds = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        givenWallet(`player-${index}`, '500.00'),
      ),
    );

    const results = await runWorkers(8, (index) => ({
      op: 'submit',
      command: bet(`player-${index}`, walletIds[index], '100.00'),
    }));

    const reports = results.map((result) => reportOf(result.detail));
    expect(
      reports.every((r) => r.status === WagerTransactionStatus.Processed),
    ).toBe(true);
    expect(reports.every((r) => !r.idempotentReplay)).toBe(true);

    for (const walletId of walletIds) {
      expect(await balanceOf(walletId)).toBe('400.00');
      await assertWalletMatchesLedger(walletId);
    }
  });
});
