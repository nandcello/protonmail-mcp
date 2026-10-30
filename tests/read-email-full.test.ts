import { ImapFlow } from "imapflow";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { loadConfig, type ProtonBridgeConfig } from "../src/config.ts";
import { ImapGate } from "../src/imap-gate.ts";
import { ProtonMailClient } from "../src/proton-mail-client.ts";
import {
  startFakeImapServer,
  type FakeImapServer,
  type FakeMessage,
} from "./fixtures/fake-imap-server.ts";
import {
  htmlOnlyMessage,
  LOAN_BODY_TEXT,
  LOAN_PDF_NAME,
  loanApprovalMessage,
} from "./fixtures/messages.ts";

let server: FakeImapServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function createConfig(overrides: Partial<ProtonBridgeConfig> = {}) {
  return {
    ...loadConfig({
      PROTON_BRIDGE_USERNAME: "bridge-user",
      PROTON_BRIDGE_PASSWORD: "bridge-password",
      PROTON_BRIDGE_TLS_REJECT_UNAUTHORIZED: "false",
    }),
    ...overrides,
  };
}

/** A real ImapFlow client talking plain IMAP to the fake server. */
function clientFor(
  port: number,
  config: ProtonBridgeConfig = createConfig(),
  gate = new ImapGate(4, 5_000),
) {
  return new ProtonMailClient(config, {
    createImapClient: () =>
      new ImapFlow({
        host: "127.0.0.1",
        port,
        secure: false,
        doSTARTTLS: false,
        auth: { user: "bridge-user", pass: "bridge-password" },
        logger: false,
      }),
    createSmtpTransport: () => {
      throw new Error("SMTP was not expected in this test.");
    },
    imapGate: gate,
  });
}

async function serve(messages: FakeMessage[], options?: { responseDelayMs?: number }) {
  server = await startFakeImapServer({ "All Mail": messages, INBOX: [] }, options);
  return server;
}

describe("read_email_full", () => {
  test("returns the text body with inline images replaced and lists attachments", async () => {
    const fake = await serve([loanApprovalMessage()]);
    const result = await clientFor(fake.port).readEmailFull({
      mailbox: "All Mail",
      uid: 1350,
      maxCharacters: 50_000,
    });

    expect(result).toMatchObject({
      mailbox: "All Mail",
      uid: 1350,
      subject: "Conditional Approval Loan Details",
      from: ["BPI <noreply@bpi.example>"],
      to: ["me@example.com"],
      bodyFormat: "text/plain",
      bodyTruncated: false,
    });
    expect(result.body).toContain(LOAN_BODY_TEXT);
    expect(result.body).toContain("[inline image: image.png, 99 KB]");
    expect(result.body).toContain("Please review the attached form.");
    expect(result.attachments).toEqual([
      expect.objectContaining({
        id: "1.2",
        filename: "image.png",
        contentType: "image/png",
        inline: true,
        contentId: "image001.png@bpi",
      }),
      expect.objectContaining({
        id: "2",
        filename: LOAN_PDF_NAME,
        contentType: "application/pdf",
        inline: false,
      }),
    ]);
    // Only the text/plain part was downloaded; image and PDF bytes never were.
    expect(fake.sectionsServed.filter((name) => !name.endsWith("MIME"))).toEqual(["1.1.1"]);
  });

  test("falls back to HTML converted to text and strips data: URIs", async () => {
    const fake = await serve([htmlOnlyMessage()]);
    const result = await clientFor(fake.port).readEmailFull({
      mailbox: "All Mail",
      uid: 1351,
      maxCharacters: 50_000,
    });

    expect(result.bodyFormat).toBe("text/html");
    expect(result.body).toContain(LOAN_BODY_TEXT);
    expect(result.body).toMatch(/\[inline image: data URI, 99 KB\]/);
    expect(result.body).not.toMatch(/base64|data:image/);
    expect(result.body.length).toBeLessThan(1_000);
  });

  test("finds a message by Message-ID in All Mail by default", async () => {
    const fake = await serve([loanApprovalMessage(), htmlOnlyMessage()]);
    const result = await clientFor(fake.port).readEmailFull({
      messageId: "approval-1350@bpi.example",
      maxCharacters: 50_000,
    });

    expect(result.uid).toBe(1350);
    expect(result.mailbox).toBe("All Mail");
  });

  test("says clearly when the body is truncated", async () => {
    const fake = await serve([loanApprovalMessage()]);
    const result = await clientFor(fake.port).readEmailFull({
      mailbox: "All Mail",
      uid: 1350,
      maxCharacters: 20,
    });

    expect(result.bodyTruncated).toBe(true);
    expect(result.body).toMatch(/\[truncated: showing 20 of \d+ characters\]$/);
  });

  test("requires exactly one of uid or messageId", async () => {
    const client = clientFor(1);
    await expect(client.readEmailFull({ maxCharacters: 1_000 })).rejects.toThrow(
      "exactly one of uid or messageId",
    );
    await expect(
      client.readEmailFull({ uid: 1, messageId: "x@y", maxCharacters: 1_000 }),
    ).rejects.toThrow("exactly one of uid or messageId");
  });
});

describe("get_email_attachment", () => {
  test("extracts PDF text", async () => {
    const fake = await serve([loanApprovalMessage()]);
    const result = await clientFor(fake.port).getAttachment({
      mailbox: "All Mail",
      uid: 1350,
      attachmentId: "2",
      maxCharacters: 50_000,
      saveToFile: false,
    });

    expect(result.attachment).toMatchObject({
      filename: LOAN_PDF_NAME,
      contentType: "application/pdf",
    });
    expect(result.text).toBe("Housing Loan Application Form");
    expect(result.pages).toBe(1);
    expect(result.textTruncated).toBe(false);
    expect(result.savedPath).toBeNull();
  });

  test("saves the raw file privately when a directory is configured", async () => {
    const directory = mkdtempSync(join(tmpdir(), "protonmail-attachments-"));
    try {
      const fake = await serve([loanApprovalMessage()]);
      const client = clientFor(fake.port, createConfig({ attachmentDirectory: directory }));
      const result = await client.getAttachment({
        mailbox: "All Mail",
        uid: 1350,
        attachmentId: "2",
        maxCharacters: 10,
        saveToFile: true,
      });

      expect(result.textTruncated).toBe(true);
      expect(result.text).toMatch(/\[truncated: showing 10 of 29 characters\]$/);
      expect(result.savedPath?.startsWith(directory)).toBe(true);
      const saved = readFileSync(result.savedPath ?? "");
      expect(saved.subarray(0, 5).toString()).toBe("%PDF-");
      expect(statSync(result.savedPath ?? "").mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses saveToFile when no directory is configured", async () => {
    await expect(
      clientFor(1).getAttachment({
        uid: 1350,
        attachmentId: "2",
        maxCharacters: 1_000,
        saveToFile: true,
      }),
    ).rejects.toThrow("PROTON_ATTACHMENT_DIR");
  });

  test("lists available ids for an unknown attachment", async () => {
    const fake = await serve([loanApprovalMessage()]);
    await expect(
      clientFor(fake.port).getAttachment({
        mailbox: "All Mail",
        uid: 1350,
        attachmentId: "9",
        maxCharacters: 1_000,
        saveToFile: false,
      }),
    ).rejects.toThrow("Available: 1.2, 2.");
  });
});

describe("read-only guarantee", () => {
  test("reading a message and its attachment never sets \\Seen", async () => {
    const message = loanApprovalMessage();
    const fake = await serve([message, htmlOnlyMessage()]);
    const client = clientFor(fake.port);
    expect(message.flags.has("\\Seen")).toBe(false);

    const read = await client.readEmailFull({
      mailbox: "All Mail",
      uid: 1350,
      maxCharacters: 50_000,
    });
    await client.readEmailFull({ messageId: "<approval-1350@bpi.example>", maxCharacters: 50_000 });
    await client.readEmailFull({ mailbox: "All Mail", uid: 1351, maxCharacters: 50_000 });
    for (const attachment of read.attachments) {
      await client.getAttachment({
        mailbox: "All Mail",
        uid: 1350,
        attachmentId: attachment.id,
        maxCharacters: 1_000,
        saveToFile: false,
      });
    }

    expect(message.flags.has("\\Seen")).toBe(false);
    expect(read.unread).toBe(true);

    const mailboxCommands = fake.commands.filter((command) => /^(SELECT|EXAMINE) /.test(command));
    expect(mailboxCommands.length).toBeGreaterThan(0);
    expect(mailboxCommands.every((command) => command.startsWith("EXAMINE "))).toBe(true);
    const mutating = fake.commands.filter((command) =>
      /^(UID )?(STORE|COPY|MOVE|EXPUNGE|APPEND|DELETE|CREATE|RENAME)\b/.test(command),
    );
    expect(mutating).toEqual([]);
    const fetches = fake.commands.filter((command) => /^(UID )?FETCH /.test(command));
    expect(fetches.length).toBeGreaterThan(0);
    for (const fetch of fetches) {
      expect(fetch).not.toMatch(/BODY\[|\bRFC822(?!\.SIZE|\.HEADER)\b/);
    }
  });

  test("the fake server would have caught a non-PEEK fetch", async () => {
    const message = loanApprovalMessage();
    const fake = await serve([message]);
    const raw = new ImapFlow({
      host: "127.0.0.1",
      port: fake.port,
      secure: false,
      doSTARTTLS: false,
      auth: { user: "bridge-user", pass: "bridge-password" },
      logger: false,
    });
    await raw.connect();
    try {
      await raw.mailboxOpen("All Mail");
      await raw.messageFlagsAdd("1350", ["\\Seen"], { uid: true });
    } finally {
      await raw.logout();
    }
    expect(message.flags.has("\\Seen")).toBe(true);
  });
});

describe("concurrency", () => {
  test("parallel reads share a bounded number of Bridge sessions and all succeed", async () => {
    const fake = await serve(
      Array.from({ length: 10 }, (_, index) => loanApprovalMessage(2000 + index)),
      { responseDelayMs: 5 },
    );
    const gate = new ImapGate(2, 30_000);
    const config = createConfig();

    // Like the gateway, every request builds its own client, but they share one gate.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        clientFor(fake.port, config, gate).readEmailFull({
          mailbox: "All Mail",
          uid: 2000 + index,
          maxCharacters: 50_000,
        }),
      ),
    );

    expect(results.map((result) => result.uid)).toEqual(
      Array.from({ length: 10 }, (_, index) => 2000 + index),
    );
    expect(results.every((result) => result.body.includes(LOAN_BODY_TEXT))).toBe(true);
    // Exactly 2: the reads really overlapped, and never beyond the limit.
    expect(fake.maxConcurrentSessions).toBe(2);
    expect(gate.inUse).toBe(0);
    expect(gate.queued).toBe(0);
  });
});
