import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options as MailOptions } from "nodemailer/lib/mailer/index.js";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  ATTACHMENT_LIMITS,
  AttachmentUploadStore,
  type AttachmentLimits,
  decodeBase64Strict,
  normalizeContentType,
  prepareOutgoingAttachments,
  sanitizeFilename,
} from "../src/attachment-uploads.ts";
import { ConfiguredInboxSubscriptionService } from "../src/inbox-subscription-service.ts";
import { InboxSubscriptionStore } from "../src/inbox-subscription-store.ts";
import { ProtonMailClient } from "../src/proton-mail-client.ts";
import { createServer } from "../src/server.ts";
import { createTestConfig } from "./fixtures/mail-client.ts";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Deterministic, incompressible-ish test bytes. */
function bytes(length: number, seed = 1) {
  const data = Buffer.alloc(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    data[index] = state >> 16;
  }
  return data;
}

/** Splits raw bytes into independently base64-encoded chunks of at most maxChars. */
function base64Chunks(data: Buffer, maxChars = ATTACHMENT_LIMITS.maxChunkBase64Chars) {
  const rawPerChunk = (maxChars / 4) * 3;
  const chunks: string[] = [];
  for (let offset = 0; offset < data.byteLength; offset += rawPerChunk) {
    chunks.push(data.subarray(offset, offset + rawPerChunk).toString("base64"));
  }
  return chunks;
}

function smallStore(overrides: Partial<AttachmentLimits> = {}, clock = { now: 0 }) {
  return new AttachmentUploadStore({ ...ATTACHMENT_LIMITS, ...overrides }, () => clock.now);
}

interface Harness {
  client: Client;
  uploads: AttachmentUploadStore;
  sent: MailOptions[];
  failNext: { value: boolean };
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  json(result: CallToolResult): Record<string, unknown>;
}

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

async function harness(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "protonmail-send-test-"));
  const subscriptions = new ConfiguredInboxSubscriptionService(
    new InboxSubscriptionStore(join(directory, "subscriptions.json")),
    new Set(),
  );
  const uploads = new AttachmentUploadStore();
  const sent: MailOptions[] = [];
  const failNext = { value: false };
  const server = createServer(
    createTestConfig,
    subscriptions,
    (config) =>
      new ProtonMailClient(config, {
        createImapClient: () => {
          throw new Error("IMAP was not expected in this test.");
        },
        createSmtpTransport: () => ({
          async verify() {
            return true as const;
          },
          async sendMail(options: MailOptions) {
            if (failNext.value) {
              failNext.value = false;
              throw new Error("SMTP is down");
            }
            sent.push(options);
            return {
              messageId: "<sent@example.com>",
              accepted: ["friend@example.com"],
              rejected: [],
              response: "250 OK",
            } as unknown as SMTPTransport.SentMessageInfo;
          },
          close() {},
        }),
      }),
    uploads,
  );
  const client = new Client({ name: "protonmail-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanup.push(async () => {
    await client.close();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    client,
    uploads,
    sent,
    failNext,
    call: async (name, args) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    json: (result) => {
      const first = result.content[0];
      return JSON.parse(first?.type === "text" ? first.text : "null");
    },
  };
}

const message = {
  from: "me@proton.me",
  to: ["friend@example.com"],
  subject: "Photo",
  text: "Attached.",
};

function errorText(result: CallToolResult) {
  expect(result.isError).toBe(true);
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

async function stage(
  h: Harness,
  data: Buffer,
  start: Record<string, unknown> = { filename: "photo.jpg", contentType: "image/jpeg" },
) {
  const started = h.json(await h.call("start_attachment_upload", start));
  const uploadId = String(started.uploadId);
  for (const [index, dataBase64] of base64Chunks(data).entries()) {
    const staged = await h.call("stage_attachment_chunk", { uploadId, index, dataBase64 });
    expect(staged.isError).toBeFalsy();
  }
  return uploadId;
}

describe("send_email attachments over MCP", () => {
  test("inline attachments reach nodemailer as sanitized Buffer content only", async () => {
    const h = await harness();
    const data = bytes(1_000);
    const result = await h.call("send_email", {
      ...message,
      attachments: [
        {
          filename: "../../etc/pa\r\nss\u202Ewd.txt",
          contentType: "Text/Plain",
          contentBase64: data.toString("base64"),
        },
      ],
      confirmed: true,
    });

    expect(result.isError).toBeFalsy();
    expect(h.json(result).attachments).toEqual([
      { filename: "etcpasswd.txt", contentType: "text/plain", size: 1_000 },
    ]);
    expect(h.sent).toHaveLength(1);
    const [options] = h.sent;
    expect(options.disableFileAccess).toBe(true);
    expect(options.disableUrlAccess).toBe(true);
    expect(options.attachments).toHaveLength(1);
    const [attachment] = options.attachments ?? [];
    expect(Object.keys(attachment).sort()).toEqual([
      "content",
      "contentDisposition",
      "contentType",
      "filename",
    ]);
    expect(Buffer.isBuffer(attachment.content)).toBe(true);
    expect((attachment.content as Buffer).equals(data)).toBe(true);
    expect(attachment).not.toHaveProperty("path");
    expect(attachment).not.toHaveProperty("href");
  });

  test("rejects unknown attachment fields such as path, without sending", async () => {
    const h = await harness();
    const result = await h.call("send_email", {
      ...message,
      attachments: [{ filename: "x.txt", contentBase64: "eA==", path: "/etc/passwd" }],
      confirmed: true,
    });
    expect(errorText(result)).toMatch(/path/);
    expect(h.sent).toEqual([]);
  });

  test("rejects bad base64 inline content without sending", async () => {
    const h = await harness();
    const result = await h.call("send_email", {
      ...message,
      attachments: [{ filename: "x.bin", contentBase64: "not base64!" }],
      confirmed: true,
    });
    expect(errorText(result)).toContain("attachments[0].contentBase64 is not valid base64");
    expect(h.sent).toEqual([]);
  });

  test("stages a 1.7 MB file in chunks, verifies sha256, sends it, then deletes the upload", async () => {
    const h = await harness();
    const data = bytes(1_700_000);
    const chunks = base64Chunks(data);
    expect(chunks.length).toBe(51);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(45_000);

    const started = h.json(
      await h.call("start_attachment_upload", {
        filename: "photo.jpg",
        contentType: "image/jpeg",
        totalBytes: data.byteLength,
        sha256: sha256(data),
      }),
    );
    expect(started.maxChunkBase64Chars).toBe(45_000);
    const uploadId = String(started.uploadId);
    expect(uploadId).toMatch(/^[A-Za-z0-9_-]{24}$/);

    let last: Record<string, unknown> = {};
    for (const [index, dataBase64] of chunks.entries()) {
      last = h.json(await h.call("stage_attachment_chunk", { uploadId, index, dataBase64 }));
    }
    expect(last).toMatchObject({ receivedBytes: data.byteLength, nextIndex: 51 });

    const finished = h.json(await h.call("finish_attachment_upload", { uploadId }));
    expect(finished).toMatchObject({ size: data.byteLength, sha256: sha256(data) });

    const result = await h.call("send_email", {
      ...message,
      attachmentUploadIds: [uploadId],
      confirmed: true,
    });
    expect(result.isError).toBeFalsy();
    const sentContent = h.sent[0].attachments?.[0].content as Buffer;
    expect(sha256(sentContent)).toBe(sha256(data));
    expect(h.uploads.has(uploadId)).toBe(false);

    const again = await h.call("send_email", {
      ...message,
      attachmentUploadIds: [uploadId],
      confirmed: true,
    });
    expect(errorText(again)).toContain("Unknown or expired upload");
    expect(h.sent).toHaveLength(1);
  });

  test("keeps the upload when sending fails so a retry works", async () => {
    const h = await harness();
    const uploadId = await stage(h, bytes(5_000));
    await h.call("finish_attachment_upload", { uploadId });

    h.failNext.value = true;
    const failed = await h.call("send_email", {
      ...message,
      attachmentUploadIds: [uploadId],
      confirmed: true,
    });
    expect(errorText(failed)).toContain("SMTP is down");
    expect(h.uploads.has(uploadId)).toBe(true);

    const retried = await h.call("send_email", {
      ...message,
      attachmentUploadIds: [uploadId],
      confirmed: true,
    });
    expect(retried.isError).toBeFalsy();
    expect(h.sent).toHaveLength(1);
    expect(h.uploads.has(uploadId)).toBe(false);
  });

  test("the confirmed guard still applies with attachments and touches nothing", async () => {
    const h = await harness();
    const uploadId = await stage(h, bytes(5_000));
    await h.call("finish_attachment_upload", { uploadId });

    for (const confirmed of [false, undefined, "true"]) {
      const result = await h.call("send_email", {
        ...message,
        attachments: [{ filename: "a.txt", contentBase64: "YQ==" }],
        attachmentUploadIds: [uploadId],
        ...(confirmed === undefined ? {} : { confirmed }),
      });
      expect(errorText(result)).toMatch(/confirmed/);
    }
    expect(h.sent).toEqual([]);
    expect(h.uploads.has(uploadId)).toBe(true);
  });

  test("unknown or unfinished uploads are refused and nothing is sent", async () => {
    const h = await harness();
    const unknown = await h.call("send_email", {
      ...message,
      attachmentUploadIds: ["does-not-exist"],
      confirmed: true,
    });
    expect(errorText(unknown)).toContain('Unknown or expired upload "does-not-exist"');

    const uploadId = await stage(h, bytes(100));
    const unfinished = await h.call("send_email", {
      ...message,
      attachmentUploadIds: [uploadId],
      confirmed: true,
    });
    expect(errorText(unfinished)).toContain("is not finished");
    expect(h.sent).toEqual([]);
  });

  test("staging tools never send mail and are not marked destructive", async () => {
    const h = await harness();
    const { tools } = await h.client.listTools();
    for (const name of [
      "start_attachment_upload",
      "stage_attachment_chunk",
      "finish_attachment_upload",
    ]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false });
    }
    expect(tools.find((tool) => tool.name === "send_email")?.annotations).toMatchObject({
      destructiveHint: true,
    });

    const uploadId = await stage(h, bytes(50_000));
    await h.call("finish_attachment_upload", { uploadId });
    expect(h.sent).toEqual([]);
  });

  test("rejects a chunk over 45,000 base64 characters at the schema", async () => {
    const h = await harness();
    const { uploadId } = h.json(
      await h.call("start_attachment_upload", { filename: "big.bin" }),
    ) as { uploadId: string };
    const result = await h.call("stage_attachment_chunk", {
      uploadId,
      index: 0,
      dataBase64: "A".repeat(45_004),
    });
    expect(errorText(result)).toMatch(/45000/);
  });
});

describe("AttachmentUploadStore", () => {
  test("reassembles chunks in order and reports progress", () => {
    const store = smallStore();
    const data = bytes(100_000);
    const { uploadId } = store.start({
      filename: "a.bin",
      totalBytes: 100_000,
      sha256: sha256(data),
    });
    let received = 0;
    for (const [index, chunk] of base64Chunks(data).entries()) {
      const progress = store.stageChunk({ uploadId, index, dataBase64: chunk });
      received += Buffer.from(chunk, "base64").byteLength;
      expect(progress).toMatchObject({ receivedBytes: received, nextIndex: index + 1 });
    }
    expect(store.finish(uploadId)).toMatchObject({ size: 100_000, sha256: sha256(data) });
    // finish is idempotent
    expect(store.finish(uploadId).sha256).toBe(sha256(data));
    const [resolved] = store.resolve([uploadId]);
    expect(resolved.content.equals(data)).toBe(true);
    expect(resolved).toMatchObject({ filename: "a.bin", contentType: "application/octet-stream" });
  });

  test("rejects duplicate and out-of-order chunks without changing state", () => {
    const store = smallStore();
    const { uploadId } = store.start({ filename: "a.bin" });
    expect(() => store.stageChunk({ uploadId, index: 1, dataBase64: "YWJj" })).toThrow(
      "Chunk 1 is out of order. Chunks must be sent in order; the next chunk is 0.",
    );
    store.stageChunk({ uploadId, index: 0, dataBase64: "YWJj" });
    expect(() => store.stageChunk({ uploadId, index: 0, dataBase64: "ZGVm" })).toThrow(
      "Chunk 0 was already received. The next chunk is 1.",
    );
    expect(() => store.stageChunk({ uploadId, index: 2, dataBase64: "ZGVm" })).toThrow(
      "out of order",
    );
    store.stageChunk({ uploadId, index: 1, dataBase64: "ZGVm" });
    expect(store.finish(uploadId)).toMatchObject({
      size: 6,
      sha256: sha256(Buffer.from("abcdef")),
    });
    expect(() => store.stageChunk({ uploadId, index: 2, dataBase64: "Zw==" })).toThrow(
      "already finished",
    );
  });

  test("enforces the chunk size, upload size, and declared totalBytes", () => {
    const store = smallStore({ maxChunkBase64Chars: 8, maxUploadBytes: 9 });
    const { uploadId } = store.start({ filename: "a.bin" });
    expect(() => store.stageChunk({ uploadId, index: 0, dataBase64: "YWJjZGVmZ2g=" })).toThrow(
      "Chunk is 12 base64 characters, above the 8-character limit.",
    );
    store.stageChunk({ uploadId, index: 0, dataBase64: "YWJjZGVm" });
    expect(() => store.stageChunk({ uploadId, index: 1, dataBase64: "YWJjZGVm" })).toThrow(
      "above the 9-byte per-upload limit",
    );
    expect(() => store.start({ filename: "b.bin", totalBytes: 10 })).toThrow(
      "totalBytes 10 is above the 9-byte per-upload limit.",
    );

    const declared = store.start({ filename: "c.bin", totalBytes: 4 });
    expect(() =>
      store.stageChunk({ uploadId: declared.uploadId, index: 0, dataBase64: "YWJjZGVm" }),
    ).toThrow("more than the declared totalBytes 4");
  });

  test("finish verifies totalBytes and sha256", () => {
    const store = smallStore();
    const short = store.start({ filename: "a.bin", totalBytes: 6 });
    store.stageChunk({ uploadId: short.uploadId, index: 0, dataBase64: "YWJj" });
    expect(() => store.finish(short.uploadId)).toThrow(
      "Upload has 3 bytes but totalBytes was 6. Stage the remaining chunks starting at index 1.",
    );
    expect(store.has(short.uploadId)).toBe(true);

    const wrong = store.start({ filename: "b.bin", sha256: "0".repeat(64) });
    store.stageChunk({ uploadId: wrong.uploadId, index: 0, dataBase64: "YWJj" });
    expect(() => store.finish(wrong.uploadId)).toThrow("does not match the declared");
    expect(store.has(wrong.uploadId)).toBe(false);

    const empty = store.start({ filename: "c.bin" });
    expect(() => store.finish(empty.uploadId)).toThrow("has no data");
  });

  test("caps concurrent uploads and total staged memory", () => {
    const store = smallStore({ maxUploads: 2, maxStagedBytes: 5 });
    const first = store.start({ filename: "a" });
    store.start({ filename: "b" });
    expect(() => store.start({ filename: "c" })).toThrow("Too many staged uploads (2)");

    store.stageChunk({ uploadId: first.uploadId, index: 0, dataBase64: "YWJj" });
    expect(() =>
      store.stageChunk({ uploadId: first.uploadId, index: 1, dataBase64: "YWJj" }),
    ).toThrow("Staging memory is full (5 bytes across all uploads)");

    store.remove([first.uploadId]);
    expect(store.start({ filename: "c" }).uploadId).toBeTruthy();
  });

  test("uploads expire 30 minutes after their last activity", () => {
    const clock = { now: 0 };
    const store = smallStore({}, clock);
    const { uploadId, expiresAt } = store.start({ filename: "a.bin" });
    expect(expiresAt).toBe(new Date(30 * 60_000).toISOString());

    clock.now = 29 * 60_000;
    store.stageChunk({ uploadId, index: 0, dataBase64: "YWJj" });
    clock.now = 58 * 60_000;
    store.finish(uploadId);
    clock.now = 87 * 60_000;
    expect(store.resolve([uploadId])).toHaveLength(1);

    clock.now = 88 * 60_000;
    expect(store.has(uploadId)).toBe(false);
    expect(() => store.resolve([uploadId])).toThrow("Unknown or expired upload");
    expect(() => store.stageChunk({ uploadId, index: 1, dataBase64: "YWJj" })).toThrow(
      "Unknown or expired upload",
    );
  });

  test("upload ids are random and unguessable", () => {
    const store = smallStore({ maxUploads: 10 });
    const ids = new Set(Array.from({ length: 10 }, () => store.start({ filename: "a" }).uploadId));
    expect(ids.size).toBe(10);
  });
});

describe("prepareOutgoingAttachments", () => {
  test("limits the attachment count across inline and staged", () => {
    const store = smallStore({ maxAttachmentsPerEmail: 2 });
    const { uploadId } = store.start({ filename: "a" });
    expect(() =>
      prepareOutgoingAttachments(
        store,
        [
          { filename: "x", contentBase64: "YQ==" },
          { filename: "y", contentBase64: "YQ==" },
        ],
        [uploadId],
      ),
    ).toThrow("at most 2 attachments; 3 were given");
  });

  test("limits total decoded bytes across inline and staged", () => {
    const store = smallStore({ maxEmailBytes: 5 });
    const { uploadId } = store.start({ filename: "a" });
    store.stageChunk({ uploadId, index: 0, dataBase64: "YWJj" });
    store.finish(uploadId);
    expect(
      prepareOutgoingAttachments(store, [{ filename: "x", contentBase64: "YWI=" }], [uploadId]),
    ).toHaveLength(2);
    expect(() =>
      prepareOutgoingAttachments(store, [{ filename: "x", contentBase64: "YWJj" }], [uploadId]),
    ).toThrow("Attachments total 6 bytes, above the 5-byte per-email limit.");
  });

  test("rejects the same upload twice and leaves uploads untouched", () => {
    const store = smallStore();
    const { uploadId } = store.start({ filename: "a" });
    store.stageChunk({ uploadId, index: 0, dataBase64: "YWJj" });
    store.finish(uploadId);
    expect(() => prepareOutgoingAttachments(store, [], [uploadId, uploadId])).toThrow(
      "more than once",
    );
    expect(prepareOutgoingAttachments(store, [], [uploadId])).toHaveLength(1);
    expect(store.has(uploadId)).toBe(true);
  });
});

describe("validation helpers", () => {
  test("decodeBase64Strict accepts only canonical base64", () => {
    expect(decodeBase64Strict("YWJjZA==", "x").toString()).toBe("abcd");
    expect(decodeBase64Strict("", "x").byteLength).toBe(0);
    for (const bad of [
      "YWJj ZA==", // whitespace
      "YWJjZA=\n=",
      "YWJjZA", // missing padding
      "YWJjZA=", // bad padding length
      "YW=jZA==", // padding in the middle
      "YWJjZA===",
      "-_-_", // URL-safe alphabet
      "YWJj*A==",
      "AB==", // non-zero padding bits
    ]) {
      expect(() => decodeBase64Strict(bad, "x"), bad).toThrow(/x is not (valid|canonical) base64/);
    }
  });

  test("sanitizeFilename strips paths, controls, and bidi overrides and caps length", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeFilename("C:\\Users\\me\\photo.jpg")).toBe("C:Usersmephoto.jpg");
    expect(sanitizeFilename("a\r\nContent-Type: text/html.txt")).toBe(
      "aContent-Type: texthtml.txt",
    );
    expect(sanitizeFilename("invoice\u202Efdp.exe")).toBe("invoicefdp.exe");
    expect(sanitizeFilename("\u0000\u0007\t  ")).toBe("attachment");
    expect(sanitizeFilename("...")).toBe("attachment");
    expect(sanitizeFilename(".hidden")).toBe("hidden");
    const long = sanitizeFilename(`${"x".repeat(300)}.jpeg`);
    expect(long).toHaveLength(200);
    expect(long.endsWith(".jpeg")).toBe(true);
  });

  test("normalizeContentType accepts only a bare type/subtype", () => {
    expect(normalizeContentType(undefined)).toBe("application/octet-stream");
    expect(normalizeContentType(" ")).toBe("application/octet-stream");
    expect(normalizeContentType("Image/JPEG")).toBe("image/jpeg");
    expect(normalizeContentType("application/vnd.ms-excel")).toBe("application/vnd.ms-excel");
    for (const bad of ["text/html; charset=utf-8", "text", "text/html\r\nX: y", "a/b/c", "/x"]) {
      expect(() => normalizeContentType(bad), bad).toThrow("must be a plain type/subtype");
    }
  });
});

describe("real MIME output", () => {
  test("nodemailer encodes Buffer attachments that parse back byte for byte", async () => {
    const { simpleParser } = await import("mailparser");
    const nodemailer = (await import("nodemailer")).default;
    const outputs: Buffer[] = [];
    const client = new ProtonMailClient(createTestConfig(), {
      createImapClient: () => {
        throw new Error("IMAP was not expected in this test.");
      },
      createSmtpTransport: () => {
        const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
        return {
          verify: async () => true as const,
          async sendMail(options: MailOptions) {
            const info = await transport.sendMail(options);
            outputs.push(info.message as Buffer);
            return {
              ...info,
              accepted: ["friend@example.com"],
              rejected: [],
              response: "250 OK",
            } as unknown as SMTPTransport.SentMessageInfo;
          },
          close: () => transport.close(),
        };
      },
    });
    const data = bytes(70_000);
    await client.sendEmail({
      ...message,
      attachments: prepareOutgoingAttachments(new AttachmentUploadStore(), [
        {
          filename: "Résumé (final).pdf",
          contentType: "application/pdf",
          contentBase64: data.toString("base64"),
        },
      ]),
    });

    const parsed = await simpleParser(outputs[0]);
    expect(parsed.attachments).toHaveLength(1);
    const [attachment] = parsed.attachments;
    expect(attachment.filename).toBe("Résumé (final).pdf");
    expect(attachment.contentType).toBe("application/pdf");
    expect(attachment.contentDisposition).toBe("attachment");
    expect(attachment.content.equals(data)).toBe(true);
  });
});
