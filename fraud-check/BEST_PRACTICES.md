# Python — Best Practices untuk `fraud-check`

> Diringkas dari Python Packaging User Guide (packaging.python.org, "src layout vs flat layout"), dokumentasi Redpanda (`docs.redpanda.com/current/develop/kafka-clients/`), dan riset perbandingan `aiokafka` vs `confluent-kafka`/`kafka-python` pada 2026-08-18, sebelum skeleton project dibuat.

## Kenapa "async Kafka consumer", bukan "dipanggil sinkron sebelum settlement"

Ada dua deskripsi Fraud Check di dokumen desain proyek yang saling tidak konsisten:

- Tabel di `bahasa-teknologi-perbankan.md` bagian 7 (baris "Fraud Check (opsional)") menyebut "Model anomali transaksi **sebelum settlement**" — kalimat ini terbaca seperti jalur sinkron.
- Tapi bagian "Bagaimana antar komponen berkomunikasi" (juga di bagian 7, dan diulang lebih rinci di `project-requirements.md` bagian 5) eksplisit menaruh Fraud Check sebagai konsumen event **asinkron** setelah Ledger Service publish ke Kafka: *"Ledger Service publish event ke Kafka/Redpanda. Event ini dikonsumsi Fraud Check, layanan notifikasi, dan proses rekonsiliasi/audit trail — semuanya di luar jalur kritis, boleh telat beberapa detik."*

Deskripsi kedua lebih detail dan konsisten di dua dokumen berbeda, jadi skeleton ini dibangun sebagai **Kafka consumer asinkron** sesuai desain tersebut. Tabel di bagian 7 tidak diubah — itu di luar scope komponen ini.

**Catatan status:** `ledger-service` (Go) belum publish event ke Kafka sama sekali (wiring producer belum dibangun di sisi Go). Karena itu belum ada producer nyata untuk komponen ini — consumer diuji dengan memproduksi pesan contoh secara manual lewat `rpk topic produce`, mengikuti skema event yang sudah disepakati:

```json
{"idempotency_key": "string", "entries": [{"account_id": "string", "amount_cents": <int64>}]}
```

## Struktur folder (`src/` layout)

```
fraud-check/
  pyproject.toml
  uv.lock
  src/
    fraud_check/
      __init__.py
      config.py      # env-based config, satu tempat
      scoring.py      # model anomali + fungsi scoring (testable tanpa Kafka)
      consumer.py      # loop konsumsi Kafka async
      health.py        # server GET /healthz di thread terpisah
      main.py          # wiring: config -> model -> health -> consumer, signal handling
  tests/
    test_scoring.py
```

**Kenapa `src/` layout, bukan flat layout:** menurut Python Packaging User Guide, `src/` layout mencegah import tidak sengaja terhadap kode development di working directory alih-alih paket yang benar-benar ter-install — test jadi berjalan melawan paket yang di-*install* (lewat `uv sync`/editable install), bukan file mentah di root repo. Ini analog dengan alasan `internal/` dipakai di `ledger-service` (Go): memisahkan apa yang "dipublikasikan/dipakai" dari struktur repo mentah. `tests/` diletakkan di top-level, bukan di dalam `src/`, sesuai rekomendasi yang sama — memisahkan kode aplikasi dari kode test.

## Dependency management: `uv`, bukan `pip` + `venv` manual

Riset per 2026-08-18 (beberapa artikel pembanding `pip` vs `uv` tahun 2026) konsisten menyebut: mayoritas project Python baru di 2026 sebaiknya default ke `uv` — lebih cepat, satu tool untuk venv + resolver + lockfile, menggantikan kombinasi `pip` + `pip-tools` + `virtualenv`. `pip` + `venv` manual tetap jadi fallback yang valid kalau kompatibilitas maksimum lebih penting daripada kecepatan, tapi untuk skeleton baru ini `uv` dipilih:

- `pyproject.toml` sebagai satu-satunya sumber metadata + dependency (bukan `requirements.txt` terpisah).
- `uv.lock` mengunci versi persis semua dependency (termasuk transitive) — setara dengan `go.sum` di `ledger-service`.
- `uv` ditambahkan ke `../.mise.toml` (tool-level, sejajar dengan `python`, `rpk`, dll) supaya konsisten dengan cara project ini mengelola tool lewat `mise` alih-alih instalasi global ad-hoc.

Perintah dasar (dari folder `fraud-check/`):

```bash
mise exec uv -- uv sync --extra dev   # install semua dependency + dev deps (pytest) ke .venv
mise exec uv -- uv run pytest -v      # jalankan unit test
mise exec uv -- uv run fraud-check    # jalankan consumer (entry point di pyproject.toml)
```

## Kafka client: `aiokafka`, bukan `confluent-kafka`/`kafka-python`

Dokumentasi Redpanda (`docs.redpanda.com/current/develop/kafka-clients/`) secara eksplisit memvalidasi dua client Python: **`kafka-python`** dan **`confluent-kafka-python`** (berbasis `librdkafka`). `aiokafka` tidak ada di daftar tervalidasi itu — tapi dokumentasi yang sama menyatakan client manapun yang mengimplementasikan Kafka protocol versi 0.11+ "bekerja dengan Redpanda dengan perubahan minimal atau tanpa perubahan", dan Redpanda memang mengklaim kompatibilitas protokol Kafka penuh (bukan reimplementasi terpisah).

`aiokafka` dipilih meskipun tidak ada di daftar resmi Redpanda, karena:

- Task ini secara eksplisit meminta **async consumer** — `aiokafka` dibangun di atas `asyncio` secara native, sedangkan `confluent-kafka-python` (berbasis `librdkafka`, blocking C extension) dan `kafka-python` (blocking, pure Python) keduanya butuh dibungkus manual (mis. `run_in_executor`) untuk dipakai di event loop asyncio.
- `aiokafka` aktif dipelihara (rilis terbaru April 2026 per PyPI, bagian dari organisasi `aio-libs`, mendukung Python 3.10–3.14).
- Untuk skeleton portofolio yang cuma butuh consume-and-log, kompatibilitas dasar protokol Kafka (yang didukung Redpanda) sudah cukup — tidak butuh fitur khusus `librdkafka` (mis. exactly-once transactional producer) yang jadi alasan utama orang memilih `confluent-kafka-python`.

**Trade-off yang disadari:** karena `aiokafka` tidak divalidasi resmi oleh Redpanda, ada risiko kecil ketidakcocokan pada fitur edge-case (compression codec tertentu, protocol negotiation lanjutan). Selama pengujian end-to-end skeleton ini, memang ditemukan `aiokafka` gagal decode batch yang dikompres `snappy` (`UnsupportedCodecError`, karena library `python-snappy` tidak ter-install) — solusinya untuk testing manual, produce tanpa kompresi: `rpk topic produce transactions --brokers localhost:9092 -z none`. Kalau nanti `ledger-service` mem-publish event sungguhan, compression codec produser harus disepakati (atau dependency `python-snappy`/`lz4`/`zstandard` ditambahkan di sisi consumer).

## Model anomali: `IsolationForest` dari `scikit-learn`, dilatih pada data SINTETIS

**Ini bukan model fraud sungguhan.** Belum ada data transaksi historis di proyek ini (`ledger-service` belum publish event nyata), jadi `scoring.py` membangkitkan dataset sintetis sendiri saat start-up:

- ~950 sampel "normal" dari distribusi normal (mean ≈ Rp 1.500,00, dalam cents) mensimulasikan transaksi harian yang khas.
- ~50 sampel "outlier" dari distribusi uniform pada rentang jauh di luar cluster normal (Rp 50.000,00 – Rp 500.000,00), mensimulasikan transaksi ekstrem.
- `IsolationForest(contamination=0.05)` dilatih sekali di awal proses (bukan online/incremental), lalu dipakai untuk men-skor `max(abs(amount_cents))` dari setiap event transaksi yang masuk.

Setiap fungsi dan class terkait (`AnomalyModel`, `_synthetic_training_data`) diberi docstring/komentar yang menegaskan sifat ilustratif ini. Tujuannya menunjukkan **pola integrasi** ML ke jalur event (train sekali, score per-event, log skor + flag) — bukan riset deteksi fraud.

## Konvensi lain yang dipegang di skeleton ini

- **Config lewat environment variable saja** (`config.py`), tanpa file config atau integrasi Vault — konsisten dengan status Vault di desain proyek ("dipanggil service manapun saat startup untuk ambil secret", belum diwajibkan untuk skeleton awal).
- **Satu log-line terstruktur per transaksi**: `idempotency_key`, `amount_cents`, `anomaly_score`, `flagged` — memudahkan grep/observability meski belum ada log aggregator sungguhan.
- **Shutdown kooperatif, bukan cancellation-based**: loop consumer di `consumer.py` mem-poll satu pesan dengan timeout pendek dan mengecek `stop_event` di antara poll, lalu memanggil `consumer.stop()` tepat sekali di luar konteks yang sedang di-cancel. Percobaan awal memakai `task.cancel()` langsung terhadap task yang sedang `async for message in consumer` sempat membuat proses macet (hang) saat shutdown — kemungkinan race dengan coroutine internal `aiokafka` sendiri saat cancel tiba persis di titik await yang salah. Pola polling ini lebih dapat diprediksi untuk service yang harus merespons `SIGTERM`/`SIGINT` dengan bersih.
- **`GET /healthz` di thread terpisah, bukan proses/port berbeda**: dijalankan lewat `http.server.ThreadingHTTPServer` di background daemon thread (lihat `health.py`) — cukup untuk satu endpoint, tidak perlu framework ASGI (FastAPI/Starlette) hanya untuk health check. Konsisten dengan prinsip "jangan pilih dependency eksternal kalau stdlib cukup" yang juga dipegang di `ledger-service` (Go pakai `net/http` standar, bukan Gin/Echo, untuk skeleton awal).
- **Type hints + `from __future__ import annotations`**: dipakai konsisten di semua modul, meski belum ada `mypy`/`pyright` di CI — memudahkan pembacaan tanpa menambah dependency lint di skeleton awal.

## Yang sengaja belum dipakai di skeleton awal

- **Vault**: fraud-check tidak butuh secret apa pun saat ini (tidak ada kredensial database, broker Kafka lokal tanpa auth) — integrasi Vault ditunda sampai ada secret sungguhan yang perlu diambil.
- **Retry/dead-letter queue** untuk pesan yang gagal di-parse: pesan malformed saat ini hanya di-log sebagai warning dan di-skip (lihat `_process_message` di `consumer.py`) — cukup untuk skeleton, belum ada topic DLQ terpisah.
- **Linter/formatter (`ruff`, `black`)**: belum ditambahkan sebagai dependency dev; ditambahkan nanti kalau kebutuhannya jelas (mis. lint CI baru mau dibangun bersama komponen lain).
