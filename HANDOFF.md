# Handoff — Ledger & Rail

Terakhir diperbarui: **2026-10-17 ~08:14 WIB**.

---

## SP-2 (akun & saldo) — SEDANG JALAN, dihentikan atas permintaan user di Task 8/10

Design doc: [`docs/superpowers/specs/2026-10-17-sp2-accounts-balance-design.md`](docs/superpowers/specs/2026-10-17-sp2-accounts-balance-design.md).
Plan: [`docs/superpowers/plans/2026-10-17-sp2-accounts-balance.md`](docs/superpowers/plans/2026-10-17-sp2-accounts-balance.md).

**Worktree:** `/Users/crowdotech/apps/me/explore/ledger-rail/.claude/worktrees/sp2-accounts-balance`
(dibuat lewat `EnterWorktree`, branch `worktree-sp2-accounts-balance` di repo induk **dan** di
submodule `ledger-service`, `bff`, `payment-gateway`; `fraud-check` tidak disentuh plan ini).
Ledger eksekusi (progress per-task, termasuk ruling yang dibuat):
`.superpowers/sdd/2026-10-17-sp2-accounts-balance/progress.md` di dalam worktree itu.

**Status per task (dari 10 total):**

| Task | Isi | Status |
|---|---|---|
| 1 | Schema migration: `customers`, `accounts`, `idempotency_claims`, FK `ledger_entries`, seed `system:cash` | selesai |
| 2 | `internal/account` domain package (ledger-service) + unit test | selesai |
| 3 | `account_store.go` — implementasi Postgres untuk `account.Repository` | selesai |
| 4 | `ApplyLocked`: skip overdraft untuk akun `system`, tolak akun `closed` | selesai |
| 5 | Endpoint HTTP `ledger-service` (`/customers`, `/accounts`, dll) + wiring `main.go` | selesai |
| 6 | `bff`: `LedgerServiceClient` + test | selesai |
| 7 | `bff`: route `/api/customers`, `/api/accounts/*` + wiring `app.ts`/`config.ts`/`docker-compose.yml` | selesai |
| 8 | `bff`: alias `payer_account: "topup"` → `"system:cash"` | selesai |
| 9 | e2e helpers (`openAccount`, `topUp`, dll) ganti `seedPayerBalance` | **belum mulai** |
| 10 | Migrasi 5 file e2e test + `accounts.test.ts` baru + jalankan `ci-local.sh` penuh | **belum mulai** |

**Langkah lanjutan sesi berikutnya:**
1. Masuk ke worktree di atas (atau `EnterWorktree` dengan `path` yang sama) — jangan mulai dari
   `main`, pekerjaan sudah ada di branch `worktree-sp2-accounts-balance` (repo induk + 3 submodule).
2. Lanjutkan eksekusi plan dengan skill `superpowers:executing-plans`, mulai dari Task 9
   (`task-start docs/superpowers/plans/2026-10-17-sp2-accounts-balance.md 9` via script
   `executing-plans/scripts/task-start`) — ledger di `.superpowers/sdd/.../progress.md` sudah
   mencatat Task 1–8 selesai, jangan dikerjakan ulang.
3. Setelah Task 9–10 selesai: jalankan final whole-branch review (fresh reviewer, model paling
   mampu) sesuai skill, lalu `superpowers:finishing-a-development-branch` untuk commit submodule →
   bump gitlink induk → PR/merge ke `main` di tiap repo (submodule dulu, baru induk — lihat gotcha
   di bawah).
4. Container Docker (`postgres`, `redis`, `redpanda`) di worktree ini mungkin masih hidup
   (`docker compose up -d postgres redis redpanda` dijalankan untuk smoke test Task 5) — cek
   `docker compose ps` dan `docker compose down` kalau sudah tidak dipakai, supaya tidak membebani
   RAM (lihat gotcha RAM di bawah).

**Catatan desain yang relevan untuk lanjutan (ringkas, detail lengkap di plan/spec):** top-up pakai
`POST /api/payments` existing dengan alias `payer_account: "topup"` (bukan endpoint baru); akun
sistem `system:cash` di-seed migrasi, bukan API; idempotency untuk create/close customer/akun pakai
tabel generik baru `idempotency_claims`, sengaja terpisah dari klaim `ledger_transactions` SP-1
supaya tidak menyentuh jalur konkurensi yang sudah teruji.

---

Dokumen acuan:
- Roadmap fitur (sub-proyek SP-0…SP-8, urutan, kriteria selesai): [`docs/ROADMAP.md`](docs/ROADMAP.md)
- Rencana & riwayat e2e (Tahap 0–4, jalur A–G): [`e2e/PLAN.md`](e2e/PLAN.md)
- Cara menjalankan stack & test: [`README.md`](README.md), [`e2e/README.md`](e2e/README.md)
- SP-1 design spec & implementation plan: [`docs/superpowers/specs/2026-10-16-sp1-ledger-correctness-design.md`](docs/superpowers/specs/2026-10-16-sp1-ledger-correctness-design.md), [`docs/superpowers/plans/2026-10-16-sp1-ledger-correctness.md`](docs/superpowers/plans/2026-10-16-sp1-ledger-correctness.md)

---

## STATUS — SP-0 dan SP-1 selesai dan di-merge ke `main` di semua repo (2026-10-17)

| Area | Keadaan |
|---|---|
| e2e jalur A–G + concurrency + outbox-resilience | 13/13 test lulus (lokal via `ci-local.sh` dan CI) |
| CI GitHub Actions `e2e.yml` di `main` | **hijau** — run 38961380321, commit `7d0f7e7` |
| CI unit test per repo submodule | **ada sekarang** (SP-0): `ledger-service`, `payment-gateway`, `bff`, `fraud-check` masing-masing punya `.github/workflows/test.yml`, action di-pin ke SHA, `persist-credentials: false` |
| Vulnerability Dependabot | **0 terbuka** di kelima repo — 19 alert di `bff` (fastify/fast-uri/vitest) + 1 di `ledger-rail` (`source-map-js`) sudah difix, dikonfirmasi `state: fixed` |
| Git | semua repo bersih, di `main`, tidak ada branch/worktree dangling (di-cek & di-prune 2026-10-17) |

### SP-1 — Kebenaran ledger (selesai)

Advisory lock per akun (`pg_advisory_xact_lock`, bukan row lock — belum ada tabel `accounts`),
transactional outbox + relay polling, klaim idempotency dua-fase dengan lease 30 detik (409 untuk
duplikat yang genuinely konkuren). Commit utama: lihat PR yang sudah merged di tiap repo (`ledger-service`#1,
`payment-gateway`#1, `ledger-rail`#1).

**Bug nyata ditemukan & diperbaiki setelah merge** (bukan sekadar flaky test): `kafka-go`'s `Writer`
yang dibuat sebagai struct literal (bukan via `NewWriter()`) default ke `RequiredAcks: RequireNone`
(fire-and-forget) — relay bisa melaporkan "berhasil publish" padahal broker belum benar-benar
mempersist pesannya (broker mati, misalnya saat `docker compose stop`). Dibuktikan langsung dengan
`rpk topic consume`: pesan yang diklaim published ternyata tidak ada di topic. Fix: `RequiredAcks:
segmentio.RequireAll` eksplisit di `ledger-service/internal/kafka/producer.go`. Ini melawan langsung
garansi inti SP-1 ("event tidak boleh hilang") — proses debugging-nya (3x gagal di CI, dua teori
salah dibantah lewat probe Go/kafkajs terisolasi) ada di riwayat percakapan sesi 2026-10-16/17,
belum dituliskan sebagai postmortem terpisah.

### SP-0 — Perapian (selesai)

Tiga item asli dari roadmap + perluasan vulnerability fix:
1. CI `ledger-service` yang dulu healthy baru setelah 51 dtk (vs batas 60 dtk) — `start-all.sh`
   sekarang build binary dulu (`go build`), bukan `go run` tiap kali.
2. bff yang dulu dapat `"result": null` untuk 422/409 — `httpapi.go` sekarang balas JSON terstruktur
   (`writeJSONError` helper) untuk semua error path, bukan plain text.
3. CI unit test per submodule (tidak ada sebelumnya) — ditambahkan untuk keempat komponen.
4. (Perluasan, bukan di roadmap asli) Fix 19+1 vulnerability Dependabot — lihat tabel status.

## LANGKAH BERIKUTNYA

1. **SP-2 (akun & saldo)** — sub-proyek berikutnya sesuai urutan roadmap. Mulai dari brainstorming
   design: entitas akun (buka rekening), akun sistem untuk top-up, `GET` saldo & mutasi.
2. **Pertimbangkan items yang di-defer dari SP-1** (lihat bagian di bawah) sebelum atau sambil jalan
   SP-2 — tidak ada yang blocking, tapi beberapa (test khusus race reclaim) akan makin bernilai begitu
   SP-2 menambah lebih banyak jalur konkuren.

## Temuan yang sengaja di-defer dari SP-1 (bukan bug, keputusan sadar — lihat spec §Decisions)

- **Tidak ada test Postgres khusus untuk race reclaim `FOR UPDATE`** (holder lama vs reclaimer lease
  30 dtk). Coverage saat ini: dua verifikasi independen lewat code-reading (termasuk trace manual ke
  behavior `database/sql`) + `go test -race`. Dinilai cukup untuk sekarang; pertimbangkan ulang kalau
  SP-2+ menambah banyak jalur konkuren baru yang menyentuh jalur ini.
- **Risiko kolisi hash advisory-lock** (`hashtext(account_id)` bisa collide untuk account_id
  berbeda) — diterima, karena Postgres auto-detect & abort deadlock (bukan hang permanen) kalau itu
  terjadi.
- **`relay_test.go` di `ledger-service`** punya race timing minor di fakes test (margin 10x,
  `-race` tetap lolos). CodeRabbit juga menemukan ini secara independen — tetap tidak ditangani.
- **Tidak ada test level HTTP-client untuk 409** di `payment-gateway` (`LedgerServiceClient`) — hanya
  `PaymentService` yang ditest lewat mock.
- **Hardening `lock_timeout`/`NOWAIT`** untuk edge case: request yang datang setelah lease 30 dtk
  kedaluwarsa bisa blocking (bukan fail-fast) kalau holder asli masih hidup tapi lambat. Bukan bug
  (tetap resolve benar, hanya lebih lambat di corner case langka ini), belum di-hardening.

## Gotcha (hemat waktu sesi berikutnya)

- **Port host di Mac ini:** Homebrew `postgresql@14` (5432) dan `redis` (6379) menang atas
  port-forward Docker → komponen/test diam-diam ke DB yang salah. `ci-local.sh` sudah menolak jalan;
  untuk `start-all.sh` cek manual `lsof -nP -iTCP:5432 -sTCP:LISTEN`, lalu
  `brew services stop postgresql@14` (start lagi sesudahnya).
- **RAM Mac ini kecil (~8 GB), Docker Desktop reservasinya besar** — jalankan `vm_stat` /
  `sysctl -n vm.swapusage` sebelum siklus Docker berat berulang-ulang; kalau free+speculative < ~200 MB,
  proses app (misal `ledger-service`) bisa **di-OOM-kill diam-diam** oleh OS (`signal: killed` di
  log-nya, bukan error aplikasi). Jangan simpulkan ada bug dari kegagalan test sebelum cek ini.
  Dibuktikan sesi 2026-10-16: belasan siklus `docker compose up/down` berturut-turut bikin RAM habis
  dan `ledger-service` mati diam-diam di tengah test.
- **`docker compose start <svc>` tidak menunggu healthcheck** — langsung return begitu proses
  container mulai, bukan begitu `healthcheck`-nya lolos. Kalau sebuah test men-stop lalu men-start
  ulang suatu service (misal `redpanda`) dan langsung memakainya, race ini nyata. `e2e/tests/support/docker.ts`'s
  `startService` sudah menangani ini (poll `docker compose ps --format json`'s `Health` field).
- **Tidak ada akun genesis** — test yang mendebit wajib seed saldo via SQL dengan idempotency key
  berbeda dari transaksi aslinya (`seedPayerBalance`). Hilang setelah SP-2.
- **Push submodule dulu, baru induk** — kalau terbalik, checkout CI gagal karena gitlink menunjuk
  commit yang belum ada di GitHub.
- **PR yang di-stack di atas branch lain (bukan `main`) otomatis ter-CLOSE** oleh GitHub kalau branch
  dasarnya di-merge+dihapus — tidak di-retarget otomatis ke `main`. Harus dibuat ulang (`gh pr create
  --base main`), bukan di-reopen (`gh pr reopen` gagal kalau base branch-nya sudah tak ada).
- **Merge beberapa PR submodule berurutan ke `main` bisa bikin konflik gitlink di parent repo**, kalau
  branch kerja di parent dicabang sebelum salah satu PR submodule itu selesai — `git merge
  origin/main` ke branch kerja, lalu arahkan gitlink manual ke commit `main` terbaru tiap submodule
  (verifikasi dulu dengan `git show <main-sha>:<path>` isinya benar) sebelum commit resolusinya.
  **Selalu bump gitlink untuk SEMUA submodule yang berubah** — sesi 2026-10-16 sempat lupa bump
  `bff`/`fraud-check` padahal sudah bump `ledger-service`/`payment-gateway`, jadi CI workflow
  keduanya tak pernah benar-benar tertaut dari repo induk sampai ketahuan manual.
- **`docker compose up -d` tanpa nama service** juga membangun & menjalankan 4 container aplikasi
  (port 8080–8090) → bentrok dengan `start-all.sh`. Pakai `docker compose up -d postgres redis redpanda`.
- **Image infra belum ada** → pull pertama bisa putus (`unexpected EOF`) di VM Docker Desktop;
  `docker compose pull postgres redis redpanda` terpisah dulu, lalu ulangi.
- **Commit:** bahasa Inggris, tanpa trailer atribusi Claude (preferensi user di `~/.claude/CLAUDE.md`).
