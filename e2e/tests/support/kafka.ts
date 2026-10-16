import type { Kafka } from "kafkajs";

/**
 * Waits until `topic` has a leader elected, polling the admin API. Redpanda's
 * own docker-compose healthcheck (`rpk cluster info`) reports healthy as
 * soon as the cluster controller answers — well before the Kafka protocol
 * listener has finished electing partition leaders after a restart, which
 * leaves real clients (kafkajs, aiokafka, kafka-go) seeing
 * NodeNotReadyError/connection-refused for tens of seconds afterward. This
 * checks the thing a producer/consumer actually needs, not a proxy for it.
 */
export async function waitForBrokerReady(kafka: Kafka, topic: string, timeoutMs: number): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const [metadata] = (await admin.fetchTopicMetadata({ topics: [topic] })).topics;
        if (metadata?.partitions.some((p) => p.leader >= 0)) return;
      } catch {
        // not ready yet — fall through to retry
      }
      if (Date.now() >= deadline) {
        throw new Error(`${topic} had no elected partition leader within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    await admin.disconnect();
  }
}

/**
 * Reads `topic` from the beginning with a fresh consumer group (so a prior
 * test run's committed offsets never hide this run's message) and resolves
 * with the first event whose Kafka key matches `key`. Rejects after
 * `timeoutMs`.
 *
 * Disconnects only in `finally`, outside the eachMessage callback's own call
 * stack — calling consumer.disconnect() *from inside* eachMessage deadlocks
 * kafkajs, since its internal run loop awaits the callback while the
 * callback awaits disconnect.
 */
export async function waitForKafkaEvent(
  kafka: Kafka,
  topic: string,
  groupIdPrefix: string,
  key: string,
  timeoutMs: number,
): Promise<unknown> {
  const consumer = kafka.consumer({ groupId: `${groupIdPrefix}-${key}` });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });

  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no Kafka message with key ${key} within ${timeoutMs}ms`));
      }, timeoutMs);

      consumer
        .run({
          eachMessage: async ({ message }) => {
            if (message.key?.toString() !== key) return;
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
