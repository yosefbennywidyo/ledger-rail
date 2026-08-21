// Jalur A-D: BFF -> Payment Gateway -> Ledger Service -> Postgres, plus the
// Payment Gateway -> Redis idempotency cache (jalur C). Requires the real
// components running (./e2e/scripts/start-all.sh) — nothing here is mocked,
// per e2e/PLAN.md principle #1: the point is to catch bugs (e.g. JSON field
// casing mismatches) that mocks would hide.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client as PgClient } from "pg";
import { createClient as createRedisClient } from "redis";

import {
  BFF_URL,
  LEDGER_SERVICE_URL,
  PAYMENT_GATEWAY_URL,
  POSTGRES_URL,
  REDIS_URL,
} from "./support/env.js";

const pg = new PgClient({ connectionString: POSTGRES_URL });
const redis = createRedisClient({ url: REDIS_URL });

beforeAll(async () => {
  await pg.connect();
  await redis.connect();
});

afterAll(async () => {
  await pg.end();
  await redis.quit();
});

interface LedgerEntryRow {
  account_id: string;
  amount_cents: string; // bigint comes back as string from node-postgres
}

/**
 * Seeds a payer balance directly in Postgres. ledger-service enforces
 * balanced (sum-to-zero) double-entry and rejects any debit that would take
 * an account negative — there is no genesis/top-up account yet (open
 * question in PLAN.md §5), so a fresh payer always starts at 0 and this is
 * the only way to fund one for a test.
 */
async function seedPayerBalance(accountId: string, amountCents: number): Promise<void> {
  const seedKey = `seed-${accountId}`;
  await pg.query("BEGIN");
  await pg.query("INSERT INTO ledger_transactions (idempotency_key) VALUES ($1)", [seedKey]);
  await pg.query(
    "INSERT INTO ledger_entries (idempotency_key, account_id, amount_cents) VALUES ($1, $2, $3)",
    [seedKey, accountId, amountCents],
  );
  await pg.query("COMMIT");
}

async function entriesFor(idempotencyKey: string): Promise<LedgerEntryRow[]> {
  const result = await pg.query<LedgerEntryRow>(
    "SELECT account_id, amount_cents FROM ledger_entries WHERE idempotency_key = $1 ORDER BY account_id",
    [idempotencyKey],
  );
  return result.rows;
}

async function submitPayment(body: {
  payer_account: string;
  payee_account: string;
  amount_cents: number;
  idempotency_key: string;
}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${BFF_URL}/api/payments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe("health checks", () => {
  it.each([
    ["ledger-service", `${LEDGER_SERVICE_URL}/healthz`],
    ["payment-gateway", `${PAYMENT_GATEWAY_URL}/healthz`],
    ["bff", `${BFF_URL}/healthz`],
  ])("%s reports healthy", async (_name, url) => {
    const response = await fetch(url);
    expect(response.status).toBe(200);
  });
});

describe("jalur A-D: submit payment through BFF", () => {
  it("applies a balanced double-entry transaction in Postgres", async () => {
    const runId = randomUUID();
    const payerAccount = `acct-payer-${runId}`;
    const payeeAccount = `acct-payee-${runId}`;
    await seedPayerBalance(payerAccount, 100_000);

    const result = await submitPayment({
      payer_account: payerAccount,
      payee_account: payeeAccount,
      amount_cents: 1_500,
      idempotency_key: runId,
    });

    expect(result.status).toBe(201);

    const entries = await entriesFor(runId);
    expect(entries).toEqual([
      { account_id: payeeAccount, amount_cents: "1500" },
      { account_id: payerAccount, amount_cents: "-1500" },
    ]);
  });

  it("rejects a debit against an account with insufficient balance", async () => {
    const runId = randomUUID();
    const payerAccount = `acct-payer-${runId}`; // never seeded — balance is 0
    const payeeAccount = `acct-payee-${runId}`;

    const result = await submitPayment({
      payer_account: payerAccount,
      payee_account: payeeAccount,
      amount_cents: 1_500,
      idempotency_key: runId,
    });

    expect(result.status).toBe(422);
    expect(await entriesFor(runId)).toEqual([]);
  });
});

describe("jalur C: idempotency via Redis", () => {
  it("caches the outcome and does not double-apply the transaction on retry", async () => {
    const runId = randomUUID();
    const payerAccount = `acct-payer-${runId}`;
    const payeeAccount = `acct-payee-${runId}`;
    await seedPayerBalance(payerAccount, 100_000);

    const request = {
      payer_account: payerAccount,
      payee_account: payeeAccount,
      amount_cents: 2_500,
      idempotency_key: runId,
    };

    const first = await submitPayment(request);
    expect(first.status).toBe(201);

    const redisKey = `payment-gateway:idempotency:${runId}`;
    const ttl = await redis.ttl(redisKey);
    expect(ttl).toBeGreaterThan(0); // key exists with the configured TTL, not persisted forever

    const second = await submitPayment(request);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);

    // The retry must have been served entirely from the Redis cache — Postgres
    // shows exactly one debit/credit pair, not two.
    expect(await entriesFor(runId)).toEqual([
      { account_id: payeeAccount, amount_cents: "2500" },
      { account_id: payerAccount, amount_cents: "-2500" },
    ]);
  });
});
