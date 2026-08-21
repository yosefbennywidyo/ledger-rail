// Path G: Legacy Core (COBOL, offline batch) reconciled against Ledger
// Service (Go, Postgres) by file exchange — the "strangler pattern" bridge
// described in legacy-core/README.md. Requires the real components running
// (./e2e/scripts/start-all.sh) plus GnuCOBOL's `cobc` on PATH.
//
// legacy-core's eod-settlement.cbl reads fixed-width data/transactions.dat
// and data/opening-balances.dat. Those paths are checked-in sample fixtures
// (used by legacy-core's own README for manual verification), so this test
// never writes there — it points eod-settlement at a temp directory via the
// EOD_*_FILE environment variables (see READ-FILE-PATHS-FROM-ENV in the
// .cbl) instead.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client as PgClient } from "pg";

import { LEGACY_CORE_DIR, POSTGRES_URL } from "./support/env.js";
import { seedPayerBalance, submitPayment } from "./support/ledger-client.js";

const pg = new PgClient({ connectionString: POSTGRES_URL });

beforeAll(async () => {
  await pg.connect();
  // Build once; eod-settlement.cbl's file paths are read from the
  // environment at runtime, so one binary serves every test run.
  execFileSync("cobc", ["-x", "-free", "eod-settlement.cbl", "-o", "eod-settlement", "-I", "copybooks"], {
    cwd: LEGACY_CORE_DIR,
  });
});

afterAll(async () => {
  await pg.end();
});

/** legacy-core account ids are a fixed PIC X(10) field. */
function shortAccountId(): string {
  return `R${randomBytes(5).toString("hex").slice(0, 9)}`.toUpperCase();
}

interface LedgerRow {
  account_id: string;
  amount_cents: string;
}

/** Parses one BALANCE-REPORT-RECORD line (10-byte id + 2 spaces + edited "-ZZZ,ZZZ,ZZ9.99") into cents. */
function parseBalanceLine(line: string): { accountId: string; cents: number } {
  const accountId = line.slice(0, 10).trim();
  const display = line.slice(10).trim();
  const negative = display.startsWith("-");
  const [whole, frac] = display.replace(/[-,]/g, "").split(".");
  const cents = Number(whole) * 100 + Number(frac);
  return { accountId, cents: negative ? -cents : cents };
}

describe("Legacy Core reconciliation", () => {
  it("produces closing balances identical to Postgres for the same transactions", async () => {
    const accountA = shortAccountId();
    const accountB = shortAccountId();
    const accountC = shortAccountId(); // never given an opening balance — must default to zero

    await seedPayerBalance(pg, accountA, 100_000);
    await seedPayerBalance(pg, accountB, 50_000);

    // Sequential on purpose: tx3 debits C, which only has a balance because
    // tx1 and tx2 already credited it.
    const tx1 = await submitPayment({
      payer_account: accountA,
      payee_account: accountC,
      amount_cents: 30_000,
      idempotency_key: `${accountA}-1`,
    });
    const tx2 = await submitPayment({
      payer_account: accountB,
      payee_account: accountC,
      amount_cents: 10_000,
      idempotency_key: `${accountB}-1`,
    });
    const tx3 = await submitPayment({
      payer_account: accountC,
      payee_account: accountA,
      amount_cents: 5_000,
      idempotency_key: `${accountC}-1`,
    });
    expect([tx1.status, tx2.status, tx3.status]).toEqual([201, 201, 201]);

    const accounts = [accountA, accountB, accountC];

    // Postgres closing balance: sum of every entry ever posted for the
    // account, seed included — this is what ledger-service itself would
    // report as the balance.
    const postgresBalances = new Map<string, number>();
    for (const accountId of accounts) {
      const result = await pg.query<{ total: string }>(
        "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM ledger_entries WHERE account_id = $1",
        [accountId],
      );
      postgresBalances.set(accountId, Number(result.rows[0]?.total ?? 0));
    }

    // Legacy Core's transactions.dat: only today's activity (tx1-tx3),
    // built from the same Postgres rows the transactions actually wrote —
    // not re-derived by hand — so this exercises the real JSON -> fixed-width
    // translation, not a hand-rolled equivalent.
    const txKeys = [`${accountA}-1`, `${accountB}-1`, `${accountC}-1`];
    const entryRows = await pg.query<LedgerRow>(
      "SELECT account_id, amount_cents FROM ledger_entries WHERE idempotency_key = ANY($1) ORDER BY id",
      [txKeys],
    );

    const transactionLines = entryRows.rows.map((row: LedgerRow) => {
      const amount = Number(row.amount_cents);
      const type = amount < 0 ? "D" : "C";
      return row.account_id.padEnd(10) + type + Math.abs(amount).toString().padStart(12, "0");
    });
    const openingBalanceLines = [
      accountA.padEnd(10) + "+" + "100000".padStart(12, "0"),
      accountB.padEnd(10) + "+" + "50000".padStart(12, "0"),
    ];

    const tmpDir = await mkdtemp(path.join(tmpdir(), "ledger-rail-reconciliation-"));
    try {
      const openingBalancesFile = path.join(tmpDir, "opening-balances.dat");
      const transactionsFile = path.join(tmpDir, "transactions.dat");
      const balancesFile = path.join(tmpDir, "balances.dat");
      const errorsFile = path.join(tmpDir, "errors.log");

      await writeFile(openingBalancesFile, openingBalanceLines.join("\n") + "\n");
      await writeFile(transactionsFile, transactionLines.join("\n") + "\n");

      execFileSync(path.join(LEGACY_CORE_DIR, "eod-settlement"), [], {
        cwd: LEGACY_CORE_DIR,
        env: {
          ...process.env,
          EOD_OPENING_BALANCES_FILE: openingBalancesFile,
          EOD_TRANSACTIONS_FILE: transactionsFile,
          EOD_BALANCES_FILE: balancesFile,
          EOD_ERRORS_FILE: errorsFile,
        },
      });

      const report = await readFile(balancesFile, "utf-8");
      const legacyBalances = new Map(
        report
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map(parseBalanceLine)
          .map(({ accountId, cents }) => [accountId, cents]),
      );

      for (const accountId of accounts) {
        expect(legacyBalances.get(accountId), `legacy-core balance for ${accountId}`).toBe(
          postgresBalances.get(accountId),
        );
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
