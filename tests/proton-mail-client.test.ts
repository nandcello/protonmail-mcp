import type {
  CopyResponseObject,
  FetchMessageObject,
  FetchQueryObject,
  ListResponse,
  SearchObject,
} from "imapflow";
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
  locks: Array<{ path: string; readOnly: boolean }>;
  commands: string[];
}

interface FakeImapBehavior {
  connectError?: Error;
  searchResult?: number[] | false;
  fetchedMessages?: FetchMessageObject[];
  fetchOneResults?: Array<FetchMessageObject | false>;
  capabilities?: string[];
  mailboxes?: Array<{ path: string; flags?: string[] }>;
  copyResult?: CopyResponseObject | false;
  deleteResult?: boolean;
}

function describeRange(range: Parameters<ProtonImapClient["messageMove"]>[0]) {
  return typeof range === "string" ? range : JSON.stringify(range);
}

function createFakeImap(behavior: FakeImapBehavior = {}) {
  const state: FakeImapState = {
    connected: 0,
    loggedOut: 0,
    releasedLocks: 0,
    searches: [],
    fetchOneQueries: [],
    locks: [],
    commands: [],
  };
  const fetchOneResults = [...(behavior.fetchOneResults ?? [])];

  const client: ProtonImapClient = {
    capabilities: new Map((behavior.capabilities ?? []).map((name) => [name, true])),
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
      return (behavior.mailboxes ?? []).map(
        ({ path, flags = [] }) =>
          ({
            path,
            pathAsListed: path,
            name: path.split("/").at(-1) ?? path,
            delimiter: "/",
            parent: [],
            parentPath: "",
            flags: new Set(flags),
            listed: true,
            subscribed: true,
          }) satisfies ListResponse,
      );
    },
    async getMailboxLock(path, options) {
      state.locks.push({
        path: Array.isArray(path) ? path[0] : path,
        readOnly: options?.readOnly ?? false,
      });
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
    async messageMove(range, destination, options) {
      state.commands.push(`move ${describeRange(range)} ${destination} uid=${options?.uid}`);
      return {
        path: "INBOX",
        destination,
        uidValidity: 1n,
        uidMap: new Map([[Number(describeRange(range)), 900]]),
      };
    },
    async messageCopy(range, destination, options) {
      state.commands.push(`copy ${describeRange(range)} ${destination} uid=${options?.uid}`);
      return (
        behavior.copyResult ?? {
          path: "INBOX",
          destination,
          uidValidity: 1n,
          uidMap: new Map([[Number(describeRange(range)), 901]]),
        }
      );
    },
    async messageDelete(range, options) {
      state.commands.push(`delete ${describeRange(range)} uid=${options?.uid}`);
      return behavior.deleteResult ?? true;
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

  describe("moveEmail", () => {
    const mailboxes = [
      { path: "INBOX" },
      { path: "Archive" },
      { path: "Trash" },
      { path: "Spam" },
      { path: "All Mail" },
      { path: "Folders", flags: ["\\Noselect"] },
      { path: "Folders/Jobs" },
      { path: "Labels/Applied" },
    ];
    const message: FetchMessageObject = { seq: 3, uid: 42 };

    test("uses UID MOVE when Bridge advertises MOVE and returns the new UID", async () => {
      const { client: imap, state } = createFakeImap({
        capabilities: ["MOVE", "UIDPLUS"],
        mailboxes,
        fetchOneResults: [message],
      });
      const client = new ProtonMailClient(createConfig(), createDependencies(imap));

      const result = await client.moveEmail({ mailbox: "inbox", uid: 42, destination: "Archive" });

      expect(result).toEqual({ moved: true, from: "INBOX", to: "Archive", uid: 42, newUid: 900 });
      expect(state.locks).toEqual([{ path: "INBOX", readOnly: false }]);
      expect(state.fetchOneQueries).toEqual([{ uid: true }]);
      expect(state.commands).toEqual(["move 42 Archive uid=true"]);
      expect(state.releasedLocks).toBe(1);
      expect(state.loggedOut).toBe(1);
    });

    test("falls back to UID COPY plus a single-UID expunge when MOVE is missing", async () => {
      const { client: imap, state } = createFakeImap({
        capabilities: ["UIDPLUS"],
        mailboxes,
        fetchOneResults: [message],
      });
      const client = new ProtonMailClient(createConfig(), createDependencies(imap));

      const result = await client.moveEmail({ mailbox: "INBOX", uid: 42, destination: "Trash" });

      expect(result).toEqual({ moved: true, from: "INBOX", to: "Trash", uid: 42, newUid: 901 });
      expect(state.commands).toEqual(["copy 42 Trash uid=true", "delete 42 uid=true"]);
    });

    test("omits newUid when Bridge does not report COPYUID", async () => {
      const { client: imap } = createFakeImap({
        capabilities: ["UIDPLUS"],
        mailboxes,
        fetchOneResults: [message],
        copyResult: { path: "INBOX", destination: "Archive" },
      });
      const client = new ProtonMailClient(createConfig(), createDependencies(imap));

      await expect(
        client.moveEmail({ mailbox: "INBOX", uid: 42, destination: "Archive" }),
      ).resolves.toEqual({ moved: true, from: "INBOX", to: "Archive", uid: 42 });
    });

    test("refuses the fallback without UIDPLUS so no mailbox-wide EXPUNGE is issued", async () => {
      const { client: imap, state } = createFakeImap({
        capabilities: [],
        mailboxes,
        fetchOneResults: [message],
      });
      const client = new ProtonMailClient(createConfig(), createDependencies(imap));

      await expect(
        client.moveEmail({ mailbox: "INBOX", uid: 42, destination: "Archive" }),
      ).rejects.toThrow("neither MOVE nor UIDPLUS");
      expect(state.commands).toEqual([]);
      expect(state.releasedLocks).toBe(1);
    });

    test("refuses the fallback out of Trash so nothing is expunged from Trash", async () => {
      const { client: imap, state } = createFakeImap({
        capabilities: ["UIDPLUS"],
        mailboxes,
        fetchOneResults: [message],
      });
      const client = new ProtonMailClient(createConfig(), createDependencies(imap));

      await expect(
        client.moveEmail({ mailbox: "Trash", uid: 42, destination: "INBOX" }),
      ).rejects.toThrow("refusing to expunge from Trash");
      expect(state.commands).toEqual([]);
    });

    test("reports a copied-but-not-removed fallback instead of claiming success", async () => {
      const { client: imap } = createFakeImap({
        capabilities: ["UIDPLUS"],
        mailboxes,
        fetchOneResults: [message],
        deleteResult: false,
      });
      const client = new ProtonMailClient(createConfig(), createDependencies(imap));

      await expect(
        client.moveEmail({ mailbox: "INBOX", uid: 42, destination: "Archive" }),
      ).rejects.toThrow("could not remove it from INBOX");
    });

    test.each(["Folders/Jobs", "Labels/Applied", "Trash", "INBOX"])(
      "allows existing destination %s",
      async (destination) => {
        const { client: imap, state } = createFakeImap({
          capabilities: ["MOVE"],
          mailboxes,
          fetchOneResults: [message],
        });
        const client = new ProtonMailClient(createConfig(), createDependencies(imap));
        const mailbox = destination === "INBOX" ? "Archive" : "INBOX";

        await expect(client.moveEmail({ mailbox, uid: 42, destination })).resolves.toMatchObject({
          moved: true,
          to: destination,
        });
        expect(state.commands).toEqual([`move 42 ${destination} uid=true`]);
      },
    );

    test.each(["Spam", "All Mail", "Sent", "Folders", "Folders/", "Other/Thing"])(
      "refuses disallowed destination %s without connecting",
      async (destination) => {
        const { client: imap, state } = createFakeImap({ capabilities: ["MOVE"], mailboxes });
        const client = new ProtonMailClient(createConfig(), createDependencies(imap));

        await expect(client.moveEmail({ mailbox: "INBOX", uid: 42, destination })).rejects.toThrow(
          `Destination ${destination} is not allowed.`,
        );
        expect(state.connected).toBe(0);
      },
    );

    test("refuses an allowed-looking destination that does not exist and never creates it", async () => {
      const { client: imap, state } = createFakeImap({ capabilities: ["MOVE"], mailboxes });
      const client = new ProtonMailClient(createConfig(), createDependencies(imap));

      await expect(
        client.moveEmail({ mailbox: "INBOX", uid: 42, destination: "Folders/Missing" }),
      ).rejects.toThrow("Destination mailbox Folders/Missing does not exist.");
      expect(state.locks).toEqual([]);
      expect(state.commands).toEqual([]);
      expect(state.loggedOut).toBe(1);
    });

    test("refuses a UID that is not in the source mailbox", async () => {
      const { client: imap, state } = createFakeImap({
        capabilities: ["MOVE"],
        mailboxes,
        fetchOneResults: [false],
      });
      const client = new ProtonMailClient(createConfig(), createDependencies(imap));

      await expect(
        client.moveEmail({ mailbox: "INBOX", uid: 77, destination: "Archive" }),
      ).rejects.toThrow("Email UID 77 was not found in INBOX.");
      expect(state.commands).toEqual([]);
      expect(state.releasedLocks).toBe(1);
      expect(state.loggedOut).toBe(1);
    });

    test.each([
      ["Archive", "Archive"],
      ["INBOX", "inbox"],
    ])("refuses moving from %s to the same mailbox %s", async (mailbox, destination) => {
      const { client: imap, state } = createFakeImap({ capabilities: ["MOVE"], mailboxes });
      const client = new ProtonMailClient(createConfig(), createDependencies(imap));

      await expect(client.moveEmail({ mailbox, uid: 42, destination })).rejects.toThrow(
        "Source and destination are both",
      );
      expect(state.connected).toBe(0);
    });
  });
});
