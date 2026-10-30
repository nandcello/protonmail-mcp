/**
 * Bounds how many IMAP sessions this process opens against Proton Bridge at
 * once. Every tool call opens its own session, so without a bound a burst of
 * parallel calls becomes a burst of simultaneous STARTTLS handshakes, logins,
 * and downloads that slow each other down until callers time out. Waiters are
 * served in arrival order and give up with a clear error after `queueTimeoutMs`.
 */
export class ImapGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    readonly maxConcurrent: number,
    readonly queueTimeoutMs: number,
  ) {}

  get inUse() {
    return this.active;
  }

  get queued() {
    return this.waiters.length;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(grant);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(
          new Error(
            `Proton Bridge is busy: ${this.maxConcurrent} IMAP sessions were in use for ${Math.round(this.queueTimeoutMs / 1000)}s. Retry shortly.`,
          ),
        );
      }, this.queueTimeoutMs);
      this.waiters.push(grant);
    });
  }

  private release() {
    const next = this.waiters.shift();
    if (next) {
      // The slot passes directly to the next waiter, so `active` is unchanged.
      next();
    } else {
      this.active -= 1;
    }
  }
}

const sharedGates = new Map<string, ImapGate>();

/** One gate per Bridge endpoint and limit, shared by every client in this process. */
export function sharedImapGate(key: string, maxConcurrent: number, queueTimeoutMs: number) {
  const gateKey = `${key}|${maxConcurrent}|${queueTimeoutMs}`;
  let gate = sharedGates.get(gateKey);
  if (!gate) {
    gate = new ImapGate(maxConcurrent, queueTimeoutMs);
    sharedGates.set(gateKey, gate);
  }
  return gate;
}

/** Bridge rejected the credentials; retrying cannot help. */
function isAuthenticationFailure(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "authenticationFailed" in error &&
    error.authenticationFailed === true
  );
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retries opening a connection with exponential backoff and jitter. Only the
 * connect step is retried, so a retry can never repeat a mailbox change.
 * `open` must create a fresh connection on every attempt.
 */
export async function connectWithRetry<T>(
  open: () => Promise<T>,
  { attempts, baseDelayMs, sleep = defaultSleep }: RetryOptions,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await open();
    } catch (error) {
      if (attempt >= attempts || isAuthenticationFailure(error)) throw error;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      await sleep(delay + Math.floor(Math.random() * delay * 0.25));
    }
  }
}
