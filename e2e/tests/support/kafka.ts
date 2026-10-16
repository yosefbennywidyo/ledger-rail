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
  const start = Date.now();
  const admin = kafka.admin();
  console.log(`[${new Date().toISOString()}] waitForBrokerReady(${topic}): admin.connect()`);
  await admin.connect();
  console.log(`[${new Date().toISOString()}] waitForBrokerReady(${topic}): admin connected after ${Date.now() - start}ms`);
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const [metadata] = (await admin.fetchTopicMetadata({ topics: [topic] })).topics;
        const leaders = metadata?.partitions.map((p) => p.leader);
        console.log(
          `[${new Date().toISOString()}] waitForBrokerReady(${topic}): leaders=${JSON.stringify(leaders)} at ${Date.now() - start}ms`,
        );
        if (metadata?.partitions.some((p) => p.leader >= 0)) return;
      } catch (err) {
        console.log(
          `[${new Date().toISOString()}] waitForBrokerReady(${topic}): fetchTopicMetadata failed at ${Date.now() - start}ms: ${err}`,
        );
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
  const start = Date.now();
  const groupId = `${groupIdPrefix}-${key}`;
  const consumer = kafka.consumer({ groupId });
  console.log(`[${new Date().toISOString()}] waitForKafkaEvent(${key}): connect(), groupId=${groupId}`);
  await consumer.connect();
  console.log(`[${new Date().toISOString()}] waitForKafkaEvent(${key}): connected after ${Date.now() - start}ms`);
  await consumer.subscribe({ topic, fromBeginning: true });
  console.log(`[${new Date().toISOString()}] waitForKafkaEvent(${key}): subscribed after ${Date.now() - start}ms`);

  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no Kafka message with key ${key} within ${timeoutMs}ms`));
      }, timeoutMs);

      consumer
        .run({
          eachMessage: async ({ message }) => {
            console.log(
              `[${new Date().toISOString()}] waitForKafkaEvent(${key}): saw message key=${message.key?.toString()} offset=${message.offset} at ${Date.now() - start}ms`,
            );
            if (message.key?.toString() !== key) return;
            clearTimeout(timer);
            resolve(JSON.parse(message.value?.toString() ?? "null"));
          },
        })
        .then(() => console.log(`[${new Date().toISOString()}] waitForKafkaEvent(${key}): run() resolved at ${Date.now() - start}ms`))
        .catch((err) => {
          console.log(`[${new Date().toISOString()}] waitForKafkaEvent(${key}): run() rejected at ${Date.now() - start}ms: ${err}`);
          reject(err);
        });
    });
  } finally {
    await consumer.disconnect();
  }
}
