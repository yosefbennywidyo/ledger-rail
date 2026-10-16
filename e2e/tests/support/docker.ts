// Minimal docker-compose control for tests that need to simulate a
// dependency being down (e.g. Redpanda during an outbox-relay test).
import { exec } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(exec);

export async function stopService(name: string): Promise<void> {
  await run(`docker compose stop ${name}`, { cwd: new URL("../../..", import.meta.url).pathname });
}

export async function startService(name: string): Promise<void> {
  await run(`docker compose start ${name}`, { cwd: new URL("../../..", import.meta.url).pathname });
}
