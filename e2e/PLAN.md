# Rencana End-to-End Test — Ledger & Rail

> Status saat ini (update 2026-08-21): **Tahap 0 dan Tahap 1 selesai** — jalur A–D dan C (sinkron + idempotency Redis) punya e2e test otomatis (`e2e/tests/sync-path.test.ts`, Vitest) yang dijalankan lewat `start-all.sh`/`stop-all.sh`. Jalur E–G (Kafka, Fraud Check, rekonsiliasi Legacy Core) masih tertutup gap — lihat §1 dan Tahap 2–3 di bawah. Dokumen ini mencakup semua jalur komunikasi yang sudah didesain di `bahasa-teknologi-perbankan.md` bagian 7.

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
                                    ▼ (belum diimplementasi — lihat §3.3)
                              Kafka / Redpanda (9092)
                                    │
                                    ▼
                              Fraud Check (consumer)

Legacy Core (COBOL) ──► batch offline, tidak nyambung live ke jalur di atas
```

| # | Jalur | Jenis | Status implementasi | Status test |
|---|---|---|---|---|
| A | BFF → Payment Gateway | sinkron (REST) | ✅ ada | ✅ `e2e/tests/sync-path.test.ts` |
| B | Payment Gateway → Ledger Service | sinkron (REST) | ✅ ada | ✅ termasuk kasus insufficient-balance (422) |
| C | Payment Gateway → Redis (idempotency) | sinkron | ✅ ada | ✅ verifikasi langsung ke Redis (TTL + no double-apply) |
| D | Ledger Service → PostgreSQL | sinkron | ✅ ada | ✅ verifikasi langsung ke Postgres (`ledger_entries`) |
| E | Ledger Service → Kafka (publish event) | asinkron | ❌ **belum diimplementasi** | ❌ tidak bisa diuji sebelum E dibangun |
| F | Kafka → Fraud Check (consume event) | asinkron | ✅ ada (sisi consumer), diuji manual pakai `rpk produce` | ⚠️ manual, tidak otomatis, dan tidak tersambung ke producer sungguhan |
| G | Legacy Core rekonsiliasi vs Ledger Service | offline/batch | ✅ Legacy Core jalan sendiri | ❌ tidak ada perbandingan otomatis dengan saldo Ledger Service |

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

### Tahap 2 — Menutup gap Kafka (jalur E), baru jalur F bisa diuji penuh
- **Prasyarat wajib:** `ledger-service` perlu ditambah producer Kafka (publish event setelah `Apply` sukses) — ini pekerjaan kode di repo `ledger-service`, bukan bagian dari e2e test itu sendiri, tapi e2e test jalur F tidak bisa jujur tanpa ini (sekarang hanya menguji consumer dengan pesan yang diproduksi manual, bukan alur nyata).
- Setelah producer ada: e2e test tahap 1 diperluas — setelah POST transaksi lewat jalur A–D, poll topic `transactions` (via `rpk` atau klien Kafka) untuk memastikan event benar-benar terbit dengan payload yang cocok, lalu cek log/health Fraud Check untuk konfirmasi ia memprosesnya.

### Tahap 3 — Rekonsiliasi Legacy Core (jalur G)
- Skrip yang: (1) menjalankan beberapa transaksi lewat jalur A–D, (2) mengekspor saldo akhir dari Postgres, (3) menyusun `data/transactions.dat` untuk Legacy Core dari transaksi yang sama, (4) menjalankan `eod-settlement`, (5) membandingkan `data/balances.dat` COBOL vs saldo Postgres — harus identik. Ini menguji konsep "strangler pattern / rekonsiliasi batch vs real-time" yang jadi tema utama komponen Legacy Core, bukan sekadar smoke test.
- Paling kompleks di antara semua tahap karena melibatkan translasi format (JSON ↔ fixed-width) — dikerjakan terakhir.

### Tahap 4 — CI (opsional, terpisah per repo + satu workflow gabungan)
- Tiap 5 repo submodule: CI ringan untuk unit test masing-masing (`go test`, `mvn test`, `npm test`, `pytest`, `cobc` compile check) — independen, tidak butuh docker-compose.
- Repo `ledger-rail`: satu GitHub Actions workflow yang checkout dengan `submodules: recursive`, `docker compose up -d`, start semua komponen, jalankan `e2e/` tahap 1–3. Ini yang paling mahal (butuh runner dengan Docker + build 4 bahasa), jadi baru masuk akal setelah tahap 1–3 stabil secara manual.

---

## 4. Struktur folder

```
ledger-rail/
  e2e/
    PLAN.md                   ← dokumen ini
    package.json               ← Vitest sebagai runner (proyek Node/TS sendiri)
    scripts/
      start-all.sh             ← tahap 1, selesai
      stop-all.sh               ← pasangan start-all.sh
      reconcile-legacy.sh        ← tahap 3, belum dibuat
    tests/
      support/env.ts             ← URL/DSN komponen, dari env var
      sync-path.test.ts          ← jalur A-D + C, selesai
      async-path.test.ts         ← jalur E-F, belum dibuat (setelah tahap 2)
      reconciliation.test.ts     ← jalur G, belum dibuat (tahap 3)
```

`scripts/smoke.sh` (tahap 0) sudah dihapus — digantikan penuh oleh `tests/sync-path.test.ts`.

---

## 5. Keputusan yang masih terbuka

- ~~**Reset state antar-run**~~ — diputuskan di Tahap 1: `randomUUID()` per test untuk account id & idempotency key, tanpa reset schema. Lihat §3 Tahap 1.
- **Siapa yang menjalankan komponen saat e2e:** proses background manual (seperti kemarin) vs `docker compose` juga untuk komponen aplikasi (butuh `Dockerfile` per komponen yang belum ada, per catatan "Docker vs mise" di `project-requirements.md`). Tahap 1 pakai proses lokal (`start-all.sh`/`stop-all.sh`); Dockerfile baru dibutuhkan serius di tahap 4 (CI).
