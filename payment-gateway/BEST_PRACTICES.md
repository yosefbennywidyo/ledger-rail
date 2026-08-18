# Java / Spring Boot — Best Practices untuk `payment-gateway`

> Diringkas dari riset web pada 2026-08-18, sebelum skeleton project dibuat. Sumber utama:
> - [Recommended Package Structure of a Spring Boot Project — Baeldung](https://www.baeldung.com/spring-boot-package-structure)
> - [Getting Started: Creating a Multi Module Project — spring.io guides](https://spring.io/guides/gs/multi-module/)
> - [Multi-Project Build Structure — spring-projects/spring-boot (DeepWiki)](https://deepwiki.com/spring-projects/spring-boot/2.1-multi-project-build-structure)
> - Pengecekan langsung: `start.spring.io` masih mengeset **Maven** sebagai pilihan default pertama untuk project baru per Agustus 2026; Gradle tetap didukung penuh dan populer di project besar/multi-module.

## Build tool: Maven (bukan Gradle)

Alasan pemilihan untuk skeleton ini:
- `payment-gateway` adalah single-module, tidak butuh build-logic custom atau multi-project composite build — keunggulan utama Gradle (incremental build cepat, DSL fleksibel) baru terasa penting di project besar/multi-module.
- Maven (`pom.xml`) bersifat deklaratif murni, lebih predictable untuk dibaca reviewer yang tidak sehari-hari menyentuh project ini — cocok untuk skeleton portfolio yang mengutamakan keterbacaan.
- `spring-boot-starter-parent` menyediakan dependency management (versi Spring Boot, plugin) tanpa perlu version catalog manual seperti di Gradle.
- Tersedia via `mise` (`maven = "latest"`), konsisten dengan cara tool lain di repo ini di-manage (`go`, `java`, `node`, dst).

Trade-off yang disadari: Gradle build lebih cepat untuk project besar (incremental compilation, build cache) dan closer to Kotlin DSL ecosystem — kalau `payment-gateway` nanti berkembang jadi multi-module (mis. pisah `api` dan `client` module), evaluasi ulang Gradle masuk akal.

## Struktur paket: layer-based, bukan feature-based

Baeldung menjabarkan dua pola populer: package-by-layer (`controller/`, `service/`, `repository/`) dan package-by-feature (`product/` berisi `ProductController`, `ProductService`, dst dalam satu paket). Untuk skeleton ini dipilih **layer-based** karena scope-nya sengaja kecil (satu use case: `POST /payments`) — package-by-feature baru memberi manfaat modularitas ketika ada banyak domain/fitur yang perlu diisolasi satu sama lain.

```
payment-gateway/
  pom.xml
  src/main/java/rail/ledger/paymentgateway/
    PaymentGatewayApplication.java   # @SpringBootApplication, entry point — tidak ada logic bisnis
    web/                              # REST controllers (adapter layer masuk)
      PaymentController.java
      HealthController.java
      GlobalExceptionHandler.java
    service/                          # domain/orchestration logic
      PaymentService.java
    client/                           # adapter layer keluar (HTTP ke ledger-service)
      LedgerServiceClient.java
      LedgerServiceException.java
    idempotency/                      # Redis-backed idempotency store
      IdempotencyStore.java
    dto/                              # request/response records, dipakai lintas layer
      ...
    config/                           # @Configuration beans (RestClient, Redis, ObjectMapper)
      ...
  src/main/resources/
    application.properties
  src/test/java/rail/ledger/paymentgateway/
    service/PaymentServiceTest.java
    idempotency/IdempotencyStoreTest.java
```

Kalau nanti bertambah fitur besar (mis. refund flow terpisah), pertimbangkan migrasi ke package-by-feature per modul.

## Konvensi lain yang dipegang di skeleton ini

- **Constructor injection, bukan field injection (`@Autowired` di field):** memudahkan test dengan mock manual/Mockito tanpa Spring context, sama semangatnya dengan `NewService(repo Repository)` di `ledger-service` (Go).
- **DTO immutable pakai Java `record`:** request/response tidak butuh setter, cocok untuk payload yang sekali-bentuk lalu diserialisasi.
- **Idempotency check sebelum I/O lain:** endpoint `/payments` cek Redis dulu sebelum memanggil `ledger-service` — mismatch antara "sudah pernah diproses" vs "baru" ditentukan di titik paling awal, sama seperti pola idempotency key di `ledger-service`.
- **Business error vs infra error dipisahkan secara eksplisit:** respons 422 dari `ledger-service` (business rejection, mis. saldo tidak cukup) diteruskan sebagai 422 ke caller; kegagalan koneksi/timeout ke `ledger-service` diteruskan sebagai 502. Ini menghindari caller salah retry pada error yang sebenarnya permanen (saldo tidak cukup tidak akan berubah dengan retry).
- **Unit test tidak butuh service eksternal running:** `LedgerServiceClient` di-mock di unit test (`PaymentServiceTest`) — konsisten dengan filosofi table-driven test `ledger-service` yang menguji domain logic lewat interface repository palsu, bukan koneksi database asli.
- **`server.port=8081`:** `ledger-service` sudah memakai 8080.

## Yang sengaja belum dipakai di skeleton awal

- **Vault integration nyata:** kredensial (kalau nanti butuh DB atau API key eksternal) idealnya diambil dari Vault (`localhost:8200`, root token `dev-root-token` di dev) lewat Spring Cloud Vault atau HTTP client langsung ke Vault API. Titik hook idealnya di `config/` (mis. `VaultConfig.java` yang resolve secret sebelum bean lain dibuat), tapi ini disengaja belum dibangun — future work sesuai instruksi task.
- **Event ke Kafka/Redpanda (`payment.initiated`):** disebutkan sebagai opsional di task, belum diimplementasi di skeleton ini. Titik hook alami: `PaymentService` publish event setelah sukses memanggil `ledger-service`, sebelum return ke caller.
- **Persistence lain di luar Redis:** tidak ada database khusus payment-gateway — state hanya idempotency cache di Redis dengan TTL 24 jam. `ledger-service` (Postgres) tetap jadi source of truth untuk data transaksi.
- **Auth/authorization:** tidak ada di skeleton ini, sesuai instruksi task ("no auth").
