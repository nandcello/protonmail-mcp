import { describe, expect, test } from "vite-plus/test";
import { ConfigurationError } from "../src/config.ts";
import { loadInboxSubscriptionConfig } from "../src/inbox-subscription-config.ts";

describe("loadInboxSubscriptionConfig", () => {
  test("uses the XDG data directory and parses configured consumers", () => {
    const config = loadInboxSubscriptionConfig(
      {
        XDG_DATA_HOME: "/var/data",
        PROTON_INBOX_CONSUMERS: " desktop-notifier,build-alerts,desktop-notifier ",
      },
      "/home/tester",
    );

    expect(config.filePath).toBe("/var/data/protonmail-mcp/inbox-subscriptions.json");
    expect([...config.consumerIds]).toEqual(["desktop-notifier", "build-alerts"]);
  });

  test("falls back to the user's local data directory", () => {
    const config = loadInboxSubscriptionConfig({}, "/home/tester");

    expect(config.filePath).toBe(
      "/home/tester/.local/share/protonmail-mcp/inbox-subscriptions.json",
    );
    expect(config.consumerIds.size).toBe(0);
  });

  test("accepts an absolute store override", () => {
    const config = loadInboxSubscriptionConfig(
      {
        PROTON_INBOX_SUBSCRIPTIONS_FILE: "/srv/proton/subscriptions.json",
      },
      "/home/tester",
    );

    expect(config.filePath).toBe("/srv/proton/subscriptions.json");
  });

  test.each([
    ["PROTON_INBOX_SUBSCRIPTIONS_FILE", "relative/subscriptions.json"],
    ["XDG_DATA_HOME", "relative/data"],
  ])("rejects a relative %s", (name, value) => {
    expect(() => loadInboxSubscriptionConfig({ [name]: value }, "/home/tester")).toThrow(
      ConfigurationError,
    );
  });
});
