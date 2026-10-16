// Minimal docker-compose control for tests that need to simulate a
// dependency being down (e.g. Redpanda during an outbox-relay test).
import { exec } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(exec);
const COMPOSE_CWD = new URL("../../..", import.meta.url).pathname;

export async function stopService(name: string): Promise<void> {
  await run(`docker compose stop ${name}`, { cwd: COMPOSE_CWD });
}

/**
 * Restarts name and waits for its compose healthcheck to report "healthy"
 * before returning. `docker compose start` alone returns as soon as the
 * container process begins, well before a heavier service like Redpanda is
 * actually ready to accept connections — a test that stops a service and
 * immediately exercises it would otherwise race the service's own startup,
 * not just the thing under test.
 */
export async function startService(name: string, timeoutMs = 30_000): Promise<void> {
  await run(`docker compose start ${name}`, { cwd: COMPOSE_CWD });
  await waitForHealthy(name, timeoutMs);
}

async function waitForHealthy(name: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout } = await run(`docker compose ps ${name} --format json`, { cwd: COMPOSE_CWD });
    const line = stdout.trim().split("\n")[0];
    if (line) {
      const status = JSON.parse(line) as { Health?: string };
      // No Health field at all means the service has no healthcheck defined,
      // in which case there's nothing further to wait for.
      if (!status.Health || status.Health === "healthy") {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${name} did not report healthy within ${timeoutMs}ms of restarting`);
}
