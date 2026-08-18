# Node.js + TypeScript — Best Practices untuk `bff`

> Diringkas dari hasil web search (WebSearch tool) pada 2026-08-18, sebelum skeleton project dibuat. Sumber utama: perbandingan framework Encore.dev ("Best TypeScript Backend Frameworks in 2026", "Best Express.js Alternatives for TypeScript Backends in 2026"), perbandingan test runner PkgPulse ("node:test vs Vitest vs Jest 2026") dan HireNodeJS ("Node.js Testing in 2026"), serta perbandingan package manager PkgPulse/dev.to ("npm vs pnpm vs Yarn 2026").

## Framework HTTP: Fastify

Express masih paling banyak dipakai, tapi didesain sebelum TypeScript/async-await jadi dukungan tipe terasa "ditempel" (perlu `@types/express` terpisah, handler tidak type-safe secara native). Fastify dibangun dengan TypeScript-first design, schema validation bawaan, dan benchmark 2026 konsisten menunjukkan Fastify jauh lebih cepat dari Express untuk beban request/detik yang sama.

Untuk `bff` — service tipis yang forward request ke `payment-gateway` — kebutuhannya sederhana (satu route utama + healthcheck), jadi overhead belajar Fastify kecil dibanding manfaat type-safety dan performanya. Dipilih Fastify, bukan Express atau NestJS (NestJS terlalu berat untuk skeleton portofolio ini — decorator/DI module tidak dibutuhkan untuk service seukuran ini).

## Package manager: npm

pnpm secara teknis lebih cepat dan lebih hemat disk (hard links, mencegah phantom dependency), tapi npm datang bundled dengan Node.js tanpa setup tambahan (tidak perlu corepack/instalasi terpisah). Untuk skeleton portofolio dengan sedikit dependency, friksi tambahan pnpm tidak sepadan — dipilih **npm** demi kesederhanaan setup (`mise exec node -- npm install`, dst). Kalau dependency tree membesar di masa depan, migrasi ke pnpm mudah (`pnpm import` dari `package-lock.json`).

## Test runner: Vitest

Untuk project baru di 2026, Vitest jadi rekomendasi default: TypeScript ditranspile instan tanpa config tambahan, ESM native, watch mode jauh lebih cepat dari Jest, dan API-nya kompatibel dengan Jest sehingga mudah dicari referensinya. `node:test` cocok untuk library/CLI tanpa dependency npm sama sekali, tapi untuk service HTTP dengan kebutuhan mocking (mock outbound call ke payment-gateway), DX Vitest (mocking bawaan via `vi.mock`/`vi.fn`) lebih baik.

## Struktur folder (`src/`)

Mengikuti konvensi umum layanan Node.js/TypeScript modern (bukan meniru `cmd/`+`internal/` Go secara literal — itu pola Go, bukan idiom Node):

```
bff/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts                     # entry point: build & start Fastify server
    app.ts                       # buildApp(): factory yang mendaftarkan route (dipisah dari index.ts supaya testable tanpa listen())
    config.ts                    # baca env var (PORT, PAYMENT_GATEWAY_URL) di satu tempat
    routes/
      payments.ts                # POST /api/payments
      health.ts                  # GET /healthz
    services/
      payment-gateway-client.ts  # HTTP client ke payment-gateway, generate idempotency_key
    __tests__/
      payment-gateway-client.test.ts
```

**Kenapa `app.ts` terpisah dari `index.ts`:** supaya unit test bisa `buildApp()` dan inject/mocking dependency (mis. `fetch` ke payment-gateway) tanpa benar-benar bind ke port — pola umum Fastify ("export buildApp, don't listen in tests").

**Kenapa `services/` terpisah dari `routes/`:** logic pembuatan `idempotency_key` dan pemanggilan HTTP ke payment-gateway adalah logic yang mau di-unit-test terpisah dari HTTP layer Fastify — mirror alasan Go project ini pakai dependency lewat constructor supaya gampang di-mock.

## Konvensi lain

- **TypeScript strict mode:** `tsconfig.json` pakai `"strict": true` (plus `noUncheckedIndexedAccess`) — konsisten dengan semangat `go vet`/`gofmt` wajib bersih di sisi Go: tidak ada shortcut type-safety.
- **ESM native:** `"type": "module"` di `package.json`, target `ES2022`/`NodeNext` — standar Node LTS 2026, tidak perlu transpile CommonJS.
- **Idempotency key digenerate di BFF:** kalau client (mobile/web) tidak mengirim `idempotency_key`, BFF generate `crypto.randomUUID()` — supaya retry dari client yang sama tetap idempoten walau client tidak sempat implement idempotency key sendiri. Kalau client kirim, BFF pakai apa adanya (supaya retry dari client dengan key yang sama benar-benar idempoten di payment-gateway).
- **Tidak ada database/auth:** BFF ini murni proxy/orchestration layer ke payment-gateway, sesuai scope skeleton portofolio — tidak over-engineered.

## Yang sengaja belum dipakai

- Tidak pakai Zod/JSON-Schema validation library terpisah — Fastify's built-in JSON Schema validation (lewat `schema` option di route) cukup untuk skeleton ini. Bisa ditambah Zod (`fastify-type-provider-zod`) kalau butuh validasi lebih kompleks nanti.
- Tidak pakai `undici`/axios sebagai HTTP client eksplisit — `fetch` global sudah tersedia di Node 18+ tanpa dependency tambahan.
