import {
  loadInboxSubscriptionConfig,
  type InboxSubscriptionConfig,
} from "./inbox-subscription-config.ts";
import {
  InboxSubscriptionStore,
  type CreateInboxSubscription,
  type SetInboxSubscriptionEnabled,
  type UpdateInboxSubscription,
} from "./inbox-subscription-store.ts";
import type { InboxSubscription } from "./inbox-subscriptions.ts";

export interface InboxSubscriptionQuery {
  consumerId?: string;
  enabled?: boolean;
}

export interface InboxSubscriptionService {
  create(input: CreateInboxSubscription): Promise<{
    subscription: InboxSubscription;
    created: boolean;
  }>;
  list(query?: InboxSubscriptionQuery): Promise<InboxSubscription[]>;
  update(id: string, patch: UpdateInboxSubscription): Promise<InboxSubscription>;
  setEnabled(id: string, input: SetInboxSubscriptionEnabled): Promise<InboxSubscription>;
  delete(id: string, expectedRevision?: number): Promise<{ id: string; deleted: boolean }>;
}

export class ConfiguredInboxSubscriptionService implements InboxSubscriptionService {
  constructor(
    private readonly store: InboxSubscriptionStore,
    private readonly consumerIds: ReadonlySet<string>,
  ) {}

  async create(input: CreateInboxSubscription) {
    this.assertConfiguredConsumer(input.consumerId);
    return await this.store.create(input);
  }

  async list(query: InboxSubscriptionQuery = {}): Promise<InboxSubscription[]> {
    return this.store
      .list()
      .filter(
        (subscription) =>
          (query.consumerId === undefined || subscription.consumerId === query.consumerId) &&
          (query.enabled === undefined || subscription.enabled === query.enabled),
      );
  }

  async update(id: string, patch: UpdateInboxSubscription) {
    if (patch.consumerId !== undefined) this.assertConfiguredConsumer(patch.consumerId);
    return await this.store.update(id, patch);
  }

  setEnabled(id: string, input: SetInboxSubscriptionEnabled) {
    return this.store.setEnabled(id, input);
  }

  delete(id: string, expectedRevision?: number) {
    return this.store.delete(id, expectedRevision);
  }

  private assertConfiguredConsumer(consumerId: string): void {
    if (!this.consumerIds.has(consumerId)) {
      throw new Error(
        `Inbox notification consumer ${consumerId} is not configured. Add it to PROTON_INBOX_CONSUMERS before creating or assigning subscriptions.`,
      );
    }
  }
}

export function createInboxSubscriptionService(
  config: InboxSubscriptionConfig = loadInboxSubscriptionConfig(),
): InboxSubscriptionService {
  return new ConfiguredInboxSubscriptionService(
    new InboxSubscriptionStore(config.filePath),
    config.consumerIds,
  );
}
