# Roadmap Fitur — Ledger & Rail

> Disusun 2026-09-25 ~14:58 WIB, setelah semua jalur e2e (A–G) + CI selesai (lihat
> [`e2e/PLAN.md`](../e2e/PLAN.md)). Status terkini & langkah berikutnya: [`HANDOFF.md`](../HANDOFF.md).

## Tujuan

Tiga tujuan dengan bobot setara (keputusan user 2026-09-25):

1. **Kedalaman teknis** — memecahkan masalah perbankan sungguhan dengan benar: konsistensi saldo
   di bawah konkurensi, event yang tidak hilang, pembatasan laju.
2. **Cakupan domain** — menyentuh standar & kontrol industri: ISO 20022/8583, Vault + mTLS,
   audit trail, observability.
3. **Produk yang bisa didemokan** — alur utuh yang bisa dipakai orang: buka rekening, top-up,
   transfer, lihat saldo & mutasi, lihat status fraud.

**Prinsip urutan:** ketergantungan dulu. Demo di atas ledger yang bisa overdraft tidak meyakinkan
→ kebenaran ledger lebih dulu; API akun dibutuhkan demo **dan** fraud loop → sebelum keduanya;
fitur domain dibangun di atas fondasi yang sudah benar.

## Proses per sub-proyek

Tiap sub-proyek punya siklus sendiri: **design (brainstorming) → spec
`docs/superpowers/specs/YYYY-MM-DD-<topik>-design.md` → rencana implementasi → eksekusi → e2e +
CI hijau → commit & push** (submodule dulu, lalu bump di induk). SP-0 cukup design singkat di chat
(perubahan kecil pada kode yang sudah ada). Roadmap ini hanya pemecahan & urutan — **belum ada
design yang disetujui untuk sub-proyek mana pun.**

## Sub-proyek

| # | Sub-proyek | Tujuan | Ukuran | Status |
|---|---|---|---|---|
| SP-0 | Perapian | fondasi | kecil | belum |
| SP-1 | Kebenaran ledger (konkurensi + outbox) | kedalaman | sedang | belum — **berikutnya** |
| SP-2 | Akun & saldo | produk | sedang | belum |
| SP-3 | Rate limiting | kedalaman | kecil | belum |
| SP-4 | Tindak lanjut fraud | produk + kedalaman | sedang | belum |
| SP-5 | UI demo | produk | sedang | belum |
| SP-6 | Observability & audit trail | kedalaman + domain | sedang | belum |
| SP-7 | Vault + mTLS | domain | besar | belum |
| SP-8 | Standar pesan ISO 20022 (8583 opsional) | domain | besar | belum |

### SP-0 — Perapian

**Masalah (terverifikasi 2026-09-25):**
- CI: `ledger-service` baru healthy setelah **51 dtk** (run 36105169709) karena `go run` compile
  dulu, sementara `start-all.sh` memberi batas 60 dtk (`e2e/scripts/start-all.sh:60`) → risiko flaky.
- bff mengembalikan `"result": null` untuk 422: payment-gateway mengirim pesan penolakan sebagai
  teks polos, bff parse sebagai JSON (`bff/src/services/payment-gateway-client.ts:80`).
- Belum ada CI unit test per repo submodule (Tahap 4 `e2e/PLAN.md`).

**Selesai bila:** build binary dulu lalu jalankan (atau pre-build di langkah prefetch CI) sehingga
waktu healthy jauh di bawah batas; penolakan 422 sampai ke klien sebagai JSON terstruktur
(`{"error": "...", ...}`) dengan test unit + e2e; tiap submodule punya workflow unit test yang hijau.

### SP-1 — Kebenaran ledger

**Masalah (terverifikasi di kode):**
- **Overdraft saat konkuren.** `ledger.Service.Post` membaca saldo lewat `repo.Balance`
  (`ledger-service/internal/ledger/ledger.go:71`) **di luar** transaksi DB, lalu `repo.Apply`
  (`:80`) membuka transaksi baru tanpa lock. Dua debit bersamaan dari akun yang sama sama-sama lolos
  cek saldo.
- **Event bisa hilang.** Publish Kafka dilakukan setelah commit dan kegagalannya hanya di-log
  (`ledger.go:87`) — dual-write tanpa outbox, fraud-check/audit bisa melewatkan transaksi.
- Cek idempotency juga di luar transaksi: dua request dengan key sama yang konkuren → salah satunya
  kena pelanggaran PK dan dijawab 422, bukan replay 201.

**Arah (akan diputuskan di design):** cek saldo + tulis dalam satu transaksi dengan lock per akun
(`SELECT … FOR UPDATE` pada baris saldo/akun, atau advisory lock, atau `SERIALIZABLE` + retry);
**transactional outbox** (tabel `outbox` ditulis di transaksi yang sama, relay terpisah publish ke
Redpanda, at-least-once + konsumen idempoten).

**Selesai bila:** test e2e konkurensi (N debit paralel dari satu akun bersaldo terbatas) tidak
pernah menghasilkan saldo negatif; test yang mematikan Redpanda saat transaksi → event tetap
terkirim setelah Redpanda hidup lagi; request idempotency konkuren dijawab konsisten.

### SP-2 — Akun & saldo

**Masalah:** API ledger hanya `POST /transactions` + `/healthz`. Tidak ada cara membuka rekening,
tidak ada akun genesis/top-up (test harus seed saldo via SQL — `seedPayerBalance` di
`e2e/tests/support/ledger-client.ts`), tidak ada cara melihat saldo/mutasi tanpa SQL.

**Arah:** entitas akun (buka rekening, status), akun sistem (mis. `cash`/settlement) sebagai
sumber top-up yang boleh negatif, `GET` saldo & mutasi (paginasi), semuanya diekspos lewat bff.

**Selesai bila:** e2e tidak lagi seed saldo lewat SQL; alur buka rekening → top-up → transfer →
lihat mutasi lulus lewat bff.

### SP-3 — Rate limiting

**Masalah:** blueprint menyebut Redis sebagai "Idempotency & Rate Limit Store"
(`project-requirements.md` §1), baru idempotency yang dibangun.

**Arah:** token bucket atomik di Redis (Lua / `INCR`+TTL) per akun/klien di payment-gateway,
respons 429 + `Retry-After`, diteruskan apa adanya oleh bff.

**Selesai bila:** unit test algoritma + e2e burst yang menghasilkan 429 tepat setelah kuota habis.

### SP-4 — Tindak lanjut fraud

**Masalah:** fraud-check hanya menulis skor ke log; tidak ada keputusan yang tersimpan atau
terlihat.

**Arah:** fraud-check publish keputusan ke topic `fraud-decisions`; ledger (atau layanan kecil)
mengonsumsinya dan menandai transaksi *flagged*; status terlihat lewat API (butuh SP-2).
Model tetap post-settlement (sesuai desain async) — bukan pre-authorization hold, kecuali design
memutuskan lain.

**Selesai bila:** transaksi anomali muncul sebagai *flagged* lewat API dalam e2e.

### SP-5 — UI demo

**Arah:** web kecil di atas bff: daftar rekening, top-up, transfer (dengan idempotency key dari
klien), mutasi, badge fraud. Butuh SP-2 (dan SP-4 untuk badge).

**Selesai bila:** alur demo bisa dijalankan dari browser terhadap stack Docker; smoke test browser
di CI atau skrip terdokumentasi.

### SP-6 — Observability & audit trail

**Arah:** OpenTelemetry tracing lintas Go/Java/Node/Python (trace id ikut ke header Kafka),
backend lokal (mis. Jaeger/Tempo di compose); konsumen audit trail append-only dari topic
transaksi.

**Selesai bila:** satu pembayaran terlihat sebagai satu trace utuh bff → gateway → ledger →
Kafka → fraud-check; e2e memverifikasi baris audit untuk tiap transaksi.

### SP-7 — Vault + mTLS

**Masalah:** Vault sudah ada di `docker-compose.yml` (mode dev, root token) tapi tak satu service
pun memakainya; komunikasi antar service plaintext HTTP.

**Arah:** kredensial Postgres dinamis dari Vault database secrets engine untuk ledger-service;
PKI Vault menerbitkan sertifikat untuk mTLS antar service.

**Selesai bila:** tidak ada password DB statis di konfigurasi service; request tanpa sertifikat
klien valid ditolak; e2e tetap hijau.

### SP-8 — Standar pesan

**Arah:** adapter ISO 20022 `pacs.008` (credit transfer) masuk ke payment-gateway — parse &
validasi XML, petakan ke alur pembayaran yang ada, balas `pacs.002` (status report). ISO 8583
(kartu) opsional sesudahnya.

**Selesai bila:** contoh `pacs.008` valid menghasilkan transaksi di ledger + `pacs.002` ACSC;
pesan tidak valid menghasilkan `pacs.002` RJCT dengan reason code.
