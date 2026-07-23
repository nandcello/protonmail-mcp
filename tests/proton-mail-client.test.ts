import { describe, expect, test } from "vite-plus/test";
import { loadConfig } from "../src/config.ts";
import { createImapClient } from "../src/proton-mail-client.ts";

describe("createImapClient", () => {
  test("keeps an IP-based Proton Bridge host as a string TLS servername", () => {
    const client = createImapClient(
      loadConfig({
        PROTON_BRIDGE_USERNAME: "bridge-user",
        PROTON_BRIDGE_PASSWORD: "bridge-password",
      }),
    );
    const runtimeClient = client as typeof client & {
      host: string;
      options: {
        tls: {
          servername: string;
        };
      };
    };

    expect(runtimeClient.host).toBe("127.0.0.1");
    expect(runtimeClient.options.tls.servername).toBe("");
    expect(typeof runtimeClient.options.tls.servername).toBe("string");
  });
});
