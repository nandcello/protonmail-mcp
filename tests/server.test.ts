import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { ConfigurationError } from "../src/config.ts";
import { ConfiguredInboxSubscriptionService } from "../src/inbox-subscription-service.ts";
import { InboxSubscriptionStore } from "../src/inbox-subscription-store.ts";
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
        "create_inbox_subscription",
        "list_inbox_subscriptions",
        "update_inbox_subscription",
        "set_inbox_subscription_enabled",
        "delete_inbox_subscription",
        "list_mailboxes",
        "list_emails",
        "search_emails",
        "read_email",
        "read_email_full",
        "get_email_attachment",
        "move_email",
        "start_attachment_upload",
        "stage_attachment_chunk",
        "finish_attachment_upload",
        "send_email",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("manages subscriptions without loading Bridge credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "protonmail-server-test-"));
    const store = new InboxSubscriptionStore(join(directory, "subscriptions.json"));
    const subscriptions = new ConfiguredInboxSubscriptionService(
      store,
      new Set(["test-consumer", "replacement-consumer"]),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(() => {
      throw new ConfigurationError("Bridge configuration must not be loaded");
    }, subscriptions);
    const client = new Client({
      name: "protonmail-mcp-test",
      version: "1.0.0",
    });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const invalid = await client.callTool({
        name: "create_inbox_subscription",
        arguments: {
          idempotency_key: "empty-request",
          consumer_id: "test-consumer",
        },
      });
      expect(invalid.isError).toBe(true);

      const created = await client.callTool({
        name: "create_inbox_subscription",
        arguments: {
          idempotency_key: "filtered-request",
          consumer_id: "test-consumer",
          filter_rules: [{ action: "include", subject: ["urgent"] }],
        },
      });
      expect(created.isError).not.toBe(true);
      const createdContent = (created as CallToolResult).content[0];
      if (createdContent.type !== "text") throw new Error("Expected a text tool result");
      const createdSubscription = JSON.parse(createdContent.text).subscription;

      const listed = await client.callTool({
        name: "list_inbox_subscriptions",
        arguments: {},
      });
      expect(listed.content).toHaveLength(1);
      const content = (listed as CallToolResult).content[0];
      expect(content.type).toBe("text");
      if (content.type !== "text") throw new Error("Expected a text tool result");
      expect(JSON.parse(content.text).subscriptions).toHaveLength(1);

      const paused = await client.callTool({
        name: "set_inbox_subscription_enabled",
        arguments: {
          id: createdSubscription.id,
          enabled: false,
          expected_revision: createdSubscription.revision,
        },
      });
      expect(paused.isError).not.toBe(true);
      const pausedContent = (paused as CallToolResult).content[0];
      if (pausedContent.type !== "text") throw new Error("Expected a text tool result");
      const pausedSubscription = JSON.parse(pausedContent.text).subscription;
      expect(pausedSubscription).toMatchObject({ enabled: false, revision: 2 });

      const updated = await client.callTool({
        name: "update_inbox_subscription",
        arguments: {
          id: createdSubscription.id,
          consumer_id: "replacement-consumer",
          expected_revision: pausedSubscription.revision,
        },
      });
      if (updated.isError) throw new Error(JSON.stringify(updated));
      expect(updated.isError).not.toBe(true);
      const updatedContent = (updated as CallToolResult).content[0];
      if (updatedContent.type !== "text") throw new Error("Expected a text tool result");
      const updatedSubscription = JSON.parse(updatedContent.text).subscription;
      expect(updatedSubscription).toMatchObject({
        consumerId: "replacement-consumer",
        revision: 3,
      });

      const deleted = await client.callTool({
        name: "delete_inbox_subscription",
        arguments: {
          id: createdSubscription.id,
          expected_revision: updatedSubscription.revision,
        },
      });
      expect(deleted.isError).not.toBe(true);
      expect(store.list()).toEqual([]);
    } finally {
      await client.close();
      await server.close();
      rmSync(directory, { recursive: true, force: true });
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

  test("reports configuration failures from direct handlers as tool errors", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(() => {
      throw new ConfigurationError("aliases unavailable without configuration");
    });
    const client = new Client({
      name: "protonmail-mcp-test",
      version: "1.0.0",
    });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const response = await client.callTool({
        name: "list_sender_aliases",
        arguments: {},
      });
      expect(response.isError).toBe(true);
      expect(response.content).toEqual([
        { type: "text", text: "aliases unavailable without configuration" },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
