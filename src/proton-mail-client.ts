import {
  ImapFlow,
  type CopyResponseObject,
  type ImapFlowOptions,
  type SearchObject,
} from "imapflow";
import { simpleParser } from "mailparser";
import { mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import nodemailer, { type SendMailOptions } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { extractAttachmentText } from "./attachment-text.ts";
import type { ProtonBridgeConfig } from "./config.ts";
import {
  formatParsedAddresses,
  toEmailSummary,
  truncate,
  type EmailSummary,
} from "./email-utils.ts";
import {
  cleanPlainText,
  describeStructure,
  htmlToText,
  truncateWithNotice,
  type AttachmentInfo,
} from "./full-email.ts";
import { connectWithRetry, sharedImapGate, type ImapGate } from "./imap-gate.ts";

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

/** Identifies one message by UID, or by Message-ID searched within the mailbox. */
export interface EmailLocator {
  mailbox?: string;
  uid?: number;
  messageId?: string;
}

export interface ReadFullEmail extends EmailLocator {
  maxCharacters: number;
}

export interface GetAttachment extends EmailLocator {
  attachmentId: string;
  maxCharacters: number;
  saveToFile: boolean;
}

/** Message-ID lookups default to All Mail so the message is found wherever it is filed. */
export const MESSAGE_ID_DEFAULT_MAILBOX = "All Mail";

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
  | "download"
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
  /** Defaults to one gate per Bridge endpoint shared by the whole process. */
  imapGate?: ImapGate;
  sleep?: (ms: number) => Promise<void>;
}

const CONNECT_ATTEMPTS = 3;
const CONNECT_BACKOFF_MS = 400;

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

  async readEmailFull({ maxCharacters, ...locator }: ReadFullEmail) {
    return this.withMessage(locator, async (client, mailbox, uid) => {
      const message = await this.fetchStructure(client, mailbox, uid);
      const layout = describeStructure(message.bodyStructure);
      const usePlain = layout.plain.length > 0;
      const parts = usePlain ? layout.plain : layout.html;

      const pieces: string[] = [];
      let downloadTruncated = false;
      for (const part of parts) {
        const { content, truncated } = await this.downloadPart(
          client,
          uid,
          part.id,
          this.config.maxMessageBytes,
        );
        downloadTruncated ||= truncated;
        pieces.push(content.toString("utf8"));
      }

      const text = usePlain
        ? cleanPlainText(pieces.join("\n\n"), layout.attachments)
        : htmlToText(pieces.join("\n"), layout.attachments);
      const body = truncateWithNotice(text || "(message has no text body)", maxCharacters);

      return {
        mailbox,
        ...toEmailSummary(message),
        bodyFormat: parts.length === 0 ? "none" : usePlain ? "text/plain" : "text/html",
        body: body.value,
        bodyTruncated: body.truncated || downloadTruncated,
        bodyCharacters: body.totalCharacters,
        attachments: layout.attachments,
      };
    });
  }

  async getAttachment({ attachmentId, maxCharacters, saveToFile, ...locator }: GetAttachment) {
    if (saveToFile && !this.config.attachmentDirectory) {
      throw new Error(
        "Saving attachments is disabled. Set PROTON_ATTACHMENT_DIR to an absolute directory to enable saveToFile.",
      );
    }

    return this.withMessage(locator, async (client, mailbox, uid) => {
      const message = await this.fetchStructure(client, mailbox, uid);
      const { attachments } = describeStructure(message.bodyStructure);
      const attachment = attachments.find((candidate) => candidate.id === attachmentId);
      if (!attachment) {
        throw new Error(
          `Attachment ${attachmentId} was not found in UID ${uid} of ${mailbox}. Available: ${attachments.map((candidate) => candidate.id).join(", ") || "none"}.`,
        );
      }
      if (attachment.size > this.config.maxMessageBytes) {
        throw new Error(
          `Attachment is about ${attachment.size} bytes, above the configured ${this.config.maxMessageBytes}-byte limit.`,
        );
      }

      const { content, truncated } = await this.downloadPart(
        client,
        uid,
        attachment.id,
        this.config.maxMessageBytes,
      );
      if (truncated) {
        throw new Error(
          `Attachment exceeded the configured ${this.config.maxMessageBytes}-byte limit while downloading.`,
        );
      }

      const extracted = await extractAttachmentText(
        content,
        attachment.contentType,
        attachment.filename,
      );
      const text =
        extracted.text === null ? null : truncateWithNotice(extracted.text, maxCharacters);
      const savedPath = saveToFile
        ? await this.saveAttachment(mailbox, uid, attachment, content)
        : null;

      return {
        mailbox,
        uid,
        attachment: { ...attachment, size: content.byteLength },
        text: text?.value ?? null,
        textTruncated: text?.truncated ?? false,
        textCharacters: text?.totalCharacters ?? 0,
        ...(extracted.pages === undefined ? {} : { pages: extracted.pages }),
        note: extracted.note,
        savedPath,
      };
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

  /** Opens the mailbox read-only (EXAMINE), so no fetch can change \Seen, then resolves the UID. */
  private async withMessage<T>(
    { mailbox, uid, messageId }: EmailLocator,
    operation: (client: ProtonImapClient, mailbox: string, uid: number) => Promise<T>,
  ): Promise<T> {
    if ((uid === undefined) === (messageId === undefined)) {
      throw new Error("Pass exactly one of uid or messageId.");
    }
    const path = mailbox ?? (uid === undefined ? MESSAGE_ID_DEFAULT_MAILBOX : "INBOX");

    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const resolved = uid ?? (await this.findByMessageId(client, path, messageId ?? ""));
        return await operation(client, path, resolved);
      } finally {
        lock.release();
      }
    });
  }

  private async findByMessageId(client: ProtonImapClient, mailbox: string, messageId: string) {
    const bare = messageId.trim().replace(/^<|>$/g, "");
    if (!bare) throw new Error("messageId must not be empty.");

    // HEADER search is a substring match, so confirm the exact ID from the envelope.
    const matches = (await client.search({ header: { "message-id": bare } }, { uid: true })) || [];
    for (const candidate of matches.toSorted((left, right) => right - left)) {
      const message = await client.fetchOne(String(candidate), { envelope: true }, { uid: true });
      const found = message && message.envelope?.messageId?.replace(/^<|>$/g, "");
      if (found === bare) return candidate;
    }
    throw new Error(`No email with Message-ID <${bare}> was found in ${mailbox}.`);
  }

  private async fetchStructure(client: ProtonImapClient, mailbox: string, uid: number) {
    const message = await client.fetchOne(
      String(uid),
      { ...SUMMARY_QUERY, bodyStructure: true },
      { uid: true },
    );
    if (!message) {
      throw new Error(`Email UID ${uid} was not found in ${mailbox}.`);
    }
    if (!message.bodyStructure) {
      throw new Error(`Bridge returned no MIME structure for UID ${uid} in ${mailbox}.`);
    }
    return { ...message, bodyStructure: message.bodyStructure };
  }

  /** Downloads one decoded MIME part with BODY.PEEK, reporting whether it exceeded maxBytes. */
  private async downloadPart(
    client: ProtonImapClient,
    uid: number,
    part: string,
    maxBytes: number,
  ) {
    const { content } = await client.download(String(uid), part, {
      uid: true,
      maxBytes: maxBytes + 1,
    });
    if (!content) {
      throw new Error(`Could not download part ${part} of email UID ${uid}.`);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of content as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      total += chunk.length;
    }
    const buffer = Buffer.concat(chunks, total);
    return {
      content: buffer.subarray(0, maxBytes),
      truncated: buffer.byteLength > maxBytes,
    };
  }

  private async saveAttachment(
    mailbox: string,
    uid: number,
    attachment: AttachmentInfo,
    content: Buffer,
  ) {
    const directory = this.config.attachmentDirectory;
    if (!directory) throw new Error("PROTON_ATTACHMENT_DIR is not configured.");

    const name = `${mailbox}-${uid}-${attachment.id}-${attachment.filename ?? "attachment"}`
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .slice(-180);
    const path = join(directory, name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
    return path;
  }

  private imapGate() {
    return (
      this.dependencies.imapGate ??
      sharedImapGate(
        `${this.config.host}:${this.config.imapPort}`,
        this.config.imapMaxConnections,
        this.config.imapQueueTimeoutMs,
      )
    );
  }

  private createImapClient() {
    return this.dependencies.createImapClient(this.config);
  }

  private createSmtpTransport() {
    return this.dependencies.createSmtpTransport(this.config);
  }

  /**
   * Runs one operation on a fresh IMAP session. Sessions are admitted through
   * the shared gate, and only a failed connect is retried with backoff.
   */
  private async withImap<T>(operation: (client: ProtonImapClient) => Promise<T>): Promise<T> {
    return this.imapGate().run(async () => {
      const client = await connectWithRetry(
        async () => {
          const candidate = this.createImapClient();
          try {
            await candidate.connect();
            return candidate;
          } catch (error) {
            await candidate.logout().catch(() => undefined);
            throw error;
          }
        },
        {
          attempts: CONNECT_ATTEMPTS,
          baseDelayMs: CONNECT_BACKOFF_MS,
          ...(this.dependencies.sleep ? { sleep: this.dependencies.sleep } : {}),
        },
      );
      try {
        return await operation(client);
      } finally {
        await client.logout().catch(() => undefined);
      }
    });
  }

  private async verifyImap() {
    return this.imapGate().run(async () => {
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
    });
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
