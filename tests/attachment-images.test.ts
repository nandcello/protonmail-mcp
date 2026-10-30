import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import jpeg from "jpeg-js";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { chunkBytes, renderPdfPages } from "../src/attachment-media.ts";
import { ConfiguredInboxSubscriptionService } from "../src/inbox-subscription-service.ts";
import { InboxSubscriptionStore } from "../src/inbox-subscription-store.ts";
import type { GetAttachment } from "../src/proton-mail-client.ts";
import { createServer } from "../src/server.ts";
import { startFakeImapServer, type FakeImapServer } from "./fixtures/fake-imap-server.ts";
import { createTestClient, createTestConfig } from "./fixtures/mail-client.ts";
import {
  imageAttachmentsMessage,
  INLINE_PNG,
  LARGE_PNG,
  SCANNED_PDF,
} from "./fixtures/messages.ts";

// Rendering and JPEG encoding run in WASM/JS; give slow CI machines room.
vi.setConfig({ testTimeout: 30_000 });

const UID = 1400;
let server: FakeImapServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function serve() {
  const message = imageAttachmentsMessage(UID);
  server = await startFakeImapServer({ "All Mail": [message], INBOX: [] });
  return { fake: server, message, client: createTestClient(server.port) };
}

const request = (attachmentId: string, extra: Partial<GetAttachment> = {}): GetAttachment => ({
  mailbox: "All Mail",
  uid: UID,
  attachmentId,
  maxCharacters: 50_000,
  saveToFile: false,
  ...extra,
});

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

describe("image attachments", () => {
  test("are returned over MCP as image content next to JSON metadata", async () => {
    const { fake } = await serve();
    const directory = mkdtempSync(join(tmpdir(), "protonmail-images-test-"));
    const subscriptions = new ConfiguredInboxSubscriptionService(
      new InboxSubscriptionStore(join(directory, "subscriptions.json")),
      new Set(),
    );
    const mcp = createServer(createTestConfig, subscriptions, (config) =>
      createTestClient(fake.port, config),
    );
    const client = new Client({ name: "protonmail-mcp-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((candidate) => candidate.name === "get_email_attachment");
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });

      const result = (await client.callTool({
        name: "get_email_attachment",
        arguments: { mailbox: "All Mail", uid: UID, attachmentId: "1.2" },
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(2);
      const [metadata, image] = result.content;
      expect(image).toEqual({
        type: "image",
        mimeType: "image/png",
        data: INLINE_PNG.toString("base64"),
      });
      const parsed = JSON.parse(metadata.type === "text" ? metadata.text : "{}");
      expect(parsed.attachment).toMatchObject({ id: "1.2", filename: "image.png" });
      expect(parsed.images).toEqual([
        expect.objectContaining({ index: 0, mimeType: "image/png", bytes: INLINE_PNG.byteLength }),
      ]);
      expect(parsed.note).toContain("Returned as image content.");

      const chunk = (await client.callTool({
        name: "get_email_attachment",
        arguments: { mailbox: "All Mail", uid: UID, attachmentId: "1.2", byteOffset: 0 },
      })) as CallToolResult;
      expect(chunk.content).toHaveLength(1);
      const chunkBody = JSON.parse(chunk.content[0].type === "text" ? chunk.content[0].text : "{}");
      expect(chunkBody.chunk).toMatchObject({ source: "attachment", done: true, offset: 0 });
      expect(Buffer.from(chunkBody.chunk.base64, "base64").equals(INLINE_PNG)).toBe(true);
    } finally {
      await client.close();
      await mcp.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a PNG within the cap is returned byte for byte", async () => {
    const { client } = await serve();
    const result = await client.getAttachment(request("3"));
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ mimeType: "image/png", reencoded: false });
    expect(result.images[0].data.equals(LARGE_PNG)).toBe(true);
  });

  test("a PNG over maxImageBytes is downscaled to a JPEG that fits", async () => {
    const { client } = await serve();
    expect(LARGE_PNG.byteLength).toBeGreaterThan(100_000);
    const result = await client.getAttachment(request("3", { maxImageBytes: 100_000 }));

    const [image] = result.images;
    expect(image).toMatchObject({ mimeType: "image/jpeg", reencoded: true });
    expect(image.data.byteLength).toBeLessThanOrEqual(100_000);
    const decoded = jpeg.decode(image.data);
    expect(decoded.width).toBe(image.width);
    expect(decoded.width).toBeLessThan(700);
    expect(result.note).toMatch(/downscaled to a \d+x\d+ JPEG to fit 100000 bytes/);
  });

  test("an oversized GIF is refused with its name, size, and the cap", async () => {
    const { client } = await serve();
    await expect(client.getAttachment(request("4", { maxImageBytes: 10_000 }))).rejects.toThrow(
      /large\.gif is 29 KB \(30000 bytes\), above maxImageBytes 10000, and image\/gif cannot be downscaled/,
    );
  });

  test("an unsafe image type falls back to the text behavior with a note", async () => {
    const { client } = await serve();
    const result = await client.getAttachment(request("5"));
    expect(result.images).toEqual([]);
    expect(result.text).toBeNull();
    expect(result.note).toContain("image/svg+xml is not returned as image content");
  });
});

describe("scanned PDF rendering", () => {
  test("text extraction reports no text layer and does not render by default", async () => {
    const { client } = await serve();
    const result = await client.getAttachment(request("2"));
    expect(result.text).toBeNull();
    expect(result.note).toContain("no text layer");
    expect(result.images).toEqual([]);
    expect(result).not.toHaveProperty("renderedPages");
  });

  test("renderPages returns at most maxPages JPEG pages and says what was left out", async () => {
    const { client } = await serve();
    const result = await client.getAttachment(request("2", { renderPages: true, maxPages: 2 }));

    expect(result.images.map((image) => image.page)).toEqual([1, 2]);
    for (const image of result.images) {
      expect(image.mimeType).toBe("image/jpeg");
      expect(image.width).toBeLessThanOrEqual(1_600);
      expect(jpeg.decode(image.data).width).toBe(image.width);
    }
    expect(result.renderedPages).toMatchObject({ totalPages: 3, notRequested: 1, skipped: [] });
    expect(result.note).toContain("Rendered 2 of 3 PDF page(s)");
    expect(result.note).toContain("1 later page(s) not rendered because maxPages=2");
  });

  test("page renders a single page and reports a missing one", async () => {
    const { client } = await serve();
    const third = await client.getAttachment(request("2", { page: 3 }));
    expect(third.images.map((image) => image.page)).toEqual([3]);

    const missing = await client.getAttachment(request("2", { page: 9 }));
    expect(missing.images).toEqual([]);
    expect(missing.renderedPages?.skipped).toEqual([
      { page: 9, reason: "The PDF has only 3 page(s)." },
    ]);
  });

  test("the combined image budget skips later pages with a clear reason", async () => {
    const single = await renderPdfPages(SCANNED_PDF, { page: 1 }, 5_000_000);
    const pageBytes = single.rendered[0].data.byteLength;

    const result = await renderPdfPages(
      SCANNED_PDF,
      { first: 3 },
      5_000_000,
      Math.floor(pageBytes * 1.5),
    );
    expect(result.rendered.map((page) => page.page)).toEqual([1]);
    // A page rendered in a batch is byte-identical to the same page alone.
    expect(result.rendered[0].data.equals(single.rendered[0].data)).toBe(true);
    expect(result.skipped.map((page) => page.page)).toEqual([2, 3]);
    expect(result.skipped[0].reason).toContain("Request this page on its own with page=2");
  });

  test("rendering a non-PDF is refused", async () => {
    const { client } = await serve();
    await expect(client.getAttachment(request("3", { renderPages: true }))).rejects.toThrow(
      "renderPages and page only apply to PDF attachments",
    );
  });
});

describe("chunked bytes", () => {
  async function reassemble(
    fetch: (offset: number) => Promise<{ chunk: ReturnType<typeof chunkBytes> }>,
  ) {
    const parts: Buffer[] = [];
    let offset: number | null = 0;
    let last: ReturnType<typeof chunkBytes> | undefined;
    let calls = 0;
    while (offset !== null) {
      ({ chunk: last } = await fetch(offset));
      expect(last.offset).toBe(offset);
      parts.push(Buffer.from(last.base64, "base64"));
      offset = last.nextOffset;
      calls += 1;
    }
    const whole = Buffer.concat(parts);
    expect(last?.done).toBe(true);
    expect(whole.byteLength).toBe(last?.totalBytes);
    expect(sha256(whole)).toBe(last?.sha256);
    return { whole, calls };
  }

  test("the raw PDF reassembles across calls and matches its sha256", async () => {
    const { client } = await serve();
    const { whole, calls } = await reassemble((offset) =>
      client.getAttachmentChunk(request("2", { byteOffset: offset, byteLength: 7_000 })),
    );
    expect(whole.equals(SCANNED_PDF)).toBe(true);
    expect(calls).toBe(Math.ceil(SCANNED_PDF.byteLength / 7_000));
  });

  test("a rendered page reassembles into the same JPEG on every call", async () => {
    const { client } = await serve();
    const { whole, calls } = await reassemble((offset) =>
      client.getAttachmentChunk(
        request("2", { page: 2, maxImageBytes: 60_000, byteOffset: offset, byteLength: 20_000 }),
      ),
    );
    expect(whole.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(calls).toBeGreaterThan(1);
    expect(whole.byteLength).toBeLessThanOrEqual(60_000);
  });

  test("a downscaled image reassembles and fits maxImageBytes", async () => {
    const { client } = await serve();
    const { whole } = await reassemble((offset) =>
      client.getAttachmentChunk(
        request("3", { maxImageBytes: 40_000, byteOffset: offset, byteLength: 40_000 }),
      ),
    );
    expect(whole.byteLength).toBeLessThanOrEqual(40_000);
    expect(jpeg.decode(whole).width).toBeGreaterThan(0);
  });

  test("defaults to 40,000-byte chunks, about 53 KB of base64", async () => {
    const { client } = await serve();
    const { chunk } = await client.getAttachmentChunk(request("3", { byteOffset: 0 }));
    expect(chunk).toMatchObject({ source: "attachment", length: 40_000, nextOffset: 40_000 });
    expect(chunk.base64.length).toBeLessThan(54_000);
    expect(chunk.sha256).toBe(sha256(LARGE_PNG));
  });

  test("a rendered page needs page in chunk mode, and offsets past the end fail", async () => {
    const { client } = await serve();
    await expect(
      client.getAttachmentChunk(request("2", { renderPages: true, byteOffset: 0 })),
    ).rejects.toThrow("Pass page");
    expect(() => chunkBytes(Buffer.alloc(3), "x/y", 4, 1)).toThrow("past the end");
    expect(chunkBytes(Buffer.alloc(3), "x/y", 3, 1)).toMatchObject({ length: 0, done: true });
  });
});

describe("read-only guarantee", () => {
  test("image fetches, page renders, and chunks never set \\Seen", async () => {
    const { fake, message, client } = await serve();

    await client.getAttachment(request("1.2"));
    await client.getAttachment(request("3", { maxImageBytes: 50_000 }));
    await client.getAttachment(request("2", { renderPages: true }));
    await client.getAttachmentChunk(request("2", { page: 1, byteOffset: 0 }));
    await client.getAttachmentChunk(request("3", { byteOffset: 40_000 }));

    expect(message.flags.has("\\Seen")).toBe(false);
    const selects = fake.commands.filter((command) => /^(SELECT|EXAMINE) /.test(command));
    expect(selects.length).toBe(5);
    expect(selects.every((command) => command.startsWith("EXAMINE "))).toBe(true);
    expect(
      fake.commands.filter((command) =>
        /^(UID )?(STORE|COPY|MOVE|EXPUNGE|APPEND|DELETE|CREATE|RENAME)\b/.test(command),
      ),
    ).toEqual([]);
    const fetches = fake.commands.filter((command) => /^(UID )?FETCH /.test(command));
    expect(fetches.length).toBeGreaterThan(0);
    for (const fetch of fetches) {
      expect(fetch).not.toMatch(/BODY\[|\bRFC822(?!\.SIZE|\.HEADER)\b/);
    }
  });
});
