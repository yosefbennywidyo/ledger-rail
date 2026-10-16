# SP-1 Ledger Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ledger-service` correct under concurrency — no overdraft, no silently lost events, no inconsistent duplicate-request handling — without changing the happy-path shape of `POST /transactions`.

**Architecture:** Account locking moves inside a single DB transaction via Postgres advisory locks (no `accounts` table exists yet); event publishing moves from synchronous best-effort to a transactional outbox table drained by a polling relay goroutine; idempotency becomes a two-phase claim (fast claim, then business work) with a lease so an abandoned claim self-heals, giving an honest 409 for genuinely concurrent duplicates instead of a flat 422 or a stuck key.

**Tech Stack:** Go 1.x (`ledger-service`, `database/sql` + `pgx` driver), Java/Spring (`payment-gateway`), TypeScript/Vitest (`e2e`), PostgreSQL, Kafka-compatible Redpanda.

**Spec:** [`docs/superpowers/specs/2026-10-16-sp1-ledger-correctness-design.md`](../specs/2026-10-16-sp1-ledger-correctness-design.md)

## Global Constraints

- Claim lease timeout: **30 seconds** (`claimed_at` older than this is reclaimable).
- Advisory lock key: `pg_advisory_xact_lock(hashtext(account_id))`, accounts locked in ascending `account_id` order within one transaction.
- `ledger_transactions.idempotency_key` stays the `PRIMARY KEY`; new columns are additive (`status`, `claimed_at`, `response_status`, `response_body`).
- `POST /transactions` response codes: `201` success, `422` business rejection or unbalanced entries, `409` genuine concurrent duplicate, `500` unexpected failure. No change to the request JSON shape.
- `payment-gateway` must not cache a `409` response (same rule it already applies to `502`, at `PaymentService.java:43`).
- Outbox delivery is at-least-once; no consumer-side change is in scope (fraud-check already only logs, so duplicates are harmless today).

## Review Focus

- **Two concurrent debits from the same account, balance only covers one.** One must succeed, the other must see the post-first-debit balance and be rejected with `422` — never both succeeding (overdraft). Exercised in Task 8.
- **Same idempotency key sent twice at effectively the same instant.** One request must get the real outcome; the other must get either `409` (if still processing) or the identical replayed outcome (if the first already finished) — never a bare unique-constraint error leaking through as an opaque `500`. Exercised in Task 2 (unit, via fake repo) and Task 8 (e2e, real Postgres).
- **A transaction whose entries touch two accounts in different lock order across two concurrent requests** (A debits X credits Y; B debits Y credits X, at the same time). Must not deadlock. Exercised implicitly by Task 5's ascending-order locking and smoke-tested in Task 8's concurrency test by including a reverse-direction pair.
- **Redpanda unreachable at the moment a transaction commits.** The transaction must still succeed (outbox row written), and the event must reach Redpanda once it's back, without ledger-service needing to resend anything itself. Exercised in Task 9.
- **A business rejection (insufficient balance) retried with the same idempotency key.** Must replay the original `422` body, not re-run the balance check against a possibly-changed balance. Exercised in Task 2's `TestPost_RejectedOutcomeReplaysOnRetry`.

---

## Task 1: Schema migration — outbox table and idempotency columns

**Files:**
- Modify: `ledger-service/internal/postgres/schema.sql`

**Interfaces:**
- Produces: the `outbox` table and the new `ledger_transactions` columns (`status`, `claimed_at`, `response_status`, `response_body`) that Tasks 3 and 5 read/write.

- [ ] **Step 1: Edit `schema.sql`** to add, after the existing `ledger_transactions` table definition:

```sql
ALTER TABLE ledger_transactions
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'processing',
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS response_status INT,
    ADD COLUMN IF NOT EXISTS response_body TEXT;

CREATE TABLE IF NOT EXISTS outbox (
    id              BIGSERIAL PRIMARY KEY,
    idempotency_key TEXT NOT NULL REFERENCES ledger_transactions(idempotency_key),
    payload         JSONB NOT NULL,
    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON outbox (created_at) WHERE published_at IS NULL;
```

- [ ] **Step 2: Verify the schema applies cleanly from scratch**

Run: `cd /Users/crowdotech/apps/me/explore/ledger-rail && docker compose up -d postgres && sleep 3 && docker compose exec -T postgres psql -U ledger -d ledger -f - < ledger-service/internal/postgres/schema.sql`
Expected: no errors; re-running the same command a second time also succeeds (idempotent via `IF NOT EXISTS`).

- [ ] **Step 3: Commit**

```bash
git -C ledger-service add internal/postgres/schema.sql
git -C ledger-service commit -m "Add outbox table and idempotency claim columns to schema"
```

---

## Task 2: `ledger` package — new domain types, errors, event encoding, and `Service.Post` rewrite

**Files:**
- Create: `ledger-service/internal/ledger/event.go`
- Modify: `ledger-service/internal/ledger/ledger.go`
- Modify: `ledger-service/internal/ledger/ledger_test.go`

**Interfaces:**
- Produces (used by Task 5's `postgres.Store` and Task 6's `httpapi`):
  - `ledger.MarshalEvent(tx Transaction) ([]byte, error)`
  - `ledger.TransactionEvent{IdempotencyKey string; Entries []EntryJSON}`, `ledger.EntryJSON{AccountID string; AmountCents int64}`
  - `ledger.ErrUnbalancedTransaction`, `ledger.ErrConflict` (sentinel errors)
  - `ledger.ClaimState` (`ClaimAcquired`, `ClaimCompleted`, `ClaimProcessing`), `ledger.Claim{State ClaimState; ResponseStatus int; ResponseBody []byte}`
  - `ledger.Repository` interface: `ClaimIdempotencyKey(ctx, key string) (Claim, error)`, `ApplyLocked(ctx, tx Transaction) (status int, body []byte, err error)`
  - `ledger.Service.Post(ctx, tx Transaction) (status int, body []byte, err error)`
  - `ledger.NewService(repo Repository) *Service` (drops the `publisher` parameter — publishing is no longer `Service`'s job)

- [ ] **Step 1: Write `event.go`**

```go
package ledger

import "encoding/json"

// TransactionEvent is the wire format published to Kafka/Redpanda and
// stored as the outbox payload — fraud-check's consumer expects this shape
// (see fraud-check/src/fraud_check/consumer.py).
type TransactionEvent struct {
	IdempotencyKey string      `json:"idempotency_key"`
	Entries        []EntryJSON `json:"entries"`
}

type EntryJSON struct {
	AccountID   string `json:"account_id"`
	AmountCents int64  `json:"amount_cents"`
}

// MarshalEvent builds the JSON payload for tx, used both for the outbox row
// written at commit time and (unmarshaled) for the message the relay later
// publishes.
func MarshalEvent(tx Transaction) ([]byte, error) {
	event := TransactionEvent{IdempotencyKey: tx.IdempotencyKey}
	for _, e := range tx.Entries {
		event.Entries = append(event.Entries, EntryJSON{AccountID: e.AccountID, AmountCents: e.AmountCents})
	}
	return json.Marshal(event)
}
```

- [ ] **Step 2: Write the failing/updated unit tests in `ledger_test.go`**

Replace the whole file's fakes and tests with:

```go
package ledger

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

type claimRecord struct {
	status   string // "processing" | "completed"
	respCode int
	respBody []byte
}

type fakeRepo struct {
	balances   map[string]int64
	claims     map[string]*claimRecord
	applied    []Transaction
	outboxRows int
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{balances: map[string]int64{}, claims: map[string]*claimRecord{}}
}

func (f *fakeRepo) ClaimIdempotencyKey(_ context.Context, key string) (Claim, error) {
	if rec, ok := f.claims[key]; ok {
		if rec.status == "processing" {
			return Claim{State: ClaimProcessing}, nil
		}
		return Claim{State: ClaimCompleted, ResponseStatus: rec.respCode, ResponseBody: rec.respBody}, nil
	}
	f.claims[key] = &claimRecord{status: "processing"}
	return Claim{State: ClaimAcquired}, nil
}

func (f *fakeRepo) ApplyLocked(_ context.Context, tx Transaction) (int, []byte, error) {
	for _, e := range tx.Entries {
		if e.AmountCents < 0 && f.balances[e.AccountID]+e.AmountCents < 0 {
			body := []byte(fmt.Sprintf(`{"error":"insufficient balance: account %s"}`, e.AccountID))
			f.claims[tx.IdempotencyKey] = &claimRecord{status: "completed", respCode: 422, respBody: body}
			return 422, body, nil
		}
	}
	for _, e := range tx.Entries {
		f.balances[e.AccountID] += e.AmountCents
	}
	f.applied = append(f.applied, tx)
	f.outboxRows++
	body := []byte(`{"status":"completed"}`)
	f.claims[tx.IdempotencyKey] = &claimRecord{status: "completed", respCode: 201, respBody: body}
	return 201, body, nil
}

func TestPost_TableDriven(t *testing.T) {
	cases := []struct {
		name       string
		startBal   int64
		tx         Transaction
		wantStatus int
		wantErr    error
	}{
		{
			name:     "sufficient balance debits and credits",
			startBal: 1000,
			tx: Transaction{IdempotencyKey: "tx-1", Entries: []Entry{
				{AccountID: "alice", AmountCents: -500},
				{AccountID: "bob", AmountCents: 500},
			}},
			wantStatus: 201,
		},
		{
			name:     "insufficient balance rejected with 422, not an error",
			startBal: 100,
			tx: Transaction{IdempotencyKey: "tx-2", Entries: []Entry{
				{AccountID: "alice", AmountCents: -500},
				{AccountID: "bob", AmountCents: 500},
			}},
			wantStatus: 422,
		},
		{
			name:     "unbalanced transaction rejected",
			startBal: 1000,
			tx: Transaction{IdempotencyKey: "tx-3", Entries: []Entry{
				{AccountID: "alice", AmountCents: -500},
				{AccountID: "bob", AmountCents: 400},
			}},
			wantErr: ErrUnbalancedTransaction,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := newFakeRepo()
			repo.balances["alice"] = tc.startBal
			svc := NewService(repo)

			status, _, err := svc.Post(context.Background(), tc.tx)

			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("got err %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if status != tc.wantStatus {
				t.Fatalf("got status %d, want %d", status, tc.wantStatus)
			}
		})
	}
}

func TestPost_IdempotentRetryReplaysOriginalResponse(t *testing.T) {
	repo := newFakeRepo()
	repo.balances["alice"] = 1000
	svc := NewService(repo)
	tx := Transaction{IdempotencyKey: "retry-key", Entries: []Entry{
		{AccountID: "alice", AmountCents: -100},
		{AccountID: "bob", AmountCents: 100},
	}}

	status1, body1, err := svc.Post(context.Background(), tx)
	if err != nil {
		t.Fatalf("first post: %v", err)
	}
	status2, body2, err := svc.Post(context.Background(), tx)
	if err != nil {
		t.Fatalf("retried post: %v", err)
	}

	if status1 != status2 || string(body1) != string(body2) {
		t.Fatalf("replay mismatch: (%d, %s) vs (%d, %s)", status1, body1, status2, body2)
	}
	if got := repo.balances["alice"]; got != 900 {
		t.Fatalf("balance double-applied: got %d, want 900", got)
	}
	if repo.outboxRows != 1 {
		t.Fatalf("expected exactly one outbox row despite the retry, got %d", repo.outboxRows)
	}
}

func TestPost_ConflictWhenKeyStillProcessing(t *testing.T) {
	repo := newFakeRepo()
	repo.claims["in-flight-key"] = &claimRecord{status: "processing"}
	svc := NewService(repo)
	tx := Transaction{IdempotencyKey: "in-flight-key", Entries: []Entry{
		{AccountID: "alice", AmountCents: -100},
		{AccountID: "bob", AmountCents: 100},
	}}

	_, _, err := svc.Post(context.Background(), tx)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("got err %v, want ErrConflict", err)
	}
	if len(repo.applied) != 0 {
		t.Fatalf("expected no business transaction to run for a conflicting claim, got %d", len(repo.applied))
	}
}

func TestPost_RejectedBusinessOutcomeIsNotAnError(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo)
	tx := Transaction{IdempotencyKey: "reject-key", Entries: []Entry{
		{AccountID: "alice", AmountCents: -500},
		{AccountID: "bob", AmountCents: 500},
	}}

	status, body, err := svc.Post(context.Background(), tx)
	if err != nil {
		t.Fatalf("a business rejection must not be a Go error: %v", err)
	}
	if status != 422 {
		t.Fatalf("got status %d, want 422", status)
	}
	if len(body) == 0 {
		t.Fatal("expected a non-empty rejection body")
	}
}

func TestPost_RejectedOutcomeReplaysOnRetry(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo)
	tx := Transaction{IdempotencyKey: "reject-retry-key", Entries: []Entry{
		{AccountID: "alice", AmountCents: -500},
		{AccountID: "bob", AmountCents: 500},
	}}

	status1, body1, err := svc.Post(context.Background(), tx)
	if err != nil {
		t.Fatalf("first post: %v", err)
	}
	// Fund the account between attempts: a real re-run of the balance check
	// would now succeed, but a retry of the same idempotency key must still
	// replay the original 422 rather than re-evaluating the balance.
	repo.balances["alice"] = 1000
	status2, body2, err := svc.Post(context.Background(), tx)
	if err != nil {
		t.Fatalf("retried post: %v", err)
	}

	if status1 != 422 || status2 != 422 {
		t.Fatalf("got statuses %d, %d, want 422, 422", status1, status2)
	}
	if string(body1) != string(body2) {
		t.Fatalf("replay mismatch: %s vs %s", body1, body2)
	}
	if repo.balances["alice"] != 1000 {
		t.Fatalf("retry must not touch the balance: got %d, want 1000 (unchanged by the replay)", repo.balances["alice"])
	}
}
```

- [ ] **Step 3: Run tests to verify they fail to compile** (the old `ledger.go` doesn't have these types yet)

Run: `cd /Users/crowdotech/apps/me/explore/ledger-rail/ledger-service && go test ./internal/ledger/...`
Expected: compile error referencing undefined `ClaimState`, `NewService` signature mismatch, etc.

- [ ] **Step 4: Rewrite `ledger.go`**

```go
package ledger

import (
	"context"
	"errors"
	"fmt"
)

var (
	ErrUnbalancedTransaction = errors.New("unbalanced transaction")
	ErrConflict              = errors.New("idempotency key still processing")
)

type Entry struct {
	AccountID   string
	AmountCents int64
}

type Transaction struct {
	IdempotencyKey string
	Entries        []Entry
}

type ClaimState int

const (
	ClaimAcquired ClaimState = iota
	ClaimCompleted
	ClaimProcessing
)

// Claim is the outcome of attempting to claim an idempotency key.
// ResponseStatus/ResponseBody are only populated when State is ClaimCompleted.
type Claim struct {
	State          ClaimState
	ResponseStatus int
	ResponseBody   []byte
}

// Repository is the persistence boundary the ledger service depends on.
type Repository interface {
	// ClaimIdempotencyKey atomically claims key for processing, or reports
	// that it's already completed (with the stored response to replay) or
	// still genuinely in flight.
	ClaimIdempotencyKey(ctx context.Context, key string) (Claim, error)
	// ApplyLocked locks every account tx touches, checks balances, and
	// atomically persists the outcome — writing ledger_entries and an
	// outbox row on success, or just the rejection on insufficient balance.
	// A business rejection is returned as (422, body, nil), never as err;
	// err is reserved for unexpected failures (e.g. the database is down).
	ApplyLocked(ctx context.Context, tx Transaction) (status int, body []byte, err error)
}

type Service struct {
	repo Repository
}

func NewService(repo Repository) *Service {
	return &Service{repo: repo}
}

// Post validates, claims the idempotency key, and applies a balanced
// transaction. Returns the HTTP status and body httpapi should send.
func (s *Service) Post(ctx context.Context, tx Transaction) (status int, body []byte, err error) {
	if verr := validateBalanced(tx); verr != nil {
		return 0, nil, fmt.Errorf("%w: %v", ErrUnbalancedTransaction, verr)
	}

	claim, err := s.repo.ClaimIdempotencyKey(ctx, tx.IdempotencyKey)
	if err != nil {
		return 0, nil, fmt.Errorf("claim idempotency key: %w", err)
	}
	switch claim.State {
	case ClaimCompleted:
		return claim.ResponseStatus, claim.ResponseBody, nil
	case ClaimProcessing:
		return 0, nil, ErrConflict
	}

	return s.repo.ApplyLocked(ctx, tx)
}

func validateBalanced(tx Transaction) error {
	var sum int64
	for _, e := range tx.Entries {
		sum += e.AmountCents
	}
	if sum != 0 {
		return fmt.Errorf("entries sum to %d, want 0", sum)
	}
	return nil
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/crowdotech/apps/me/explore/ledger-rail/ledger-service && go test ./internal/ledger/... -v`
Expected: PASS for all six test functions.

- [ ] **Step 6: Commit**

```bash
git -C ledger-service add internal/ledger/event.go internal/ledger/ledger.go internal/ledger/ledger_test.go
git -C ledger-service commit -m "Rework ledger.Service around a locked Repository and two-phase idempotency claim"
```

---

## Task 3: `outbox` package — polling relay

**Files:**
- Create: `ledger-service/internal/outbox/relay.go`
- Create: `ledger-service/internal/outbox/relay_test.go`

**Interfaces:**
- Produces: `outbox.Record{ID int64; Key string; Payload []byte}`, `outbox.Repository` interface (`FetchUnpublished`, `MarkPublished`), `outbox.Publisher` interface (`PublishRaw`), `outbox.NewRelay(repo Repository, publisher Publisher, pollInterval time.Duration, batchSize int) *Relay`, `Relay.Run(ctx context.Context)` (blocks until `ctx` is canceled; intended to run in its own goroutine). This package is self-contained — it defines the interfaces it needs rather than importing `postgres` or `kafka`. Task 5's `postgres.Store` implements `outbox.Repository` (and imports this package for the `Record`/`Repository` types); Task 4's `kafka.Producer` implements `outbox.Publisher` structurally (same method signature, no import needed). Used by Task 6's `main.go`.

- [ ] **Step 1: Write the failing test in `relay_test.go`**

```go
package outbox

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeRepo struct {
	pending   []Record
	published []int64
}

func (f *fakeRepo) FetchUnpublished(_ context.Context, limit int) ([]Record, error) {
	if len(f.pending) > limit {
		return f.pending[:limit], nil
	}
	return f.pending, nil
}

func (f *fakeRepo) MarkPublished(_ context.Context, id int64) error {
	f.published = append(f.published, id)
	for i, r := range f.pending {
		if r.ID == id {
			f.pending = append(f.pending[:i], f.pending[i+1:]...)
			break
		}
	}
	return nil
}

type fakePublisher struct {
	sent []string
}

func (f *fakePublisher) PublishRaw(_ context.Context, key string, _ []byte) error {
	f.sent = append(f.sent, key)
	return nil
}

type failingPublisher struct{}

func (failingPublisher) PublishRaw(context.Context, string, []byte) error {
	return errors.New("broker unreachable")
}

func TestRelay_PublishesAndMarksPublished(t *testing.T) {
	repo := &fakeRepo{pending: []Record{{ID: 1, Key: "tx-1", Payload: []byte(`{}`)}}}
	pub := &fakePublisher{}
	relay := NewRelay(repo, pub, 10*time.Millisecond, 10)

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	go relay.Run(ctx)
	<-ctx.Done()

	if len(pub.sent) != 1 || pub.sent[0] != "tx-1" {
		t.Fatalf("expected tx-1 published once, got %v", pub.sent)
	}
	if len(repo.published) != 1 || repo.published[0] != int64(1) {
		t.Fatalf("expected outbox row 1 marked published, got %v", repo.published)
	}
}

func TestRelay_PublishFailureLeavesRowPendingForNextPoll(t *testing.T) {
	repo := &fakeRepo{pending: []Record{{ID: 1, Key: "tx-1", Payload: []byte(`{}`)}}}
	relay := NewRelay(repo, failingPublisher{}, 10*time.Millisecond, 10)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	go relay.Run(ctx)
	<-ctx.Done()

	if len(repo.published) != 0 {
		t.Fatalf("expected no row marked published when every publish attempt fails, got %v", repo.published)
	}
	if len(repo.pending) != 1 {
		t.Fatalf("expected the row to remain pending, got %d", len(repo.pending))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/crowdotech/apps/me/explore/ledger-rail/ledger-service && go test ./internal/outbox/...`
Expected: FAIL / compile error — package `outbox` and `NewRelay` don't exist yet.

- [ ] **Step 3: Implement `relay.go`**

```go
package outbox

import (
	"context"
	"log"
	"time"
)

// Record is one unpublished outbox row.
type Record struct {
	ID      int64
	Key     string
	Payload []byte
}

// Repository is the outbox-table persistence boundary the relay depends on.
// postgres.Store implements this.
type Repository interface {
	FetchUnpublished(ctx context.Context, limit int) ([]Record, error)
	MarkPublished(ctx context.Context, id int64) error
}

// Publisher is the broker boundary the relay depends on. kafka.Producer
// implements this via PublishRaw.
type Publisher interface {
	PublishRaw(ctx context.Context, key string, payload []byte) error
}

type Relay struct {
	repo         Repository
	publisher    Publisher
	pollInterval time.Duration
	batchSize    int
}

func NewRelay(repo Repository, publisher Publisher, pollInterval time.Duration, batchSize int) *Relay {
	return &Relay{repo: repo, publisher: publisher, pollInterval: pollInterval, batchSize: batchSize}
}

// Run polls for unpublished outbox rows until ctx is canceled. A publish or
// mark-published failure is logged and retried on the next tick — the row
// stays unpublished until it succeeds, which is what makes this
// at-least-once rather than best-effort.
func (r *Relay) Run(ctx context.Context) {
	ticker := time.NewTicker(r.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.drainOnce(ctx)
		}
	}
}

func (r *Relay) drainOnce(ctx context.Context) {
	records, err := r.repo.FetchUnpublished(ctx, r.batchSize)
	if err != nil {
		log.Printf("outbox: fetch unpublished: %v", err)
		return
	}
	for _, rec := range records {
		if err := r.publisher.PublishRaw(ctx, rec.Key, rec.Payload); err != nil {
			log.Printf("outbox: publish %s: %v", rec.Key, err)
			continue
		}
		if err := r.repo.MarkPublished(ctx, rec.ID); err != nil {
			log.Printf("outbox: mark published %d: %v", rec.ID, err)
		}
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/crowdotech/apps/me/explore/ledger-rail/ledger-service && go test ./internal/outbox/... -v`
Expected: PASS for both test functions.

- [ ] **Step 5: Commit**

```bash
git -C ledger-service add internal/outbox/relay.go internal/outbox/relay_test.go
git -C ledger-service commit -m "Add polling outbox relay"
```

---

## Task 4: `kafka` package — raw publish for the relay

**Files:**
- Modify: `ledger-service/internal/kafka/producer.go`

**Interfaces:**
- Produces (used by Task 6's wiring; satisfies Task 3's `outbox.Publisher` structurally, no import needed): `Producer.PublishRaw(ctx context.Context, key string, payload []byte) error`

- [ ] **Step 1: Replace `Publish(ctx, tx ledger.Transaction)` and the private `transactionEvent`/`entryJSON` types** (now redundant with `ledger.MarshalEvent`) with:

```go
// PublishRaw sends an already-encoded event payload to Kafka under key, so
// all entries of one transaction stay on the same partition and in order.
// Used by the outbox relay, which reads already-marshaled payloads from the
// outbox table rather than re-encoding a ledger.Transaction.
func (p *Producer) PublishRaw(ctx context.Context, key string, payload []byte) error {
	if err := p.writer.WriteMessages(ctx, segmentio.Message{
		Key:   []byte(key),
		Value: payload,
	}); err != nil {
		return fmt.Errorf("publish event: %w", err)
	}
	return nil
}
```

Remove the now-unused `"encoding/json"` import and the `ledger` import if nothing else in the file needs it.

- [ ] **Step 2: Run the package build**

Run: `cd /Users/crowdotech/apps/me/explore/ledger-rail/ledger-service && go build ./internal/kafka/...`
Expected: builds cleanly. (Not `go build ./...` yet — `cmd/ledger-service/main.go` still calls the old `Publish` method until Task 6 rewires it.)

- [ ] **Step 3: Commit**

```bash
git -C ledger-service add internal/kafka/producer.go
git -C ledger-service commit -m "Replace kafka.Producer.Publish with PublishRaw for the outbox relay"
```

---

## Task 5: `postgres` package — advisory-locked `ApplyLocked`, `ClaimIdempotencyKey`, outbox write

**Files:**
- Modify: `ledger-service/internal/postgres/postgres.go`

**Interfaces:**
- Consumes: `ledger.Claim`, `ledger.ClaimState`, `ledger.Transaction`, `ledger.MarshalEvent` (Task 2, implements `ledger.Repository`); `outbox.Record`, `outbox.Repository` (Task 3, implements it — `postgres` imports `internal/outbox` for these types; `outbox` imports neither `postgres` nor `ledger`, so there's no cycle).
- Produces (used by Task 6's wiring): `Store` satisfies both `ledger.Repository` and `outbox.Repository`, so the same `*postgres.Store` value passed to `ledger.NewService` is also passed to `outbox.NewRelay`.

No new Go-level test is added for this task — there is no existing unit-test harness for `postgres.Store` against a real database in this codebase (only `ledger`'s fake-repo unit tests and the e2e suite exercise it), so correctness here is verified by the existing `e2e/tests/sync-path.test.ts` (regression, run at the end of Task 6 once wiring is complete) and the new concurrency/outbox e2e tests in Tasks 8-9. This matches the project's established testing convention — don't introduce a new one for this task alone.

- [ ] **Step 1: Replace `Balance`, `Apply`, `SeenIdempotencyKey` with `ClaimIdempotencyKey` and `ApplyLocked`, add outbox accessors**

Exact SQL to use (the implementer writes the surrounding Go — error wrapping, scanning, `pgconn.PgError` detection for unique-violation code `23505` — following the existing style already in this file):

Claim (own transaction, committed before returning):
```sql
INSERT INTO ledger_transactions (idempotency_key, status, claimed_at) VALUES ($1, 'processing', now())
```
On unique-violation, read:
```sql
SELECT status, claimed_at, response_status, response_body FROM ledger_transactions WHERE idempotency_key = $1
```
then branch per the design doc's three cases (`completed` -> `ledger.Claim{State: ClaimCompleted, ...}`; `processing` within 30s -> `ledger.Claim{State: ClaimProcessing}`; `processing` older than 30s -> attempt the reclaim UPDATE below, and if it affects zero rows, re-run this same SELECT-and-branch once more):
```sql
UPDATE ledger_transactions SET claimed_at = now() WHERE idempotency_key = $1 AND status = 'processing' AND claimed_at < now() - interval '30 seconds'
```

Business transaction (`ApplyLocked`), all inside one `dbTx`:
```sql
-- for each distinct account_id in tx.Entries, sorted ascending:
SELECT pg_advisory_xact_lock(hashtext($1))

-- for each account being debited (AmountCents < 0), after all locks are held:
SELECT COALESCE(SUM(amount_cents), 0) FROM ledger_entries WHERE account_id = $1
```
If any debited account's `balance + AmountCents < 0`: build the rejection body (mirror the existing error text style, e.g. `{"error":"insufficient balance: account <id>"}`), then:
```sql
UPDATE ledger_transactions SET status = 'completed', response_status = 422, response_body = $2 WHERE idempotency_key = $1
```
commit, return `(422, body, nil)`.

Otherwise, insert entries exactly as the current `Apply` does, plus:
```sql
INSERT INTO outbox (idempotency_key, payload) VALUES ($1, $2)  -- $2 = ledger.MarshalEvent(tx)
UPDATE ledger_transactions SET status = 'completed', response_status = 201, response_body = $2 WHERE idempotency_key = $1  -- $2 = `{"status":"completed"}`
```
commit, return `(201, body, nil)`.

Outbox accessors for the relay (`FetchUnpublishedOutbox(ctx, limit) ([]outbox.Record, error)`, `MarkOutboxPublished(ctx, id int64) error`):
```sql
SELECT id, idempotency_key, payload FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
UPDATE outbox SET published_at = now() WHERE id = $1
```

- [ ] **Step 2: Verify the package builds on its own**

Run: `cd /Users/crowdotech/apps/me/explore/ledger-rail/ledger-service && go build ./internal/postgres/...`
Expected: builds cleanly. (The whole-module build and the e2e regression check wait until Task 6, since `cmd/ledger-service/main.go` still calls the old `postgres.Store`/`ledger.NewService` signatures until then.)

- [ ] **Step 3: Commit**

```bash
git -C ledger-service add internal/postgres/postgres.go
git -C ledger-service commit -m "Implement advisory-locked balance checks and two-phase idempotency claim in postgres.Store"
```

---

## Task 6: Wire `httpapi` and `main.go` to the new `Service`/`Repository`/`Relay`

**Files:**
- Modify: `ledger-service/internal/httpapi/httpapi.go`
- Modify: `ledger-service/cmd/ledger-service/main.go`

**Interfaces:**
- Consumes: `ledger.Service.Post` (new signature, Task 2), `ledger.ErrUnbalancedTransaction`/`ledger.ErrConflict` (Task 2), `outbox.NewRelay`/`Relay.Run` (Task 3), `postgres.Store.FetchUnpublishedOutbox`/`MarkOutboxPublished` (Task 5), `kafka.Producer.PublishRaw` (Task 4).

- [ ] **Step 1: Update `handlePostTransaction`**

```go
func (s *Server) handlePostTransaction(w http.ResponseWriter, r *http.Request) {
	var req postTransactionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	tx := ledger.Transaction{IdempotencyKey: req.IdempotencyKey}
	for _, e := range req.Entries {
		tx.Entries = append(tx.Entries, ledger.Entry{AccountID: e.AccountID, AmountCents: e.AmountCents})
	}

	status, body, err := s.svc.Post(r.Context(), tx)
	if err != nil {
		switch {
		case errors.Is(err, ledger.ErrUnbalancedTransaction):
			http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		case errors.Is(err, ledger.ErrConflict):
			http.Error(w, err.Error(), http.StatusConflict)
		default:
			http.Error(w, "internal error", http.StatusInternalServerError)
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(body)
}
```

Add `"errors"` to the import block.

- [ ] **Step 2: Update `main.go` wiring**

```go
store, err := postgres.Open(dsn)
if err != nil {
	log.Fatalf("open postgres: %v", err)
}
defer store.Close()

producer := kafka.NewProducer(strings.Split(brokers, ","), topic)
defer producer.Close()

svc := ledger.NewService(store)
server := httpapi.NewServer(svc)

relay := outbox.NewRelay(store, producer, 200*time.Millisecond, 20)
relayCtx, cancelRelay := context.WithCancel(context.Background())
defer cancelRelay()
go relay.Run(relayCtx)

log.Printf("ledger-service listening on :%s", addr)
if err := http.ListenAndServe(":"+addr, server); err != nil {
	log.Fatalf("serve: %v", err)
}
```

Add `"context"`, `"time"`, and `"ledger-rail/ledger-service/internal/outbox"` to the imports.

- [ ] **Step 3: Build and run the full existing e2e suite as a regression gate**

Run: `cd /Users/crowdotech/apps/me/explore/ledger-rail/ledger-service && go build ./... && go vet ./...`
Expected: clean build, no vet warnings.

Run: `cd /Users/crowdotech/apps/me/explore/ledger-rail/e2e && ./scripts/ci-local.sh`
Expected: all existing e2e suites (sync-path, async-path, reconciliation) still pass. This is the point where Task 5's `ApplyLocked`/`ClaimIdempotencyKey` SQL gets its first real exercise against Postgres.

- [ ] **Step 4: Commit**

```bash
git -C ledger-service add internal/httpapi/httpapi.go cmd/ledger-service/main.go
git -C ledger-service commit -m "Wire httpapi and main to the locked Service and outbox relay"
```

---

## Task 7: `payment-gateway` — handle ledger-service's 409 without caching it

**Files:**
- Create: `payment-gateway/src/main/java/rail/ledger/paymentgateway/client/LedgerServiceConflictException.java`
- Modify: `payment-gateway/src/main/java/rail/ledger/paymentgateway/client/LedgerServiceClient.java`
- Modify: `payment-gateway/src/main/java/rail/ledger/paymentgateway/service/PaymentService.java`
- Modify: `payment-gateway/src/test/java/rail/ledger/paymentgateway/service/PaymentServiceTest.java`

**Interfaces:**
- Produces: `LedgerServiceConflictException(String message)`, thrown by `LedgerServiceClient.postTransaction` on HTTP 409, caught by `PaymentService.callLedgerService` and mapped to `PaymentResult(409, message)`.

- [ ] **Step 1: Write the failing test in `PaymentServiceTest.java`**

Add:

```java
@Test
void propagatesConflictAs409AndDoesNotCacheIt() {
    when(idempotencyStore.find("idem-key-1")).thenReturn(Optional.empty());
    doThrow(new LedgerServiceConflictException("idempotency key still processing"))
            .when(ledgerServiceClient).postTransaction(any());

    PaymentService service = new PaymentService(idempotencyStore, ledgerServiceClient);
    PaymentResult result = service.process(request);

    assertThat(result.httpStatus()).isEqualTo(409);
    verify(idempotencyStore, never()).save(any(), any());
}
```

Add the matching import: `import rail.ledger.paymentgateway.client.LedgerServiceConflictException;`

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/crowdotech/apps/me/explore/ledger-rail/payment-gateway && ./mvnw -q -Dtest=PaymentServiceTest test`
Expected: compile failure — `LedgerServiceConflictException` doesn't exist yet.

- [ ] **Step 3: Create `LedgerServiceConflictException.java`**

```java
package rail.ledger.paymentgateway.client;

/**
 * ledger-service reported HTTP 409: a request with this idempotency key is
 * genuinely still being processed by another concurrent request. Distinct
 * from {@link LedgerServiceException} (a definitive business rejection) and
 * {@link LedgerServiceUnavailableException} (connectivity) because, like
 * those, it changes what PaymentService does with the outcome — this one
 * must never be cached, the same way a 502 isn't.
 */
public class LedgerServiceConflictException extends RuntimeException {

    public LedgerServiceConflictException(String message) {
        super(message);
    }
}
```

- [ ] **Step 4: Update `LedgerServiceClient.postTransaction`**

```java
} catch (HttpStatusCodeException e) {
    if (e.getStatusCode() == HttpStatusCode.valueOf(422)) {
        throw new LedgerServiceException(e.getResponseBodyAsString());
    }
    if (e.getStatusCode() == HttpStatusCode.valueOf(409)) {
        throw new LedgerServiceConflictException(e.getResponseBodyAsString());
    }
    throw new LedgerServiceUnavailableException(
            "ledger-service returned unexpected status " + e.getStatusCode(), e);
}
```

Update the class Javadoc's status-code list and the `postTransaction` `@throws` list to mention 409 -> `LedgerServiceConflictException`.

- [ ] **Step 5: Update `PaymentService.callLedgerService` and the caching guard**

```java
private PaymentResult callLedgerService(PaymentRequest request) {
    LedgerTransactionRequest transaction = toLedgerTransaction(request);
    try {
        ledgerServiceClient.postTransaction(transaction);
        return new PaymentResult(201, "{\"status\":\"completed\"}");
    } catch (LedgerServiceException businessRejection) {
        return new PaymentResult(422, businessRejection.getMessage());
    } catch (LedgerServiceConflictException conflict) {
        return new PaymentResult(409, conflict.getMessage());
    } catch (LedgerServiceUnavailableException unavailable) {
        return new PaymentResult(502, "ledger-service unavailable: " + unavailable.getMessage());
    }
}
```

```java
PaymentResult result = callLedgerService(request);
if (result.httpStatus() != 502 && result.httpStatus() != 409) {
    // 502: we don't know whether ledger-service processed the request.
    // 409: it's telling us a twin request is still in flight right now —
    // caching that would wedge every future retry of this key behind a
    // stale "still processing" answer. Neither is a definitive outcome.
    idempotencyStore.save(request.idempotencyKey(), result);
}
return result;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/crowdotech/apps/me/explore/ledger-rail/payment-gateway && ./mvnw -q test`
Expected: PASS, including the new test and all previously existing ones.

- [ ] **Step 7: Commit**

```bash
git -C payment-gateway add src/main/java/rail/ledger/paymentgateway/client/LedgerServiceConflictException.java \
  src/main/java/rail/ledger/paymentgateway/client/LedgerServiceClient.java \
  src/main/java/rail/ledger/paymentgateway/service/PaymentService.java \
  src/test/java/rail/ledger/paymentgateway/service/PaymentServiceTest.java
git -C payment-gateway commit -m "Propagate ledger-service 409 as an uncached conflict response"
```

---

## Task 8: e2e — concurrent debits don't overdraft; concurrent idempotency keys behave consistently

**Files:**
- Create: `e2e/tests/concurrency.test.ts`

**Interfaces:**
- Consumes: `seedPayerBalance`, `submitPayment` (`e2e/tests/support/ledger-client.ts`), `POSTGRES_URL` (`e2e/tests/support/env.ts`).

- [ ] **Step 1: Write `concurrency.test.ts`**

```typescript
// Concurrency correctness for SP-1: overdraft prevention and idempotency-key
// races against the real stack (BFF -> Payment Gateway -> Ledger Service ->
// Postgres). Requires ./e2e/scripts/start-all.sh (or ci-local.sh).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client as PgClient } from "pg";

import { POSTGRES_URL } from "./support/env.js";
import { seedPayerBalance, submitPayment } from "./support/ledger-client.js";

const pg = new PgClient({ connectionString: POSTGRES_URL });

beforeAll(async () => {
  await pg.connect();
});

afterAll(async () => {
  await pg.end();
});

async function finalBalance(accountId: string): Promise<number> {
  const result = await pg.query<{ balance: string }>(
    "SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM ledger_entries WHERE account_id = $1",
    [accountId],
  );
  return Number(result.rows[0].balance);
}

describe("concurrent debits never overdraw an account", () => {
  it("lets exactly as many debits succeed as the balance covers", async () => {
    const payer = `payer-${randomUUID()}`;
    const payee = `payee-${randomUUID()}`;
    await seedPayerBalance(pg, payer, 1_000);

    // 5 concurrent debits of 300 each against a balance of 1,000: at most 3
    // can succeed (900 cents moved), never all 5 (which would overdraw to -500).
    const attempts = Array.from({ length: 5 }, () =>
      submitPayment({
        payer_account: payer,
        payee_account: payee,
        amount_cents: 300,
        idempotency_key: randomUUID(),
      }),
    );
    const results = await Promise.all(attempts);

    const succeeded = results.filter((r) => r.status === 201).length;
    expect(succeeded).toBeLessThanOrEqual(3);
    expect(await finalBalance(payer)).toBeGreaterThanOrEqual(-0); // never negative
    expect(await finalBalance(payer)).toBe(1_000 - succeeded * 300);
  });

  it("locks accounts in a consistent order regardless of transfer direction", async () => {
    const accountA = `acct-a-${randomUUID()}`;
    const accountB = `acct-b-${randomUUID()}`;
    await seedPayerBalance(pg, accountA, 1_000);
    await seedPayerBalance(pg, accountB, 1_000);

    // Opposite-direction transfers between the same two accounts, fired at
    // once — must not deadlock or time out.
    const [aToB, bToA] = await Promise.all([
      submitPayment({
        payer_account: accountA,
        payee_account: accountB,
        amount_cents: 100,
        idempotency_key: randomUUID(),
      }),
      submitPayment({
        payer_account: accountB,
        payee_account: accountA,
        amount_cents: 100,
        idempotency_key: randomUUID(),
      }),
    ]);

    expect(aToB.status).toBe(201);
    expect(bToA.status).toBe(201);
    expect(await finalBalance(accountA)).toBe(1_000);
    expect(await finalBalance(accountB)).toBe(1_000);
  });
});

describe("concurrent requests with the same idempotency key", () => {
  it("settles to one consistent outcome, replayed identically afterwards", async () => {
    const payer = `payer-${randomUUID()}`;
    const payee = `payee-${randomUUID()}`;
    await seedPayerBalance(pg, payer, 1_000);
    const key = randomUUID();
    const body = { payer_account: payer, payee_account: payee, amount_cents: 100, idempotency_key: key };

    const [first, second] = await Promise.all([submitPayment(body), submitPayment(body)]);

    // Exactly one definitive 201 must appear; the other is either the same
    // 201 (if it lost the DB-level race after the first committed) or a 409
    // (if it was still genuinely in flight) — never a bare 500 or a second
    // debit applied.
    const statuses = [first.status, second.status].sort();
    expect(statuses[1]).toBe(201);
    expect([201, 409]).toContain(statuses[0]);
    expect(await finalBalance(payer)).toBe(900);

    // A third request after both have settled must replay the 201.
    const third = await submitPayment(body);
    expect(third.status).toBe(201);
    expect(await finalBalance(payer)).toBe(900);
  });
});
```

- [ ] **Step 2: Run the new test against the real stack**

Run: `cd /Users/crowdotech/apps/me/explore/ledger-rail/e2e && ./scripts/start-all.sh && npx vitest run tests/concurrency.test.ts; ./scripts/stop-all.sh`
Expected: PASS. If the idempotency race test is flaky because both requests always land sequentially in practice (never producing a 409), that's acceptable — the assertion already allows `[201, 409]` for the loser; don't force a 409 to occur.

- [ ] **Step 3: Run the full e2e suite once more**

Run: `cd /Users/crowdotech/apps/me/explore/ledger-rail/e2e && ./scripts/ci-local.sh`
Expected: everything passes, including the new file.

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/concurrency.test.ts
git commit -m "Add e2e coverage for concurrent debits and idempotency-key races"
```

---

## Task 9: e2e — outbox delivers events even if Redpanda is down at commit time

**Files:**
- Create: `e2e/tests/support/docker.ts`
- Create: `e2e/tests/outbox-resilience.test.ts`

**Interfaces:**
- Consumes: `seedPayerBalance`, `submitPayment` (`ledger-client.ts`); `POSTGRES_URL`, `KAFKA_BROKERS`, `KAFKA_TOPIC` (`env.ts`).
- Produces: `stopService(name: string): Promise<void>`, `startService(name: string): Promise<void>` (`docker.ts`), used only by this test file.

- [ ] **Step 1: Write `support/docker.ts`**

```typescript
// Minimal docker-compose control for tests that need to simulate a
// dependency being down (e.g. Redpanda during an outbox-relay test).
import { exec } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(exec);

export async function stopService(name: string): Promise<void> {
  await run(`docker compose stop ${name}`, { cwd: new URL("../../..", import.meta.url).pathname });
}

export async function startService(name: string): Promise<void> {
  await run(`docker compose start ${name}`, { cwd: new URL("../../..", import.meta.url).pathname });
}
```

- [ ] **Step 2: Write `outbox-resilience.test.ts`**

```typescript
// Outbox resilience: a transaction committed while Redpanda is down must
// still have its event delivered once Redpanda comes back — the write
// itself must never fail because the broker is unreachable.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client as PgClient } from "pg";
import { Kafka } from "kafkajs";

import { KAFKA_BROKERS, KAFKA_TOPIC, POSTGRES_URL } from "./support/env.js";
import { seedPayerBalance, submitPayment } from "./support/ledger-client.js";
import { startService, stopService } from "./support/docker.js";

const pg = new PgClient({ connectionString: POSTGRES_URL });
const kafka = new Kafka({ clientId: "e2e-outbox-resilience", brokers: KAFKA_BROKERS, logLevel: 1 });

beforeAll(async () => {
  await pg.connect();
});

afterAll(async () => {
  await pg.end();
});

async function waitForEvent(idempotencyKey: string, timeoutMs = 20_000): Promise<unknown> {
  const consumer = kafka.consumer({ groupId: `e2e-outbox-resilience-${idempotencyKey}` });
  await consumer.connect();
  await consumer.subscribe({ topic: KAFKA_TOPIC, fromBeginning: true });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no event for ${idempotencyKey} within ${timeoutMs}ms`)), timeoutMs);
      consumer
        .run({
          eachMessage: async ({ message }) => {
            if (message.key?.toString() !== idempotencyKey) return;
            clearTimeout(timer);
            resolve(JSON.parse(message.value?.toString() ?? "null"));
          },
        })
        .catch(reject);
    });
  } finally {
    await consumer.disconnect();
  }
}

describe("transactional outbox survives Redpanda being down at commit time", () => {
  it("still accepts and later delivers the event once Redpanda is back", async () => {
    const payer = `payer-${randomUUID()}`;
    const payee = `payee-${randomUUID()}`;
    await seedPayerBalance(pg, payer, 1_000);
    const key = randomUUID();

    await stopService("redpanda");
    try {
      const result = await submitPayment({
        payer_account: payer,
        payee_account: payee,
        amount_cents: 250,
        idempotency_key: key,
      });
      expect(result.status).toBe(201); // the write succeeds regardless of Redpanda
    } finally {
      await startService("redpanda");
    }

    const event = await waitForEvent(key);
    expect(event).toMatchObject({ idempotency_key: key });
  }, 30_000);
});
```

- [ ] **Step 3: Run the new test against the real stack**

Run: `cd /Users/crowdotech/apps/me/explore/ledger-rail/e2e && ./scripts/start-all.sh && npx vitest run tests/outbox-resilience.test.ts; ./scripts/stop-all.sh`
Expected: PASS — the `201` comes back while Redpanda is stopped, and the event shows up on the topic once it restarts and the relay's next poll fires.

- [ ] **Step 4: Run the full e2e suite one final time**

Run: `cd /Users/crowdotech/apps/me/explore/ledger-rail/e2e && ./scripts/ci-local.sh`
Expected: everything passes — this is the SP-1 "selesai bila" bar from `docs/ROADMAP.md`.

- [ ] **Step 5: Commit**

```bash
git add e2e/tests/support/docker.ts e2e/tests/outbox-resilience.test.ts
git commit -m "Add e2e coverage for outbox delivery surviving a Redpanda outage"
```

---

## Final step: bump submodule pointers in the parent repo

Per the project's established submodule workflow (push each submodule before the parent, per `HANDOFF.md`'s gotcha list):

- [ ] Push `ledger-service` and `payment-gateway` to their remotes.
- [ ] In the `ledger-rail` parent repo, `git add ledger-service payment-gateway e2e docs` and commit the bumped gitlinks plus the new e2e tests and spec/plan docs together.

