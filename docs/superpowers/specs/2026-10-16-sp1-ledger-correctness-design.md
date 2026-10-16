# SP-1 — Ledger Correctness (Concurrency + Transactional Outbox)

Status: design, not yet approved for implementation.
Roadmap entry: [`docs/ROADMAP.md`](../../ROADMAP.md) §SP-1.

## Intent

`ledger-service` currently checks balance and applies a transaction as two
separate, unlocked database operations (`ledger.go:71` and `:80`), publishes
Kafka events after commit with only a log line on failure (`ledger.go:87`),
and checks the idempotency key outside the transaction that enforces it
(`SeenIdempotencyKey` then `Apply`). Under concurrency this allows overdraft,
silent event loss, and inconsistent handling of duplicate requests sent at
the same time. SP-1 makes these three paths correct under concurrency
without changing the public `POST /transactions` contract's happy path.

This is one of three equally-weighted project goals (see `docs/ROADMAP.md`
intro): **kedalaman teknis** — solving the concurrency problem the way real
ledger/payment systems do, not the simplest thing that passes a single-request
test.

## Goals

- N concurrent debits against one account with limited balance never produce
  a negative balance.
- A transaction's event is eventually published to Kafka even if Redpanda is
  down at commit time (at-least-once, not best-effort).
- Two concurrent requests with the same idempotency key both receive the
  *same* definitive outcome (the real business result), never one getting a
  result that silently gets cached as wrong or stuck.
- Genuinely concurrent duplicate requests (second one arrives while the first
  is still being processed) get an honest "still processing" signal, not a
  blocking wait disguised as success.

## Non-goals

- Account entities, opening an account, top-up endpoints — that's SP-2.
- Rate limiting — SP-3.
- Any change to the happy-path request/response JSON shape of
  `POST /transactions`.
- Exactly-once delivery to Kafka consumers — at-least-once + log-only
  fraud-check tolerating duplicates is acceptable for SP-1; consumer-side
  dedup is not in scope.

## Anti-goals

- Introducing an `accounts` table now to get a lockable row — that's SP-2's
  job; pulling it forward here blurs the sub-project boundary the roadmap
  deliberately set.
- A two-phase idempotency flow that leaks an un-cacheable status code into
  `payment-gateway` without `payment-gateway` understanding it accurately
  (see Decision 3) — it already has a precedent for "don't cache this" (502)
  and the 409 case should extend that precedent explicitly, not rely on it
  falling into the catch-all by accident.

## Constraints (from grounding in the current code)

- Balance is derived (`SUM(amount_cents) FROM ledger_entries WHERE
  account_id = $1`), not stored on an account row
  (`ledger-service/internal/postgres/schema.sql`). There is nothing to
  `SELECT ... FOR UPDATE` yet.
- `ledger_transactions.idempotency_key` is already a `PRIMARY KEY`
  (`schema.sql:5`) — concurrent duplicate inserts already collide at the DB
  level today; the bug is that nothing distinguishes "already completed,
  replay the result" from "in progress right now" from "the PK violation is
  swallowed into a flat 422".
- `payment-gateway`'s `PaymentService.process` (`PaymentService.java:43`)
  caches any ledger-service response except HTTP 502 into Redis, keyed by
  idempotency key, and replays it on retry forever. Any new ledger-service
  status code must be accounted for in that caching decision, explicitly —
  not left to fall into the existing catch-all by coincidence.
- `LedgerServiceClient.postTransaction` (`LedgerServiceClient.java:61-69`)
  currently maps 201 -> success, 422 -> `LedgerServiceException` (business
  rejection), anything else -> `LedgerServiceUnavailableException` (502).

## Decisions

### 1. Account locking: Postgres advisory lock, not row `FOR UPDATE`

`pg_advisory_xact_lock(hashtext(account_id))` per account involved in the
transaction, acquired inside the same DB transaction that checks balance and
writes entries. Advisory locks are released automatically on commit or
rollback, need no schema change, and don't require an `accounts` table.

For a transaction touching multiple accounts (debit + credit), acquire locks
in a **fixed order** (entries sorted by `account_id` ascending) before doing
any balance check, so two transactions moving money in opposite directions
between the same two accounts can't deadlock.

### 2. Event delivery: transactional outbox + in-process polling relay

New `outbox` table, written in the **same transaction** as the ledger entries
(so publish-intent is atomic with the write it describes):

```sql
CREATE TABLE outbox (
    id              BIGSERIAL PRIMARY KEY,
    idempotency_key TEXT NOT NULL REFERENCES ledger_transactions(idempotency_key),
    payload         JSONB NOT NULL,
    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_unpublished ON outbox (created_at) WHERE published_at IS NULL;
```

A goroutine inside `ledger-service` (no new deployable) polls on an interval,
takes an unpublished batch with `SELECT ... FOR UPDATE SKIP LOCKED`, publishes
each to Redpanda via the existing `kafka.Producer`, and sets `published_at` on
success. This is at-least-once: a crash between publish and marking
`published_at` re-publishes on the next poll, which is why fraud-check (or
any future consumer) must tolerate duplicates — already true today since it
only logs.

### 3. Idempotency: two-phase claim, Stripe-style, with an honest 409

This is a genuine two-phase design (not collapsed into one transaction),
because it must give a fast, correct answer to a request that arrives while
an earlier one with the same key is still mid-flight — not make it wait out
the first request's full processing time.

Add columns to `ledger_transactions`:

```sql
ALTER TABLE ledger_transactions
    ADD COLUMN status TEXT NOT NULL DEFAULT 'processing',
    ADD COLUMN claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN response_status INT,
    ADD COLUMN response_body TEXT;
```

Flow in `ledger.Service.Post`:

1. **Claim** (own short transaction): `INSERT INTO ledger_transactions
   (idempotency_key, status, claimed_at) VALUES ($1, 'processing', now())`.
   - Succeeds -> proceed to step 2.
   - Fails on unique violation -> read the existing row's `status` and
     `claimed_at`:
     - `status = 'completed'` -> return the stored `response_status` /
       `response_body` verbatim (replay — this is the common retry case and
       must look identical to the original answer, 201 or 422 alike).
     - `status = 'processing'` and `claimed_at` is within the last
       **30 seconds** (the claim lease) -> return a distinct **conflict**
       error (maps to HTTP 409 at `httpapi`). The request genuinely has a
       twin in flight; the caller retries.
     - `status = 'processing'` and `claimed_at` is older than 30 seconds (the
       lease expired — the request that claimed it crashed or the process
       died between the claim committing and the business transaction
       finishing) -> attempt to **reclaim**: `UPDATE ledger_transactions SET
       claimed_at = now() WHERE idempotency_key = $1 AND status =
       'processing' AND claimed_at < now() - interval '30 seconds'`. If that
       updates a row, proceed to step 2 as the new owner. If it updates no
       row (lost the race to another reclaimer), re-read the row once more
       and branch again — this is why claiming is a small bounded loop, not
       a single read-then-decide, same as the retry-until-settled shape
       described for Decision 1's lock ordering.

   This is a *lease*, not a permanent "stuck" state: nothing needs to
   explicitly mark a row "failed" for cleanup to happen, which matters
   because a crash can't run cleanup code. Any abandoned claim heals itself
   the next time the same idempotency key is retried, after the lease
   expires. 30 seconds is far longer than step 2 should ever take in this
   system (no network calls, no external services) — it only needs to be
   longer than the slowest real request, not tuned precisely.
2. **Business transaction**: advisory-lock the involved accounts (Decision
   1), check balances, insert `ledger_entries`, insert the `outbox` row
   (Decision 2), update the `ledger_transactions` row to `status =
   'completed'` with the resulting `response_status`/`response_body` — all
   in one transaction. On insufficient balance, this still commits with
   `status = 'completed'` and `response_status = 422` (a business rejection
   is a definitive, cacheable outcome, same as today).

**Response construction moves into `ledger.Service`.** Today `httpapi`
builds the HTTP body ad hoc (plain-text `http.Error` for 422, empty body for
201) and that logic can't be replayed later, since step 2 above needs to
persist `response_status`/`response_body` *inside* the business transaction.
`ledger.Service.Post` changes to return `(status int, body []byte, err
error)` (or an equivalent result struct) — it decides the exact bytes for
every outcome (success, business rejection, replay), `postgres.Store`
persists those same bytes into `response_status`/`response_body` when it
marks a transaction `'completed'`, and `httpapi.handlePostTransaction` just
writes whatever `Post` returned verbatim. 201 gets a real minimal JSON body
(e.g. `{"status":"completed"}`) instead of an empty one, so a replay has
something concrete to reproduce. (Note: `payment-gateway`'s
`PaymentService.callLedgerService` already synthesizes its own `201` body
today and ignores ledger-service's — this change doesn't require touching
that, it just makes ledger-service's own body well-defined for anyone who
does read it, e.g. e2e tests or future callers.)

**`postgres.Store.Apply`'s existing `INSERT INTO ledger_transactions`
becomes an `UPDATE`.** The claim step (step 1 above) already inserts that
row with `status = 'processing'`; `Apply` doing its own `INSERT` on the same
primary key would immediately collide with the row it just claimed. `Apply`
(or whatever step 2 is renamed to) must `UPDATE ledger_transactions SET
status = 'completed', response_status = $2, response_body = $3 WHERE
idempotency_key = $1` instead.

`httpapi.handlePostTransaction` maps the new conflict error to 409 (new),
keeps 422 for business rejection, 201 for success/replay — all via the
`(status, body)` `Post` now returns, not separately decided in `httpapi`.

`payment-gateway` changes: `LedgerServiceClient` adds a `409 ->
LedgerServiceConflictException` branch (distinct from the 502 catch-all it
falls into today), and `PaymentService.process` excludes that exception's
mapped response from caching, the same way it already excludes 502 — with a
comment explaining why, mirroring the existing one at `PaymentService.java:43`.
`PaymentService` does **not** retry internally on a conflict — it returns
`PaymentResult(409, body)` to its own caller, same shape as every other
outcome. This needs no change in `bff`: `PaymentGatewayClient.submitPayment`
(`bff/src/services/payment-gateway-client.ts:81`) already relays whatever
status/body payment-gateway returns verbatim, with no per-status-code
branching, so a 409 flows through to the original client untouched.

## What's left to the builder

- Exact Go error type/sentinel for the new "conflict" case and how it
  threads from `postgres.Store` through `ledger.Service` to `httpapi` (follow
  the existing `ErrInsufficientBalance` pattern).
- Exact polling interval and batch size for the outbox relay (pick something
  that keeps e2e test latency reasonable, e.g. 100-200ms, not a hard
  requirement from this design).
- Whether the claim step (step 1) and business transaction (step 2) share a
  DB connection/pool entry or are independent `BeginTx` calls — independent
  is simpler and is what "own short transaction" above implies.
- Go/Java exception and HTTP client test coverage for the new 409 path.
- Migration mechanics for `schema.sql` (it's applied fresh in CI/dev per
  `docker-entrypoint-initdb.d` — confirm whether an `ALTER TABLE` needs a
  separate migration file or schema.sql can just be edited in place, matching
  existing project convention for schema changes so far, which has none yet
  since this is the first one).

## Verification (maps to roadmap "selesai bila")

- e2e: N parallel debits from one account with a limited balance never drive
  it negative.
- e2e: kill Redpanda during a transaction's commit window; assert the event
  is still delivered once Redpanda is back up.
- e2e: fire two requests with the same idempotency key at the same time;
  assert one gets 409 (or both get the same successful replay if timing
  makes them sequential at the DB level) and a third request with the same
  key sent after both finish gets the original definitive result.
