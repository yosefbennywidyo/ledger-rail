# Rencana End-to-End Test — Ledger & Rail

> Status saat ini: **belum ada integration/e2e test otomatis di proyek ini** — hanya unit test per komponen (semua pakai mock/fake) dan smoke test manual lewat `curl` yang dijalankan sekali lalu tidak disimpan. Dokumen ini adalah rencana untuk menutup gap itu, mencakup semua jalur komunikasi yang sudah didesain di `bahasa-teknologi-perbankan.md` bagian 7.

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
| A | BFF → Payment Gateway | sinkron (REST) | ✅ ada | ❌ belum |
| B | Payment Gateway → Ledger Service | sinkron (REST) | ✅ ada | ⚠️ pernah di-smoke-test manual, tidak tersimpan |
| C | Payment Gateway → Redis (idempotency) | sinkron | ✅ ada | ⚠️ sama seperti B |
| D | Ledger Service → PostgreSQL | sinkron | ✅ ada | ✅ tercakup smoke test manual sebelumnya |
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

### Tahap 0 — Skrip smoke test manual → jadi skrip yang tersimpan (belum otomatis)
Ubah apa yang kemarin dilakukan manual jadi skrip `e2e/scripts/smoke.sh` yang bisa dijalankan siapa pun tanpa mengingat urutan `curl` satu-satu. Cakupan: jalur A–D (semua sinkron). Prasyarat: `docker compose up -d`, lalu jalankan tiap komponen manual di terminal terpisah (belum ada orkestrasi start-all).

**Belum butuh perubahan kode di komponen manapun** — ini murni membungkus apa yang sudah terbukti jalan.

### Tahap 1 — Orkestrasi start-all + assertion otomatis
- Tambah `e2e/docker-compose.override.yml` atau skrip `e2e/scripts/start-all.sh` yang menjalankan kelima komponen (bukan cuma infra) sebagai proses background dengan health-check polling ke `/healthz` masing-masing sebelum test mulai.
- Ganti skrip shell tahap 0 dengan test framework yang bisa assert dengan jelas dan exit code yang benar (bukan sekadar baca output curl dengan mata). Kandidat: **Node.js + Vitest** (satu-satunya bahasa yang sudah punya test runner modern terpasang di proyek ini lewat `bff/`, dan `fetch` bawaan cocok untuk memanggil banyak REST endpoint) — jalankan lewat `mise exec node --` dari `e2e/`, terpisah dari `bff/` sendiri (punya `package.json` sendiri di `e2e/`).
- Cakupan: jalur A–D, ditambah verifikasi langsung ke Postgres (`psql`) dan Redis (`redis-cli`) untuk memastikan side-effect benar, bukan cuma HTTP response code.

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

## 4. Struktur folder yang diusulkan (belum dibuat, menunggu implementasi tahap 1)

```
ledger-rail/
  e2e/
    PLAN.md                 ← dokumen ini
    scripts/
      smoke.sh              ← tahap 0
      start-all.sh           ← tahap 1
      reconcile-legacy.sh    ← tahap 3
    package.json             ← tahap 1, Vitest sebagai runner
    tests/
      sync-path.test.ts      ← jalur A-D
      async-path.test.ts     ← jalur E-F (setelah tahap 2)
      reconciliation.test.ts ← jalur G (tahap 3)
```

---

## 5. Keputusan yang masih terbuka

- **Reset state antar-run:** drop & re-apply `schema.sql` tiap kali, atau pakai akun/idempotency-key unik per run supaya data lama tidak mengganggu? Tahap 1 perlu memutuskan ini sebelum ditulis.
- **Siapa yang menjalankan komponen saat e2e:** proses background manual (seperti kemarin) vs `docker compose` juga untuk komponen aplikasi (butuh `Dockerfile` per komponen yang belum ada, per catatan "Docker vs mise" di `project-requirements.md`). Tahap 1 kemungkinan tetap pakai proses lokal dulu; Dockerfile baru dibutuhkan serius di tahap 4 (CI).
