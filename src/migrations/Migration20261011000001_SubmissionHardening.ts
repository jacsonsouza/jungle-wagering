import { Migration } from '@mikro-orm/migrations';

/**
 * Hardening found by reading the challenge end-to-end after Phase 2 was
 * already applied. Three gaps, one reversible migration:
 *
 *   1. `wallet_ledger_entries.transaction_id` had a UNIQUE pair but NO foreign
 *      key to `wager_transactions`. Nothing stopped an entry pointing at a
 *      transaction that never existed. §5.9 puts these guarantees in the
 *      schema, not in the application.
 *
 *   2. §7.7 requires a replay to return "the balance observed at that moment".
 *      For BET/WIN the ledger's `balance_after` would do, but LOSS and
 *      REJECTED produce no ledger entry — so the balance has to live on the
 *      transaction itself.
 *
 *   3. §7.1 puts PENDING_REFERENCE under a scheduled worker with exponential
 *      backoff and an attempt limit. That state belongs on the row the worker
 *      polls, not in memory.
 */
export class Migration20261011000001_SubmissionHardening extends Migration {
  override name = 'Migration20261011000001_SubmissionHardening';

  override up(): void | Promise<void> {
    // ---- 1. ledger → transaction FK -------------------------------------
    // Added as a named constraint so `down()` can drop exactly this one.
    this.addSql(
      `alter table "wallet_ledger_entries"
         add constraint "wallet_ledger_entries_transaction_id_foreign"
         foreign key ("transaction_id")
         references "wager_transactions" ("id")
         on delete RESTRICT;`,
    );

    // ---- 2. balance snapshot for faithful replay (§7.7) ------------------
    // Nullable only while the transaction has not been answered yet; every
    // terminal status and PENDING_REFERENCE must carry it. The CHECK keeps
    // "both columns or neither" true — a half-written snapshot would silently
    // corrupt a replay response.
    this.addSql(
      `alter table "wager_transactions"
         add column "result_balance_amount" numeric(20,2) null,
         add column "result_balance_currency" varchar(3) null;`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "ck_wager_tx_result_balance"
         check (
           ("result_balance_amount" is null and "result_balance_currency" is null)
           or
           ("result_balance_amount" is not null and "result_balance_currency" is not null)
         );`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "ck_wager_tx_result_balance_non_negative"
         check ("result_balance_amount" is null or "result_balance_amount" >= 0);`,
    );

    // ---- 3. backoff state for the reference worker (§7.1) ----------------
    this.addSql(
      `alter table "wager_transactions"
         add column "pending_attempts" integer not null default 0,
         add column "pending_next_attempt_at" timestamptz null;`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "ck_wager_tx_pending_attempts"
         check ("pending_attempts" >= 0);`,
    );
    // The worker's hot query: "what is due?". Partial, so it stays tiny —
    // answered transactions never enter it.
    this.addSql(
      `create index "idx_wager_tx_pending_due"
         on "wager_transactions" ("pending_next_attempt_at")
         where "status" = 'PENDING_REFERENCE';`,
    );
  }

  override down(): void | Promise<void> {
    // Reverse order: drop the index and constraints owned by this migration
    // before the columns and the FK they belong to.
    this.addSql(`drop index if exists "idx_wager_tx_pending_due";`);

    this.addSql(
      `alter table "wager_transactions" drop constraint if exists "ck_wager_tx_pending_attempts";`,
    );
    this.addSql(
      `alter table "wager_transactions"
         drop column if exists "pending_next_attempt_at",
         drop column if exists "pending_attempts";`,
    );

    this.addSql(
      `alter table "wager_transactions" drop constraint if exists "ck_wager_tx_result_balance_non_negative";`,
    );
    this.addSql(
      `alter table "wager_transactions" drop constraint if exists "ck_wager_tx_result_balance";`,
    );
    this.addSql(
      `alter table "wager_transactions"
         drop column if exists "result_balance_currency",
         drop column if exists "result_balance_amount";`,
    );

    this.addSql(
      `alter table "wallet_ledger_entries" drop constraint if exists "wallet_ledger_entries_transaction_id_foreign";`,
    );
  }
}
