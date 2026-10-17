// Concurrency correctness for SP-1: overdraft prevention and idempotency-key
// races against the real stack (BFF -> Payment Gateway -> Ledger Service ->
// Postgres). Requires ./e2e/scripts/start-all.sh (or ci-local.sh).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client as PgClient } from "pg";

import { POSTGRES_URL } from "./support/env.js";
import { openAccount, submitPayment, topUp } from "./support/ledger-client.js";

const pg = new PgClient({ connectionString: POSTGRES_URL });

beforeAll(async () => {
  await pg.connect();
});

afterAll(async () => {
  await pg.end();
});

async function finalBalance(accountId: string): Promise<number> {
  const result = await pg.query<{ balance: string }>(
    "SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM ledger_entries WHERE account_id = $1",
    [accountId],
  );
  return Number(result.rows[0]!.balance);
}

describe("concurrent debits never overdraw an account", () => {
  it("lets exactly as many debits succeed as the balance covers", async () => {
    const payer = await openAccount("Payer");
    const payee = await openAccount("Payee");
    await topUp(payer, 1_000);

    // 5 concurrent debits of 300 each against a balance of 1,000: at most 3
    // can succeed (900 cents moved), never all 5 (which would overdraw to -500).
    const attempts = Array.from({ length: 5 }, () =>
      submitPayment({
        payer_account: payer,
        payee_account: payee,
        amount_cents: 300,
        idempotency_key: randomUUID(),
      }),
    );
    const results = await Promise.all(attempts);

    const succeeded = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 422).length;
    expect(succeeded).toBe(3);
    expect(rejected).toBe(2);
    expect(await finalBalance(payer)).toBe(1_000 - succeeded * 300);
  });

  it("locks accounts in a consistent order regardless of transfer direction", async () => {
    const accountA = await openAccount("A");
    const accountB = await openAccount("B");
    await topUp(accountA, 1_000);
    await topUp(accountB, 1_000);

    // Opposite-direction transfers between the same two accounts, fired at
    // once — must not deadlock or time out.
    const [aToB, bToA] = await Promise.all([
      submitPayment({
        payer_account: accountA,
        payee_account: accountB,
        amount_cents: 100,
        idempotency_key: randomUUID(),
      }),
      submitPayment({
        payer_account: accountB,
        payee_account: accountA,
        amount_cents: 100,
        idempotency_key: randomUUID(),
      }),
    ]);

    expect(aToB.status).toBe(201);
    expect(bToA.status).toBe(201);
    expect(await finalBalance(accountA)).toBe(1_000);
    expect(await finalBalance(accountB)).toBe(1_000);
  });
});

describe("concurrent requests with the same idempotency key", () => {
  it("settles to one consistent outcome, replayed identically afterwards", async () => {
    const payer = await openAccount("Payer");
    const payee = await openAccount("Payee");
    await topUp(payer, 1_000);
    const key = randomUUID();
    const body = { payer_account: payer, payee_account: payee, amount_cents: 100, idempotency_key: key };

    const [first, second] = await Promise.all([submitPayment(body), submitPayment(body)]);

    // At least one 201 must appear; the other is either a replayed 201 or a
    // 409 (if it was still genuinely in flight) — never a bare 500. A
    // double-apply, if it happened, is caught by the balance check below, not
    // by this status check.
    // Order-independent: sorting numerically would put 201 before 409 and
    // misplace the winner when the loser gets a 409.
    const statuses = [first.status, second.status];
    expect(statuses).toContain(201);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    expect(await finalBalance(payer)).toBe(900);

    // A third request after both have settled must replay the 201.
    const third = await submitPayment(body);
    expect(third.status).toBe(201);
    expect(await finalBalance(payer)).toBe(900);
  });
});
