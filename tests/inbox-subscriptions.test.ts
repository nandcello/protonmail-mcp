import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  InboxSubscriptionStore,
  InboxSubscriptionStoreError,
  subscriptionMatchesMessage,
} from "../src/inbox-subscriptions.ts";

const temporaryDirectories: string[] = [];

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "protonmail-subscriptions-"));
  temporaryDirectories.push(directory);
  return new InboxSubscriptionStore(join(directory, "subscriptions.json"));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("InboxSubscriptionStore", () => {
  test("starts with no subscriptions and persists an explicit filtered subscription", () => {
    const store = createStore();
    expect(store.list()).toEqual([]);

    const created = store.create({
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

  test("requires an include filter or explicit all-inbox opt-in", () => {
    const store = createStore();

    expect(() =>
      store.create({
        idempotencyKey: "request-empty",
        consumerId: "consumer",
      }),
    ).toThrow("Set all_inbox_mail=true or provide at least one include filter rule");

    expect(() =>
      store.create({
        idempotencyKey: "request-exclusion-only",
        consumerId: "consumer",
        filterRules: [{ action: "exclude", subject: ["newsletter"] }],
      }),
    ).toThrow("Exclusion rules alone do not opt in");

    expect(
      store.create({
        idempotencyKey: "request-all",
        consumerId: "consumer",
        allInboxMail: true,
      }).subscription.allInboxMail,
    ).toBe(true);
  });

  test("deduplicates creation retries and reserves keys after deletion", () => {
    const store = createStore();
    const request = {
      idempotencyKey: "stable-request",
      consumerId: "consumer",
      filterRules: [
        {
          action: "include" as const,
          sender: ["alerts@example.com", "builds@example.com"],
        },
      ],
    };
    const first = store.create(request);
    const retry = store.create({
      ...request,
      filterRules: [
        {
          action: "include",
          sender: ["BUILDS@example.com", "ALERTS@example.com"],
        },
      ],
    });

    expect(retry).toEqual({ subscription: first.subscription, created: false });
    expect(store.list()).toHaveLength(1);
    expect(() => store.create({ ...request, consumerId: "other" })).toThrow(
      "already used for a different subscription request",
    );

    expect(store.delete(first.subscription.id)).toEqual({
      id: first.subscription.id,
      deleted: true,
    });
    expect(store.delete(first.subscription.id)).toEqual({
      id: first.subscription.id,
      deleted: false,
    });
    expect(() => store.create(request)).toThrow("belongs to a subscription that was deleted");
  });

  test("updates, pauses, and enforces optimistic revisions", () => {
    const store = createStore();
    const original = store.create({
      idempotencyKey: "request-1",
      consumerId: "consumer",
      allInboxMail: true,
    }).subscription;
    const updated = store.update(original.id, {
      expectedRevision: 1,
      allInboxMail: false,
      filterRules: [{ action: "include", subject: ["build failed"] }],
    });

    expect(updated).toMatchObject({
      allInboxMail: false,
      revision: 2,
    });
    expect(() => store.setEnabled(original.id, { enabled: false, expectedRevision: 1 })).toThrow(
      InboxSubscriptionStoreError,
    );

    const paused = store.setEnabled(original.id, {
      enabled: false,
      expectedRevision: 2,
    });
    expect(paused).toMatchObject({ enabled: false, revision: 3 });
    expect(store.setEnabled(original.id, { enabled: false })).toEqual(paused);
  });
});

describe("subscriptionMatchesMessage", () => {
  test("combines include fields, applies exclusions last, and ignores paused subscriptions", () => {
    const store = createStore();
    const subscription = store.create({
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
    }).subscription;
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

  test("allows explicit all-inbox selection with safe recipient exclusions", () => {
    const store = createStore();
    const subscription = store.create({
      idempotencyKey: "request-1",
      consumerId: "consumer",
      allInboxMail: true,
      filterRules: [{ action: "exclude", recipient: ["bulk@example.com"] }],
    }).subscription;

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
