// Async path: Ledger Service -> Kafka (publish) -> Fraud Check (consume).
// Requires the real components running (./e2e/scripts/start-all.sh), including
// Redpanda and fraud-check. Nothing here is mocked — we read the real topic
// and the real fraud-check log, not a stand-in producer/consumer.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client as PgClient } from "pg";
import { Kafka } from "kafkajs";

import { FRAUD_CHECK_LOG, FRAUD_CHECK_URL, KAFKA_BROKERS, KAFKA_TOPIC, POSTGRES_URL } from "./support/env.js";
import { seedPayerBalance, submitPayment } from "./support/ledger-client.js";

const pg = new PgClient({ connectionString: POSTGRES_URL });
const kafka = new Kafka({ clientId: "e2e-async-path", brokers: KAFKA_BROKERS, logLevel: 1 /* ERROR */ });

beforeAll(async () => {
  await pg.connect();
});

afterAll(async () => {
  await pg.end();
});

/**
 * Reads the transactions topic from the beginning with a fresh consumer
 * group (so a prior test run's committed offsets never hide this run's
 * message) and resolves with the first event whose Kafka key matches.
 *
 * Disconnects only in `finally`, outside the eachMessage callback's own call
 * stack — calling consumer.disconnect() *from inside* eachMessage deadlocks
 * kafkajs, since its internal run loop awaits the callback while the
 * callback awaits disconnect.
 */
async function waitForPublishedEvent(idempotencyKey: string, timeoutMs = 15_000): Promise<unknown> {
  const consumer = kafka.consumer({ groupId: `e2e-async-path-${idempotencyKey}` });
  await consumer.connect();
  await consumer.subscribe({ topic: KAFKA_TOPIC, fromBeginning: true });

  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no Kafka message with key ${idempotencyKey} within ${timeoutMs}ms`));
      }, timeoutMs);

      consumer
        .run({
          eachMessage: async ({ message }) => {
            if (message.key?.toString() !== idempotencyKey) return;
            clearTimeout(timer);
            resolve(JSON.parse(message.value?.toString() ?? "null"));
          },
        })
        .catch(reject);
    });
  } finally {
    await consumer.disconnect();
  }
}

/** Polls fraud-check's log file for the line it writes after scoring a transaction. */
async function waitForFraudCheckToProcess(idempotencyKey: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await readFile(FRAUD_CHECK_LOG, "utf-8").catch(() => "");
    const line = content.split("\n").find((l) => l.includes(`idempotency_key=${idempotencyKey}`));
    if (line) return line;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`fraud-check did not log processing of ${idempotencyKey} within ${timeoutMs}ms`);
}

describe("health check", () => {
  it("fraud-check reports healthy", async () => {
    const response = await fetch(`${FRAUD_CHECK_URL}/healthz`);
    expect(response.status).toBe(200);
  });
});

describe("ledger-service publishes, fraud-check consumes", () => {
  it("publishes the exact transaction to Kafka and fraud-check scores it", async () => {
    const runId = randomUUID();
    const payerAccount = `acct-payer-${runId}`;
    const payeeAccount = `acct-payee-${runId}`;
    await seedPayerBalance(pg, payerAccount, 100_000);

    const eventPromise = waitForPublishedEvent(runId);

    const result = await submitPayment({
      payer_account: payerAccount,
      payee_account: payeeAccount,
      amount_cents: 3_000,
      idempotency_key: runId,
    });
    expect(result.status).toBe(201);

    const event = await eventPromise;
    expect(event).toEqual({
      idempotency_key: runId,
      entries: [
        { account_id: payerAccount, amount_cents: -3000 },
        { account_id: payeeAccount, amount_cents: 3000 },
      ],
    });

    const logLine = await waitForFraudCheckToProcess(runId);
    expect(logLine).toContain("flagged=");
  });
});
