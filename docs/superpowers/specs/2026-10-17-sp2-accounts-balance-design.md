# SP-2 — Akun & Saldo (Design)

Status: disetujui lewat brainstorm 2026-10-17. Rujukan: [`docs/ROADMAP.md`](../../ROADMAP.md) §SP-2,
[`HANDOFF.md`](../../../HANDOFF.md).

## Intent & kenapa

API ledger saat ini hanya punya `POST /transactions` (generik, double-entry, tanpa konsep akun
sebagai entitas) dan `GET /healthz`. Tidak ada cara membuka rekening, tidak ada sumber top-up resmi
(e2e seed saldo lewat SQL langsung — `seedPayerBalance` di `e2e/tests/support/ledger-client.ts`),
dan tidak ada cara melihat saldo/mutasi tanpa query SQL manual.

SP-2 menutup gap ini: akun jadi entitas nyata (dibuat lewat API, bukan string bebas), ada satu akun
sistem resmi untuk top-up, dan saldo/mutasi bisa dilihat lewat API. Ini prasyarat untuk SP-4
(status fraud butuh API akun) dan SP-5 (UI demo butuh API akun+saldo).

## Goals

- Entitas `customers` dan `accounts`, menggantikan `account_id` string bebas di `ledger_entries`.
- Satu akun sistem (`system:cash`) sebagai sumber top-up, boleh bersaldo negatif.
- `GET` saldo dan mutasi (dengan pagination) per akun.
- `POST /customers`, `POST /accounts`, `POST /accounts/{id}/close` lewat API (idempotent).
- Top-up dan transfer memakai mekanisme transaksi double-entry yang sudah ada (SP-1), tidak ada
  jalur uang baru.
- e2e tidak lagi seed saldo lewat SQL — alur penuh: buka customer → buka akun → top-up → transfer →
  lihat mutasi, semua lewat `bff`.

## Non-goals (sengaja di luar scope SP-2)

- UI browser — itu SP-5.
- Auth/otorisasi (siapa boleh buka akun siapa, dsb) — belum ada di proyek ini sama sekali; endpoint
  baru di SP-2 sama "terbuka"-nya dengan endpoint yang sudah ada.
- Multi-currency — tidak ada kolom `currency`; satu mata uang implisit, konsisten dengan schema
  `amount_cents` yang sudah ada dan tidak pernah menyebut currency.
- Akun sistem kedua/lebih — hanya `system:cash`. Kalau nanti dibutuhkan (mis. fee-collector di SP-4/
  SP-8), baru dibangun jalur pembuatannya saat itu (lihat §Decisions, opsi akun sistem).
- Rate limiting pada endpoint baru ini — itu SP-3, dan scope-nya di `payment-gateway` (domain
  pembayaran), bukan akun/customer.

## Anti-goals

- Jangan membuat endpoint yang bisa membuat akun bersaldo-negatif sembarangan tanpa kontrol (lihat
  keputusan akun sistem di bawah — ini sebabnya opsi "flag `type` di `POST /accounts` publik"
  ditolak).
- Jangan menduplikasi logic transaksi untuk top-up — top-up HARUS memakai `POST /transactions`
  (lewat `payment-gateway`) yang sama dengan transfer, bukan jalur kode baru.

## Constraints

- Harus kompatibel dengan mekanisme SP-1 yang sudah ada: advisory lock per akun, transactional
  outbox, klaim idempotency dua-fase. SP-2 menambah data/validasi di jalur itu, tidak mengganti
  mekanismenya.
- `ledger_entries.account_id` sudah berisi data (dari SP-1 e2e) — migrasi FK harus aman dijalankan
  di DB yang sudah terisi (lihat §What's left to the builder).

## Keputusan desain (dari brainstorm)

### Model data

Satu tabel `accounts` (bukan tabel terpisah untuk akun sistem vs nasabah):

```sql
CREATE TABLE customers (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
    id          TEXT PRIMARY KEY,           -- "system:cash" perlu ID bisa-dibaca-manusia, bukan UUID murni
    customer_id UUID REFERENCES customers(id),  -- NULL untuk akun sistem
    kind        TEXT NOT NULL CHECK (kind IN ('customer', 'system')),
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ledger_entries
    ADD CONSTRAINT fk_ledger_entries_account FOREIGN KEY (account_id) REFERENCES accounts(id);
```

Alasan satu tabel (bukan `accounts` + `gl_accounts` terpisah seperti pola GL/customer account di
bank sungguhan): SP-2 cuma butuh satu akun GL. Tabel terpisah akan butuh FK "menunjuk ke salah satu
dari dua tabel", yang Postgres tidak dukung native tanpa kolom tambahan + validasi aplikasi — biaya
yang tidak sepadan untuk satu akun. Kalau nanti ada banyak akun GL dengan aturan akses sendiri,
revisit (lebih dekat ke SP-7).

Satu customer boleh punya banyak akun (relasi 1-ke-banyak) — karena itu `POST /customers` dan
`POST /accounts` dua langkah terpisah, bukan digabung satu call.

### Akun sistem (`system:cash`)

Di-seed lewat migrasi SQL (`INSERT ... ON CONFLICT DO NOTHING`), **bukan** lewat endpoint publik.
Ini meniru pola Chart of Accounts di perbankan sungguhan: akun GL/settlement dikonfigurasi sekali
saat setup, bukan dibuat lewat API transaksional oleh klien sembarang. Tidak ada endpoint
`POST /system-accounts` di SP-2 — kalau akun sistem kedua dibutuhkan nyata di sub-proyek
berikutnya (fee-collector, dsb.), endpoint admin terpisah itu baru dibangun saat itu.

Opsi yang ditolak: `POST /accounts` publik dengan flag `type: "system"` — ditolak karena proyek ini
belum punya auth sama sekali, jadi flag itu bisa dipakai siapa saja untuk membuat akun saldo-negatif
tanpa kontrol.

### Perilaku ledger (`ApplyLocked`)

Di `ledger-service/internal/postgres/postgres.go` (fungsi `ApplyLocked`), dua pengecekan baru per
akun yang terlibat (join ke `accounts`):

1. **Overdraft check (sudah ada, baris ~194-221) di-skip untuk `kind = 'system'`** — akun sistem
   boleh net negatif, akun customer tidak.
2. **Status check (baru):** akun `status = 'closed'` ditolak sebagai sumber/tujuan transaksi
   (422, pesan serupa pola `insufficient balance` yang sudah ada).

### Top-up

Tidak ada endpoint baru. Top-up memakai `POST /api/payments` yang sudah ada, dengan
`payer_account: "system:cash"`. `bff` menambah alias: `payer_account: "topup"` dari klien
diterjemahkan ke `"system:cash"` sebelum diteruskan ke `payment-gateway` — jadi klien tidak perlu
tahu ID akun sistem secara eksplisit, tanpa menduplikasi jalur transaksi.

`fraud-check` tidak perlu diubah untuk ini: dia consumer Kafka async post-settlement yang cuma
menulis skor ke log (tidak pernah menolak transaksi — model post-settlement, bukan pre-authorization
hold, sesuai catatan SP-4 di roadmap). Top-up akan diskor sama seperti transaksi lain tanpa
perlakuan khusus apa pun di `payment-gateway`.

### Endpoint baru & routing

Semua endpoint akun/customer: `bff` memanggil `ledger-service` **langsung**, bypass
`payment-gateway` sama sekali. `payment-gateway` tetap murni domain pembayaran (fraud-check);
memaksa akun/customer lewat sana akan jadi proxy kosong tanpa nilai (YAGNI) dan menambah hop +
coupling yang tidak perlu untuk `GET` saldo yang sering dipanggil.

`ledger-service` (baru):
- `POST /customers` — body `{name, idempotency_key}` → `201 {id, name, created_at}`.
- `POST /accounts` — body `{customer_id, idempotency_key}` → `201 {id, customer_id, kind: "customer", status: "active", created_at}`. `id` server-generated (UUID as TEXT) — konsisten dengan `customers.id`; `system:cash` tetap ID khusus yang dibaca manusia, di luar jalur ini.
- `GET /accounts/{id}` — `200 {id, customer_id, kind, status, balance_cents}`. `balance_cents` dihitung (`SUM(amount_cents)` atas `ledger_entries`, konvensi tanda yang sudah ada: positif = credit, negatif = debit), dibaca di luar advisory lock (read-only, eventual consistency cukup untuk demo — pola yang sama dengan query balance yang sudah ada di `ApplyLocked`).
- `GET /accounts/{id}/transactions?page=&limit=` — `200 {entries: [...], page, limit, total}` (offset-based pagination, bukan cursor — lebih familiar, dan volume data demo kecil sehingga downside offset — skip/duplicate di tengah insert cepat — tidak signifikan). Tiap item `entries` adalah baris `ledger_entries` milik akun ini sendiri (satu leg, `amount_cents` bertanda, bukan kedua leg transaksi).
- `POST /accounts/{id}/close` — body `{idempotency_key}` → `200 {id, status: "closed"}`. Set `accounts.status = 'closed'`; sejak itu akun ditolak sebagai sumber/tujuan transaksi oleh pengecekan status di `ApplyLocked` (lihat §Perilaku ledger). Tidak ada `POST /accounts/{id}/reopen` — belum ada kebutuhan nyata untuk itu (YAGNI); tambah kalau sub-proyek berikutnya memang butuh.

`bff` (baru, proxy tipis ke atas, tanpa logic tambahan selain alias `topup`):
- `POST /api/customers`, `POST /api/accounts`, `GET /api/accounts/:id`, `GET /api/accounts/:id/transactions`, `POST /api/accounts/:id/close`.

Keduanya (`POST /customers`, `POST /accounts`) pakai idempotency key dengan pola klaim yang sama
seperti `POST /transactions` (klaim dua-fase, lease, replay response tersimpan) — konsisten dengan
mekanisme SP-1, bukan "create" polos. Alasan: konsistensi satu pola di seluruh proyek untuk semua
operasi create yang bisa di-retry aman, bukan karena ada bukti risiko dobel-klik yang tinggi untuk
operasi ini (risikonya memang lebih rendah daripada dobel-transfer, tapi tidak ada alasan untuk
mekanisme berbeda).

### e2e

Hapus `seedPayerBalance` (seed SQL langsung) dari `e2e/tests/support/ledger-client.ts`. Ganti alur
test yang memakainya dengan: `POST /api/customers` → `POST /api/accounts` → top-up via
`POST /api/payments` (`payer_account: "topup"`) → transfer → `GET /api/accounts/:id` /
`GET /api/accounts/:id/transactions` untuk verifikasi.

## What's left to the builder

- Mekanisme klaim idempotency untuk `POST /customers`/`POST /accounts`: reuse tabel klaim yang ada
  (`ledger_transactions`, yang sekarang khusus bentuk transaksi) atau tabel klaim generik baru
  (mis. `idempotent_requests(key, status, response_status, response_body, claimed_at)`) yang dipakai
  bersama oleh transaksi, customer, dan account creation. Builder pilih yang paling kecil
  perubahannya terhadap kode SP-1 yang sudah ada.
- Strategi migrasi `fk_ledger_entries_account` di DB yang sudah berisi data dari e2e SP-1 sebelumnya
  (akun yang sudah dipakai sebagai string bebas belum punya baris di `accounts`) — builder perlu
  backfill `accounts` dari `DISTINCT account_id` di `ledger_entries` yang sudah ada sebelum
  menambahkan constraint, atau pastikan ini hanya berlaku di DB fresh (test/CI selalu migrasi dari
  nol — cek apakah ini benar untuk semua environment sebelum menganggap tidak perlu backfill).
- Bentuk persis respons error untuk status check baru (closed account) dan konsistensinya dengan
  pola `writeJSONError`/pola rejection `insufficient balance` yang sudah ada.
- Validasi input detail (`name` non-empty, `customer_id` harus UUID valid dan ada di `customers`,
  dsb.) dan kode status HTTP untuk masing-masing kegagalan (400 vs 404 vs 422) — ikuti pola yang
  sudah dipakai di `handlePostTransaction`.
- Index tambahan untuk `GET /accounts/{id}/transactions` dengan pagination offset (mis.
  `idx_ledger_entries_account_id_created_at`) kalau `idx_ledger_entries_account_id` yang ada
  sekarang tidak cukup untuk `ORDER BY created_at` yang efisien.
