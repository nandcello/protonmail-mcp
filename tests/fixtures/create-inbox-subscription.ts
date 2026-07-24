import { InboxSubscriptionStore } from "../../src/inbox-subscription-store.ts";

const [filePath, index] = process.argv.slice(2);
if (!filePath || !index) throw new Error("Expected a store path and unique index.");

await new InboxSubscriptionStore(filePath).create({
  idempotencyKey: `concurrent-request-${index}`,
  consumerId: `consumer-${index}`,
  allInboxMail: true,
});
