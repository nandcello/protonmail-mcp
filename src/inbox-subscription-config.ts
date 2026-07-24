import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod/v4";
import { ConfigurationError } from "./config.ts";
import { inboxConsumerIdSchema } from "./inbox-subscriptions.ts";

const optionalPath = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional(),
);

const environmentSchema = z.object({
  PROTON_INBOX_SUBSCRIPTIONS_FILE: optionalPath,
  PROTON_INBOX_CONSUMERS: z.string().optional(),
  XDG_DATA_HOME: optionalPath,
});

export interface InboxSubscriptionConfig {
  filePath: string;
  consumerIds: ReadonlySet<string>;
}

function configurationError(message: string): ConfigurationError {
  return new ConfigurationError(`Invalid inbox subscription configuration: ${message}`);
}

function requireAbsolutePath(name: string, value: string): string {
  if (!isAbsolute(value)) {
    throw configurationError(`${name} must be an absolute path.`);
  }
  return value;
}

export function loadInboxSubscriptionConfig(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): InboxSubscriptionConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const description = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw configurationError(description);
  }

  const values = parsed.data;
  const dataHome = values.XDG_DATA_HOME
    ? requireAbsolutePath("XDG_DATA_HOME", values.XDG_DATA_HOME)
    : join(homeDirectory, ".local", "share");
  const filePath = values.PROTON_INBOX_SUBSCRIPTIONS_FILE
    ? requireAbsolutePath("PROTON_INBOX_SUBSCRIPTIONS_FILE", values.PROTON_INBOX_SUBSCRIPTIONS_FILE)
    : join(dataHome, "protonmail-mcp", "inbox-subscriptions.json");

  const rawConsumerIds = (values.PROTON_INBOX_CONSUMERS ?? "")
    .split(",")
    .map((consumerId) => consumerId.trim())
    .filter(Boolean);
  const consumerIds = z.array(inboxConsumerIdSchema).safeParse(rawConsumerIds);
  if (!consumerIds.success) {
    const description = consumerIds.error.issues
      .map((issue) => `${issue.path.join(".") || "PROTON_INBOX_CONSUMERS"}: ${issue.message}`)
      .join("; ");
    throw configurationError(description);
  }

  return {
    filePath,
    consumerIds: new Set(consumerIds.data),
  };
}
