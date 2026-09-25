# e2e — test end-to-end Ledger & Rail

Suite Vitest yang menjalankan semua komponen sungguhan (tanpa mock) dan menguji
ketujuh jalur komunikasi A–G. Rencana, peta jalur, dan riwayat keputusan ada di
[`PLAN.md`](PLAN.md); dokumen ini hanya soal **cara menjalankannya**.

| File test | Jalur | Yang diuji |
|---|---|---|
| `tests/sync-path.test.ts` | A–D | Klien → BFF → Payment Gateway (+ Redis idempotency) → Ledger Service → Postgres |
| `tests/async-path.test.ts` | E–F | Ledger Service publish event ke Redpanda → Fraud Check consume |
| `tests/reconciliation.test.ts` | G | Saldo Postgres vs hasil batch COBOL `legacy-core` harus identik |

## Prasyarat

- Toolchain: `mise install` di root repo (Go, Java, Maven, Node, Python, uv, rpk).
- GnuCOBOL (`cobc`) untuk test rekonsiliasi — lihat [`legacy-core/README.md`](../legacy-core/README.md).
- Docker (Postgres, Redis, Redpanda jalan di container).
- Dependency e2e: `cd e2e && npm install` (sekali).

**Port 5432 dan 6379 harus dipegang Docker, bukan service di host.** Postgres/Redis
Homebrew bind `127.0.0.1` dan menang atas port-forward Docker untuk koneksi ke
`localhost` — komponen dan test akan diam-diam bicara ke database yang salah.

```bash
lsof -nP -iTCP:5432 -sTCP:LISTEN   # pemilik harus com.docke…
lsof -nP -iTCP:6379 -sTCP:LISTEN
brew services stop postgresql@14   # kalau perlu; start lagi setelah selesai
brew services stop redis
```

## Tiga cara menjalankan

Semua perintah dari root repo `ledger-rail/`.

### 1. Komponen sebagai proses lokal — untuk iterasi harian

```bash
./e2e/scripts/start-all.sh    # infra via docker compose, 4 komponen via go run / mvn / tsx / uv
(cd e2e && npm test)
./e2e/scripts/stop-all.sh
```

- `start-all.sh` baru return setelah `/healthz` keempat komponen menjawab 200 (maks. 60 dtk per komponen).
- bff jalan dengan `tsx watch` — edit kode bff langsung reload tanpa restart stack.
- `stop-all.sh` mematikan proses berdasarkan port dan `docker compose stop` (bukan `down -v`), jadi isi Postgres tetap ada untuk diinspeksi.

### 2. Semua komponen di container — mendekati deployment

```bash
./e2e/scripts/start-all-docker.sh   # docker compose up -d --build --wait
(cd e2e && npm test)
./e2e/scripts/stop-all-docker.sh
```

Membangun image keempat komponen (butuh disk dan RAM lebih). Test yang sama
jalan tanpa perubahan karena port yang diekspos identik.

### 3. Replika CI dari state bersih

```bash
./e2e/scripts/ci-local.sh
```

Mengulang langkah `.github/workflows/e2e.yml`: `docker compose down -v` (**menghapus
volume Postgres proyek ini**), pre-fetch dependency, `start-all.sh`, `npm test`,
dump log komponen kalau gagal, `stop-all.sh`. Menolak jalan kalau 5432/6379
dipegang service host. Exit 0 hanya kalau start dan test sama-sama lulus.

## Menjalankan sebagian test

```bash
cd e2e
npx vitest run tests/sync-path.test.ts        # satu file
npx vitest run -t "idempotency"               # filter nama test
npx vitest                                    # watch mode
```

Stack harus sudah jalan (cara 1 atau 2).

## Konfigurasi

Default di `tests/support/env.ts` cocok dengan kedua cara di atas; override lewat env var kalau perlu:

| Env var | Default |
|---|---|
| `BFF_URL` | `http://localhost:8082` |
| `PAYMENT_GATEWAY_URL` | `http://localhost:8081` |
| `LEDGER_SERVICE_URL` | `http://localhost:8080` |
| `FRAUD_CHECK_URL` | `http://localhost:8090` |
| `DATABASE_URL` | `postgres://ledger:ledger@localhost:5432/ledger` |
| `REDIS_URL` | `redis://localhost:6379` |
| `KAFKA_BROKERS` / `KAFKA_TOPIC` | `localhost:9092` / `transactions` |
| `FRAUD_CHECK_LOG` | `e2e/.run/fraud-check.log` |
| `LEGACY_CORE_DIR` | `../legacy-core` |

## Kalau gagal

- Log tiap komponen (cara 1): `e2e/.run/<komponen>.log`. Cara 2: `docker compose logs <service>`.
- `database "ledger" does not exist` saat start: pastikan versi `start-all.sh` terbaru — ia menunggu server Postgres final lewat TCP, bukan hanya `pg_isready`.
- Komponen tidak healthy dalam 60 dtk pada run pertama: biasanya download dependency; jalankan langkah pre-fetch di `ci-local.sh` sekali dulu.
- Debit ditolak `insufficient balance`: `ledger-service` tidak punya akun genesis — setiap test yang mendebit harus seed saldo langsung ke Postgres (`seedPayerBalance` di `tests/support/ledger-client.ts`), dengan idempotency key berbeda dari transaksi aslinya.
