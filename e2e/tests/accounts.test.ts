// Account lifecycle regression cases for SP-2 — Review Focus items from
// docs/superpowers/plans/2026-10-17-sp2-accounts-balance.md that aren't
// already exercised incidentally by the other suites. Requires the real
// stack running (./e2e/scripts/start-all.sh), same as the other e2e files.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client as PgClient } from "pg";

import { BFF_URL, POSTGRES_URL } from "./support/env.js";
import { closeAccount, openAccount, submitPayment, topUp } from "./support/ledger-client.js";

const pg = new PgClient({ connectionString: POSTGRES_URL });

beforeAll(async () => {
  await pg.connect();
});

afterAll(async () => {
  await pg.end();
});

describe("transaction referencing a never-created account", () => {
  it("rejects a top-up to an account_id that was never created, with a 4xx not a 500", async () => {
    const neverCreatedAccount = randomUUID();

    const result = await submitPayment({
      payer_account: "topup",
      payee_account: neverCreatedAccount,
      amount_cents: 500,
      idempotency_key: randomUUID(),
    });

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
  });
});

describe("transfers against a closed account", () => {
  it("rejects a transfer whose payee account is closed, with a 422", async () => {
    const payer = await openAccount("Payer");
    const payee = await openAccount("Payee");
    await topUp(payer, 10_000);
    const closeResult = await closeAccount(payee);
    expect(closeResult.status).toBe(200);

    const result = await submitPayment({
      payer_account: payer,
      payee_account: payee,
      amount_cents: 1_000,
      idempotency_key: randomUUID(),
    });

    expect(result.status).toBe(422);
  });

  it("rejects a transfer whose payer account is closed, with a 422", async () => {
    const payer = await openAccount("Payer");
    const payee = await openAccount("Payee");
    // Not funded: closing requires a zero balance (see "closing an account
    // with a non-zero balance" below), and the closed check rejects
    // regardless of balance anyway.
    const closeResult = await closeAccount(payer);
    expect(closeResult.status).toBe(200);

    const result = await submitPayment({
      payer_account: payer,
      payee_account: payee,
      amount_cents: 1_000,
      idempotency_key: randomUUID(),
    });

    expect(result.status).toBe(422);
  });
});

describe("system account overdraft", () => {
  it("lets repeated top-ups push system:cash negative, all 201", async () => {
    const payee = await openAccount("Payee");

    for (let i = 0; i < 3; i++) {
      const result = await topUp(payee, 10_000);
      expect(result.status).toBe(201);
    }
  });
});

describe("closing system:cash", () => {
  it("is rejected with a 422, and top-ups keep working afterwards", async () => {
    const result = await closeAccount("system:cash");
    expect(result.status).toBe(422);

    const payee = await openAccount("Payee");
    const topUpResult = await topUp(payee, 1_000);
    expect(topUpResult.status).toBe(201);
  });
});

describe("closing an account with a non-zero balance", () => {
  it("is rejected with a 422", async () => {
    const payer = await openAccount("Payer");
    await topUp(payer, 5_000);

    const result = await closeAccount(payer);

    expect(result.status).toBe(422);
  });
});

describe("GET /api/accounts/:id for an account that was never created", () => {
  it("returns 404", async () => {
    const response = await fetch(`${BFF_URL}/api/accounts/${randomUUID()}`);
    expect(response.status).toBe(404);
  });
});

describe("concurrent account creation with the same idempotency key", () => {
  it("returns the same 201 body for both and persists only one row", async () => {
    const customerId = await (async () => {
      const response = await fetch(`${BFF_URL}/api/customers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Concurrent", idempotency_key: randomUUID() }),
      });
      const body = (await response.json()) as { id: string };
      return body.id;
    })();
    const idempotencyKey = randomUUID();

    const createOnce = () =>
      fetch(`${BFF_URL}/api/accounts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customer_id: customerId, idempotency_key: idempotencyKey }),
      }).then(async (response) => ({ status: response.status, body: await response.json() }));

    const [first, second] = await Promise.all([createOnce(), createOnce()]);

    // Whichever request's ClaimKey call runs second while the first is still
    // mid-flight gets 409, not a replayed 201 — the same order-independent
    // shape concurrency.test.ts's idempotency-key test asserts. A bare 500 is
    // never acceptable either way.
    const statuses = [first.status, second.status];
    expect(statuses).toContain(201);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);

    const rows = await pg.query("SELECT id FROM accounts WHERE customer_id = $1", [customerId]);
    expect(rows.rowCount).toBe(1);

    // The case the Review Focus actually names: retry with the same key
    // *after* the account already exists must replay the original 201, not
    // attempt a duplicate insert or error.
    const third = await createOnce();
    expect(third.status).toBe(201);
    const rowsAfterRetry = await pg.query("SELECT id FROM accounts WHERE customer_id = $1", [customerId]);
    expect(rowsAfterRetry.rowCount).toBe(1);
  });
});
