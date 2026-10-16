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
import { waitForBrokerReady, waitForKafkaEvent } from "./support/kafka.js";

const pg = new PgClient({ connectionString: POSTGRES_URL });
const kafka = new Kafka({ clientId: "e2e-outbox-resilience", brokers: KAFKA_BROKERS, logLevel: 1 });

beforeAll(async () => {
  await pg.connect();
});

afterAll(async () => {
  await pg.end();
});

describe("transactional outbox survives Redpanda being down at commit time", () => {
  it("still accepts and later delivers the event once Redpanda is back", async () => {
    const payer = `payer-${randomUUID()}`;
    const payee = `payee-${randomUUID()}`;
    await seedPayerBalance(pg, payer, 1_000);
    const key = randomUUID();

    console.log(`[${new Date().toISOString()}] test: key=${key}`);
    await stopService("redpanda");
    try {
      console.log(`[${new Date().toISOString()}] test: submitting payment`);
      const result = await submitPayment({
        payer_account: payer,
        payee_account: payee,
        amount_cents: 250,
        idempotency_key: key,
      });
      console.log(`[${new Date().toISOString()}] test: submitPayment returned status=${result.status}`);
      expect(result.status).toBe(201); // the write succeeds regardless of Redpanda
    } finally {
      await startService("redpanda");
    }

    // Docker's healthcheck (cluster liveness) passing doesn't mean the Kafka
    // protocol listener has finished electing a leader for this topic yet —
    // confirm that specifically before waiting for the event, or the wait
    // below just times out on a broker that's up but not yet ready.
    await waitForBrokerReady(kafka, KAFKA_TOPIC, 30_000);

    const event = await waitForKafkaEvent(kafka, KAFKA_TOPIC, "e2e-outbox-resilience", key, 30_000);
    expect(event).toMatchObject({ idempotency_key: key });
  }, 120_000);
});
