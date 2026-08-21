// Shared helpers for driving the synchronous path (BFF -> Payment Gateway ->
// Ledger Service -> Postgres) from tests, used by both sync-path.test.ts and
// async-path.test.ts so payment submission and balance seeding aren't
// duplicated between them.
import type { Client as PgClient } from "pg";
import { BFF_URL } from "./env.js";

export interface LedgerEntryRow {
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
export async function seedPayerBalance(
  pg: PgClient,
  accountId: string,
  amountCents: number,
): Promise<void> {
  const seedKey = `seed-${accountId}`;
  await pg.query("BEGIN");
  await pg.query("INSERT INTO ledger_transactions (idempotency_key) VALUES ($1)", [seedKey]);
  await pg.query(
    "INSERT INTO ledger_entries (idempotency_key, account_id, amount_cents) VALUES ($1, $2, $3)",
    [seedKey, accountId, amountCents],
  );
  await pg.query("COMMIT");
}

export async function entriesFor(pg: PgClient, idempotencyKey: string): Promise<LedgerEntryRow[]> {
  const result = await pg.query<LedgerEntryRow>(
    "SELECT account_id, amount_cents FROM ledger_entries WHERE idempotency_key = $1 ORDER BY account_id",
    [idempotencyKey],
  );
  return result.rows;
}

export interface SubmitPaymentBody {
  payer_account: string;
  payee_account: string;
  amount_cents: number;
  idempotency_key: string;
}

export async function submitPayment(
  body: SubmitPaymentBody,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${BFF_URL}/api/payments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
