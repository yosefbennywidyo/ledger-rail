// Outbox resilience: a transaction committed while Redpanda is down must
// still have its event delivered once Redpanda comes back — the write
// itself must never fail because the broker is unreachable.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client as PgClient } from "pg";
import { Kafka } from "kafkajs";

import { KAFKA_BROKERS, KAFKA_TOPIC, POSTGRES_URL } from "./support/env.js";
import { seedPayerBalance, submitPayment } from "./support/ledger-client.js";
import { startService, stopService } from "./support/docker.js";

const pg = new PgClient({ connectionString: POSTGRES_URL });
const kafka = new Kafka({ clientId: "e2e-outbox-resilience", brokers: KAFKA_BROKERS, logLevel: 1 });

beforeAll(async () => {
  await pg.connect();
});

afterAll(async () => {
  await pg.end();
});

async function waitForEvent(idempotencyKey: string, timeoutMs = 20_000): Promise<unknown> {
  const consumer = kafka.consumer({ groupId: `e2e-outbox-resilience-${idempotencyKey}` });
  await consumer.connect();
  await consumer.subscribe({ topic: KAFKA_TOPIC, fromBeginning: true });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no event for ${idempotencyKey} within ${timeoutMs}ms`)), timeoutMs);
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

describe("transactional outbox survives Redpanda being down at commit time", () => {
  it("still accepts and later delivers the event once Redpanda is back", async () => {
    const payer = `payer-${randomUUID()}`;
    const payee = `payee-${randomUUID()}`;
    await seedPayerBalance(pg, payer, 1_000);
    const key = randomUUID();

    await stopService("redpanda");
    try {
      const result = await submitPayment({
        payer_account: payer,
        payee_account: payee,
        amount_cents: 250,
        idempotency_key: key,
      });
      expect(result.status).toBe(201); // the write succeeds regardless of Redpanda
    } finally {
      await startService("redpanda");
    }

    const event = await waitForEvent(key);
    expect(event).toMatchObject({ idempotency_key: key });
  }, 30_000);
});
