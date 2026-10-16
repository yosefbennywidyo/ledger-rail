import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    hookTimeout: 20_000,
    testTimeout: 40_000, // async-path.test.ts waits on Kafka + a log file, sequentially
    fileParallelism: false, // outbox-resilience.test.ts stops Redpanda for the whole process; other files must not run concurrently with it
  },
});
