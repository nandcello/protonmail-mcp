import { ImapFlow } from "imapflow";
import { loadConfig, type ProtonBridgeConfig } from "../../src/config.ts";
import { ImapGate } from "../../src/imap-gate.ts";
import { ProtonMailClient } from "../../src/proton-mail-client.ts";

export function createTestConfig(overrides: Partial<ProtonBridgeConfig> = {}) {
  return {
    ...loadConfig({
      PROTON_BRIDGE_USERNAME: "bridge-user",
      PROTON_BRIDGE_PASSWORD: "bridge-password",
      PROTON_BRIDGE_TLS_REJECT_UNAUTHORIZED: "false",
    }),
    ...overrides,
  };
}

/** A client whose real ImapFlow talks plain IMAP to a fake server on `port`. */
export function createTestClient(
  port: number,
  config: ProtonBridgeConfig = createTestConfig(),
  gate = new ImapGate(4, 5_000),
) {
  return new ProtonMailClient(config, {
    createImapClient: () =>
      new ImapFlow({
        host: "127.0.0.1",
        port,
        secure: false,
        doSTARTTLS: false,
        auth: { user: "bridge-user", pass: "bridge-password" },
        logger: false,
      }),
    createSmtpTransport: () => {
      throw new Error("SMTP was not expected in this test.");
    },
    imapGate: gate,
  });
}
