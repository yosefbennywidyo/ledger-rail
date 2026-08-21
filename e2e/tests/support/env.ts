export const BFF_URL = process.env["BFF_URL"] ?? "http://localhost:8082";
export const PAYMENT_GATEWAY_URL =
  process.env["PAYMENT_GATEWAY_URL"] ?? "http://localhost:8081";
export const LEDGER_SERVICE_URL =
  process.env["LEDGER_SERVICE_URL"] ?? "http://localhost:8080";

export const POSTGRES_URL =
  process.env["DATABASE_URL"] ??
  "postgres://ledger:ledger@localhost:5432/ledger";

export const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
