import { Migration } from '@mikro-orm/migrations';

/**
 * Phase 2 schema: wallets, append-only ledger, wager transactions, inbox and
 * outbox.
 *
 * Written by hand (up AND down, both reversible — an explicit requirement of
 * the challenge) because the schema generator cannot express two things this
 * design needs:
 *
 *   1. composite UNIQUE constraints (`@Unique({ expression })` is emitted as
 *      a bare `unique (...)` statement, which is not valid SQL on its own);
 *   2. the append-only trigger on `wallet_ledger_entries` (auditability:
 *      the application never UPDATEs/DELETEs ledger rows, and the trigger
 *      turns that convention into a database guarantee).
 *
 * Money columns are numeric(20,2), never float/double — floating point
 * corrupts money, which is the heart of this challenge.
 */
export class Migration20261010000001_Phase2Schema extends Migration {
  override name = 'Migration20261010000001_Phase2Schema';

  override up(): void | Promise<void> {
    // ---- wallets --------------------------------------------------------
    // One wallet per (player, currency) — §5.1. The balance CHECK is the last
    // line of defense: no race or future bug can persist a negative balance.
    this.addSql(
      `create table "wallets" (
         "id" uuid not null,
         "player_id" varchar(64) not null,
         "currency" varchar(3) not null,
         "balance" numeric(20,2) not null,
         "version" integer not null,
         "created_at" timestamptz not null,
         "updated_at" timestamptz not null,
         primary key ("id")
       );`,
    );
    this.addSql(
      `alter table "wallets" add constraint "uq_wallets_player_currency"
         unique ("player_id", "currency");`,
    );
    this.addSql(
      `alter table "wallets" add constraint "ck_wallets_balance_non_negative"
         check (balance >= 0);`,
    );
    this.addSql(
      `alter table "wallets" add constraint "ck_wallets_version_positive"
         check (version >= 1);`,
    );

    // ---- wager_transactions ---------------------------------------------
    // Both uniques are dedupe mechanisms at the database level (§9): the
    // provider's (provider_id, external_transaction_id) and the HTTP header's
    // (idempotency_key). A SELECT-then-INSERT would leave a race window; a
    // constraint does not.
    this.addSql(
      `create table "wager_transactions" (
         "id" uuid not null,
         "provider_id" varchar(64) not null,
         "external_transaction_id" varchar(128) not null,
         "idempotency_key" varchar(255) not null,
         "payload_hash" varchar(64) not null,
         "wallet_id" uuid not null,
         "player_id" varchar(64) not null,
         "round_id" varchar(128) not null,
         "game_id" varchar(64) not null,
         "kind" varchar(16) not null,
         "amount" numeric(20,2) not null,
         "currency" varchar(3) not null,
         "reference_external_transaction_id" varchar(128) null,
         "status" varchar(20) not null,
         "reference_transaction_id" uuid null,
         "failure_code" varchar(64) null,
         "processed_at" timestamptz null,
         "created_at" timestamptz not null,
         primary key ("id")
       );`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "uq_wager_tx_provider_external"
         unique ("provider_id", "external_transaction_id");`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "uq_wager_tx_idempotency_key"
         unique ("idempotency_key");`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "ck_wager_tx_kind_valid"
         check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "ck_wager_tx_status_valid"
         check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`,
    );
    // §7.4: a reference may be reversed at most once. The partial index covers
    // only reversal kinds, so ordinary BETs (reference column NULL, which does
    // not collide in unique indexes) are untouched. Indexing the resolved
    // internal reference keeps double-reversal impossible even if two requests
    // race past application-level checks.
    this.addSql(
      `create unique index "uq_wager_tx_single_reversal"
         on "wager_transactions" ("reference_transaction_id")
         where "kind" in ('REFUND', 'ROLLBACK');`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign"
         foreign key ("wallet_id") references "wallets" ("id") on delete RESTRICT;`,
    );

    // ---- wallet_ledger_entries ------------------------------------------
    // UNIQUE(wallet_id, transaction_id) is the anti-duplicate-debit guarantee:
    // the same transaction can never debit the same wallet twice, even if the
    // application has a bug. amount > 0 because a zero/negative entry would
    // break reconciliation (§5.10).
    this.addSql(
      `create table "wallet_ledger_entries" (
         "id" uuid not null,
         "wallet_id" uuid not null,
         "transaction_id" uuid not null,
         "direction" varchar(6) not null,
         "amount" numeric(20,2) not null,
         "currency" varchar(3) not null,
         "balance_before" numeric(20,2) not null,
         "balance_after" numeric(20,2) not null,
         "created_at" timestamptz not null,
         primary key ("id")
       );`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "uq_ledger_wallet_transaction"
         unique ("wallet_id", "transaction_id");`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "ck_ledger_amount_positive"
         check (amount > 0);`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_id_foreign"
         foreign key ("wallet_id") references "wallets" ("id") on delete RESTRICT;`,
    );
    // Auditability: the ledger is append-only. The application never mutates
    // these rows; the trigger enforces it against any future code, script or
    // manual UPDATE/DELETE.
    this.addSql(
      `create function forbid_ledger_mutation() returns trigger as $$
         begin
           raise exception 'wallet_ledger_entries is append-only';
         end;
       $$ language plpgsql;`,
    );
    this.addSql(
      `create trigger trg_ledger_append_only
         before update or delete on "wallet_ledger_entries"
         for each row execute function forbid_ledger_mutation();`,
    );

    // ---- inbox_messages --------------------------------------------------
    // UNIQUE(consumer_name, message_id) IS the dedupe mechanism (§11): the
    // consumer inserts first, and a conflict means "already processed"
    // without reading anything.
    this.addSql(
      `create table "inbox_messages" (
         "id" uuid not null,
         "consumer_name" varchar(128) not null,
         "message_id" varchar(64) not null,
         "payload_hash" varchar(64) not null,
         "received_at" timestamptz not null,
         "processed_at" timestamptz null,
         primary key ("id")
       );`,
    );
    this.addSql(
      `alter table "inbox_messages" add constraint "uq_inbox_consumer_message"
         unique ("consumer_name", "message_id");`,
    );

    // ---- outbox_messages -------------------------------------------------
    // Transactional outbox (§11): rows are inserted in the SAME database
    // transaction as the state change, and a separate publisher drains them.
    // The partial index matches the publisher's hot query and stays tiny —
    // published rows never bloat it.
    this.addSql(
      `create table "outbox_messages" (
         "id" uuid not null,
         "aggregate_id" varchar(64) not null,
         "event_type" varchar(128) not null,
         "payload" jsonb not null,
         "occurred_at" timestamptz not null,
         "attempts" integer not null,
         "next_attempt_at" timestamptz null,
         "published_at" timestamptz null,
         primary key ("id")
       );`,
    );
    this.addSql(
      `create index "idx_outbox_due"
         on "outbox_messages" ("next_attempt_at")
         where "published_at" is null;`,
    );
  }

  override down(): void | Promise<void> {
    // Reverse dependency order: children first, then parents. Constraints
    // owned by a table drop with it; only the trigger objects need explicit
    // cleanup.
    this.addSql(
      `drop trigger if exists trg_ledger_append_only on "wallet_ledger_entries";`,
    );
    this.addSql(`drop function if exists forbid_ledger_mutation();`);

    this.addSql(`drop table if exists "outbox_messages" cascade;`);
    this.addSql(`drop table if exists "inbox_messages" cascade;`);
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop table if exists "wallets" cascade;`);
  }
}
