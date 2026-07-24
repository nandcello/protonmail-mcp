import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { InboxSubscriptionService } from "./inbox-subscription-service.ts";
import { inboxConsumerIdSchema, inboxFilterRulesSchema } from "./inbox-subscriptions.ts";
import { toolResult, withToolErrorHandling } from "./tool-results.ts";

export function registerInboxSubscriptionTools(
  server: McpServer,
  subscriptions: InboxSubscriptionService,
): void {
  server.registerTool(
    "create_inbox_subscription",
    {
      title: "Create an inbox notification subscription",
      description:
        "Explicitly opt a configured consumer into future inbox notifications. Requires a retry-stable idempotency_key and either an include filter rule or all_inbox_mail=true. Exclusions alone never opt into mail. This stores configuration only; it does not start a watcher or deliver notifications.",
      inputSchema: {
        idempotency_key: z.string().trim().min(1).max(200),
        consumer_id: inboxConsumerIdSchema,
        enabled: z.boolean().default(true),
        all_inbox_mail: z.boolean().default(false),
        filter_rules: inboxFilterRulesSchema.default([]),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ idempotency_key, consumer_id, enabled, all_inbox_mail, filter_rules }) =>
      withToolErrorHandling(async () =>
        toolResult(
          await subscriptions.create({
            idempotencyKey: idempotency_key,
            consumerId: consumer_id,
            enabled,
            allInboxMail: all_inbox_mail,
            filterRules: filter_rules,
          }),
        ),
      ),
  );

  server.registerTool(
    "list_inbox_subscriptions",
    {
      title: "List inbox notification subscriptions",
      description:
        "List the persistent inbox notification subscriptions. With no subscriptions, inbox notifications are off.",
      inputSchema: {
        consumer_id: inboxConsumerIdSchema.optional(),
        enabled: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ consumer_id, enabled }) =>
      withToolErrorHandling(async () =>
        toolResult({
          subscriptions: await subscriptions.list({
            ...(consumer_id === undefined ? {} : { consumerId: consumer_id }),
            ...(enabled === undefined ? {} : { enabled }),
          }),
        }),
      ),
  );

  server.registerTool(
    "update_inbox_subscription",
    {
      title: "Update an inbox notification subscription",
      description:
        "Update a subscription's consumer or filter scope. expected_revision prevents overwriting a concurrent change. The resulting subscription must retain an include rule unless all_inbox_mail=true.",
      inputSchema: {
        id: z.uuid(),
        consumer_id: inboxConsumerIdSchema.optional(),
        all_inbox_mail: z.boolean().optional(),
        filter_rules: inboxFilterRulesSchema.optional(),
        expected_revision: z.number().int().positive().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id, consumer_id, all_inbox_mail, filter_rules, expected_revision }) =>
      withToolErrorHandling(async () =>
        toolResult({
          subscription: await subscriptions.update(id, {
            ...(consumer_id === undefined ? {} : { consumerId: consumer_id }),
            ...(all_inbox_mail === undefined ? {} : { allInboxMail: all_inbox_mail }),
            ...(filter_rules === undefined ? {} : { filterRules: filter_rules }),
            ...(expected_revision === undefined ? {} : { expectedRevision: expected_revision }),
          }),
        }),
      ),
  );

  server.registerTool(
    "set_inbox_subscription_enabled",
    {
      title: "Enable or pause an inbox notification subscription",
      description:
        "Enable or pause a persistent inbox subscription without deleting its filters. A paused subscription never matches messages. expected_revision prevents overwriting a concurrent change.",
      inputSchema: {
        id: z.uuid(),
        enabled: z.boolean(),
        expected_revision: z.number().int().positive().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id, enabled, expected_revision }) =>
      withToolErrorHandling(async () =>
        toolResult({
          subscription: await subscriptions.setEnabled(id, {
            enabled,
            ...(expected_revision === undefined ? {} : { expectedRevision: expected_revision }),
          }),
        }),
      ),
  );

  server.registerTool(
    "delete_inbox_subscription",
    {
      title: "Delete an inbox notification subscription",
      description:
        "Permanently delete an inbox notification subscription. Repeating a successful deletion returns deleted=false. Its create idempotency key remains reserved so a retry cannot recreate it.",
      inputSchema: {
        id: z.uuid(),
        expected_revision: z.number().int().positive().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id, expected_revision }) =>
      withToolErrorHandling(async () =>
        toolResult(await subscriptions.delete(id, expected_revision)),
      ),
  );
}
