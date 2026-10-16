# Handoff — Ledger & Rail

Terakhir diperbarui: **2026-09-25 ~15:00 WIB**.

Dokumen acuan:
- Roadmap fitur (sub-proyek SP-0…SP-8, urutan, kriteria selesai): [`docs/ROADMAP.md`](docs/ROADMAP.md)
- Rencana & riwayat e2e (Tahap 0–4, jalur A–G): [`e2e/PLAN.md`](e2e/PLAN.md)
- Cara menjalankan stack & test: [`README.md`](README.md), [`e2e/README.md`](e2e/README.md)

---

## STATUS — fondasi selesai, roadmap fitur disusun, belum ada design sub-proyek (2026-09-25)

| Area | Keadaan |
|---|---|
| e2e jalur A–G | 9/9 test lulus (lokal via `ci-local.sh` dan CI) |
| CI GitHub Actions `e2e.yml` | **hijau** — run 36105169709 (2m52s, commit `bc40071`). Sempat merah sejak `f363231` (2026-08-21) |
| Unit test per komponen | lulus lokal: Go ok, Java 9, bff 6, fraud-check 5. **Belum ada CI per repo** |
| Dokumentasi run/test | lengkap: README induk, `e2e/README.md`, README di ledger-service/payment-gateway/bff/fraud-check, `legacy-core/README.md` |
| Git | semua repo bersih & ter-push (`ledger-rail` `bc40071`, submodule masing-masing 1 commit README) |

### Yang dikerjakan sesi 2026-09-25

1. **Diagnosis + perbaikan CI merah** (`d55100c`): skema Postgres kini di-mount ke
   `docker-entrypoint-initdb.d`; server Postgres *sementara* selama init lolos `pg_isready`
   (unix socket) sebelum database `ledger` dibuat → `database "ledger" does not exist` di runner
   yang cepat. `start-all.sh` kini menunggu `psql -h 127.0.0.1 -d ledger -c 'select 1'` (TCP hanya
   dibuka server final). Tak bisa direproduksi di Mac (celah ~0,34 dtk < latensi `docker exec`);
   terbukti lewat CI hijau.
2. **`e2e/scripts/ci-local.sh`** (`50f6c74`): replika langkah workflow dari state bersih
   (`docker compose down -v` → prefetch → start → test → dump log bila gagal → stop). Menolak jalan
   bila 5432/6379 dipegang service host.
3. **Dokumentasi** (`4ce9b51`, `bc40071`): lihat tabel di atas. Semua perintah & contoh curl
   dijalankan nyata terhadap stack sebelum ditulis.
4. **Roadmap fitur** (`docs/ROADMAP.md`): gabungan audit kode vs blueprint
   (`../bahasa-teknologi-perbankan.md` §7, `../project-requirements.md`) → 9 sub-proyek berurutan.
   Tujuan disepakati: kedalaman teknis + cakupan domain + produk bisa didemokan, bobot setara.

## LANGKAH BERIKUTNYA

1. **Konfirmasi urutan roadmap** dengan user (usulan: SP-0 → SP-1 → … → SP-8). Belum dikonfirmasi
   eksplisit — user minta didokumentasikan dulu.
2. **SP-1 (kebenaran ledger)**: mulai brainstorming design → spec di
   `docs/superpowers/specs/` → rencana implementasi. Keputusan kunci yang harus dibuat: mekanisme
   lock saldo (`FOR UPDATE` vs advisory lock vs `SERIALIZABLE`+retry), bentuk tabel outbox & relay,
   dan perilaku idempotency konkuren.
3. **SP-0 (perapian)** bisa jalan paralel — kecil, cukup design singkat di chat.

## Temuan terbuka (belum diperbaiki)

- **Overdraft konkuren** — cek saldo di luar transaksi DB (`ledger-service/internal/ledger/ledger.go:71` vs `:80`). → SP-1
- **Event Kafka bisa hilang** — publish setelah commit, gagal hanya di-log (`ledger.go:87`). → SP-1
- **Idempotency konkuren** — dua request key sama bersamaan: satu kena pelanggaran PK → 422, dan
  payment-gateway meng-cache 422 itu. → SP-1
- **bff `"result": null` untuk 422** — body penolakan payment-gateway teks polos
  (`bff/src/services/payment-gateway-client.ts:80`). → SP-0
- **Risiko CI flaky** — ledger-service healthy setelah 51 dtk di CI vs batas 60 dtk
  (`e2e/scripts/start-all.sh:60`). → SP-0

## Gotcha (hemat waktu sesi berikutnya)

- **Port host di Mac ini:** Homebrew `postgresql@14` (5432) dan `redis` (6379) menang atas
  port-forward Docker → komponen/test diam-diam ke DB yang salah. `ci-local.sh` sudah menolak jalan;
  untuk `start-all.sh` cek manual `lsof -nP -iTCP:5432 -sTCP:LISTEN`, lalu
  `brew services stop postgresql@14` (start lagi sesudahnya).
- **Tidak ada akun genesis** — test yang mendebit wajib seed saldo via SQL dengan idempotency key
  berbeda dari transaksi aslinya (`seedPayerBalance`). Hilang setelah SP-2.
- **Push submodule dulu, baru induk** — kalau terbalik, checkout CI gagal karena gitlink menunjuk
  commit yang belum ada di GitHub.
- **`docker compose up -d` tanpa nama service** juga membangun & menjalankan 4 container aplikasi
  (port 8080–8090) → bentrok dengan `start-all.sh`. Pakai `docker compose up -d postgres redis redpanda`.
- **Image infra belum ada** → pull pertama bisa putus (`unexpected EOF`) di VM Docker Desktop;
  `docker compose pull postgres redis redpanda` terpisah dulu, lalu ulangi.
- **Commit:** bahasa Inggris, tanpa trailer atribusi Claude (preferensi user di `~/.claude/CLAUDE.md`).
