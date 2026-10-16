import type { Kafka } from "kafkajs";

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
