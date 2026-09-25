# Ledger & Rail

Simulasi mini core banking + payment gateway — proyek portofolio untuk memahami bagaimana lapisan-lapisan sistem perbankan (core ledger, payment rail, digital/BFF, fraud detection, legacy core) saling terintegrasi.

Setiap komponen adalah repo GitHub sendiri, disatukan di sini lewat **git submodule**:

| Komponen | Stack | Repo |
|---|---|---|
| `ledger-service` | Go + PostgreSQL | [github.com/yosefbennywidyo/ledger-service](https://github.com/yosefbennywidyo/ledger-service) |
| `payment-gateway` | Java (Spring Boot) + Redis | [github.com/yosefbennywidyo/payment-gateway](https://github.com/yosefbennywidyo/payment-gateway) |
| `bff` | Node.js + TypeScript | [github.com/yosefbennywidyo/bff](https://github.com/yosefbennywidyo/bff) |
| `fraud-check` | Python (Kafka consumer, opsional) | [github.com/yosefbennywidyo/fraud-check](https://github.com/yosefbennywidyo/fraud-check) |
| `legacy-core` | COBOL/GnuCOBOL batch (opsional) | [github.com/yosefbennywidyo/legacy-core](https://github.com/yosefbennywidyo/legacy-core) |

Detail arsitektur, pola komunikasi antar komponen, dan blueprint lengkap ada di `bahasa-teknologi-perbankan.md` dan `project-requirements.md` di folder induk proyek.

---

## Clone

Submodule tidak otomatis terisi dengan `git clone` biasa — wajib pakai `--recurse-submodules`:

```bash
git clone --recurse-submodules git@github.com:yosefbennywidyo/ledger-rail.git
```

Kalau terlanjur clone tanpa itu (folder komponen kosong):

```bash
git submodule update --init --recursive
```

---

## Menjalankan environment lokal

```bash
mise install                                  # Go, Java, Node, Python, Maven, uv, rpk
docker compose up -d postgres redis redpanda  # infra saja; skema Postgres otomatis diterapkan di volume baru
```

> `docker compose up -d` **tanpa nama service** juga membangun dan menjalankan
> keempat komponen aplikasi sebagai container di port 8080–8090 — jangan dipakai
> kalau mau menjalankan komponen sebagai proses lokal (port bentrok).

> **Mac dengan Postgres/Redis Homebrew:** service host yang bind `127.0.0.1:5432`
> / `:6379` menang atas port-forward Docker. Cek `lsof -nP -iTCP:5432 -sTCP:LISTEN`;
> kalau pemiliknya bukan Docker, `brew services stop postgresql@14` (dan/atau `redis`) dulu.

### Menjalankan komponen

| Komponen | Port | Jalankan (dari folder komponen) | Unit test |
|---|---|---|---|
| `ledger-service` | 8080 | `mise exec go -- go run ./cmd/ledger-service` | `mise exec go -- go test ./...` |
| `payment-gateway` | 8081 | `mise exec java maven -- mvn spring-boot:run` | `mise exec java maven -- mvn test` |
| `bff` | 8082 | `npm install && npm run dev` | `npm test` |
| `fraud-check` | 8090 (`/healthz`) | `uv sync && uv run fraud-check` | `uv sync --extra dev && uv run pytest` |
| `legacy-core` | — (batch) | lihat [`legacy-core/README.md`](legacy-core/README.md) | — |

Unit test tidak butuh infra apa pun. Detail konfigurasi (env var) ada di README
masing-masing komponen.

### Menjalankan semua sekaligus + e2e test

```bash
./e2e/scripts/start-all.sh && (cd e2e && npm test); ./e2e/scripts/stop-all.sh
```

Varian container penuh (`start-all-docker.sh`), replika CI dari state bersih
(`ci-local.sh`), menjalankan satu file test, dan troubleshooting: lihat
[`e2e/README.md`](e2e/README.md). CI GitHub Actions (`.github/workflows/e2e.yml`)
menjalankan suite yang sama di tiap push/PR ke `main`.

---

## Alur kerja git dengan submodule

Ini bagian yang paling sering kelewat kalau baru pertama kali pakai submodule — baca sebelum mulai ubah kode.

### 1. Submodule punya dua repo, bukan satu

`ledger-rail` (repo induk) **tidak menyimpan kode** komponen — ia hanya menyimpan **pointer** ke satu commit spesifik di tiap repo komponen (tercatat di `.gitmodules` + entri khusus di git index). Artinya setiap perubahan kode harus di-commit **dua kali**, di dua repo berbeda:

```
ledger-rail/               ← repo induk: hanya tahu "ledger-service ada di commit abc123"
  ledger-service/          ← checkout submodule, .git di dalamnya menunjuk ke repo ledger-service asli
```

### 2. Mengubah kode di satu komponen

```bash
cd ledger-rail/ledger-service
# ...edit kode...
git add .
git commit -m "tambah endpoint X"
git push origin main              # push ke repo ledger-service sendiri

cd ..                              # kembali ke root ledger-rail
git add ledger-service             # mencatat pointer submodule ke commit baru
git commit -m "bump ledger-service: tambah endpoint X"
git push origin main               # push ke repo ledger-rail
```

Kalau langkah terakhir (`git add ledger-service` di root + commit + push induk) dilewatkan, orang lain yang clone `ledger-rail` tetap mendapat versi **lama** `ledger-service` — commit di repo komponen tidak otomatis "terlihat" oleh induk.

### 3. Menarik update terbaru dari repo komponen

Kalau ada commit baru di `github.com/yosefbennywidyo/ledger-service` (misalnya dari mesin lain atau kolaborator) dan kamu mau menariknya ke `ledger-rail`:

```bash
git submodule update --remote ledger-service
git add ledger-service
git commit -m "bump ledger-service to latest main"
```

### 4. `git status` di induk itu buta terhadap isi submodule

Di root `ledger-rail`, `git status` hanya bilang "submodule ledger-service punya perubahan" (karena HEAD-nya bergeser atau ada file belum di-commit) — tidak menampilkan diff isinya. Untuk lihat apa yang berubah, masuk dulu ke foldernya:

```bash
cd ledger-service && git status && git diff
```

### 5. Clone kolaborator lain / mesin baru

Kolaborator yang clone `ledger-rail` mendapat kode komponen dalam kondisi **read-only terhadap remote asalnya** secara default (submodule checkout ada di `detached HEAD`, bukan di branch `main`). Kalau mereka mau ikut ngoding di salah satu komponen:

```bash
cd ledger-rail/payment-gateway
git checkout main       # keluar dari detached HEAD, baru bisa commit & push normal
git pull
```

### 6. Ringkasan command yang sering dipakai

| Situasi | Command |
|---|---|
| Clone pertama kali | `git clone --recurse-submodules <url>` |
| Lupa `--recurse-submodules` saat clone | `git submodule update --init --recursive` |
| Cek commit apa yang dipakai tiap submodule | `git submodule status` |
| Tarik commit terbaru satu submodule | `git submodule update --remote <nama>` |
| Setelah ubah kode submodule, catat di induk | `git add <nama> && git commit -m "bump <nama>"` |
| Submodule kosong / rusak | `git submodule sync --recursive && git submodule update --init --recursive` |

---

*Struktur repo dan alur submodule ini sengaja dipilih sebagai bahan belajar — untuk proyek portofolio seukuran ini, monorepo biasa sebenarnya lebih sederhana. Lihat diskusi di riwayat proyek kalau perlu konteks.*
