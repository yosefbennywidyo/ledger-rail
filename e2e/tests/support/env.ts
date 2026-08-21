export const BFF_URL = process.env["BFF_URL"] ?? "http://localhost:8082";
export const PAYMENT_GATEWAY_URL =
  process.env["PAYMENT_GATEWAY_URL"] ?? "http://localhost:8081";
export const LEDGER_SERVICE_URL =
  process.env["LEDGER_SERVICE_URL"] ?? "http://localhost:8080";

export const POSTGRES_URL =
  process.env["DATABASE_URL"] ??
  "postgres://ledger:ledger@localhost:5432/ledger";

export const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

export const KAFKA_BROKERS = (process.env["KAFKA_BROKERS"] ?? "localhost:9092").split(",");
export const KAFKA_TOPIC = process.env["KAFKA_TOPIC"] ?? "transactions";

export const FRAUD_CHECK_URL = process.env["FRAUD_CHECK_URL"] ?? "http://localhost:8090";
export const FRAUD_CHECK_LOG =
  process.env["FRAUD_CHECK_LOG"] ?? new URL("../../.run/fraud-check.log", import.meta.url).pathname;

export const LEGACY_CORE_DIR =
  process.env["LEGACY_CORE_DIR"] ?? new URL("../../../legacy-core", import.meta.url).pathname;
