import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { lock } from "proper-lockfile";
import { z } from "zod/v4";
import {
  inboxSubscriptionSchema,
  subscriptionSpecSchema,
  type InboxFilterRule,
  type InboxSubscription,
} from "./inbox-subscriptions.ts";

const createRequestSchema = z.object({
  key: z.string().min(1),
  fingerprint: z.string().min(1),
  subscriptionId: z.uuid(),
  createdAt: z.iso.datetime(),
});

const storeFileSchema = z.object({
  version: z.literal(1),
  subscriptions: z.array(inboxSubscriptionSchema),
  createRequests: z.array(createRequestSchema),
});

type StoreFile = z.infer<typeof storeFileSchema>;

export interface CreateInboxSubscription {
  idempotencyKey: string;
  consumerId: string;
  enabled?: boolean;
  allInboxMail?: boolean;
  filterRules?: InboxFilterRule[];
}

export interface UpdateInboxSubscription {
  consumerId?: string;
  allInboxMail?: boolean;
  filterRules?: InboxFilterRule[];
  expectedRevision?: number;
}

export interface SetInboxSubscriptionEnabled {
  enabled: boolean;
  expectedRevision?: number;
}

interface TransactionResult<T> {
  value: T;
  changed: boolean;
}

export class InboxSubscriptionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxSubscriptionStoreError";
  }
}

function emptyStore(): StoreFile {
  return { version: 1, subscriptions: [], createRequests: [] };
}

function errorDescription(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "subscription"}: ${issue.message}`)
    .join("; ");
}

export class InboxSubscriptionStore {
  constructor(readonly filePath: string) {}

  list(): InboxSubscription[] {
    return this.read().subscriptions.toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  async create(input: CreateInboxSubscription): Promise<{
    subscription: InboxSubscription;
    created: boolean;
  }> {
    const idempotencyKey = z.string().trim().min(1).max(200).parse(input.idempotencyKey);
    const spec = this.parseSpec(input);
    const fingerprint = JSON.stringify(spec);

    return this.transact<{
      subscription: InboxSubscription;
      created: boolean;
    }>((store) => {
      const priorRequest = store.createRequests.find(({ key }) => key === idempotencyKey);

      if (priorRequest) {
        if (priorRequest.fingerprint !== fingerprint) {
          throw new InboxSubscriptionStoreError(
            `Idempotency key ${idempotencyKey} was already used for a different subscription request.`,
          );
        }

        const existing = store.subscriptions.find(({ id }) => id === priorRequest.subscriptionId);
        if (!existing) {
          throw new InboxSubscriptionStoreError(
            `Idempotency key ${idempotencyKey} belongs to a subscription that was deleted; use a new key to create another subscription.`,
          );
        }
        return {
          value: { subscription: existing, created: false },
          changed: false,
        };
      }

      const now = new Date().toISOString();
      const subscription = inboxSubscriptionSchema.parse({
        ...spec,
        id: randomUUID(),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      store.subscriptions.push(subscription);
      store.createRequests.push({
        key: idempotencyKey,
        fingerprint,
        subscriptionId: subscription.id,
        createdAt: now,
      });
      return {
        value: { subscription, created: true },
        changed: true,
      };
    });
  }

  async update(id: string, patch: UpdateInboxSubscription): Promise<InboxSubscription> {
    return this.mutateExisting(id, patch.expectedRevision, (current) => {
      const spec = this.parseSpec({
        consumerId: patch.consumerId ?? current.consumerId,
        enabled: current.enabled,
        allInboxMail: patch.allInboxMail ?? current.allInboxMail,
        filterRules: patch.filterRules ?? current.filterRules,
      });
      return { ...current, ...spec };
    });
  }

  async setEnabled(id: string, input: SetInboxSubscriptionEnabled): Promise<InboxSubscription> {
    return this.mutateExisting(id, input.expectedRevision, (current) => ({
      ...current,
      enabled: input.enabled,
    }));
  }

  async delete(id: string, expectedRevision?: number): Promise<{ id: string; deleted: boolean }> {
    const subscriptionId = z.uuid().parse(id);
    return this.transact<{ id: string; deleted: boolean }>((store) => {
      const index = store.subscriptions.findIndex(
        (subscription) => subscription.id === subscriptionId,
      );
      if (index < 0) {
        return {
          value: { id: subscriptionId, deleted: false },
          changed: false,
        };
      }

      const current = store.subscriptions[index];
      this.assertRevision(current, expectedRevision);
      store.subscriptions.splice(index, 1);
      return {
        value: { id: subscriptionId, deleted: true },
        changed: true,
      };
    });
  }

  private async mutateExisting(
    id: string,
    expectedRevision: number | undefined,
    mutate: (current: InboxSubscription) => InboxSubscription,
  ): Promise<InboxSubscription> {
    const subscriptionId = z.uuid().parse(id);
    return this.transact((store) => {
      const index = store.subscriptions.findIndex(
        (subscription) => subscription.id === subscriptionId,
      );
      if (index < 0) {
        throw new InboxSubscriptionStoreError(
          `Inbox subscription ${subscriptionId} was not found.`,
        );
      }

      const current = store.subscriptions[index];
      this.assertRevision(current, expectedRevision);
      const candidate = inboxSubscriptionSchema.parse(mutate(current));
      const unchanged =
        candidate.consumerId === current.consumerId &&
        candidate.enabled === current.enabled &&
        candidate.allInboxMail === current.allInboxMail &&
        JSON.stringify(candidate.filterRules) === JSON.stringify(current.filterRules);
      if (unchanged) return { value: current, changed: false };

      const updated = inboxSubscriptionSchema.parse({
        ...candidate,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      store.subscriptions[index] = updated;
      return { value: updated, changed: true };
    });
  }

  private parseSpec(input: {
    consumerId: string;
    enabled?: boolean;
    allInboxMail?: boolean;
    filterRules?: InboxFilterRule[];
  }) {
    const parsed = subscriptionSpecSchema.safeParse(input);
    if (!parsed.success) {
      throw new InboxSubscriptionStoreError(
        `Invalid inbox subscription: ${errorDescription(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  private assertRevision(subscription: InboxSubscription, expectedRevision: number | undefined) {
    if (expectedRevision !== undefined && subscription.revision !== expectedRevision) {
      throw new InboxSubscriptionStoreError(
        `Inbox subscription ${subscription.id} is at revision ${subscription.revision}, not expected revision ${expectedRevision}. Refresh it before retrying the change.`,
      );
    }
  }

  private async transact<T>(operation: (store: StoreFile) => TransactionResult<T>): Promise<T> {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });

    let release: (() => Promise<void>) | undefined;
    try {
      release = await lock(this.filePath, {
        realpath: false,
        retries: {
          retries: 100,
          factor: 1.2,
          minTimeout: 5,
          maxTimeout: 50,
          randomize: true,
        },
      });
    } catch (error) {
      throw new InboxSubscriptionStoreError(
        `Could not lock inbox subscription store ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const store = this.read();
      const transaction = operation(store);
      if (transaction.changed) this.write(store);
      return transaction.value;
    } finally {
      await release();
    }
  }

  private read(): StoreFile {
    if (!existsSync(this.filePath)) return emptyStore();

    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new InboxSubscriptionStoreError(
        `Could not read inbox subscriptions from ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const parsed = storeFileSchema.safeParse(value);
    if (!parsed.success) {
      throw new InboxSubscriptionStoreError(
        `Invalid inbox subscription store ${this.filePath}: ${errorDescription(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  private write(store: StoreFile) {
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;

    try {
      writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporaryPath, this.filePath);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }
}
