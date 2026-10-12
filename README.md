# Jungle Wagering — Distributed Wagering Processor

A wagering transaction processor for a gaming platform. Players get wallets; providers submit
bets and reversals over HTTP or SQS; every movement is recorded in an append-only ledger.

Built for the Jungle Gaming technical challenge. The invariants it is constructed around:

- **Money is never a `number`.** Decimal strings in, decimal strings out, `numeric(20,2)` in
  the database.
- **A balance can never go negative** — enforced by the application *and* by a `CHECK`
  constraint, so no race can produce one.
- **A submission is applied exactly once**, whether it arrives as a REST call, an SQS message,
  or a redelivery after a crash.
- **The ledger is the audit trail**: append-only, enforced by a database trigger, and it always
  rebuilds to the stored balance.

[**Architecture →**](./ARCHITECTURE.md) · [**Domain model →**](./src/domain/README.md)

---

## Stack

| | |
|---|---|
| Runtime | Bun · TypeScript (strict) |
| Framework | NestJS 12 |
| Database | PostgreSQL 16 · MikroORM 7 |
| Queue | SQS FIFO — LocalStack locally, AWS in production |
| Metrics | prom-client → Prometheus |
| Tests | Vitest — unit, integration, concurrency, e2e |

---

## Quick start

**Prerequisites:** Bun 1.x and Docker (Postgres and LocalStack come from `compose.yaml`).

```bash
# 1. install and configure
bun install
cp .env.example .env          # fill in the Postgres values

# 2. start PostgreSQL 16 + LocalStack (FIFO queue and DLQ are created for you)
bun run infra:up

# 3. create the schema
bun run db:migration:up

# 4. run — HTTP API and all messaging workers, one process
bun run start:dev
```

The service listens on `http://localhost:3000` (`PORT` to change it).

`.env` needs `DATABASE_URL` and the Postgres credentials used by `compose.yaml`, plus
`TEST_DATABASE_URL` (the test database is created for you by the container init script).
Everything SQS has a LocalStack default, so `start:dev` works without touching those values.

Pointing at real AWS instead means overriding `SQS_ENDPOINT`, `SQS_QUEUE_URL`, `SQS_DLQ_URL`
and the two `AWS_*` credentials. The workers never inspect the host — they only ever see a URL.

---

## Commands

| Command | What it does |
|---|---|
| `bun run infra:up` / `infra:down` | Start/stop PostgreSQL + LocalStack |
| `bun run db:migration:up` | Apply migrations |
| `bun run db:migration:down` | Roll back the last migration |
| `bun run db:migration:status` | Applied vs. pending |
| `bun run db:fresh` | Drop, re-create, re-apply from scratch |
| `bun run start:dev` | Run with reload |
| `bun run start:prod` | Run the built output |
| `bun run build` | Compile to `dist/` |
| `bun run test` | Unit suite — pure, no containers |
| `bun run test:int` | Integration — real PostgreSQL |
| `bun run test:conc` | Concurrency — real PostgreSQL, real SQS, real OS processes |
| `bun run test:e2e` | HTTP contract — Supertest |
| `bun run test:cov` | Unit suite with coverage |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | `oxlint --type-aware` |
| `bun run format` | Prettier |

---

## API

All responses are JSON. Errors always carry a machine-readable body:

```json
{ "error": { "name": "…Error", "code": "…", "category": "…", "message": "…", "details": {} } }
```

`code` is stable and `category` is one of `VALIDATION` · `CONFLICT` · `STATE` · `NOT_FOUND` ·
`EXHAUSTED`.

### Create a wallet

```http
POST /wallets
```

```json
{ "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" } }
```

`201` with the wallet. A positive initial balance also writes an internal `OPENING`
transaction and its `CREDIT` ledger entry **in the same SQL transaction**. A second wallet for
the same `(playerId, currency)` is a `409 WALLET_ALREADY_EXISTS`.

### Submit a transaction

```http
POST /wagering/transactions
Idempotency-Key: provider-a:transaction-123
```

```json
{ "providerId": "provider-a", "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987", "gameId": "fortune-chimp",
  "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" } }
```

`kind` is one of `BET` · `WIN` · `LOSS` · `REFUND` · `ROLLBACK`. The last two additionally
require `referenceExternalTransactionId`.

```json
{ "transactionId": "0192f298-345e-7e38-af88-e43f851a819d", "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false }
```

A `REJECTED` answer carries `failureCode` instead (e.g. `INSUFFICIENT_FUNDS`); a processed one
omits the field rather than sending `null`.

The `Idempotency-Key` header is **required** and is the source of truth. Re-sending the same
payload returns the original answer with `idempotentReplay: true` — including the balance as
it was at that moment, not today's. The same key with a different payload is a `409`, never a
replay.

**Status codes**

| Status | Meaning |
|---|---|
| `200` | Applied, or an identical resubmission |
| `202` | Accepted — still waiting for its reference |
| `400` | Invalid payload, missing `Idempotency-Key`, bad cursor |
| `404` | Not found |
| `409` | Idempotency conflict, `ALREADY_REVERSED`, wallet already exists |
| `422` | Rejected by a business rule — see `failureCode` |
| `503` | Transient infrastructure failure; retrying later may work |

The status alone tells the provider whether resending is safe. No error text needs parsing.

### Look things up

```http
GET  /wallets/:walletId
GET  /wallets/:walletId/ledger?cursor=…&limit=50
GET  /wagering/transactions/:transactionId
GET  /providers/:providerId/wagering/transactions/:externalTransactionId
POST /wallets/:walletId/reconciliation
```

The ledger cursor is opaque and keyset-based on `(created_at, id)`, so pages stay stable while
new entries keep arriving. Anything the endpoint did not mint is a `400`.

Reconciliation compares the stored balance against the sum of the ledger and reports. It
**never** corrects: a divergence is logged, counted in a metric and flagged in the response.

### Health

```http
GET /health/live    # the process is up — never touches the network
GET /health/ready   # PostgreSQL and SQS reachable — 503 when they are not
```

Neither requires authentication.

---

## Messaging

`POST /wagering/transactions` and the queue run the **same use case**, so an operation behaves
identically however it arrives.

| | |
|---|---|
| Main queue | `wager-transactions.fifo` |
| Dead letter | `wager-transactions-dlq.fifo` |
| Grouping | `messageGroupId` = the event's own aggregate id — balance events by wallet, lifecycle events by transaction |
| Redrive | `maxReceiveCount: 5` |

Three workers run in-process with the API:

- **Consumer** — inserts an `inbox_messages` row and applies the effects in **one** transaction.
  A duplicate `messageId` trips a unique constraint and rolls the whole thing back, so a worker
  that dies before acking cannot double-apply on redelivery.
- **Outbox publisher** — drains `outbox_messages` and sends to SQS. Events are written in the
  same transaction as the state change and published only **after** commit; instances claim
  disjoint slices via `FOR UPDATE SKIP LOCKED`.
- **Reference worker** — re-processes `PENDING_REFERENCE` transactions whose `REFUND`/`ROLLBACK`
  reference had not arrived, with exponential backoff (`1s × 2^(n−1)`, capped at 5 min,
  10 attempts).

A failed message is classified once: already-in-the-inbox → ack; understood-and-refused → ack;
unreadable → DLQ; anything else → retry.

---

## Observability

`GET /metrics` exposes Prometheus. Health endpoints are separate for liveness and readiness,
and logs are structured JSON with `correlationId` injected automatically.

| | |
|---|---|
| Transactions by status | `transactions_total{status}` · `consumer_processed_total{status}` |
| Duplicates detected | `idempotent_replays_total` · `consumer_duplicates_total` |
| Retries | `consumer_retries_total` · `reference_retry_failures_total` · `outbox_publish_failures_total` |
| Dead letters | `consumer_dead_letters_total` |
| Lock conflicts | `lock_conflicts_total` · `wallet_lock_wait_seconds` |
| Outbox lag | `outbox_lag_seconds` |
| Processing latency | `transaction_processing_seconds{status}` · `message_processing_seconds{status}` |
| Reconciliation | `wallet_reconciliation_divergences_total` |

Labels are low-cardinality by construction — no wallet or transaction id can reach the registry.

Answered submissions log `transactionId`, `walletId`, `providerId`, `status` and `failureCode`.
**Never an amount** — the ledger is the audit trail for money.

---

## Testing

Four suites, separated by what they are allowed to prove.

| Suite | Command | Proves | Runs against |
|---|---|---|---|
| Unit | `bun run test` | Domain rules and use-case logic | Nothing external |
| Integration | `bun run test:int` | Real persistence, real transactions, real `23505` | PostgreSQL |
| Concurrency | `bun run test:conc` | §8 invariants under real contention | PostgreSQL + SQS |
| End-to-end | `bun run test:e2e` | The HTTP contract through the whole Nest stack | PostgreSQL + Supertest |

The concurrency suite is the one worth reading. It covers the eight mandatory scenarios —
including 50 parallel submissions of one bet, two simultaneous `80.00` bets against a `100.00`
wallet, and three or more separate instances racing one wallet — and it spawns **real OS
processes** rather than workers in a thread pool. §8 asks for "three or more instances", which
means three processes with three pids and three connection pools; an in-process fake would
have passed while proving nothing about the thing it names.

Nothing in the unit or integration suite mocks away PostgreSQL or SQS. Where a fake exists, it
is a **port** — the same seam production uses.

---

## Documentation

- [**ARCHITECTURE.md**](./ARCHITECTURE.md) — concurrency strategy, idempotency, outbox and
  inbox, the HTTP status mapping, schema-level guarantees, and every interpretive decision
  with its trade-off.
- [**src/domain/README.md**](./src/domain/README.md) — the domain model: state machine,
  `Money`, reference rules, `payloadHash` specification, failure taxonomy.
