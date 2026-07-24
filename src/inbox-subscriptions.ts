import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";

const MAX_RULES = 100;
const MAX_MATCHERS_PER_FIELD = 50;

const matcherList = z
  .array(z.string().trim().min(1).max(320))
  .min(1)
  .max(MAX_MATCHERS_PER_FIELD)
  .transform((values) => [...new Set(values.map((value) => value.toLowerCase()))].sort());

export const inboxFilterRuleSchema = z
  .object({
    action: z.enum(["include", "exclude"]).default("include"),
    sender: matcherList.optional(),
    recipient: matcherList.optional(),
    subject: matcherList.optional(),
    mailbox: matcherList.optional(),
  })
  .refine(
    (rule) =>
      rule.sender !== undefined ||
      rule.recipient !== undefined ||
      rule.subject !== undefined ||
      rule.mailbox !== undefined,
    { message: "A filter rule must contain at least one matcher." },
  );

export const inboxFilterRulesSchema = z.array(inboxFilterRuleSchema).max(MAX_RULES);

const subscriptionSpecSchema = z
  .object({
    consumerId: z.string().trim().min(1).max(200),
    enabled: z.boolean().default(true),
    allInboxMail: z.boolean().default(false),
    filterRules: inboxFilterRulesSchema.default([]),
  })
  .refine(
    (subscription) =>
      subscription.allInboxMail ||
      subscription.filterRules.some((rule) => rule.action === "include"),
    {
      message:
        "Set all_inbox_mail=true or provide at least one include filter rule. Exclusion rules alone do not opt in to inbox mail.",
    },
  );

const inboxSubscriptionSchema = subscriptionSpecSchema.extend({
  id: z.uuid(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const createRequestSchema = z.object({
  key: z.string().min(1),
  fingerprint: z.string().min(1),
  subscriptionId: z.uuid(),
  createdAt: z.iso.datetime(),
});

const storeFileSchema = z.object({
  version: z.literal(1),
  subscriptions: z.array(inboxSubscriptionSchema),
  createRequests: z.array(createRequestSchema),
});

export type InboxFilterRule = z.infer<typeof inboxFilterRuleSchema>;
export type InboxSubscription = z.infer<typeof inboxSubscriptionSchema>;

export interface InboxMessageForFiltering {
  mailbox: string;
  from: string[];
  to: string[];
  cc?: string[];
  subject: string;
}

export interface CreateInboxSubscription {
  idempotencyKey: string;
  consumerId: string;
  enabled?: boolean;
  allInboxMail?: boolean;
  filterRules?: InboxFilterRule[];
}

export interface UpdateInboxSubscription {
  consumerId?: string;
  allInboxMail?: boolean;
  filterRules?: InboxFilterRule[];
  expectedRevision?: number;
}

export interface SetInboxSubscriptionEnabled {
  enabled: boolean;
  expectedRevision?: number;
}

interface StoreFile {
  version: 1;
  subscriptions: InboxSubscription[];
  createRequests: z.infer<typeof createRequestSchema>[];
}

export class InboxSubscriptionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxSubscriptionStoreError";
  }
}

function emptyStore(): StoreFile {
  return { version: 1, subscriptions: [], createRequests: [] };
}

function errorDescription(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "subscription"}: ${issue.message}`)
    .join("; ");
}

function normalized(value: string): string {
  return value.toLowerCase();
}

function anyContains(values: string[], matchers: string[]): boolean {
  return values.some((value) => {
    const candidate = normalized(value);
    return matchers.some((matcher) => candidate.includes(normalized(matcher)));
  });
}

function ruleMatches(rule: InboxFilterRule, message: InboxMessageForFiltering): boolean {
  if (rule.sender && !anyContains(message.from, rule.sender)) return false;
  if (rule.recipient && !anyContains([...message.to, ...(message.cc ?? [])], rule.recipient)) {
    return false;
  }
  if (rule.subject && !anyContains([message.subject], rule.subject)) return false;
  if (
    rule.mailbox &&
    !rule.mailbox.some((mailbox) => normalized(mailbox) === normalized(message.mailbox))
  ) {
    return false;
  }
  return true;
}

/**
 * Defines the watcher boundary without starting a watcher: include rules opt a
 * message in, exclusion rules always win, and paused subscriptions never match.
 */
export function subscriptionMatchesMessage(
  subscription: InboxSubscription,
  message: InboxMessageForFiltering,
): boolean {
  if (!subscription.enabled) return false;

  const included =
    subscription.allInboxMail ||
    subscription.filterRules.some(
      (rule) => rule.action === "include" && ruleMatches(rule, message),
    );
  if (!included) return false;

  return !subscription.filterRules.some(
    (rule) => rule.action === "exclude" && ruleMatches(rule, message),
  );
}

export function defaultInboxSubscriptionsFile(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.PROTON_INBOX_SUBSCRIPTIONS_FILE?.trim()) {
    return resolve(environment.PROTON_INBOX_SUBSCRIPTIONS_FILE.trim());
  }

  const dataHome = environment.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(dataHome, "protonmail-mcp", "inbox-subscriptions.json");
}

export class InboxSubscriptionStore {
  constructor(readonly filePath: string = defaultInboxSubscriptionsFile()) {}

  list(): InboxSubscription[] {
    return this.read().subscriptions.toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  create(input: CreateInboxSubscription): {
    subscription: InboxSubscription;
    created: boolean;
  } {
    const idempotencyKey = z.string().trim().min(1).max(200).parse(input.idempotencyKey);
    const spec = this.parseSpec(input);
    const fingerprint = JSON.stringify(spec);
    const store = this.read();
    const priorRequest = store.createRequests.find(({ key }) => key === idempotencyKey);

    if (priorRequest) {
      if (priorRequest.fingerprint !== fingerprint) {
        throw new InboxSubscriptionStoreError(
          `Idempotency key ${idempotencyKey} was already used for a different subscription request.`,
        );
      }

      const existing = store.subscriptions.find(({ id }) => id === priorRequest.subscriptionId);
      if (!existing) {
        throw new InboxSubscriptionStoreError(
          `Idempotency key ${idempotencyKey} belongs to a subscription that was deleted; use a new key to create another subscription.`,
        );
      }
      return { subscription: existing, created: false };
    }

    const now = new Date().toISOString();
    const subscription = inboxSubscriptionSchema.parse({
      ...spec,
      id: randomUUID(),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    store.subscriptions.push(subscription);
    store.createRequests.push({
      key: idempotencyKey,
      fingerprint,
      subscriptionId: subscription.id,
      createdAt: now,
    });
    this.write(store);
    return { subscription, created: true };
  }

  update(id: string, patch: UpdateInboxSubscription): InboxSubscription {
    return this.mutateExisting(id, patch.expectedRevision, (current) => {
      const spec = this.parseSpec({
        consumerId: patch.consumerId ?? current.consumerId,
        enabled: current.enabled,
        allInboxMail: patch.allInboxMail ?? current.allInboxMail,
        filterRules: patch.filterRules ?? current.filterRules,
      });
      return { ...current, ...spec };
    });
  }

  setEnabled(id: string, input: SetInboxSubscriptionEnabled): InboxSubscription {
    return this.mutateExisting(id, input.expectedRevision, (current) => ({
      ...current,
      enabled: input.enabled,
    }));
  }

  delete(id: string, expectedRevision?: number): { id: string; deleted: boolean } {
    const subscriptionId = z.uuid().parse(id);
    const store = this.read();
    const index = store.subscriptions.findIndex(
      (subscription) => subscription.id === subscriptionId,
    );
    if (index < 0) return { id: subscriptionId, deleted: false };

    const current = store.subscriptions[index];
    this.assertRevision(current, expectedRevision);
    store.subscriptions.splice(index, 1);
    this.write(store);
    return { id: subscriptionId, deleted: true };
  }

  private mutateExisting(
    id: string,
    expectedRevision: number | undefined,
    mutate: (current: InboxSubscription) => InboxSubscription,
  ): InboxSubscription {
    const subscriptionId = z.uuid().parse(id);
    const store = this.read();
    const index = store.subscriptions.findIndex(
      (subscription) => subscription.id === subscriptionId,
    );
    if (index < 0) {
      throw new InboxSubscriptionStoreError(`Inbox subscription ${subscriptionId} was not found.`);
    }

    const current = store.subscriptions[index];
    this.assertRevision(current, expectedRevision);
    const candidate = inboxSubscriptionSchema.parse(mutate(current));
    const unchanged =
      candidate.consumerId === current.consumerId &&
      candidate.enabled === current.enabled &&
      candidate.allInboxMail === current.allInboxMail &&
      JSON.stringify(candidate.filterRules) === JSON.stringify(current.filterRules);
    if (unchanged) return current;

    const updated = inboxSubscriptionSchema.parse({
      ...candidate,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    store.subscriptions[index] = updated;
    this.write(store);
    return updated;
  }

  private parseSpec(input: {
    consumerId: string;
    enabled?: boolean;
    allInboxMail?: boolean;
    filterRules?: InboxFilterRule[];
  }) {
    const parsed = subscriptionSpecSchema.safeParse(input);
    if (!parsed.success) {
      throw new InboxSubscriptionStoreError(
        `Invalid inbox subscription: ${errorDescription(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  private assertRevision(subscription: InboxSubscription, expectedRevision: number | undefined) {
    if (expectedRevision !== undefined && subscription.revision !== expectedRevision) {
      throw new InboxSubscriptionStoreError(
        `Inbox subscription ${subscription.id} is at revision ${subscription.revision}, not expected revision ${expectedRevision}. Refresh it before retrying the change.`,
      );
    }
  }

  private read(): StoreFile {
    if (!existsSync(this.filePath)) return emptyStore();

    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new InboxSubscriptionStoreError(
        `Could not read inbox subscriptions from ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const parsed = storeFileSchema.safeParse(value);
    if (!parsed.success) {
      throw new InboxSubscriptionStoreError(
        `Invalid inbox subscription store ${this.filePath}: ${errorDescription(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  private write(store: StoreFile) {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;

    try {
      writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporaryPath, this.filePath);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }
}
