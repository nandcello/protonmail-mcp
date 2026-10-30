import { describe, expect, test } from "vite-plus/test";
import { connectWithRetry, ImapGate } from "../src/imap-gate.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("ImapGate", () => {
  test("never runs more than the limit at once and serves waiters in order", async () => {
    const gate = new ImapGate(2, 5_000);
    let running = 0;
    let peak = 0;
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        gate.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          order.push(index);
          await tick();
          running -= 1;
        }),
      ),
    );

    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(gate.inUse).toBe(0);
  });

  test("releases the slot when an operation fails", async () => {
    const gate = new ImapGate(1, 5_000);
    await expect(gate.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
    expect(gate.inUse).toBe(0);
  });

  test("gives up with a clear busy error after the queue timeout", async () => {
    const gate = new ImapGate(1, 20);
    let finish: () => void = () => undefined;
    const holder = gate.run(() => new Promise<void>((resolve) => (finish = resolve)));

    await expect(gate.run(async () => "late")).rejects.toThrow("Proton Bridge is busy");
    expect(gate.queued).toBe(0);
    finish();
    await holder;
    expect(gate.inUse).toBe(0);
  });
});

describe("connectWithRetry", () => {
  test("retries transient failures with growing backoff", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const result = await connectWithRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("Connection not available");
        return "connected";
      },
      { attempts: 3, baseDelayMs: 100, sleep: async (ms) => void delays.push(ms) },
    );

    expect(result).toBe("connected");
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
  });

  test("does not retry authentication failures", async () => {
    let attempts = 0;
    const failure = Object.assign(new Error("Invalid credentials"), { authenticationFailed: true });
    await expect(
      connectWithRetry(
        async () => {
          attempts += 1;
          throw failure;
        },
        { attempts: 3, baseDelayMs: 1, sleep: async () => undefined },
      ),
    ).rejects.toThrow("Invalid credentials");
    expect(attempts).toBe(1);
  });

  test("gives up after the configured attempts", async () => {
    let attempts = 0;
    await expect(
      connectWithRetry(
        async () => {
          attempts += 1;
          throw new Error("ECONNRESET");
        },
        { attempts: 3, baseDelayMs: 1, sleep: async () => undefined },
      ),
    ).rejects.toThrow("ECONNRESET");
    expect(attempts).toBe(3);
  });
});
