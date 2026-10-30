import { describe, expect, test } from "vite-plus/test";
import { ConfigurationError, loadConfig, publicConfig } from "../src/config.ts";

const requiredEnvironment = {
  PROTON_BRIDGE_USERNAME: "bridge-user",
  PROTON_BRIDGE_PASSWORD: "bridge-password",
};

describe("loadConfig", () => {
  test("uses the local Proton Bridge defaults", () => {
    const config = loadConfig(requiredEnvironment);

    expect(config.host).toBe("127.0.0.1");
    expect(config.imapPort).toBe(1143);
    expect(config.smtpPort).toBe(1025);
    expect(config.security).toBe("starttls");
    expect(config.tls.rejectUnauthorized).toBe(false);
    expect(config.maxMessageBytes).toBe(25 * 1_024 * 1_024);
    expect(config.imapMaxConnections).toBe(3);
    expect(config.imapQueueTimeoutMs).toBe(45_000);
    expect(config.attachmentDirectory).toBeUndefined();
  });

  test("treats an empty default sender as unset", () => {
    const config = loadConfig({ ...requiredEnvironment, PROTON_DEFAULT_FROM: " " });

    expect(config.defaultFrom).toBeUndefined();
    expect(config.allowedSenders.size).toBe(0);
  });

  test("requires an absolute attachment directory", () => {
    expect(() =>
      loadConfig({ ...requiredEnvironment, PROTON_ATTACHMENT_DIR: "relative/dir" }),
    ).toThrow(ConfigurationError);
    expect(
      loadConfig({ ...requiredEnvironment, PROTON_ATTACHMENT_DIR: "/var/lib/mail/attachments" })
        .attachmentDirectory,
    ).toBe("/var/lib/mail/attachments");
  });

  test("normalizes and enforces configured sender aliases", () => {
    const config = loadConfig({
      ...requiredEnvironment,
      PROTON_DEFAULT_FROM: "Primary@Example.com",
      PROTON_ALLOWED_SENDERS: "Primary@Example.com, Alias@One.example,alias@two.example",
    });

    expect([...config.allowedSenders]).toEqual([
      "primary@example.com",
      "alias@one.example",
      "alias@two.example",
    ]);
  });

  test("does not expose credentials through publicConfig", () => {
    const safe = publicConfig(loadConfig(requiredEnvironment));

    expect(safe).not.toHaveProperty("username");
    expect(safe).not.toHaveProperty("password");
  });

  test("refuses disabled certificate verification on a remote host", () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        PROTON_BRIDGE_HOST: "mail.example.com",
        PROTON_BRIDGE_TLS_REJECT_UNAUTHORIZED: "false",
      }),
    ).toThrow(ConfigurationError);
  });
});
