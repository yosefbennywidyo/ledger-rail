// Shared helpers for driving the synchronous path (BFF -> Payment Gateway ->
// Ledger Service -> Postgres) from tests, used by both sync-path.test.ts and
// async-path.test.ts so payment submission and account/balance setup aren't
// duplicated between them.
import { randomUUID } from "node:crypto";
import type { Client as PgClient } from "pg";
import { BFF_URL } from "./env.js";

export interface LedgerEntryRow {
  account_id: string;
  amount_cents: string; // bigint comes back as string from node-postgres
}

export async function createCustomer(name: string): Promise<string> {
  const response = await fetch(`${BFF_URL}/api/customers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, idempotency_key: randomUUID() }),
  });
  const body = (await response.json()) as { id: string };
  return body.id;
}

export async function createAccount(customerId: string): Promise<string> {
  const response = await fetch(`${BFF_URL}/api/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ customer_id: customerId, idempotency_key: randomUUID() }),
  });
  const body = (await response.json()) as { id: string };
  return body.id;
}

/**
 * Convenience for tests that don't care about the customer id.
 */
export async function openAccount(name: string): Promise<string> {
  const customerId = await createCustomer(name);
  return createAccount(customerId);
}

export async function topUp(
  accountId: string,
  amountCents: number,
): Promise<{ status: number; body: unknown }> {
  return submitPayment({
    payer_account: "topup",
    payee_account: accountId,
    amount_cents: amountCents,
    idempotency_key: randomUUID(),
  });
}

export async function closeAccount(
  accountId: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${BFF_URL}/api/accounts/${accountId}/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotency_key: randomUUID() }),
  });
  return { status: response.status, body: await response.json() };
}

export async function getAccountBalance(accountId: string): Promise<number> {
  const response = await fetch(`${BFF_URL}/api/accounts/${accountId}`);
  const body = await response.json();
  if (response.status !== 200) {
    throw new Error(`getAccountBalance(${accountId}) failed: ${JSON.stringify(body)}`);
  }
  return (body as { balance_cents: number }).balance_cents;
}

export async function getAccountTransactions(
  accountId: string,
  page?: number,
  limit?: number,
): Promise<unknown> {
  const params = new URLSearchParams();
  if (page !== undefined) params.set("page", String(page));
  if (limit !== undefined) params.set("limit", String(limit));
  const query = params.toString();
  const response = await fetch(
    `${BFF_URL}/api/accounts/${accountId}/transactions${query ? `?${query}` : ""}`,
  );
  return response.json();
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
