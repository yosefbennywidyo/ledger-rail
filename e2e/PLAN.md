# Rencana End-to-End Test — Ledger & Rail

> Status saat ini (update 2026-09-25 ~13:52 WIB): **Tahap 0-4 selesai** — semua 7 jalur (A-G) punya e2e test otomatis (`e2e/tests/sync-path.test.ts`, `async-path.test.ts`, `reconciliation.test.ts`, Vitest), dijalankan lewat `start-all.sh`/`stop-all.sh` (atau varian Docker / `ci-local.sh`) dan di CI GitHub Actions. Cara menjalankan: [`README.md`](README.md). Sisa di luar rencana ini: CI unit test per repo submodule. Dokumen ini mencakup semua jalur komunikasi yang sudah didesain di `bahasa-teknologi-perbankan.md` bagian 7.

Ditulis: 2026-08-18. Lokasi: `ledger-rail/e2e/` — repo induk, bukan salah satu submodule, karena e2e test secara definisi menyentuh lebih dari satu komponen sekaligus.

---

## 1. Peta jalur yang perlu diuji

```
Klien
  │
  ▼
BFF (8082) ──────────────► Payment Gateway (8081) ──► Redis (idempotency)
                                    │
                                    ▼
                          Ledger Service (8080) ──► PostgreSQL
                                    │
                                    ▼
                              Kafka / Redpanda (9092)
                                    │
                                    ▼
                              Fraud Check (8090, consumer)

Legacy Core (COBOL) ──► batch offline, tidak nyambung live ke jalur di atas
```

| # | Jalur | Jenis | Status implementasi | Status test |
|---|---|---|---|---|
| A | BFF → Payment Gateway | sinkron (REST) | ✅ ada | ✅ `e2e/tests/sync-path.test.ts` |
| B | Payment Gateway → Ledger Service | sinkron (REST) | ✅ ada | ✅ termasuk kasus insufficient-balance (422) |
| C | Payment Gateway → Redis (idempotency) | sinkron | ✅ ada | ✅ verifikasi langsung ke Redis (TTL + no double-apply) |
| D | Ledger Service → PostgreSQL | sinkron | ✅ ada | ✅ verifikasi langsung ke Postgres (`ledger_entries`) |
| E | Ledger Service → Kafka (publish event) | asinkron | ✅ `internal/kafka.Producer` | ✅ `e2e/tests/async-path.test.ts` verifikasi lewat consumer kafkajs |
| F | Kafka → Fraud Check (consume event) | asinkron | ✅ ada | ✅ sama, plus verifikasi log fraud-check benar memproses |
| G | Legacy Core rekonsiliasi vs Ledger Service | offline/batch | ✅ Legacy Core jalan sendiri | ✅ `e2e/tests/reconciliation.test.ts` — saldo penutupan identik |

---

## 2. Prinsip desain test

1. **Jangan mock antar-komponen di level e2e.** Unit test tiap repo sudah menutupi logic dengan mock — e2e justru harus memakai instance nyata (docker compose) supaya menangkap bug seperti "snake_case vs camelCase JSON" yang ditemukan agent Payment Gateway kemarin, yang lolos dari unit test karena mock tidak peduli format field.
2. **Idempotent & bisa diulang.** Test harus bisa dijalankan berkali-kali dari state bersih tanpa campur tangan manual — pakai idempotency key unik per run (`uuid` atau timestamp), dan/atau reset skema Postgres di awal.
3. **Bahasa test harus netral terhadap komponen.** Karena proyek ini sengaja multi-bahasa, harness e2e tidak boleh "milik" satu komponen. Pilihan: script shell tipis (curl + rpk + psql/redis-cli) untuk tahap awal, baru naik ke test framework kalau assertion mulai rumit.
4. **Terpisah dari unit test tiap repo.** Unit test tetap hidup di masing-masing 5 repo submodule (sudah ada). E2e test hidup di `ledger-rail/e2e/` karena butuh docker-compose + lebih dari satu repo berjalan bersamaan — tidak masuk akal taruh di salah satu submodule.

---

## 3. Rencana bertahap

### Tahap 0 — Skrip smoke test manual → jadi skrip yang tersimpan (belum otomatis) — ✅ selesai
`e2e/scripts/smoke.sh` dibuat dan diverifikasi jalan nyata terhadap `docker compose up -d` (postgres, redis) + ketiga komponen aplikasi dijalankan manual. Cakupan: jalur A–D.

### Tahap 1 — Orkestrasi start-all + assertion otomatis — ✅ selesai
- `e2e/scripts/start-all.sh` menjalankan postgres+redis (docker compose), apply schema, lalu ketiga komponen aplikasi sebagai proses background, dengan health-check polling ke `/healthz` masing-masing sebelum return. `e2e/scripts/stop-all.sh` adalah pasangannya — mematikan berdasarkan port (bukan PID) karena `go run`/`mvn spring-boot:run`/`npm run dev` masing-masing beranak child process.
- `e2e/` sekarang proyek Node/TS/Vitest sendiri (`package.json` terpisah dari `bff/`), berisi `tests/sync-path.test.ts`.
- Cakupan: jalur A–D lewat Postgres (`pg` client, bukan mock), jalur C lewat Redis (`redis` client — verifikasi key `payment-gateway:idempotency:<key>` benar-benar ada dengan TTL > 0), plus kasus bisnis: debit ke akun bersaldo 0 ditolak 422 tanpa membuat baris `ledger_entries`.
- **Keputusan reset state (buka pertanyaan §5):** tidak reset schema antar-run — tiap test memakai `randomUUID()` untuk account id & idempotency key, sehingga aman dijalankan berulang dari state manapun tanpa bentrok data lama.
- Diverifikasi end-to-end: `start-all.sh` → `npm test` (6/6 pass) → `stop-all.sh`, dijalankan nyata bukan cuma dibaca.

### Tahap 2 — Menutup gap Kafka (jalur E), baru jalur F bisa diuji penuh — ✅ selesai
- `ledger-service` mendapat `internal/kafka.Producer` (paket baru, pakai `segmentio/kafka-go`) yang mengimplementasikan interface baru `ledger.EventPublisher`. `ledger.Service.Post` memanggil `Publish` setelah `Apply` sukses — gagal publish di-log tapi tidak menggagalkan request (Postgres tetap source of truth, Kafka cuma fan-out async). Unit test memverifikasi publish terjadi tepat sekali per transaksi (termasuk saat idempotent retry) dan gagal-publish tidak menggagalkan `Post`.
- `start-all.sh`/`stop-all.sh` diperluas: nyalakan Redpanda + `fraud-check` (lewat `uv run fraud-check`), poll `/healthz` fraud-check juga.
- `e2e/tests/async-path.test.ts` ditambahkan: submit pembayaran lewat BFF, konsumsi topic `transactions` pakai `kafkajs` untuk verifikasi event benar-benar terbit dengan payload yang cocok persis skema yang diharapkan `fraud-check`, lalu poll log `fraud-check` untuk konfirmasi ia benar-benar memproses (bukan cuma health check statis).
- **Bug ditemukan & diperbaiki saat verifikasi nyata:** memanggil `consumer.disconnect()` dari dalam callback `eachMessage` kafkajs menyebabkan deadlock (run loop internal kafkajs menunggu callback, callback menunggu disconnect). Perbaikan: disconnect di blok `finally` di luar stack callback.
- Diverifikasi end-to-end nyata: post transaksi ke `ledger-service` langsung, konfirmasi event ada di topic via `rpk topic consume`, jalankan `fraud-check` sungguhan dan lihat log `processed transaction ... flagged=False`. Lalu suite penuh: `start-all.sh` → `npm test` (8/8 pass) → `stop-all.sh`.

### Tahap 3 — Rekonsiliasi Legacy Core (jalur G) — ✅ selesai
- **Prasyarat yang muncul saat implementasi:** `eod-settlement.cbl` men-hardcode path `data/transactions.dat` dkk., yang berisi sample data ter-commit (dipakai README untuk verifikasi manual) — menimpanya langsung akan merusak fixture itu. Diperbaiki di `legacy-core`: path file sekarang dibaca dari environment variable (`EOD_OPENING_BALANCES_FILE`, `EOD_TRANSACTIONS_FILE`, `EOD_BALANCES_FILE`, `EOD_ERRORS_FILE`) lewat paragraf baru `READ-FILE-PATHS-FROM-ENV`, dengan default identik ke path lama kalau env var tidak diset (diverifikasi: output tidak berubah tanpa env var).
- `e2e/tests/reconciliation.test.ts`: (1) seed saldo awal 2 dari 3 akun langsung di Postgres (akun ketiga sengaja tanpa saldo awal untuk menguji aturan "default nol"), (2) jalankan 3 transaksi berurutan lewat BFF yang saling bergantung saldo (akun C baru punya saldo untuk didebit setelah dikredit transaksi sebelumnya), (3) bangun `transactions.dat`/`opening-balances.dat` sintetis di direktori temp langsung dari baris `ledger_entries` Postgres milik transaksi tersebut (bukan dihitung ulang manual — jadi benar-benar menguji jalur data asli), (4) compile + jalankan `eod-settlement` terhadap direktori temp itu via env var, (5) parse `balances.dat` (format `-ZZZ,ZZZ,ZZ9.99`) dan bandingkan tiap akun terhadap `SUM(amount_cents)` dari Postgres — harus identik persis.
- Diverifikasi nyata: build `cobc` sukses, saldo akhir 3 akun (termasuk kasus tanpa saldo awal & akun yang di-debit dari saldo hasil kredit transaksi lain) cocok 100% antara COBOL dan Postgres. Sample data `legacy-core/data/*.dat` dikonfirmasi tidak berubah (`git status` bersih) setelah test jalan.

### Tahap 4 — CI (opsional, terpisah per repo + satu workflow gabungan) — ✅ workflow gabungan selesai; CI per repo belum
- Tiap 5 repo submodule: CI ringan untuk unit test masing-masing (`go test`, `mvn test`, `npm test`, `pytest`, `cobc` compile check) — independen, tidak butuh docker-compose.
- Repo `ledger-rail`: satu GitHub Actions workflow yang checkout dengan `submodules: recursive`, `docker compose up -d`, start semua komponen, jalankan `e2e/` tahap 1–3. Ini yang paling mahal (butuh runner dengan Docker + build 4 bahasa), jadi baru masuk akal setelah tahap 1–3 stabil secara manual.
- Workflow gabungan `.github/workflows/e2e.yml` selesai 2026-08-21 (toolchain via `jdx/mise-action`, GnuCOBOL via apt, pre-fetch dependency sebelum `start-all.sh`), run pertama hijau 2m36s.
- 2026-09-25: CI merah sejak commit Dockerize (`f363231`) — `database "ledger" does not exist`. Penyebab: skema kini di-mount ke `docker-entrypoint-initdb.d`, dan server Postgres *sementara* selama init sudah lolos `pg_isready` (unix socket) sebelum database dibuat. Perbaikan `d55100c`: `start-all.sh` menunggu `psql -h 127.0.0.1 -d ledger -c 'select 1'` (TCP hanya dibuka server final). Tak bisa direproduksi di Mac lokal (celah ~0,34 dtk lebih pendek dari latensi `docker exec`), jadi bukti akhirnya run CI berikutnya. `e2e/scripts/ci-local.sh` ditambahkan untuk mengulang langkah workflow dari state bersih.
- CI unit test per repo submodule: belum dibuat. Perintahnya sudah terverifikasi lokal 2026-09-25 (lihat README root).

---

## 4. Struktur folder

```
ledger-rail/
  e2e/
    PLAN.md                   ← dokumen ini
    README.md                  ← cara menjalankan (3 mode, subset test, env var, troubleshooting)
    package.json               ← Vitest sebagai runner (proyek Node/TS sendiri)
    scripts/
      start-all.sh             ← tahap 1-2, selesai (infra + 4 komponen aplikasi)
      stop-all.sh               ← pasangan start-all.sh
      ci-local.sh               ← replika langkah .github/workflows/e2e.yml dari state bersih (down -v → prefetch → start → test → stop); tolak jalan kalau 5432/6379 dipegang service host
    tests/
      support/env.ts             ← URL/DSN/broker/path komponen, dari env var
      support/ledger-client.ts   ← seed saldo + submit payment, dipakai sync/async/reconciliation
      sync-path.test.ts          ← jalur A-D + C, selesai
      async-path.test.ts         ← jalur E-F, selesai
      reconciliation.test.ts     ← jalur G, selesai
```

`scripts/smoke.sh` (tahap 0) sudah dihapus — digantikan penuh oleh `tests/sync-path.test.ts`. Rencana awal punya `scripts/reconcile-legacy.sh` terpisah di tahap 3, tapi tidak dibuat — mengikuti keputusan yang sama dengan smoke.sh: logic rekonsiliasi hidup penuh di `tests/reconciliation.test.ts` (assert otomatis + exit code yang benar), bukan skrip shell yang perlu dibaca manual.

---

## 5. Keputusan yang masih terbuka

- ~~**Reset state antar-run**~~ — diputuskan di Tahap 1: `randomUUID()` per test untuk account id & idempotency key, tanpa reset schema. Lihat §3 Tahap 1.
- ~~**Siapa yang menjalankan komponen saat e2e**~~ — selesai 2026-08-21: kedua jalur sekarang didukung. `start-all.sh`/`stop-all.sh` tetap ada untuk proses lokal (lebih cepat untuk iterasi harian). `Dockerfile` per komponen (`ledger-service`, `payment-gateway`, `bff`, `fraud-check`) ditambahkan plus service definitions di root `docker-compose.yml` (healthcheck per komponen, `depends_on: condition: service_healthy`, skema Postgres di-mount ke `docker-entrypoint-initdb.d`, listener Redpanda dipisah internal `redpanda:29092` vs eksternal `localhost:9092` supaya host dan container bisa akses broker yang sama tanpa bentrok). `e2e/scripts/start-all-docker.sh` / `stop-all-docker.sh` menjalankan jalur ini via `docker compose up -d --build --wait`. Diverifikasi nyata: `npm test` (9/9 pass) melawan stack Docker penuh. Legacy Core tetap di luar compose (offline/batch, sesuai desain).
