import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  ConfiguredInboxSubscriptionService,
  type InboxSubscriptionService,
} from "../src/inbox-subscription-service.ts";
import {
  InboxSubscriptionStore,
  InboxSubscriptionStoreError,
} from "../src/inbox-subscription-store.ts";
import { subscriptionMatchesMessage } from "../src/inbox-subscriptions.ts";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "protonmail-subscriptions-"));
  temporaryDirectories.push(directory);
  return new InboxSubscriptionStore(join(directory, "subscriptions.json"));
}

function createService(
  store: InboxSubscriptionStore,
  consumerIds: string[] = ["consumer", "desktop-notifier"],
): InboxSubscriptionService {
  return new ConfiguredInboxSubscriptionService(store, new Set(consumerIds));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("InboxSubscriptionStore", () => {
  test("starts with no subscriptions and persists an explicit filtered subscription", async () => {
    const store = createStore();
    expect(store.list()).toEqual([]);

    const created = await store.create({
      idempotencyKey: "request-1",
      consumerId: "desktop-notifier",
      filterRules: [{ action: "include", sender: ["alerts@example.com"] }],
    });

    expect(created.created).toBe(true);
    expect(created.subscription).toMatchObject({
      consumerId: "desktop-notifier",
      enabled: true,
      allInboxMail: false,
      revision: 1,
    });
    expect(new InboxSubscriptionStore(store.filePath).list()).toEqual([created.subscription]);
    expect(JSON.parse(readFileSync(store.filePath, "utf8"))).toMatchObject({
      version: 1,
    });
  });

  test("requires an include filter or explicit all-inbox opt-in", async () => {
    const store = createStore();

    await expect(
      store.create({
        idempotencyKey: "request-empty",
        consumerId: "consumer",
      }),
    ).rejects.toThrow("Set all_inbox_mail=true or provide at least one include filter rule");

    await expect(
      store.create({
        idempotencyKey: "request-exclusion-only",
        consumerId: "consumer",
        filterRules: [{ action: "exclude", subject: ["newsletter"] }],
      }),
    ).rejects.toThrow("Exclusion rules alone do not opt in");

    expect(
      (
        await store.create({
          idempotencyKey: "request-all",
          consumerId: "consumer",
          allInboxMail: true,
        })
      ).subscription.allInboxMail,
    ).toBe(true);
  });

  test("canonicalizes creation retries and reserves keys after deletion", async () => {
    const store = createStore();
    const request = {
      idempotencyKey: "stable-request",
      consumerId: "consumer",
      filterRules: [
        {
          action: "include" as const,
          sender: ["alerts@example.com", "builds@example.com"],
        },
        {
          action: "exclude" as const,
          subject: ["expected failure"],
        },
      ],
    };
    const first = await store.create(request);
    const retry = await store.create({
      ...request,
      filterRules: [
        {
          action: "exclude",
          subject: ["EXPECTED FAILURE"],
        },
        {
          action: "include",
          sender: ["BUILDS@example.com", "ALERTS@example.com"],
        },
        {
          action: "include",
          sender: ["alerts@example.com", "builds@example.com"],
        },
      ],
    });

    expect(retry).toEqual({ subscription: first.subscription, created: false });
    expect(store.list()).toHaveLength(1);
    await expect(store.create({ ...request, consumerId: "other" })).rejects.toThrow(
      "already used for a different subscription request",
    );

    expect(await store.delete(first.subscription.id)).toEqual({
      id: first.subscription.id,
      deleted: true,
    });
    expect(await store.delete(first.subscription.id)).toEqual({
      id: first.subscription.id,
      deleted: false,
    });
    await expect(store.create(request)).rejects.toThrow(
      "belongs to a subscription that was deleted",
    );
  });

  test("updates, pauses, and enforces optimistic revisions", async () => {
    const store = createStore();
    const original = (
      await store.create({
        idempotencyKey: "request-1",
        consumerId: "consumer",
        allInboxMail: true,
      })
    ).subscription;
    const updated = await store.update(original.id, {
      expectedRevision: 1,
      allInboxMail: false,
      filterRules: [{ action: "include", subject: ["build failed"] }],
    });

    expect(updated).toMatchObject({
      allInboxMail: false,
      revision: 2,
    });
    expect(
      await store.update(original.id, {
        filterRules: updated.filterRules.toReversed(),
      }),
    ).toEqual(updated);
    await expect(
      store.setEnabled(original.id, { enabled: false, expectedRevision: 1 }),
    ).rejects.toThrow(InboxSubscriptionStoreError);

    const paused = await store.setEnabled(original.id, {
      enabled: false,
      expectedRevision: 2,
    });
    expect(paused).toMatchObject({ enabled: false, revision: 3 });
    expect(await store.setEnabled(original.id, { enabled: false })).toEqual(paused);
  });

  test("serializes independent processes without losing subscriptions", async () => {
    const store = createStore();
    const fixture = fileURLToPath(
      new URL("./fixtures/create-inbox-subscription.ts", import.meta.url),
    );
    const processCount = 24;

    await Promise.all(
      Array.from({ length: processCount }, (_, index) =>
        executeFile("bun", [fixture, store.filePath, String(index)]),
      ),
    );

    const persisted = JSON.parse(readFileSync(store.filePath, "utf8"));
    expect(store.list()).toHaveLength(processCount);
    expect(persisted.createRequests).toHaveLength(processCount);
  });
});

describe("ConfiguredInboxSubscriptionService", () => {
  test("rejects unconfigured consumers on create and reassignment", async () => {
    const store = createStore();
    const service = createService(store);

    await expect(
      service.create({
        idempotencyKey: "unknown-consumer",
        consumerId: "not-configured",
        allInboxMail: true,
      }),
    ).rejects.toThrow("not configured");

    const subscription = (
      await service.create({
        idempotencyKey: "configured-consumer",
        consumerId: "consumer",
        allInboxMail: true,
      })
    ).subscription;
    await expect(service.update(subscription.id, { consumerId: "not-configured" })).rejects.toThrow(
      "not configured",
    );
  });
});

describe("subscriptionMatchesMessage", () => {
  test("combines include fields, applies exclusions last, and ignores paused subscriptions", async () => {
    const store = createStore();
    const subscription = (
      await store.create({
        idempotencyKey: "request-1",
        consumerId: "consumer",
        filterRules: [
          {
            action: "include",
            sender: ["builds@example.com"],
            subject: ["failed"],
            mailbox: ["INBOX"],
          },
          { action: "exclude", subject: ["expected failure"] },
        ],
      })
    ).subscription;
    const matchingMessage = {
      mailbox: "inbox",
      from: ["Build Bot <builds@example.com>"],
      to: ["team@example.com"],
      subject: "Build failed on main",
    };

    expect(subscriptionMatchesMessage(subscription, matchingMessage)).toBe(true);
    expect(
      subscriptionMatchesMessage(subscription, {
        ...matchingMessage,
        subject: "Expected failure in test fixture",
      }),
    ).toBe(false);
    expect(subscriptionMatchesMessage({ ...subscription, enabled: false }, matchingMessage)).toBe(
      false,
    );
  });

  test("allows explicit all-inbox selection with safe recipient exclusions", async () => {
    const store = createStore();
    const subscription = (
      await store.create({
        idempotencyKey: "request-1",
        consumerId: "consumer",
        allInboxMail: true,
        filterRules: [{ action: "exclude", recipient: ["bulk@example.com"] }],
      })
    ).subscription;

    expect(
      subscriptionMatchesMessage(subscription, {
        mailbox: "INBOX",
        from: ["person@example.com"],
        to: ["me@example.com"],
        subject: "Hello",
      }),
    ).toBe(true);
    expect(
      subscriptionMatchesMessage(subscription, {
        mailbox: "INBOX",
        from: ["person@example.com"],
        to: ["Bulk <bulk@example.com>"],
        subject: "Hello",
      }),
    ).toBe(false);
  });
});
