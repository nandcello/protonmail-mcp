import type { FetchMessageObject, FetchQueryObject, SearchObject } from "imapflow";
import type { Options as MailOptions } from "nodemailer/lib/mailer/index.js";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { describe, expect, test } from "vite-plus/test";
import { loadConfig, type ProtonBridgeConfig } from "../src/config.ts";
import {
  createImapOptions,
  ProtonMailClient,
  type ProtonImapClient,
  type ProtonMailClientDependencies,
  type ProtonSmtpTransport,
} from "../src/proton-mail-client.ts";

interface FakeImapState {
  connected: number;
  loggedOut: number;
  releasedLocks: number;
  searches: SearchObject[];
  fetchOneQueries: FetchQueryObject[];
}

interface FakeImapBehavior {
  connectError?: Error;
  searchResult?: number[] | false;
  fetchedMessages?: FetchMessageObject[];
  fetchOneResults?: Array<FetchMessageObject | false>;
}

function createFakeImap(behavior: FakeImapBehavior = {}) {
  const state: FakeImapState = {
    connected: 0,
    loggedOut: 0,
    releasedLocks: 0,
    searches: [],
    fetchOneQueries: [],
  };
  const fetchOneResults = [...(behavior.fetchOneResults ?? [])];

  const client: ProtonImapClient = {
    async connect() {
      state.connected += 1;
      if (behavior.connectError) {
        throw behavior.connectError;
      }
    },
    async logout() {
      state.loggedOut += 1;
    },
    async list() {
      return [];
    },
    async getMailboxLock(path) {
      return {
        path: Array.isArray(path) ? path[0] : path,
        release() {
          state.releasedLocks += 1;
        },
      };
    },
    async search(query) {
      state.searches.push(query);
      return behavior.searchResult ?? [];
    },
    async *fetch() {
      yield* behavior.fetchedMessages ?? [];
    },
    async fetchOne(_sequence, query) {
      state.fetchOneQueries.push(query);
      return fetchOneResults.shift() ?? false;
    },
  };

  return { client, state };
}

function createDependencies(
  imap: ProtonImapClient,
  createSmtpTransport: ProtonMailClientDependencies["createSmtpTransport"] = () => {
    throw new Error("SMTP was not expected in this test.");
  },
): ProtonMailClientDependencies {
  return {
    createImapClient: () => imap,
    createSmtpTransport,
  };
}

function createConfig(overrides: Partial<ProtonBridgeConfig> = {}): ProtonBridgeConfig {
  return {
    ...loadConfig({
      PROTON_BRIDGE_USERNAME: "bridge-user",
      PROTON_BRIDGE_PASSWORD: "bridge-password",
      PROTON_MAX_MESSAGE_BYTES: "1024",
    }),
    ...overrides,
  };
}

describe("ProtonMailClient", () => {
  test("builds inspectable IMAP options for an IP-based Bridge host", () => {
    const options = createImapOptions(createConfig());

    expect(options.host).toBe("127.0.0.1");
    expect(options.tls?.servername).toBe("");
    expect(typeof options.tls?.servername).toBe("string");
  });

  test("searches newest UIDs first and releases the mailbox and connection", async () => {
    const { client: imap, state } = createFakeImap({
      searchResult: [3, 9, 5],
      fetchedMessages: [
        {
          seq: 1,
          uid: 5,
          envelope: { subject: "Older selected message" },
          flags: new Set(),
        },
        {
          seq: 2,
          uid: 9,
          envelope: { subject: "Newest message" },
          flags: new Set(["\\Seen"]),
        },
      ],
    });
    const client = new ProtonMailClient(createConfig(), createDependencies(imap));

    const messages = await client.searchEmails({
      mailbox: "INBOX",
      limit: 2,
      subject: "message",
      unreadOnly: true,
    });

    expect(messages.map(({ uid }) => uid)).toEqual([9, 5]);
    expect(state.searches).toEqual([{ subject: "message", seen: false }]);
    expect(state.connected).toBe(1);
    expect(state.releasedLocks).toBe(1);
    expect(state.loggedOut).toBe(1);
  });

  test("logs out a partially connected IMAP client when connect fails", async () => {
    const { client: imap, state } = createFakeImap({
      connectError: new Error("Bridge is unavailable"),
    });
    const client = new ProtonMailClient(createConfig(), createDependencies(imap));

    await expect(client.listMailboxes()).rejects.toThrow("Bridge is unavailable");

    expect(state.connected).toBe(1);
    expect(state.loggedOut).toBe(1);
  });

  test("bounds source download when size metadata is absent and rejects the sentinel byte", async () => {
    const limit = 1024;
    const { client: imap, state } = createFakeImap({
      fetchOneResults: [
        {
          seq: 1,
          uid: 42,
          envelope: { subject: "No size metadata" },
          flags: new Set(),
        },
        {
          seq: 1,
          uid: 42,
          source: Buffer.alloc(limit + 1),
        },
      ],
    });
    const client = new ProtonMailClient(
      createConfig({ maxMessageBytes: limit }),
      createDependencies(imap),
    );

    await expect(
      client.readEmail({ mailbox: "INBOX", uid: 42, maxCharacters: 500 }),
    ).rejects.toThrow(`Email is above the configured ${limit}-byte read limit.`);

    expect(state.fetchOneQueries).toEqual([
      {
        envelope: true,
        flags: true,
        internalDate: true,
        size: true,
      },
      { source: { maxLength: limit + 1 } },
    ]);
    expect(state.releasedLocks).toBe(1);
    expect(state.loggedOut).toBe(1);
  });

  test("does not download a source already known to exceed the limit", async () => {
    const { client: imap, state } = createFakeImap({
      fetchOneResults: [{ seq: 1, uid: 7, size: 1025 }],
    });
    const client = new ProtonMailClient(createConfig(), createDependencies(imap));

    await expect(
      client.readEmail({ mailbox: "Archive", uid: 7, maxCharacters: 500 }),
    ).rejects.toThrow("Email is 1025 bytes, above the configured 1024-byte read limit.");

    expect(state.fetchOneQueries).toHaveLength(1);
    expect(state.releasedLocks).toBe(1);
    expect(state.loggedOut).toBe(1);
  });

  test("closes SMTP after sending and disables file and URL access", async () => {
    let closed = 0;
    let sentOptions: MailOptions | undefined;
    const smtp: ProtonSmtpTransport = {
      async verify() {
        return true;
      },
      async sendMail(options) {
        sentOptions = options;
        return {
          envelope: { from: "me@example.com", to: ["you@example.com"] },
          messageId: "message-id",
          accepted: ["you@example.com"],
          rejected: [],
          pending: [],
          response: "250 OK",
        } satisfies SMTPTransport.SentMessageInfo;
      },
      close() {
        closed += 1;
      },
    };
    const { client: imap } = createFakeImap();
    const client = new ProtonMailClient(
      createConfig({ defaultFrom: "me@example.com" }),
      createDependencies(imap, () => smtp),
    );

    const result = await client.sendEmail({
      to: ["you@example.com"],
      subject: "Hello",
      text: "Safe body",
    });

    expect(result).toEqual({
      messageId: "message-id",
      accepted: ["you@example.com"],
      rejected: [],
      response: "250 OK",
    });
    expect(sentOptions).toMatchObject({
      from: "me@example.com",
      to: ["you@example.com"],
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(closed).toBe(1);
  });
});
