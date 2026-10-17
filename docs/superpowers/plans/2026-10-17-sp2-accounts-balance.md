# SP-2 — Akun & Saldo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `account_id` from a free-form string into a real entity (`customers` + `accounts`), add one system account for top-up, and expose balance/mutation reads — all through `bff`, replacing SQL-seeded e2e balances with a real API flow.

**Architecture:** A new `internal/account` domain package in `ledger-service` (mirrors the existing `internal/ledger` package: a `Service` wrapping a `Repository` interface, returning `(status, body, err)` ready for `httpapi` to write out). A new `account_store.go` implements that `Repository` against Postgres, including its own generic idempotency-claim table (`idempotency_claims`) — deliberately *not* reusing `ledger_transactions`'s claim code, to avoid touching SP-1's already-debugged concurrency path (per the design doc's explicit builder note). `postgres.go`'s `ApplyLocked` gets two new checks (skip overdraft for `kind='system'`, reject `status='closed'`). `bff` gets a new `LedgerServiceClient` calling `ledger-service` directly (bypassing `payment-gateway`, per design doc), plus a `topup` alias on the existing payments route. e2e helpers replace SQL seeding with real API calls.

**Tech Stack:** Go (`ledger-service`, standard library `net/http`, `database/sql` + `pgx`), TypeScript/Fastify/vitest (`bff`), Playwright/vitest + `pg` client (`e2e`).

**Spec:** [`docs/superpowers/specs/2026-10-17-sp2-accounts-balance-design.md`](../specs/2026-10-17-sp2-accounts-balance-design.md)

## Global Constraints

- Satu mata uang implisit — tidak ada kolom `currency` di mana pun.
- Tidak ada auth/otorisasi pada endpoint baru — konsisten dengan sisa proyek saat ini.
- Top-up dan transfer **wajib** lewat `POST /transactions` (via `payment-gateway`) yang sudah ada — tidak ada jalur uang baru.
- Hanya satu akun sistem (`system:cash`), di-seed lewat migrasi SQL — tidak ada endpoint untuk membuat akun sistem lain.
- Pagination mutasi: offset-based (`page`, `limit`), bukan cursor.
- ID akun customer: UUID server-generated (TEXT). ID `system:cash` tetap literal itu.
- Idempotency key wajib untuk `POST /customers`, `POST /accounts`, `POST /accounts/{id}/close`; tidak dipakai untuk `GET`.
- `fraud-check` dan `payment-gateway` tidak berubah untuk top-up — top-up adalah transfer biasa dari `system:cash`.

## Review Focus

- Transaksi mereferensikan `account_id` yang belum pernah dibuka lewat `POST /accounts` — harus ditolak dengan error bersih (FK violation tidak boleh bocor sebagai 500 mentah).
- Akun `status='closed'` dipakai sebagai payer **atau** payee — keduanya harus ditolak 422, bukan hanya satu sisi.
- Akun sistem (`system:cash`) net negatif berulang kali — harus tetap sukses (overdraft check di-skip), tidak pernah 422.
- `GET /accounts/{id}` atau `GET /accounts/{id}/transactions` untuk `id` yang tidak ada — harus 404, bukan 200 kosong atau crash.
- Retry `POST /accounts` dengan idempotency key yang sama setelah akun sudah dibuat — harus replay response 201 asli, bukan percobaan insert duplikat atau error.

---

## Task 1: Schema migration — customers, accounts, idempotency_claims

**Files:**
- Modify: `ledger-service/internal/postgres/schema.sql`

**Interfaces:**
- Produces: tabel `customers(id, name, created_at)`, `accounts(id, customer_id, kind, status, created_at)`, `idempotency_claims(key, status, claimed_at, response_status, response_body)`; constraint `fk_ledger_entries_account` pada `ledger_entries.account_id`; baris seed `accounts` untuk `system:cash`.

- [ ] **Step 1: Tambah DDL di `schema.sql`**

Tambahkan (idempoten, `CREATE TABLE IF NOT EXISTS` / `ADD CONSTRAINT IF NOT EXISTS` di PG ≥ 12, atau bungkus dengan `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` untuk constraint kalau versi PG proyek ini tidak dukung `IF NOT EXISTS` pada `ADD CONSTRAINT` — cek `docker-compose.yml` untuk versi image Postgres yang dipakai sebelum memilih sintaks):

```sql
CREATE TABLE IF NOT EXISTS customers (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
    id          TEXT PRIMARY KEY,
    customer_id UUID REFERENCES customers(id),
    kind        TEXT NOT NULL CHECK (kind IN ('customer', 'system')),
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO accounts (id, customer_id, kind, status)
    VALUES ('system:cash', NULL, 'system', 'active')
    ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS idempotency_claims (
    key             TEXT PRIMARY KEY,
    status          TEXT NOT NULL DEFAULT 'processing',
    claimed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    response_status INT,
    response_body   TEXT
);
```

FK pada `ledger_entries` ditambahkan **setelah** tabel `accounts` ada dan seed `system:cash` jalan (urutan di file: tabel+seed dulu, FK sesudah). Karena belum ada environment dengan data lama (lihat design doc §Constraints — belum ada staging/prod), tidak perlu backfill:

```sql
ALTER TABLE ledger_entries
    ADD CONSTRAINT fk_ledger_entries_account FOREIGN KEY (account_id) REFERENCES accounts(id);
```

- [ ] **Step 2: Terapkan migrasi dua kali ke DB lokal untuk memverifikasi idempoten**

Run: `psql "$DATABASE_URL" -f ledger-service/internal/postgres/schema.sql` (dua kali berturut-turut)
Expected: kedua run sukses tanpa error (run kedua no-op untuk semua `CREATE`/`INSERT ... ON CONFLICT`).

- [ ] **Step 3: Verifikasi manual isi tabel**

Run: `psql "$DATABASE_URL" -c "SELECT id, kind, status FROM accounts;"`
Expected: satu baris `system:cash | system | active`.

- [ ] **Step 4: Commit**

```bash
git add ledger-service/internal/postgres/schema.sql
git commit -m "add accounts, customers, idempotency_claims schema"
```

---

## Task 2: `internal/account` domain package

**Files:**
- Create: `ledger-service/internal/account/account.go`
- Test: `ledger-service/internal/account/account_test.go`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (used by Task 3 and Task 5):
  ```go
  type Kind string
  const (
      KindCustomer Kind = "customer"
      KindSystem   Kind = "system"
  )
  type Status string
  const (
      StatusActive Status = "active"
      StatusClosed Status = "closed"
  )
  type Customer struct { ID, Name string; CreatedAt time.Time }
  type Account struct {
      ID, CustomerID string
      Kind           Kind
      Status         Status
      CreatedAt      time.Time
      BalanceCents   int64
  }
  type Entry struct { AccountID string; AmountCents int64; CreatedAt time.Time }

  var ErrCustomerNotFound = errors.New("customer not found")
  var ErrAccountNotFound  = errors.New("account not found")

  type ClaimState int
  const (
      ClaimAcquired ClaimState = iota
      ClaimCompleted
      ClaimProcessing
  )
  type Claim struct {
      State          ClaimState
      ResponseStatus int
      ResponseBody   []byte
  }

  type Repository interface {
      ClaimKey(ctx context.Context, key string) (Claim, error)
      CompleteClaim(ctx context.Context, key string, status int, body []byte) error
      CreateCustomer(ctx context.Context, name string) (Customer, error)
      CreateAccount(ctx context.Context, customerID string) (Account, error) // ErrCustomerNotFound
      CloseAccount(ctx context.Context, accountID string) error             // ErrAccountNotFound
      GetAccount(ctx context.Context, accountID string) (Account, error)    // ErrAccountNotFound, BalanceCents filled
      ListEntries(ctx context.Context, accountID string, offset, limit int) (entries []Entry, total int, err error) // ErrAccountNotFound
  }

  type Service struct{ /* unexported repo field */ }
  func NewService(repo Repository) *Service
  func (s *Service) CreateCustomer(ctx context.Context, name, idempotencyKey string) (status int, body []byte, err error)
  func (s *Service) CreateAccount(ctx context.Context, customerID, idempotencyKey string) (status int, body []byte, err error)
  func (s *Service) CloseAccount(ctx context.Context, accountID, idempotencyKey string) (status int, body []byte, err error)
  func (s *Service) GetAccount(ctx context.Context, accountID string) (status int, body []byte, err error)
  func (s *Service) ListTransactions(ctx context.Context, accountID string, page, limit int) (status int, body []byte, err error)
  ```

Response JSON shapes (exact, used by the `body []byte` these methods return):
- `CreateCustomer` 201: `{"id":"...","name":"...","created_at":"..."}`
- `CreateAccount` 201: `{"id":"...","customer_id":"...","kind":"customer","status":"active","created_at":"..."}`; 404 if customer missing: `{"error":"customer not found"}`
- `CloseAccount` 200: `{"id":"...","status":"closed"}`; 404: `{"error":"account not found"}`
- `GetAccount` 200: `{"id":"...","customer_id":"...","kind":"...","status":"...","balance_cents":N}`; 404: `{"error":"account not found"}`
- `ListTransactions` 200: `{"entries":[{"account_id":"...","amount_cents":N,"created_at":"..."}],"page":N,"limit":N,"total":N}`; 404: `{"error":"account not found"}`

Idempotency orchestration in each create/close method mirrors `ledger.Service.Post`: call `ClaimKey`; on `ClaimCompleted` replay stored response; on `ClaimProcessing` return a sentinel `ErrConflict` (define it alongside the other errors) for `httpapi` to map to 409; on `ClaimAcquired` do the work, build the body, call `CompleteClaim`, return it. `GetAccount`/`ListTransactions` take no idempotency key and skip this orchestration entirely — they call the repository directly and map `ErrAccountNotFound` to 404.

- [ ] **Step 1: Write failing tests in `account_test.go`** using a `fakeRepo` (same shape as `ledger/ledger_test.go`'s `fakeRepo`: in-memory maps for customers, accounts, claims, entries). Cover:
  - `TestCreateCustomer_Success` — returns 201 with the name echoed back.
  - `TestCreateCustomer_IdempotentRetryReplays` — second call with same key returns identical `(status, body)`, fake records only one customer.
  - `TestCreateAccount_CustomerNotFound` — fake's `CreateAccount` returns `ErrCustomerNotFound`; service returns 404 with `{"error":"customer not found"}`.
  - `TestCreateAccount_Success` — 201, `kind: "customer"`, `status: "active"`.
  - `TestCloseAccount_NotFound` — 404.
  - `TestCloseAccount_Success` — 200, `status: "closed"`.
  - `TestGetAccount_NotFound` — 404.
  - `TestGetAccount_Success` — 200 with `balance_cents` from the fake.
  - `TestListTransactions_Success` — 200, body's `page`/`limit`/`total` match what the fake returned.
  - `TestListTransactions_NotFound` — 404.
  - `TestCreateAccount_ConflictWhenKeyStillProcessing` — fake's `ClaimKey` reports `ClaimProcessing`; service returns `ErrConflict`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/account/... -v`
Expected: FAIL — package/types don't exist yet.

- [ ] **Step 3: Implement `account.go`** per the Interfaces block above. The `ErrConflict` sentinel and the claim-orchestration shape should read like `ledger.Service.Post` (same file you already have open at `internal/ledger/ledger.go` is the reference).

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/account/... -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ledger-service/internal/account
git commit -m "add account domain package: customers, accounts, idempotent create/close"
```

---

## Task 3: Postgres implementation of `account.Repository`

**Files:**
- Create: `ledger-service/internal/postgres/account_store.go`
- Modify: `ledger-service/internal/postgres/postgres.go:19-20` (add `var _ account.Repository = (*Store)(nil)`)

**Interfaces:**
- Consumes: `account.Repository`, `account.Account`, `account.Customer`, `account.Entry`, `account.Claim`, `account.ErrCustomerNotFound`, `account.ErrAccountNotFound` (Task 2).
- Produces: `Store` (already defined in `postgres.go`) now also satisfies `account.Repository`.

No new `_test.go` here — this package has no existing Postgres-integration test file (`ApplyLocked` itself isn't unit-tested either; see `HANDOFF.md`'s "Temuan yang sengaja di-defer"). Real behavior is proven by the e2e suite in Task 10.

- [ ] **Step 1: Implement `ClaimKey` / `CompleteClaim` against `idempotency_claims`**

Same two-phase claim shape as `Store.ClaimIdempotencyKey`/`inspectExistingClaim` in `postgres.go` (insert `status='processing'`; on unique violation, inspect the existing row: `completed` → replay, `processing` within `processingTimeout` (reuse the existing 30s constant) → `ClaimProcessing`, else reclaim via `UPDATE ... WHERE status='processing' AND claimed_at < now() - interval '30 seconds'`), but against `idempotency_claims` instead of `ledger_transactions`. Write this fresh rather than factoring out a shared helper — the existing claim code in `postgres.go` is SP-1's already-debugged concurrency path; the design doc's builder note explicitly accepts this duplication to avoid touching it.

- [ ] **Step 2: Implement `CreateCustomer(ctx, name) (account.Customer, error)`**

`INSERT INTO customers (name) VALUES ($1) RETURNING id, name, created_at`.

- [ ] **Step 3: Implement `CreateAccount(ctx, customerID) (account.Account, error)`**

`INSERT INTO accounts (id, customer_id, kind) VALUES (gen_random_uuid()::text, $1, 'customer') RETURNING id, customer_id, kind, status, created_at`. On FK violation (`pgconn.PgError.Code == "23503"` — use the existing `isUniqueViolation`-style helper in this file as a model, add an `isForeignKeyViolation` helper), return `account.ErrCustomerNotFound`.

- [ ] **Step 4: Implement `CloseAccount(ctx, accountID) error`**

`UPDATE accounts SET status = 'closed' WHERE id = $1 RETURNING id`. Zero rows affected → `account.ErrAccountNotFound`.

- [ ] **Step 5: Implement `GetAccount(ctx, accountID) (account.Account, error)`**

Join `accounts` with a `SUM(ledger_entries.amount_cents)` subquery (or `LEFT JOIN LATERAL`) to fill `BalanceCents`. Zero rows → `account.ErrAccountNotFound`.

- [ ] **Step 6: Implement `ListEntries(ctx, accountID, offset, limit) ([]account.Entry, int, error)`**

First confirm the account exists (`SELECT 1 FROM accounts WHERE id = $1`) — zero rows → `account.ErrAccountNotFound`. Then `SELECT account_id, amount_cents, created_at FROM ledger_entries WHERE account_id = $1 ORDER BY created_at OFFSET $2 LIMIT $3`, plus a separate `SELECT COUNT(*) FROM ledger_entries WHERE account_id = $1` for `total`.

- [ ] **Step 7: Build**

Run: `go build ./...`
Expected: succeeds, `var _ account.Repository = (*Store)(nil)` compiles (confirms the interface is fully satisfied).

- [ ] **Step 8: Commit**

```bash
git add ledger-service/internal/postgres/account_store.go ledger-service/internal/postgres/postgres.go
git commit -m "implement account.Repository against Postgres"
```

---

## Task 4: `ApplyLocked` — skip overdraft for system accounts, reject closed accounts

**Files:**
- Modify: `ledger-service/internal/postgres/postgres.go` (the account-locking loop currently at lines ~180-221)

**Interfaces:**
- Consumes: `accounts` table (Task 1).
- Produces: unchanged `ApplyLocked` signature; new rejection body shape `{"error":"account closed: <id>"}`.

No new test file (consistent with the existing gap noted in `HANDOFF.md` — `ApplyLocked` has no dedicated Postgres test today). Proven by e2e in Task 10. Run the existing suite to catch any regression this change causes to SP-1 behavior.

- [ ] **Step 1: Add a kind/status lookup inside the existing `dbTx`**

After computing `net` (the per-account sum of entries, already in the code) and before the advisory-lock loop, fetch `SELECT id, kind, status FROM accounts WHERE id = ANY($1)` for the `accounts` slice already being built, into a `map[string]struct{ kind, status string }`.

- [ ] **Step 2: Reject any account with `status = 'closed'`**

Before the overdraft loop, iterate `accounts`; if any involved account's status is `'closed'`, build `{"error": "account closed: " + id}`, record it via the same `UPDATE ledger_transactions SET status='completed', response_status=422, response_body=$2 ...` + commit + return pattern already used for `insufficient balance` (lines ~206-219).

- [ ] **Step 3: Skip the overdraft floor check for `kind = 'system'`**

In the existing `for _, id := range accounts { if net[id] >= 0 { continue } ... }` loop, add: `if accountsInfo[id].kind == "system" { continue }` right after the `net[id] >= 0` check.

- [ ] **Step 4: Run the existing suite to confirm no regression**

Run: `go test ./... -race`
Expected: PASS (this exercises `ledger_test.go`'s fake-repo tests, which don't touch `ApplyLocked` directly, but confirms nothing else broke; `go build ./...` must also succeed).

- [ ] **Step 5: Commit**

```bash
git add ledger-service/internal/postgres/postgres.go
git commit -m "ApplyLocked: allow system accounts to go negative, reject closed accounts"
```

---

## Task 5: `httpapi` routes + `main.go` wiring

**Files:**
- Modify: `ledger-service/internal/httpapi/httpapi.go`
- Modify: `ledger-service/cmd/ledger-service/main.go`

**Interfaces:**
- Consumes: `account.Service` (Task 2), its 5 methods and their exact `(status, body, err)` contract.
- Produces: `NewServer(svc *ledger.Service, accountSvc *account.Service) *Server` (signature change — note for whoever wires `Server` elsewhere, only `main.go` does today).

No new test file (matches the existing lack of `httpapi_test.go`; covered by e2e). Build + a manual `curl` smoke pass stand in for a step-level check here.

- [ ] **Step 1: Change `NewServer` signature and register routes**

```go
func NewServer(svc *ledger.Service, accountSvc *account.Service) *Server {
    s := &Server{svc: svc, accountSvc: accountSvc, mux: http.NewServeMux()}
    s.mux.HandleFunc("POST /transactions", s.handlePostTransaction)
    s.mux.HandleFunc("POST /customers", s.handlePostCustomer)
    s.mux.HandleFunc("POST /accounts", s.handlePostAccount)
    s.mux.HandleFunc("GET /accounts/{id}", s.handleGetAccount)
    s.mux.HandleFunc("GET /accounts/{id}/transactions", s.handleGetAccountTransactions)
    s.mux.HandleFunc("POST /accounts/{id}/close", s.handlePostAccountClose)
    s.mux.HandleFunc("GET /healthz", s.handleHealthz)
    return s
}
```

- [ ] **Step 2: Implement `handlePostCustomer`**

Decode `{"name": string, "idempotency_key": string}`; 400 via `writeJSONError` if `name` empty or `idempotency_key` empty; else call `accountSvc.CreateCustomer(r.Context(), req.Name, req.IdempotencyKey)` and write `(status, body)` straight through (same pattern as `handlePostTransaction`'s tail).

- [ ] **Step 3: Implement `handlePostAccount`**

Decode `{"customer_id": string, "idempotency_key": string}`; same 400 validation; call `accountSvc.CreateAccount`.

- [ ] **Step 4: Implement `handleGetAccount`**

Read `{id}` via `r.PathValue("id")`; call `accountSvc.GetAccount(r.Context(), id)`; write through.

- [ ] **Step 5: Implement `handleGetAccountTransactions`**

Parse `?page=&limit=` query params: default `page=1`, `limit=20`; non-integer or `<1` values → 400 `writeJSONError`; cap `limit` at 100 (clamp, don't error, if higher is given). Call `accountSvc.ListTransactions(r.Context(), id, page, limit)`.

- [ ] **Step 6: Implement `handlePostAccountClose`**

Decode `{"idempotency_key": string}`; call `accountSvc.CloseAccount(r.Context(), id, req.IdempotencyKey)`.

- [ ] **Step 7: Wire `main.go`**

```go
accountSvc := account.NewService(store)
server := httpapi.NewServer(svc, accountSvc)
```

- [ ] **Step 8: Build and smoke-test manually**

Run: `go build ./... && go vet ./...`
Then (with the stack up via `docker compose up -d postgres redis redpanda` + `go run ./cmd/ledger-service`): `curl -X POST localhost:8080/customers -d '{"name":"Alice","idempotency_key":"k1"}'`
Expected: `201` with a JSON body containing a UUID `id`.

- [ ] **Step 9: Commit**

```bash
git add ledger-service/internal/httpapi/httpapi.go ledger-service/cmd/ledger-service/main.go
git commit -m "expose customers/accounts endpoints over HTTP"
```

---

## Task 6: `bff` — `LedgerServiceClient`

**Files:**
- Create: `bff/src/services/ledger-service-client.ts`
- Test: `bff/src/services/ledger-service-client.test.ts`

**Interfaces:**
- Consumes: `GatewayResult` type, imported from `./payment-gateway-client.js` (reuse, don't redefine).
- Produces (used by Task 7):
  ```ts
  export interface LedgerServiceClientOptions { baseUrl: string; fetchImpl?: typeof fetch }
  export class LedgerServiceClient {
    constructor(options: LedgerServiceClientOptions)
    async createCustomer(name: string, idempotencyKey: string): Promise<GatewayResult>
    async createAccount(customerId: string, idempotencyKey: string): Promise<GatewayResult>
    async getAccount(accountId: string): Promise<GatewayResult>
    async listAccountTransactions(accountId: string, page: number, limit: number): Promise<GatewayResult>
    async closeAccount(accountId: string, idempotencyKey: string): Promise<GatewayResult>
  }
  ```
  Each method mirrors `PaymentGatewayClient.submitPayment`'s error handling: a network failure (`fetchImpl` throws) becomes `{status: 502, body: {error: "ledger_service_unreachable", message: ...}}` rather than throwing.

- [ ] **Step 1: Write failing tests in `ledger-service-client.test.ts`** (mirror `payment-gateway-client.test.ts`'s structure):
  - `createCustomer` POSTs to `{baseUrl}/customers` with `{name, idempotency_key}`, relays status/body.
  - `createAccount` POSTs to `{baseUrl}/accounts` with `{customer_id, idempotency_key}`.
  - `getAccount` GETs `{baseUrl}/accounts/{id}`.
  - `listAccountTransactions` GETs `{baseUrl}/accounts/{id}/transactions?page=N&limit=M`.
  - `closeAccount` POSTs to `{baseUrl}/accounts/{id}/close` with `{idempotency_key}`.
  - One test per method asserting a thrown fetch becomes `{status: 502, body: {error: "ledger_service_unreachable"}}`.

- [ ] **Step 2: Run to verify failure**

Run: `cd bff && npx vitest run src/services/ledger-service-client.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `ledger-service-client.ts`** per the Interfaces block.

- [ ] **Step 4: Run to verify pass**

Run: `cd bff && npx vitest run src/services/ledger-service-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bff/src/services/ledger-service-client.ts bff/src/services/ledger-service-client.test.ts
git commit -m "add LedgerServiceClient for direct bff -> ledger-service account calls"
```

---

## Task 7: `bff` — accounts route + wiring

**Files:**
- Create: `bff/src/routes/accounts.ts`
- Modify: `bff/src/config.ts`, `bff/src/app.ts`, `bff/src/index.ts`
- Modify: `docker-compose.yml` (bff service: add `LEDGER_SERVICE_URL`, `depends_on.ledger-service`)

**Interfaces:**
- Consumes: `LedgerServiceClient` (Task 6).
- Produces: `registerAccountsRoute(app: FastifyInstance, ledgerClient: LedgerServiceClient): void`, routes `POST /api/customers`, `POST /api/accounts`, `GET /api/accounts/:id`, `GET /api/accounts/:id/transactions`, `POST /api/accounts/:id/close`.

No dedicated route-level test file — `payments.ts` itself has none either (coverage for the route layer in this codebase is e2e). Verified by e2e in Task 10.

- [ ] **Step 1: Add `ledgerServiceUrl` to `config.ts`**

```ts
export interface Config {
  port: number;
  paymentGatewayUrl: string;
  ledgerServiceUrl: string;
}
```
`env.LEDGER_SERVICE_URL ?? "http://localhost:8080"`.

- [ ] **Step 2: Implement `accounts.ts`**

Each handler: decode body/params, generate an idempotency key with `randomUUID()` when the client didn't supply one (same pattern as `buildGatewayRequest`), call the matching `LedgerServiceClient` method, `reply.code(result.status)` and return `result.body`. Fastify schemas: `name`/`customer_id` required strings; `page`/`limit` optional integers on the transactions route.

- [ ] **Step 3: Wire `app.ts`**

```ts
export interface BuildAppOptions {
  paymentGatewayUrl: string;
  ledgerServiceUrl: string;
  fetchImpl?: typeof fetch;
}
```
Construct a `LedgerServiceClient` alongside the existing `PaymentGatewayClient`; call `registerAccountsRoute(app, ledgerClient)`.

- [ ] **Step 4: Wire `index.ts`**

Pass `config.ledgerServiceUrl` into `buildApp`.

- [ ] **Step 5: Wire `docker-compose.yml`**

Under the `bff` service: add `LEDGER_SERVICE_URL: http://ledger-service:8080` to `environment`, and `ledger-service: { condition: service_healthy }` to `depends_on`.

- [ ] **Step 6: Build and run existing bff tests**

Run: `cd bff && npm run build && npx vitest run`
Expected: PASS (existing payment-gateway-client tests unaffected).

- [ ] **Step 7: Commit**

```bash
git add bff/src/routes/accounts.ts bff/src/config.ts bff/src/app.ts bff/src/index.ts docker-compose.yml
git commit -m "expose account/customer endpoints through bff"
```

---

## Task 8: `bff` — `topup` alias on the payments route

**Files:**
- Modify: `bff/src/services/payment-gateway-client.ts` (or add logic directly in `routes/payments.ts` — see Step 1)
- Modify: `bff/src/services/payment-gateway-client.test.ts` (or `payments.ts`'s own test if one exists — there isn't one today, so add the test next to `buildGatewayRequest`'s existing tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildGatewayRequest` translates `payer_account: "topup"` → `"system:cash"` before building the gateway request; leaves every other `payer_account` value untouched.

- [ ] **Step 1: Write a failing test**

```ts
it("translates the 'topup' alias to the system cash account", () => {
  const gatewayRequest = buildGatewayRequest({
    payer_account: "topup",
    payee_account: "acc-2",
    amount_cents: 500,
  });
  expect(gatewayRequest.payer_account).toBe("system:cash");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd bff && npx vitest run src/services/payment-gateway-client.test.ts`
Expected: FAIL — `payer_account` is still `"topup"`.

- [ ] **Step 3: Implement the alias in `buildGatewayRequest`**

```ts
const SYSTEM_CASH_ALIAS = "topup";
// ...
payer_account: clientRequest.payer_account === SYSTEM_CASH_ALIAS ? "system:cash" : clientRequest.payer_account,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd bff && npx vitest run src/services/payment-gateway-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bff/src/services/payment-gateway-client.ts bff/src/services/payment-gateway-client.test.ts
git commit -m "add 'topup' payer_account alias for system:cash"
```

---

## Task 9: e2e helpers — replace SQL seeding

**Files:**
- Modify: `e2e/tests/support/ledger-client.ts`

**Interfaces:**
- Produces (used by Task 10):
  ```ts
  export async function createCustomer(name: string): Promise<string> // returns id
  export async function createAccount(customerId: string): Promise<string> // returns id
  export async function openAccount(name: string): Promise<string> // createCustomer + createAccount, convenience for tests that don't care about the customer id
  export async function topUp(accountId: string, amountCents: number): Promise<{ status: number; body: unknown }>
  export async function closeAccount(accountId: string): Promise<{ status: number; body: unknown }>
  export async function getAccountBalance(accountId: string): Promise<number> // throws if the GET isn't 200
  export async function getAccountTransactions(accountId: string, page?: number, limit?: number): Promise<unknown>
  ```
  `seedPayerBalance` is removed.

- [ ] **Step 1: Remove `seedPayerBalance`** and its now-unneeded `PgClient` import if nothing else in the file uses it (check `entriesFor`, which still needs `pg` — keep the import if so).

- [ ] **Step 2: Implement the new helpers**, each a thin `fetch` wrapper against `BFF_URL` (same style as the existing `submitPayment`):
  - `createCustomer`: `POST {BFF_URL}/api/customers` with `{name, idempotency_key: randomUUID()}`; return `body.id`.
  - `createAccount`: `POST {BFF_URL}/api/accounts` with `{customer_id, idempotency_key: randomUUID()}`; return `body.id`.
  - `openAccount`: calls both above.
  - `topUp`: calls `submitPayment` with `payer_account: "topup"`, `payee_account: accountId`, a fresh `idempotency_key`.
  - `closeAccount`: `POST {BFF_URL}/api/accounts/{accountId}/close` with `{idempotency_key: randomUUID()}`.
  - `getAccountBalance`: `GET {BFF_URL}/api/accounts/{accountId}`; throw with the response body if status isn't 200; return `body.balance_cents`.
  - `getAccountTransactions`: `GET {BFF_URL}/api/accounts/{accountId}/transactions?page=...&limit=...`; return the parsed body.

- [ ] **Step 3: Build/typecheck**

Run: `cd e2e && npx tsc --noEmit` (or the project's existing lint/typecheck command — check `e2e/package.json` scripts)
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/support/ledger-client.ts
git commit -m "replace SQL balance seeding with real account/top-up API helpers"
```

---

## Task 10: Migrate e2e tests off SQL seeding, full suite green

**Files:**
- Modify: `e2e/tests/sync-path.test.ts`
- Modify: `e2e/tests/async-path.test.ts`
- Modify: `e2e/tests/concurrency.test.ts`
- Modify: `e2e/tests/outbox-resilience.test.ts`
- Modify: `e2e/tests/reconciliation.test.ts`

**Interfaces:**
- Consumes: the Task 9 helpers (`openAccount`, `topUp`, `closeAccount`, `getAccountBalance`, `getAccountTransactions`).

Each of these five files currently calls `seedPayerBalance(pg, accountId, amountCents)` with a hardcoded `accountId` string (e.g. `"payer-1"`). This task is mechanical but must be done per-file since account IDs are now real UUIDs returned at runtime, not literals:

- [ ] **Step 1: Read each file's current use of `seedPayerBalance` and the hardcoded account id strings it seeds**

For each of the five files, find every `seedPayerBalance(pg, "<id>", N)` call and every other place that same `"<id>"` literal is reused (assertions, `entriesFor` calls, payee ids that might also need a real account now).

- [ ] **Step 2: Replace seeding with `openAccount` + `topUp` per file**

Pattern: where a test currently does
```ts
await seedPayerBalance(pg, "payer-1", 10_000);
```
replace with
```ts
const payerId = await openAccount("Payer");
await topUp(payerId, 10_000);
```
and replace every later use of the literal `"payer-1"` in that test with `payerId`. If a payee account is also referenced only as a literal string (never funded), it also needs `await openAccount(...)` first — the FK from Task 1 means every `account_id` a transaction touches must exist in `accounts`.

- [ ] **Step 3: Add at least one assertion per file's balance checks using the new read endpoints**

Where a test currently inspects balance via `entriesFor` + manual summing, it may keep doing that (it still works — `ledger_entries` is unchanged), but at least one test overall (pick the simplest, likely in `sync-path.test.ts`) should additionally assert via `getAccountBalance(payerId)` that the API-reported balance matches, proving the new endpoint end-to-end.

- [ ] **Step 4: Add the Review Focus regression cases as new test cases** (in whichever file is the natural home — likely a new `accounts.test.ts` is cleaner than overloading the five existing files; if so, create `e2e/tests/accounts.test.ts` and add it here):
  - Transaction referencing a never-created `account_id` → expect a 4xx from `/api/payments`, not a 500.
  - Transfer where the payee account is `closed` → expect 422.
  - Repeated top-ups past what would be "negative" for a normal account succeed against `system:cash` (e.g. three top-ups that net `system:cash` to -30,000, all 201).
  - `GET /api/accounts/{id}` for a random UUID that was never created → 404.
  - Two concurrent `POST /api/accounts` calls with the same idempotency key → both return the same 201 body, only one row in `accounts`.

- [ ] **Step 5: Run the full local e2e suite**

Run: `./e2e/ci-local.sh` (per `e2e/README.md`'s documented entry point — check the Mac-specific gotchas in `HANDOFF.md` first: stop Homebrew `postgresql@14`/`redis` if they're bound to the same ports)
Expected: all suites pass, including the five migrated files and the new `accounts.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add e2e/tests/
git commit -m "migrate e2e suite off SQL balance seeding, cover account lifecycle"
```

---

## Self-Review Notes

- **Spec coverage:** every §Decisions item in the design doc has a task — model (Task 1), system account (Task 1), `ApplyLocked` behavior (Task 4), top-up alias (Task 8), new endpoints + routing (Tasks 5-7), e2e migration (Tasks 9-10). The five "What's left to the builder" items are resolved explicitly in Task 1 (backfill: not needed, no existing persistent env), Task 3 (claim mechanism: fresh table, not shared code), Task 4/5 (error shapes), Task 5 (validation/status codes), Task 3 (pagination index: `ORDER BY created_at` without a dedicated index is accepted for SP-2's demo data volume — revisit only if `GET .../transactions` is measured slow).
- **Type consistency:** `account.Service`'s five method names and signatures (Task 2) are used identically in Task 5's handlers; `LedgerServiceClient`'s five method names (Task 6) are used identically in Task 7's route; both match the endpoint paths fixed in the design doc.
- **Review Focus coverage:** all five lines have an owning task — four are new cases added in Task 10 Step 4, the "closed account rejected both directions" case should be written as two of those bullets' sub-cases (payer closed, payee closed) when Task 10 is executed.
