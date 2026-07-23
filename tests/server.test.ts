import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vite-plus/test";
import { ConfigurationError } from "../src/config.ts";
import { createServer } from "../src/server.ts";

describe("MCP server", () => {
  test("advertises the Proton Mail tools over MCP", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(() => {
      throw new ConfigurationError("test configuration is intentionally missing");
    });
    const client = new Client({
      name: "protonmail-mcp-test",
      version: "1.0.0",
    });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const response = await client.listTools();
      expect(response.tools.map((tool) => tool.name)).toEqual([
        "connection_status",
        "list_sender_aliases",
        "list_mailboxes",
        "list_emails",
        "search_emails",
        "read_email",
        "send_email",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("reports missing Bridge configuration as a tool error", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(() => {
      throw new ConfigurationError("missing test credentials");
    });
    const client = new Client({
      name: "protonmail-mcp-test",
      version: "1.0.0",
    });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const response = await client.callTool({
        name: "connection_status",
        arguments: {},
      });
      expect(response.isError).toBe(true);
      expect(response.content).toEqual([{ type: "text", text: "missing test credentials" }]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
