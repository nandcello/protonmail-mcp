import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { z } from "zod/v4";

const booleanString = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const optionalBooleanString = z
  .string()
  .optional()
  .transform((value, context) => {
    if (value === undefined || value === "") {
      return undefined;
    }

    const parsed = booleanString.safeParse(value.toLowerCase());
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        message: 'Expected "true", "false", "1", or "0"',
      });
      return z.NEVER;
    }

    return parsed.data;
  });

const portString = z.coerce.number().int().min(1).max(65_535);

const optionalEmailString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.email().optional(),
);

const environmentSchema = z.object({
  PROTON_BRIDGE_USERNAME: z.string().trim().min(1),
  PROTON_BRIDGE_PASSWORD: z.string().min(1),
  PROTON_BRIDGE_HOST: z.string().trim().min(1).default("127.0.0.1"),
  PROTON_BRIDGE_IMAP_PORT: portString.default(1143),
  PROTON_BRIDGE_SMTP_PORT: portString.default(1025),
  PROTON_BRIDGE_SECURITY: z.enum(["starttls", "tls"]).default("starttls"),
  PROTON_BRIDGE_TLS_REJECT_UNAUTHORIZED: optionalBooleanString,
  PROTON_BRIDGE_CA_FILE: z.string().trim().min(1).optional(),
  PROTON_DEFAULT_FROM: optionalEmailString,
  PROTON_ALLOWED_SENDERS: z.string().optional(),
  PROTON_MAX_MESSAGE_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(100 * 1_024 * 1_024)
    .default(25 * 1_024 * 1_024),
  PROTON_MAX_IMAGE_BYTES: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(20 * 1_024 * 1_024)
    .default(5 * 1_024 * 1_024),
  PROTON_IMAP_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(10).default(3),
  PROTON_IMAP_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(45_000),
  PROTON_ATTACHMENT_DIR: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined))
    .refine((value) => value === undefined || isAbsolute(value), {
      message: "Must be an absolute path",
    }),
});

export interface ProtonBridgeConfig {
  username: string;
  password: string;
  host: string;
  imapPort: number;
  smtpPort: number;
  security: "starttls" | "tls";
  tls: {
    rejectUnauthorized: boolean;
    ca?: string;
  };
  defaultFrom?: string;
  allowedSenders: ReadonlySet<string>;
  maxMessageBytes: number;
  maxImageBytes: number;
  imapMaxConnections: number;
  imapQueueTimeoutMs: number;
  attachmentDirectory?: string;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }

  return isIP(host) === 4 && host.startsWith("127.");
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
    .join("; ");
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ProtonBridgeConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ConfigurationError(
      `Invalid Proton Bridge configuration: ${formatZodError(parsed.error)}`,
    );
  }

  const values = parsed.data;
  const ca = values.PROTON_BRIDGE_CA_FILE
    ? readFileSync(values.PROTON_BRIDGE_CA_FILE, "utf8")
    : undefined;
  const rejectUnauthorized = values.PROTON_BRIDGE_TLS_REJECT_UNAUTHORIZED ?? ca !== undefined;

  if (!rejectUnauthorized && !isLoopbackHost(values.PROTON_BRIDGE_HOST)) {
    throw new ConfigurationError(
      "TLS certificate verification may only be disabled for a loopback Proton Bridge host.",
    );
  }

  const allowedSenders = new Set(
    (values.PROTON_ALLOWED_SENDERS ?? "")
      .split(",")
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean),
  );

  if (values.PROTON_DEFAULT_FROM) {
    allowedSenders.add(values.PROTON_DEFAULT_FROM.toLowerCase());
  }

  return {
    username: values.PROTON_BRIDGE_USERNAME,
    password: values.PROTON_BRIDGE_PASSWORD,
    host: values.PROTON_BRIDGE_HOST,
    imapPort: values.PROTON_BRIDGE_IMAP_PORT,
    smtpPort: values.PROTON_BRIDGE_SMTP_PORT,
    security: values.PROTON_BRIDGE_SECURITY,
    tls: {
      rejectUnauthorized,
      ...(ca === undefined ? {} : { ca }),
    },
    ...(values.PROTON_DEFAULT_FROM === undefined
      ? {}
      : { defaultFrom: values.PROTON_DEFAULT_FROM }),
    allowedSenders,
    maxMessageBytes: values.PROTON_MAX_MESSAGE_BYTES,
    maxImageBytes: values.PROTON_MAX_IMAGE_BYTES,
    imapMaxConnections: values.PROTON_IMAP_MAX_CONNECTIONS,
    imapQueueTimeoutMs: values.PROTON_IMAP_QUEUE_TIMEOUT_MS,
    ...(values.PROTON_ATTACHMENT_DIR === undefined
      ? {}
      : { attachmentDirectory: values.PROTON_ATTACHMENT_DIR }),
  };
}

export function publicConfig(config: ProtonBridgeConfig) {
  return {
    host: config.host,
    imapPort: config.imapPort,
    smtpPort: config.smtpPort,
    security: config.security,
    tlsRejectUnauthorized: config.tls.rejectUnauthorized,
    defaultFrom: config.defaultFrom ?? null,
    allowedSenders: [...config.allowedSenders],
    maxMessageBytes: config.maxMessageBytes,
    maxImageBytes: config.maxImageBytes,
    imapMaxConnections: config.imapMaxConnections,
    attachmentSavingEnabled: config.attachmentDirectory !== undefined,
  };
}
