import {
  ImapFlow,
  type CopyResponseObject,
  type ImapFlowOptions,
  type SearchObject,
} from "imapflow";
import { simpleParser } from "mailparser";
import { isIP } from "node:net";
import nodemailer, { type SendMailOptions } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { ProtonBridgeConfig } from "./config.ts";
import {
  formatParsedAddresses,
  toEmailSummary,
  truncate,
  type EmailSummary,
} from "./email-utils.ts";

const SUMMARY_QUERY = {
  envelope: true,
  flags: true,
  internalDate: true,
  size: true,
} as const;

export interface EmailSearch {
  mailbox: string;
  limit: number;
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  since?: Date;
  before?: Date;
  unreadOnly?: boolean;
}

export interface ReadEmail {
  mailbox: string;
  uid: number;
  maxCharacters: number;
}

export interface MoveEmail {
  mailbox: string;
  uid: number;
  destination: string;
}

export interface MoveEmailResult {
  moved: true;
  from: string;
  to: string;
  uid: number;
  newUid?: number;
}

export interface SendEmail {
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
}

export interface ConnectionStatus {
  imap: { ok: boolean; error?: string };
  smtp: { ok: boolean; error?: string };
}

export type ProtonImapClient = Pick<
  ImapFlow,
  | "capabilities"
  | "connect"
  | "logout"
  | "list"
  | "getMailboxLock"
  | "search"
  | "fetch"
  | "fetchOne"
  | "messageMove"
  | "messageCopy"
  | "messageDelete"
>;

const FIXED_MOVE_DESTINATIONS = new Set(["INBOX", "Archive", "Trash"]);
const USER_MAILBOX_PREFIXES = ["Folders/", "Labels/"];

/** IMAP treats INBOX case-insensitively; every other mailbox name is exact. */
function normalizeMailboxPath(path: string) {
  return path.toUpperCase() === "INBOX" ? "INBOX" : path;
}

function isAllowedMoveDestination(path: string) {
  return (
    FIXED_MOVE_DESTINATIONS.has(path) ||
    USER_MAILBOX_PREFIXES.some((prefix) => path.startsWith(prefix) && path.length > prefix.length)
  );
}

export interface ProtonSmtpTransport {
  verify(): Promise<true>;
  sendMail(options: SendMailOptions): Promise<SMTPTransport.SentMessageInfo>;
  close(): void;
}

export interface ProtonMailClientDependencies {
  createImapClient(config: ProtonBridgeConfig): ProtonImapClient;
  createSmtpTransport(config: ProtonBridgeConfig): ProtonSmtpTransport;
}

export function createImapOptions(config: ProtonBridgeConfig): ImapFlowOptions {
  const secure = config.security === "tls";
  return {
    host: config.host,
    port: config.imapPort,
    secure,
    doSTARTTLS: secure ? undefined : true,
    auth: {
      user: config.username,
      pass: config.password,
    },
    tls: {
      ...config.tls,
      servername: isIP(config.host) ? "" : config.host,
    },
    logger: false,
    clientInfo: {
      name: "protonmail-mcp",
      version: "0.1.0",
    },
  };
}

export function createImapClient(config: ProtonBridgeConfig): ProtonImapClient {
  return new ImapFlow(createImapOptions(config));
}

export function createSmtpOptions(config: ProtonBridgeConfig): SMTPTransport.Options {
  const secure = config.security === "tls";
  return {
    host: config.host,
    port: config.smtpPort,
    secure,
    requireTLS: !secure,
    auth: {
      user: config.username,
      pass: config.password,
    },
    tls: config.tls,
  };
}

export function createSmtpTransport(config: ProtonBridgeConfig): ProtonSmtpTransport {
  return nodemailer.createTransport(createSmtpOptions(config));
}

const DEFAULT_DEPENDENCIES: ProtonMailClientDependencies = {
  createImapClient,
  createSmtpTransport,
};

export class ProtonMailClient {
  constructor(
    private readonly config: ProtonBridgeConfig,
    private readonly dependencies: ProtonMailClientDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  async connectionStatus(): Promise<ConnectionStatus> {
    const [imap, smtp] = await Promise.all([this.verifyImap(), this.verifySmtp()]);
    return { imap, smtp };
  }

  async listMailboxes() {
    return this.withImap(async (client) => {
      const mailboxes = await client.list({
        statusQuery: { messages: true, unseen: true },
      });

      return mailboxes.map((mailbox) => ({
        path: mailbox.path,
        name: mailbox.name,
        specialUse: mailbox.specialUse ?? null,
        subscribed: mailbox.subscribed,
        messages: mailbox.status?.messages ?? null,
        unseen: mailbox.status?.unseen ?? null,
      }));
    });
  }

  async listEmails(mailbox: string, limit: number, unreadOnly = false): Promise<EmailSummary[]> {
    return this.searchEmails({ mailbox, limit, unreadOnly });
  }

  async searchEmails(search: EmailSearch): Promise<EmailSummary[]> {
    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock(search.mailbox, {
        readOnly: true,
      });

      try {
        const query: SearchObject = {};
        if (search.text) query.text = search.text;
        if (search.from) query.from = search.from;
        if (search.to) query.to = search.to;
        if (search.subject) query.subject = search.subject;
        if (search.since) query.since = search.since;
        if (search.before) query.before = search.before;
        if (search.unreadOnly) query.seen = false;
        if (Object.keys(query).length === 0) query.all = true;

        const matches = await client.search(query, { uid: true });
        const selected = (matches || [])
          .toSorted((left, right) => right - left)
          .slice(0, search.limit);

        if (selected.length === 0) {
          return [];
        }

        const byUid = new Map<number, EmailSummary>();
        for await (const message of client.fetch(selected, SUMMARY_QUERY, {
          uid: true,
        })) {
          byUid.set(message.uid, toEmailSummary(message));
        }

        return selected.flatMap((uid) => {
          const message = byUid.get(uid);
          return message ? [message] : [];
        });
      } finally {
        lock.release();
      }
    });
  }

  async readEmail({ mailbox, uid, maxCharacters }: ReadEmail) {
    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });

      try {
        const metadata = await client.fetchOne(uid, SUMMARY_QUERY, {
          uid: true,
        });
        if (!metadata) {
          throw new Error(`Email UID ${uid} was not found in ${mailbox}.`);
        }

        if (metadata.size !== undefined && metadata.size > this.config.maxMessageBytes) {
          throw new Error(
            `Email is ${metadata.size} bytes, above the configured ${this.config.maxMessageBytes}-byte read limit.`,
          );
        }

        const message = await client.fetchOne(
          uid,
          { source: { maxLength: this.config.maxMessageBytes + 1 } },
          { uid: true },
        );
        if (!message || !message.source) {
          throw new Error(`Could not download email UID ${uid} from ${mailbox}.`);
        }

        if (message.source.byteLength > this.config.maxMessageBytes) {
          throw new Error(
            `Email is above the configured ${this.config.maxMessageBytes}-byte read limit.`,
          );
        }

        const parsed = await simpleParser(message.source, {
          skipHtmlToText: false,
          maxHtmlLengthToParse: this.config.maxMessageBytes,
        });
        const body = truncate(
          parsed.text ||
            (typeof parsed.html === "string" ? parsed.html : "(message has no text body)"),
          maxCharacters,
        );

        return {
          ...toEmailSummary(metadata),
          from: formatParsedAddresses(parsed.from),
          to: formatParsedAddresses(parsed.to),
          cc: formatParsedAddresses(parsed.cc),
          bcc: formatParsedAddresses(parsed.bcc),
          replyTo: formatParsedAddresses(parsed.replyTo),
          body: body.value,
          bodyTruncated: body.truncated,
          attachments: parsed.attachments.map((attachment) => ({
            filename: attachment.filename ?? null,
            contentType: attachment.contentType,
            size: attachment.size,
            contentId: attachment.contentId ?? null,
          })),
        };
      } finally {
        lock.release();
      }
    });
  }

  async moveEmail({ mailbox, uid, destination }: MoveEmail): Promise<MoveEmailResult> {
    const from = normalizeMailboxPath(mailbox);
    const to = normalizeMailboxPath(destination);
    if (from === to) {
      throw new Error(`Source and destination are both ${to}; choose a different destination.`);
    }
    if (!isAllowedMoveDestination(to)) {
      throw new Error(
        `Destination ${to} is not allowed. Use INBOX, Archive, Trash, or an existing Folders/... or Labels/... mailbox.`,
      );
    }

    return this.withImap(async (client) => {
      const mailboxes = await client.list();
      const target = mailboxes.find(
        (candidate) =>
          normalizeMailboxPath(candidate.path) === to &&
          !candidate.flags.has("\\Noselect") &&
          !candidate.flags.has("\\NonExistent"),
      );
      if (!target) {
        throw new Error(
          `Destination mailbox ${to} does not exist. move_email never creates mailboxes.`,
        );
      }

      const lock = await client.getMailboxLock(from);
      try {
        const existing = await client.fetchOne(uid, { uid: true }, { uid: true });
        if (!existing) {
          throw new Error(`Email UID ${uid} was not found in ${from}.`);
        }

        const result = await this.moveMessage(client, from, uid, target.path);
        const newUid = result.uidMap?.get(uid);
        return {
          moved: true,
          from,
          to: target.path,
          uid,
          ...(newUid === undefined ? {} : { newUid }),
        };
      } finally {
        lock.release();
      }
    });
  }

  async sendEmail(email: SendEmail) {
    const from = email.from ?? this.config.defaultFrom;
    if (!from) {
      throw new Error("A from address is required. Pass from or set PROTON_DEFAULT_FROM.");
    }

    if (
      this.config.allowedSenders.size > 0 &&
      !this.config.allowedSenders.has(from.toLowerCase())
    ) {
      throw new Error(
        `Sender ${from} is not in PROTON_ALLOWED_SENDERS. Configured senders: ${[...this.config.allowedSenders].join(", ")}`,
      );
    }

    const transporter = this.createSmtpTransport();
    try {
      const result = await transporter.sendMail({
        from,
        to: email.to,
        cc: email.cc,
        bcc: email.bcc,
        replyTo: email.replyTo,
        subject: email.subject,
        text: email.text,
        html: email.html,
        disableFileAccess: true,
        disableUrlAccess: true,
      });

      return {
        messageId: result.messageId,
        accepted: result.accepted.map(String),
        rejected: result.rejected.map(String),
        response: result.response,
      };
    } finally {
      transporter.close();
    }
  }

  /** Moves one UID out of the selected mailbox without ever expunging other messages. */
  private async moveMessage(
    client: ProtonImapClient,
    from: string,
    uid: number,
    destination: string,
  ): Promise<CopyResponseObject> {
    const range = String(uid);

    if (client.capabilities.has("MOVE")) {
      const moved = await client.messageMove(range, destination, { uid: true });
      if (!moved) {
        throw new Error(`Bridge refused to move email UID ${uid} from ${from} to ${destination}.`);
      }
      return moved;
    }

    // Without UIDPLUS the only way to finish the fallback is a plain EXPUNGE,
    // which would also remove any other message already flagged \Deleted.
    if (!client.capabilities.has("UIDPLUS")) {
      throw new Error(
        "Bridge advertises neither MOVE nor UIDPLUS, so the email cannot be moved without risking other messages.",
      );
    }
    if (from === "Trash") {
      throw new Error("Moving out of Trash requires IMAP MOVE; refusing to expunge from Trash.");
    }

    const copied = await client.messageCopy(range, destination, { uid: true });
    if (!copied) {
      throw new Error(`Bridge refused to copy email UID ${uid} from ${from} to ${destination}.`);
    }

    // With UIDPLUS advertised, imapflow flags \Deleted and issues UID EXPUNGE for this UID only.
    const removed = await client.messageDelete(range, { uid: true });
    if (!removed) {
      throw new Error(
        `Copied email UID ${uid} to ${destination}, but could not remove it from ${from}. It may now appear in both mailboxes.`,
      );
    }
    return copied;
  }

  private createImapClient() {
    return this.dependencies.createImapClient(this.config);
  }

  private createSmtpTransport() {
    return this.dependencies.createSmtpTransport(this.config);
  }

  private async withImap<T>(operation: (client: ProtonImapClient) => Promise<T>): Promise<T> {
    const client = this.createImapClient();
    try {
      await client.connect();
      return await operation(client);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  private async verifyImap() {
    const client = this.createImapClient();
    try {
      await client.connect();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  private async verifySmtp() {
    const transporter = this.createSmtpTransport();
    try {
      await transporter.verify();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      transporter.close();
    }
  }
}
