import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { ConfigurationError } from "../src/config.ts";
import { createServer } from "../src/server.ts";

describe("search date validation", () => {
  let client: Client;
  let server: ReturnType<typeof createServer>;
  let configRequests: number;

  beforeEach(async () => {
    configRequests = 0;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createServer(() => {
      configRequests += 1;
      throw new ConfigurationError("valid search reached the tool handler");
    });
    client = new Client({
      name: "protonmail-mcp-date-test",
      version: "1.0.0",
    });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  test.each(["2026-02-31", "2025-02-29", "2026-13-01", "03-01-2026"])(
    "rejects invalid calendar date %s before creating a mail client",
    async (since) => {
      const response = await client.callTool({
        name: "search_emails",
        arguments: { since },
      });

      expect(response.isError).toBe(true);
      expect(response.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining("Use a real calendar date in YYYY-MM-DD format."),
        },
      ]);
      expect(configRequests).toBe(0);
    },
  );

  test.each(["2026-03-01", "2024-02-29"])("accepts valid calendar date %s", async (since) => {
    const response = await client.callTool({
      name: "search_emails",
      arguments: { since },
    });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      { type: "text", text: "valid search reached the tool handler" },
    ]);
    expect(configRequests).toBe(1);
  });
});
