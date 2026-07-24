import { z } from "zod/v4";

const MAX_RULES = 100;
const MAX_MATCHERS_PER_FIELD = 50;

const matcherList = z
  .array(z.string().trim().min(1).max(320))
  .min(1)
  .max(MAX_MATCHERS_PER_FIELD)
  .transform((values) => [...new Set(values.map((value) => value.toLowerCase()))].sort());

export const inboxConsumerIdSchema = z.string().trim().min(1).max(200);

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

export const inboxFilterRulesSchema = z
  .array(inboxFilterRuleSchema)
  .max(MAX_RULES)
  .transform((rules) => {
    const canonicalRules = new Map(rules.map((rule) => [JSON.stringify(rule), rule]));
    return [...canonicalRules.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, rule]) => rule);
  });

export const subscriptionSpecSchema = z
  .object({
    consumerId: inboxConsumerIdSchema,
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

export const inboxSubscriptionSchema = subscriptionSpecSchema.extend({
  id: z.uuid(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type InboxFilterRule = z.infer<typeof inboxFilterRuleSchema>;
export type InboxSubscription = z.infer<typeof inboxSubscriptionSchema>;
export type InboxSubscriptionSpec = z.infer<typeof subscriptionSpecSchema>;

export interface InboxMessageForFiltering {
  mailbox: string;
  from: string[];
  to: string[];
  cc?: string[];
  subject: string;
}

function anyContains(values: string[], matchers: string[]): boolean {
  return values.some((value) => {
    const candidate = value.toLowerCase();
    return matchers.some((matcher) => candidate.includes(matcher));
  });
}

function ruleMatches(rule: InboxFilterRule, message: InboxMessageForFiltering): boolean {
  if (rule.sender && !anyContains(message.from, rule.sender)) return false;
  if (rule.recipient && !anyContains([...message.to, ...(message.cc ?? [])], rule.recipient)) {
    return false;
  }
  if (rule.subject && !anyContains([message.subject], rule.subject)) return false;
  if (rule.mailbox && !rule.mailbox.some((mailbox) => mailbox === message.mailbox.toLowerCase())) {
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
