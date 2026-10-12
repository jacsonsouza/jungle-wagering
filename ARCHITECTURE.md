# Architecture — Jungle Wagering

A distributed wagering processor: providers submit bets and reversals over HTTP or SQS,
players get wallets, and every movement lands in an append-only ledger.

This document covers the **system-level** decisions — concurrency, idempotency, messaging,
the HTTP contract, the schema. The **domain-level** model (state machine, `Money`, reference
rules, `payloadHash`, failure taxonomy) has its own document: [`src/domain/README.md`](./src/domain/README.md).

Every section says *why*, not only *what*. Where the challenge left something open and an
interpretation was required, it is called out under [Interpretive decisions](#10-interpretive-decisions).

---

## 1. Shape of the system

```
                        ┌──────────────────────────────┐
   HTTP  ──────────────►│  http/        controllers    │
                        │                  │ DTO       │
                        │               presenters     │
                        └──────────────────┼───────────┘
                                           │
   SQS ──► consumer ───────────────────────┤
                                           ▼
                        ┌──────────────────────────────┐
                        │  use-cases/   orchestration   │
                        │  (one entry point per job)    │
                        └──────┬───────────────┬───────┘
                               │               │
                     domain ◄──┘               └──► ports/  (interfaces)
                        │                                   │
                  pure, no                                 ▲ implemented by
                  framework                               │
                        │                    repositories/ · messaging/ · mappers/
                        ▼                                        │
                  events ◄────────────── outbox ─────────────────┘
                                                   │
                                             publisher ──► SQS ──► consumers
```

### The dependency rule

`domain` imports nothing from NestJS, MikroORM or the AWS SDK. Not "should not" — it is
enforced, and the only `node:` builtin it touches is `crypto` for `SHA-256` (a pure
function, no I/O). Every database access, every queue call and every clock read goes
through a **port** in `src/ports/`.

The payoff is not aesthetic. The domain layer runs in unit tests with no database, no
container and no mock library; the ports are what the concurrency suite swaps when it runs
the same use case in fifty separate OS processes.

| Directory | Responsibility |
|---|---|
| `domain/` | Aggregates, value objects, rules, events. Pure. |
| `ports/` | The seams: interfaces, plus `MikroOrmUnitOfWork` and the DI token map. |
| `entities/` | MikroORM entities — the persistence shape of the domain. |
| `repositories/` | Port implementations over the ORM. |
| `mappers/` | Entity ⇄ domain. The only place the two shapes meet. |
| `use-cases/` | One job per class; owns the transaction boundary. |
| `http/` | Controllers, DTOs, presenters, the exception filter. |
| `messaging/` | Consumer, outbox publisher, reference worker, SQS adapter. |
| `observability/` | JSON logger, Prometheus registry, lock-conflict detection. |
| `migrations/` | Hand-written, reversible SQL. |

### Why MikroORM

Prisma was excluded by the challenge. Among the alternatives, MikroORM was chosen for three
reasons that matter here and not elsewhere:

1. **`em.transactional(fn, { clear: true })`** — an explicit transaction scope whose
   identity map can be dropped on entry. Two concurrent submissions in one process share a
   root `EntityManager`; `clear: true` is what stops the second one from seeing the first
   one's uncommitted entities through the identity map. Without it, correctness would
   depend on how many instances are running.
2. **`LockMode.PESSIMISTIC_WRITE`** emits `SELECT … FOR UPDATE` on an entity fetch, so the
   lock is taken by the repository and cannot be forgotten by a caller.
3. **Raw SQL is always available** where the abstraction would lie — the outbox claim and
   the ledger sum both need SQL the query builder cannot express.

The cost is that entities carry decorators, so the domain cannot be an entity. That is the
point of the `mappers/` layer.

---

## 2. Concurrency (§8) — pessimistic locking, keyed by `walletId`

§8, in the original (*"A **unidade de concorrência é a `walletId`**"*): the concurrency unit
is the `walletId`. So the lock is the wallet row.

### The mechanism

Every submission runs in one SQL transaction:

```
BEGIN
  SELECT … FROM wallets WHERE id = $1 FOR UPDATE      ← the only lock in the system
  …validate, move the balance, write the transaction row, ledger entry, outbox row…
COMMIT
```

`SELECT … FOR UPDATE` is taken through `WalletRepository.findByIdForUpdate`. Two
submissions for the same wallet serialise on that row; two submissions for different
wallets never touch. Three instances, thirty instances, one instance — the database is the
only arbiter, so the application stays stateless.

### Why pessimistic, and not optimistic

Optimistic locking (version check + retry) was considered and rejected. The rejected case
is the spec's own mandatory scenario: two `80.00` bets against a `100.00` wallet. Under
optimistic concurrency both bets read `100.00`, one wins, and the loser must **retry** —
only to find it can now never succeed, because the wallet is at `20.00`. The retry bought
nothing and cost a round trip plus a rollback.

That is the general shape here. A wager is a *contention* workload, not a
read-modify-write-rarely workload: the losing transaction is rejected on the merits, so
retrying cannot change its outcome. Pessimistic locking turns "speculate, lose, roll back,
retry" into "wait a few milliseconds, then read the true balance and answer correctly".

It also makes the failure mode legible. Under contention the second bet simply **waits**,
then reads `20.00` and is rejected with `INSUFFICIENT_FUNDS` — which is the correct,
honest answer. Nothing rolls back that did not have to.

### What it costs, and what bounds it

- **Lock hold time = transaction duration.** The transaction is deliberately short: no
  external calls, no HTTP, no queue send. Events are written to the outbox *inside* it and
  published after commit (§4 below).
- **No ordering requirement across wallets**, so no deadlock cycle: a transaction takes
  exactly one lock and never a second.
- **A stuck lock blocks only its own wallet**, not the service.

### Detecting contention

A blocking lock is silent by design — a waiter cannot be seen from the outside. So two
signals, answering two different questions (§12):

- `wallet_lock_wait_seconds` — time to acquire the wallet row. This is the one that fires
  under normal load, and a rising tail means wallets are getting contended.
- `lock_conflicts_total` — PostgreSQL *refusing* (deadlock `40P01`, lock timeout `55P03`,
  serialization failure `40001`). Rare, and it means waiting stopped working.

### Schema-level backstop

`ck_wallets_balance_non_negative` means that even if every line of application code were
wrong, the database would refuse to store a negative balance. §5.9 puts the invariants in
the schema; the lock is what makes them reachable without constant rollbacks.

### A note on raw SQL inside transactions

`em.transactional` only joins the transaction for ORM calls. A raw
`getConnection().execute()` checks out **its own** connection in auto-commit — which is a
correctness bug waiting to happen, and also a connection-pool deadlock: at `pool: { max: 1 }`
the transaction holds the only connection while the raw statement waits for a second one
forever. This bit the concurrency harness and is why the test worker pool is `{ max: 2 }`.

Both raw statements in `src/` are safe, and both are documented as such at their call sites:
`sumEntries` reads **while holding** the wallet lock, and `claimDue`'s outbox lease is a
single atomic statement that opens no transaction of its own.

---

## 3. Idempotency (§9)

Two independent guards, because they answer two different questions.

| Guard | Constraint | Answers |
|---|---|---|
| `Idempotency-Key` header | `uq_wager_tx_idempotency_key` | "Did *this provider* already send this?" |
| `(providerId, externalTransactionId)` | `uq_wager_tx_provider_external` | "Did this *operation* already happen?" |

The header is the source of truth (§9). The pair is an independent second guard that works
even for a caller who reuses keys badly.

### Detecting a duplicate vs. detecting a divergence

A unique violation alone cannot tell the two apart, and the spec requires they be
distinguishable: an identical resubmission is a **replay** (same answer back), while the
same key with a different payload is a **conflict** (`PAYLOAD_MISMATCH`, 409).

So on `23505` the use case **re-reads** the winning row and compares the stored
`payloadHash`. Not the error message — MikroORM's message text is not a contract.

`payloadHash` is `SHA-256` over the canonical JSON of the business fields only (the header
and transport metadata are excluded, as §9 requires). The exact algorithm, the field list
and a fixed test vector are documented in
[`src/domain/README.md`](./src/domain/README.md#payloadhash--specification).

### Replay fidelity

§7.7 requires a replay to return "the balance observed at that moment" — **not** today's
balance, which other bets may have moved since.

That balance cannot be reconstructed from the ledger: `LOSS` and `REJECTED` produce no
entry at all. So `wager_transactions.result_balance_amount/currency` is a **snapshot**
written when the transaction is answered. A replay is then a pure read of a committed row:
same `transactionId`, same `status`, same `balance`, same `failureCode`, forever.

### Two entry points, one rule

`SubmitTransactionUseCase.execute()` opens the transaction (HTTP). `executeIn(tx, command)`
runs the *same* rules inside a transaction the **caller** owns (SQS), so the inbox row and
its effects commit together — §10 demands exactly that, and offering the second form keeps
the guarantee structural rather than a rule someone must remember.

### Not in-memory, not single-instance

Idempotency lives in two unique constraints. Nothing about it depends on process memory, so
it survives a restart and holds across instances — which the concurrency suite proves by
running the same submission from fifty separate OS processes.

---

## 4. Transactional outbox (§11)

An event is written to `outbox_messages` **in the same SQL transaction** as the state
change, so "state changed" and "event pending" cannot disagree. A separate publisher
drains the table and sends to SQS.

Nothing is ever published before its transaction commits — an event announcing work that
later rolls back is worse than a missing event, because a consumer cannot undo it.

### Claiming, not deleting

The publisher claims due rows by pushing `next_attempt_at` forward under
`FOR UPDATE SKIP LOCKED`, in **one atomic statement**:

```sql
with due as (
  select id
  from outbox_messages
  where published_at is null
    and (next_attempt_at is null or next_attempt_at <= ?)
  order by next_attempt_at nulls first
  limit ?
  for update skip locked
)
update outbox_messages o
set next_attempt_at = ?
from due
where o.id = due.id
returning o.*
```

`SKIP LOCKED` means two publisher instances claim **disjoint** slices of the same outbox
without coordinating: neither blocks on, nor steals from, a publisher that is mid-flight.
The `set next_attempt_at = ?` binds a `leaseUntil` computed as now + 30s, so the claim *is*
the lease. A publisher that dies mid-send leaves the row leased, and it returns to the due set
on its own when the lease expires.

Claiming deliberately does **not** increment `attempts` — taking a lease is not a failure.
`attempts` moves only when a publish actually fails, in `recordFailure`.

### At-least-once, and why that is the right choice

A crash between "sent" and "marked published" re-sends. That duplicate is deliberate and
safe: the consumer's inbox makes redelivery idempotent. Choosing at-least-once here is what
lets the publisher never lose an event.

**10 attempts**, backoff `1s, 2s, 4s …` capped at 5 minutes — the same exponential curve as
the reference worker, so there is one policy to reason about, and no jitter because
publishers coordinate through the lease rather than through timing. By the tenth attempt the
schedule has already spanned minutes, so exhaustion means "the broker is not coming back"
rather than a blip. It is logged and counted in `outbox_events_abandoned_total`: an abandoned
event is an operational alarm, not a silent gap.

---

## 5. Messaging (§10)

### FIFO, and what it is *not* responsible for

`messageGroupId` is the event's **own `aggregateId`** — the entity the event is *about*, which
is what a grouping key means in an event-driven system. `WalletBalanceChanged` therefore groups
by wallet, while the transaction lifecycle events (`…Processed`, `…Rejected`,
`…PendingReference`) group by the transaction, so a consumer observes each aggregate's events
in the order they were recorded. `deduplicationId` is the outbox row id.

§10 names the two queues but leaves the grouping key to the implementer. The choice follows
the events' own aggregates rather than a fixed `walletId`, because a subscriber watching one
bet's lifecycle does not care about — and should not be serialised against — unrelated
transactions on the same wallet.

§8 is explicit that broker ordering and dedup are **optimisation, not the guarantee** — the
database is still responsible for the invariants. Nothing here depends on FIFO being
perfect. The 5-minute SQS dedup window is an optimisation on top of two unique constraints
that would hold on their own.

### Inbox

`inbox_messages` is inserted **first**, inside the same transaction as the effects, with
`uq_inbox_consumer_message` on `(consumer_name, message_id)`. A duplicate `messageId` trips
the constraint, the transaction rolls back, and nothing was applied twice — so a worker that
dies *before* acking cannot double-apply on redelivery.

### How a failure becomes an outcome

Every failure is classified in exactly one place:

| Failure | Outcome | Why |
|---|---|---|
| Already in the inbox | **ACK** | Already applied; redelivering changes nothing. |
| `DomainError` | **ACK** (+ count) | Understood and refused on the merits. Redelivery cannot change the answer, so looping would only burn attempts. |
| Parse/unreadable payload | **DLQ** | It will never become readable. |
| Anything else | **RETRY** (`release`) | Deliberately conservative. |

Unknown ⇒ transient is the safe default: a spurious retry is cheap, while a spurious DLQ
entry hides a working system's bug. The queue's own `maxReceiveCount: 5` redrive is the net
that catches what classification cannot — a process that *crashes* mid-message.

`release` (rather than delete) makes the message visible immediately instead of costing a
full visibility timeout, so a transient outage does not stall the queue.

### Reference worker (§7.1)

A `REFUND` or `ROLLBACK` whose reference has not arrived yet is persisted as
`PENDING_REFERENCE` — never rejected, never guessed at. A scheduled worker re-processes it
through `executeIn`, with exponential backoff `1s × 2^(n−1)` capped at 5 minutes.

**Attempt limit: 10.** Justification: the schedule spans about **13 minutes** end to end —
`1s, 2s, 4s …` capped at 5 minutes, so `811s` across the ten waits. That is long enough for
any plausible cross-region replication lag or provider delay, and short enough that a
genuinely missing reference does not sit unresolved for a day. Exhaustion produces `REJECTED`
with `REFERENCE_NOT_FOUND` and publishes the corresponding event, per §7.1.

---

## 6. Schema-level guarantees (§5.9)

The invariants that would matter even if the application code were replaced entirely.

| Constraint | Enforces |
|---|---|
| `ck_wallets_balance_non_negative` | A balance can never go negative. |
| `ck_wallets_version_positive` | `version >= 1` — a wallet is born at version 1. |
| `uq_wallets_player_currency` | One wallet per (player, currency). |
| `uq_wager_tx_idempotency_key` | The header is the source of truth. |
| `uq_wager_tx_provider_external` | An operation happens at most once per provider. |
| `uq_wager_tx_single_reversal` | A reference is reversed at most once. |
| `ck_wager_tx_result_balance` | The §7.7 snapshot is all-or-nothing, never half-written. |
| `ck_wager_tx_pending_attempts` | Attempt counter cannot go negative. |
| `uq_ledger_wallet_transaction` | At most one ledger entry per (wallet, transaction). |
| `ck_ledger_amount_positive` | Ledger amounts are positive; direction carries the sign. |
| `wallet_ledger_entries_transaction_id_foreign` | An entry points at a real transaction. |
| `trg_ledger_append_only` | **Nothing** can `UPDATE`/`DELETE` a ledger row. |
| `uq_inbox_consumer_message` | A message is applied once per consumer. |

Plus: every money column is `numeric(20,2)` — never `float`/`double`. Enum columns are
`varchar` + `CHECK`, so adding a value is a migration rather than a type change.

The append-only trigger deserves a note: the application never writes ledger rows it did not
just insert, but a trigger makes that true against any future code, any migration script and
any ad-hoc `psql` session. Auditability that depends on discipline is not auditability.

### Reversals, and a stricter reading of §7.4

§7.4 — *"uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação"*:
a reference may not be reversed twice **by the same operation type**. Literally read, a `BET`
could be both `REFUND`ed and `ROLLBACK`ed.

This implementation is **stricter**: `uq_wager_tx_single_reversal` blocks a *second* reversal
of any kind. Two different reversal types against one reference would move money twice for
the same underlying bet — economically a partial reversal, which §7.5 puts out of scope, and
operationally indistinguishable from a duplicate. Blocking both is the interpretation that
cannot lose money. It is a one-line change to the index predicate if the literal reading is
wanted.

---

## 7. HTTP surface (§9)

### Status mapping

The mapping exists so a provider can decide whether resending is safe **without parsing
error text**. §9 names five situations; collapsing them is explicitly called out as wrong.

| Situation | Status | Body |
|---|---|---|
| Wallet created | `201` | wallet |
| Wallet already exists for (player, currency) | `409` `WALLET_ALREADY_EXISTS` | — |
| Applied | `200` | result, `idempotentReplay: false` |
| Identical resubmission | `200` | original result, `idempotentReplay: true` |
| Accepted, waiting for its reference | `202` `PENDING_REFERENCE` | — |
| Rejected by a business rule | `422` | `failureCode` |
| `ALREADY_REVERSED` | `409` | — |
| Same key, different payload | `409` `PAYLOAD_MISMATCH` | — |
| Invalid payload, missing header, bad cursor | `400` | — |
| Not found | `404` | — |
| Transient infrastructure failure | `503` | — |

Two choices worth their own words:

- **`ALREADY_REVERSED` is `409`, not `422`.** It is the one business refusal a caller may be
  able to fix — they reversed twice — so it must not look like a refusal they can only stop
  repeating.
- **`REJECTED` is mapped in the controller, not in the exception filter.** A rejection is a
  *committed row*, not an exception. It must replay with the same status forever (§7.7), and
  a filter only ever sees things that were thrown.

### Three phases, and why every refusal is persisted

`SubmitTransactionUseCase` runs in three phases:

1. **Payload** — throws. Nothing was read, nothing was written; there is nothing to replay.
2. **Ownership + idempotency** — throws. `WALLET_SCOPE_MISMATCH`, `PAYLOAD_MISMATCH`.
3. **Business rules** — every refusal is **persisted** as a `REJECTED` row with its
   `failureCode`.

The asymmetry is the whole point. A rule that depends on rows outside the request's own
scope — a balance another bet may have moved, a reference that may never arrive — can answer *differently* on a
retry. §7.7 requires the same answer forever, so the first answer must be recorded.

### Reconciliation never corrects

`POST /wallets/:walletId/reconciliation` compares `wallets.balance` against the ledger sum
and reports. On divergence it **locks the wallet, logs, increments a metric and flags the
response** — and changes nothing. A reconciliation that silently rewrites balances destroys
the very evidence needed to understand how they diverged.

### Cursor pagination

The ledger cursor is opaque: `base64url` of `{"c": <created_at>, "i": <id>}`. The keyset is on
`(created_at, id)`, so a page is stable while new entries keep arriving — no offset drift, no
duplicates or gaps. Anything the endpoint did not mint is a `400 INVALID_CURSOR`, not a silent first page.

---

## 8. Observability (§12)

### Metrics

Every metric is emitted at a **funnel**, so a path cannot be missed by accident — and one
funnel per entry point, so HTTP and queue traffic never double-count each other.

| Spec requirement | Metric |
|---|---|
| Transactions by status | `transactions_total{status}` · `consumer_processed_total{status}` |
| Duplicates detected | `idempotent_replays_total` · `consumer_duplicates_total` |
| Retries | `consumer_retries_total` · `reference_retry_failures_total` · `outbox_publish_failures_total` |
| Messages in DLQ | `consumer_dead_letters_total` |
| Lock conflicts | `lock_conflicts_total` · `wallet_lock_wait_seconds` |
| Outbox lag | `outbox_lag_seconds` |
| Processing latency | `transaction_processing_seconds{status}` · `message_processing_seconds{status}` |

Also `wallet_reconciliation_divergences_total` (§9) and the standard Node process metrics.

Labels are deliberately low-cardinality — `status`, `code`, `outcome`, `eventType`. No
`walletId` or `transactionId` can ever reach the registry.

A replay **is** counted under `transactions_total`: that series describes what callers were
*told*, and a replay is an answered request like any other. "How many requests were
duplicates" is a different question, so it has a series of its own.

### Logs

JSON, one line per event, `correlationId` injected from `AsyncLocalStorage`. Every answered
submission logs `transactionId`, `walletId`, `providerId`, `status`, `failureCode`.

**No money in logs.** The ledger is the audit trail for amounts; a log line is not the place
for a financial payload, even a partial one.

### Health

`/health/live` never touches the network — a slow database must not make an orchestrator
restart a healthy process. `/health/ready` checks dependencies and answers `503` when any is
down.

---

## 9. Authentication (§2)

§2, in the spec's own words (*"Se você optar por não implementar, isso é aceito: documente a
decisão no `ARCHITECTURE.md` … e deixe o ponto de extensão explícito no código"*): choosing
not to implement authentication is **accepted**, provided the decision is documented here, the
design you would adopt is described, and the extension point is explicit in the code.

**Not implemented.** The service sits behind whatever the provider-integration layer is;
adding a credential store here would invent a requirement the challenge did not state, and
authenticating *providers* properly means provider-scoped credentials, key rotation and
auditing — none of which the spec defines.

The extension point is a Nest `AuthGuard` (`src/http/noop-auth.guard.ts`), registered globally
as an `APP_GUARD` in the composition root rather than per route. It is a real guard, not an
absent one, precisely so that enabling real auth later means replacing **one class** — no
`@UseGuards` to retrofit across controllers, and no change to any use case or domain code.

Health endpoints deliberately carry **no** auth, as §9 requires.

---

## 10. Interpretive decisions

Where the challenge was silent, and what was chosen.

1. **`Idempotency-Key` is the source of truth; `(providerId, externalTransactionId)` is an
   independent second guard.** §9 gives a recommended default for the header but does not say
   what happens if a caller sends a foreign key. Two guards means a badly-behaved caller
   cannot bypass idempotency by choosing an unusual key.
2. **Every business refusal is persisted, every payload refusal is thrown.** §7.7 demands a
   stable replay; a rule that depends on unowned rows cannot answer twice the same way unless
   the first answer was recorded.
3. **`ALREADY_REVERSED` maps to `409`.** See [§7](#7-http-surface-9).
4. **`WALLET_ALREADY_EXISTS` and `INVALID_CURSOR` are returned as error codes.** §9 requires
   distinguishable failures but lists no code for them; inventing codes keeps the body
   machine-readable and consistent with the rest.
5. **The ledger page body is `{ walletId, entries, nextCursor }`.** §9 calls the cursor opaque
   but never defines the page shape.
6. **A missing wallet and another player's wallet both answer `404`.** `WALLET_SCOPE_MISMATCH`
   is categorised `NOT_FOUND`, so wallet ids cannot be probed for existence.
7. **`uq_wager_tx_single_reversal` is stricter than §7.4's literal wording.** See [§6](#6-schema-level-guarantees-59).
8. **`WALLET_SCOPE_MISMATCH` / `PAYLOAD_MISMATCH` are thrown, not persisted.** They describe
   *the request*, not a business outcome — there is no state the provider could retry into.
9. **A reference worker attempt #1 is the submission itself.** §7.1 gives the worker the
   reprocessing job; attempt #1 is where the submission *discovers* the reference is missing,
   so the use case records the deferral and arms the worker.
10. **Enums are `varchar` + `CHECK`.** Adding a status is a migration, not a type rewrite.
11. **A wallet is born funded at `version: 1`.** §9 returns `version: 1` for a wallet created
    with an initial balance; starting at zero and crediting would be the same money at two
    versions. Detail in [`src/domain/README.md`](./src/domain/README.md#interpretive-decisions).
12. **OpenTelemetry and a dashboard are not built.** §12 marks both optional. prom-client
    already emits everything they would consume; adding a tracing SDK to a system with one
    database and one queue would measure the network it does not have.

---

## 11. Deliberate omissions

Each of these is a decision, not an oversight.

- **No authentication.** §9 of this document.
- **No partial reversals.** §7.5 puts them out of scope; the value must equal the reference.
- **No rate limiting, no provider-scoped quotas.** Requires the credential model that does not exist.
- **No sharding or read replicas.** One database is correct here; horizontal read scaling is a
  deployment decision that would not change a line of this code.
- **No retry on the optimistic path** — there is no optimistic path.
- **No scheduled cleanup of `inbox_messages` / published outbox rows.** Retention policy is an
  operational decision; both tables are append-mostly and small in tests.

---

## 12. Limitations

Stated plainly, because a system without them is a system nobody thought about.

- **At-least-once delivery means duplicate events are possible.** Consumers must be
  idempotent; the inbox makes this service's own consumer so, but an external subscriber does not get that
  for free.
- **A stuck `FOR UPDATE` blocks its wallet only** — but it does block, with no automatic
  timeout. `wallet_lock_wait_seconds` is the alarm; the runbook is `pg_cancel_backend`.
- **`outbox_events_abandoned_total` is a terminal signal.** Ten failed publishes means the
  event is gone from the stream; recovery requires a human to re-emit it. This is the correct
  trade — a silently-retrying publisher is how an outage becomes an unbounded queue — but it
  is a real operational burden.
- **The ledger sum for reconciliation is `O(entries)` per wallet.** Fine at challenge scale;
  at production scale it wants a materialised running total or a nightly job, and the
  comparison point would move.
- **`payloadHash` covers the business subset only.** Two payloads differing *only* in a
  field outside that subset would compare equal. The subset is exactly the fields §9 names.
- **Single-region.** Cross-region `PENDING_REFERENCE` resolution depends on replication lag
  that the 10-attempt budget assumes is bounded.

---

## 13. Testing strategy

Four suites, separated by what they are allowed to prove. Full detail in the README.

| Suite | Proves | Runs against |
|---|---|---|
| `test` | Domain rules, use-case logic | Nothing external — fast, pure |
| `test:int` | Persistence, real transactions, real 23505 | PostgreSQL |
| `test:conc` | §8 invariants under real contention | PostgreSQL + SQS, **real OS processes** |
| `test:e2e` | The HTTP contract through the whole Nest stack | PostgreSQL + Supertest |

The concurrency suite is the one worth reading. It spawns real OS processes — not workers in
a thread pool — with a readiness handshake, because "three or more instances" (§8) means three
processes with three pids and three connection pools. An in-process fake would have passed
while proving nothing about the thing it names.
