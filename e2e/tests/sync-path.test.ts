// Synchronous path: BFF -> Payment Gateway -> Ledger Service -> Postgres,
// plus the Payment Gateway -> Redis idempotency cache. Requires the real
// components running (./e2e/scripts/start-all.sh) — nothing here is mocked,
// per e2e/PLAN.md principle #1: the point is to catch bugs (e.g. JSON field
// casing mismatches) that mocks would hide.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client as PgClient } from "pg";
import { createClient as createRedisClient } from "redis";

import { BFF_URL, LEDGER_SERVICE_URL, PAYMENT_GATEWAY_URL, POSTGRES_URL, REDIS_URL } from "./support/env.js";
import { entriesFor, getAccountBalance, openAccount, submitPayment, topUp } from "./support/ledger-client.js";

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

describe("submit payment through BFF", () => {
  it("applies a balanced double-entry transaction in Postgres", async () => {
    const runId = randomUUID();
    const payerAccount = await openAccount("Payer");
    const payeeAccount = await openAccount("Payee");
    await topUp(payerAccount, 100_000);

    const result = await submitPayment({
      payer_account: payerAccount,
      payee_account: payeeAccount,
      amount_cents: 1_500,
      idempotency_key: runId,
    });

    expect(result.status).toBe(201);

    // entriesFor orders by account_id, and both ids are now real UUIDs (no
    // longer a stable "payee" < "payer" prefix ordering), so compare as a
    // set rather than asserting a fixed row order.
    const entries = await entriesFor(pg, runId);
    expect(entries).toEqual(
      expect.arrayContaining([
        { account_id: payeeAccount, amount_cents: "1500" },
        { account_id: payerAccount, amount_cents: "-1500" },
      ]),
    );
    expect(entries).toHaveLength(2);

    // Prove the new read endpoint end-to-end: the API-reported balance must
    // match what Postgres actually holds.
    expect(await getAccountBalance(payerAccount)).toBe(100_000 - 1_500);
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
    expect(await entriesFor(pg, runId)).toEqual([]);
  });
});

describe("idempotency via Redis", () => {
  it("caches the outcome and does not double-apply the transaction on retry", async () => {
    const runId = randomUUID();
    const payerAccount = await openAccount("Payer");
    const payeeAccount = await openAccount("Payee");
    await topUp(payerAccount, 100_000);

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
    // shows exactly one debit/credit pair, not two. (Order-independent: see
    // the comment on the first test in this file.)
    const entries = await entriesFor(pg, runId);
    expect(entries).toEqual(
      expect.arrayContaining([
        { account_id: payeeAccount, amount_cents: "2500" },
        { account_id: payerAccount, amount_cents: "-2500" },
      ]),
    );
    expect(entries).toHaveLength(2);
  });
});
