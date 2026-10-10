# Domain — Jungle Wagering

**Pure domain**: no `@nestjs/*`, `@mikro-orm/*` or `reflect-metadata` imports
(enforced by lint over `src/domain/**`). No decorators, no ID generation, no
clock — `Date` and `id` always arrive as parameters, which makes the domain
deterministic and trivial to test.

```bash
bun run test          # specs live next to the code in src/domain/**/*.spec.ts
bun run test:cov      # target: 100% line/branch coverage in this directory
bun run typecheck
bun run lint
```

## Structure

| Folder | Responsibility |
|---|---|
| `shared/` | `DomainError`, `canonicalJson`, `payloadHash`, enums, `CurrencyCode` |
| `failures/` | `FailureCode` + `FailureCategory` taxonomy |
| `money/` | `Money` (immutable VO, fixed scale of 2) over `decimal.js` |
| `ledger/` | `WalletLedgerEntry` (immutable; `balanceBefore ± money === balanceAfter`) |
| `wallet/` | `Wallet` (aggregate root; `version` changes only when the balance changes) |
| `transaction/` | `WagerTransaction` + state machine + reference rules |
| `messaging/` | `InboxMessage`, `OutboxMessage`, exponential backoff |
| `events/` | abstract `IntegrationEvent<T>` + 4 concrete events + registry |
| `testing/` | Deterministic factories for the tests |

## State machine — `WagerTransactionStatus`

```
                 ┌───────────────────────────────────────────────┐
                 │                                               │
   PENDING ──────┼──► PROCESSED   (terminal)                     │
      │  │  │    │                                               │
      │  │  └────┼──► REJECTED    (terminal, carries failureCode) │
      │  │       │                                               │
      │  └───────┼──► FAILED      (terminal, infra failure)      │
      │          │                                               │
      └──────────┴──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
```

- The source of truth is `transaction/transaction-table.ts` (`ALLOWED_TRANSITIONS`).
- `PROCESSED`, `REJECTED` and `FAILED` are **terminal**: any transition out of
  them throws `InvalidTransactionStateError` with `details: { from, to }`.
- Rehydration (`rehydrate`) does **not** revalidate transitions — it only
  rebuilds already-persisted state (§6.0 of the challenge).

## Balance effect and ledger direction

| Kind | `affectsBalance` | Base direction |
|---|---|---|
| `OPENING` | yes | `CREDIT` |
| `BET` | yes | `DEBIT` |
| `WIN` | yes | `CREDIT` |
| `LOSS` | **no** | `null` (no ledger entry) |
| `REFUND` | yes | `CREDIT` |
| `ROLLBACK` | yes | **inverts the reference's direction** |

Derived rules (in `transaction/transaction-rules.ts`):

- real effect = `status === PROCESSED` **and** `affectsBalance`; `REJECTED`
  never produces a ledger entry;
- `REFUND` references only `BET`; `ROLLBACK` references `BET`, `WIN` or
  `REFUND` (§7.3);
- a reversal requires the **same** value as its reference (§7.5) —
  `reference-rules.ts`;
- insufficient balance has distinct codes for bets (`INSUFFICIENT_FUNDS`) and
  reversals (`REVERSAL_INSUFFICIENT_FUNDS`) — §7.9.

## `payloadHash` — specification

```
payloadHash = SHA-256( UTF-8( canonicalJson(businessSubset) ) )  → 64 hex chars
```

- **Fields in the hash** (`BUSINESS_PAYLOAD_FIELDS`): `providerId`,
  `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`,
  `kind`, `money`. The `Idempotency-Key` header and transport metadata are
  **excluded** (§9).
- **Canonical JSON**: keys sorted by code unit (never `localeCompare` — it
  varies by OS locale), no whitespace, recursive; non-finite `number` and
  `undefined` are **errors**, never silence.
- **`money` is always `MoneyProps` (decimal string)** — `{"amount":"25.00",
  "currency":"BRL"}` — so floating point can never diverge the hash.
- Fixed vector that locks the format: `sha256Hex('{"a":"1","b":2}')` =
  `d79684d992c6150eea853d790cdef25f804d994cfe3a9198a5b012132dc46ec6`.
- Same key + divergent hash = **conflict**, not replay (§9).

## Backoff

```
delay(attempt) = min(maxMs, baseMs × factor^(attempt − 1))     attempt is 1-based
DEFAULT: baseMs = 1_000 · factor = 2 · maxMs = 300_000 (5 min)
```

Deterministic, **no jitter** — jitter is a consumer/infra decision, not a
domain one.

## Failure taxonomy

`FailureCategory`: `VALIDATION` · `CONFLICT` · `STATE` · `NOT_FOUND` ·
`EXHAUSTED`. Every `FailureCode` has exactly one category (enforced by a
completeness test in `failure-code.spec.ts`). Domain errors extend
`DomainError`, carry a `code` and frozen `details`, and serialize via
`toJSON()` — mapping to HTTP status is the presentation layer's job (Phase 2).

## Interpretive decisions

1. **Negative `Money`**: `from()` rejects negatives at the *entry contract*
   (§6.1), but `add/subtract/negate` may produce negative values
   (`isNegative()` exposes them). `Wallet` guarantees balance ≥ 0. Reason: the
   ledger invariant requires real subtraction; restricting inside the VO would
   duplicate a business rule.
2. **`ROLLBACK` inverts the reference's direction** (§7 "inverse of the
   reference"): ROLLBACK of `BET` → `CREDIT`; of `WIN`/`REFUND` → `DEBIT`.
   No resolved reference → `REFERENCE_REQUIRED` (we never guess).
3. **SHA-256 inside the domain** (`node:crypto`): a pure, deterministic
   function, no DI. Swappable later behind `shared/payload-hash.ts`.
4. **Enums as const object + union** instead of TS `enum`
   (`isolatedModules`-friendly); string values identical to the spec's.
5. **Event `aggregateId`** = the aggregate owning the transition (`transactionId`
   on transaction events, `walletId` on the balance event). `walletId` also
   rides in `data` for anyone who wants a FIFO `MessageGroupId`.
6. **`WagerTransaction.processedAt`** = *timestamp of the last state
   transition* (including `PENDING_REFERENCE`) — that is what the events use
   as `occurredAt`.
7. **Reversing twice** (§7.4) is not a code rule: it will be a **partial unique
   index** in the schema (Phase 2). `ALREADY_REVERSED` exists in the taxonomy
   to signal a violation.
