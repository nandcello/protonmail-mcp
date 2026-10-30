import { createHash, randomBytes } from "node:crypto";

/**
 * Outgoing attachments for send_email. Content only ever arrives as base64
 * and is held in memory as Buffers; nothing here reads files or URLs.
 */

const MiB = 1024 * 1024;

export const ATTACHMENT_LIMITS = {
  /** Decoded bytes per email, inline and staged combined. */
  maxEmailBytes: 20 * MiB,
  maxAttachmentsPerEmail: 10,
  /** Decoded bytes per staged upload. */
  maxUploadBytes: 20 * MiB,
  /** Staged uploads held at once, finished or not. */
  maxUploads: 10,
  /** Decoded bytes held across all staged uploads. */
  maxStagedBytes: 50 * MiB,
  /** Fits Executor's 64 KB execute output cap with room for the JSON around it. */
  maxChunkBase64Chars: 45_000,
  /** Uploads are dropped this long after their last activity. */
  idleTimeoutMs: 30 * 60 * 1000,
  maxFilenameLength: 200,
} as const;

export type AttachmentLimits = { readonly [K in keyof typeof ATTACHMENT_LIMITS]: number };

/** A validated attachment ready to hand to nodemailer. */
export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decodes canonical base64 only: no whitespace, no URL-safe alphabet, length a
 * multiple of 4, padding only at the end, and zero padding bits.
 */
export function decodeBase64Strict(value: string, label: string): Buffer {
  if (value.length % 4 !== 0 || !BASE64.test(value)) {
    throw new Error(
      `${label} is not valid base64: use A-Z a-z 0-9 + / with = padding, no whitespace, length a multiple of 4.`,
    );
  }
  const decoded = Buffer.from(value, "base64");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (
    decoded.byteLength !== (value.length / 4) * 3 - padding ||
    decoded.toString("base64") !== value
  ) {
    throw new Error(`${label} is not canonical base64.`);
  }
  return decoded;
}

const UNSAFE_FILENAME_CHARACTERS =
  // Control characters (including CR/LF), path separators, and bidi overrides
  // that can disguise an extension (U+202E can make "exe.pdf" display reversed).
  /[\p{Cc}/\\\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;

/** Strips anything that could act as a path or header injection; never returns "". */
export function sanitizeFilename(
  name: string,
  maxLength: number = ATTACHMENT_LIMITS.maxFilenameLength,
): string {
  let cleaned = name.replace(UNSAFE_FILENAME_CHARACTERS, "").replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/^\.+/, "").trim();
  if (cleaned.length > maxLength) {
    const extension = /\.[A-Za-z0-9]{1,10}$/.exec(cleaned)?.[0] ?? "";
    cleaned = `${cleaned.slice(0, maxLength - extension.length).trimEnd()}${extension}`;
  }
  return cleaned || "attachment";
}

const MIME_TOKEN = "[a-z0-9][a-z0-9!#$&^_.+-]{0,126}";
const CONTENT_TYPE = new RegExp(`^${MIME_TOKEN}/${MIME_TOKEN}$`);

/** Accepts a bare type/subtype token, without parameters. */
export function normalizeContentType(contentType: string | undefined): string {
  if (contentType === undefined || contentType.trim() === "") return "application/octet-stream";
  const normalized = contentType.trim().toLowerCase();
  if (!CONTENT_TYPE.test(normalized)) {
    throw new Error(
      `contentType ${JSON.stringify(contentType.slice(0, 100))} must be a plain type/subtype such as application/pdf.`,
    );
  }
  return normalized;
}

interface Upload {
  id: string;
  filename: string;
  contentType: string;
  expectedBytes?: number;
  expectedSha256?: string;
  chunks: Buffer[];
  receivedBytes: number;
  nextIndex: number;
  finished?: { content: Buffer; sha256: string };
  lastActivity: number;
}

export interface StartUpload {
  filename: string;
  contentType?: string;
  totalBytes?: number;
  sha256?: string;
}

/**
 * In-memory staging for attachments too large for one tool call. Chunks must
 * arrive in order from index 0; finish verifies and freezes an upload, and
 * only finished uploads can be attached. The store is process-wide, so it
 * survives the per-request MCP servers the HTTP gateway creates.
 */
export class AttachmentUploadStore {
  private readonly uploads = new Map<string, Upload>();

  constructor(
    readonly limits: AttachmentLimits = ATTACHMENT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  start({ filename, contentType, totalBytes, sha256 }: StartUpload) {
    this.sweep();
    if (this.uploads.size >= this.limits.maxUploads) {
      throw new Error(
        `Too many staged uploads (${this.limits.maxUploads}). Send or finish existing ones, or wait ${this.limits.idleTimeoutMs / 60_000} minutes for idle uploads to expire.`,
      );
    }
    if (totalBytes !== undefined && totalBytes > this.limits.maxUploadBytes) {
      throw new Error(
        `totalBytes ${totalBytes} is above the ${this.limits.maxUploadBytes}-byte per-upload limit.`,
      );
    }

    const upload: Upload = {
      id: randomBytes(18).toString("base64url"),
      filename: sanitizeFilename(filename, this.limits.maxFilenameLength),
      contentType: normalizeContentType(contentType),
      ...(totalBytes === undefined ? {} : { expectedBytes: totalBytes }),
      ...(sha256 === undefined ? {} : { expectedSha256: sha256.toLowerCase() }),
      chunks: [],
      receivedBytes: 0,
      nextIndex: 0,
      lastActivity: this.now(),
    };
    this.uploads.set(upload.id, upload);
    return {
      uploadId: upload.id,
      filename: upload.filename,
      contentType: upload.contentType,
      maxChunkBase64Chars: this.limits.maxChunkBase64Chars,
      maxUploadBytes: this.limits.maxUploadBytes,
      expiresAt: this.expiresAt(upload),
    };
  }

  stageChunk({
    uploadId,
    index,
    dataBase64,
  }: {
    uploadId: string;
    index: number;
    dataBase64: string;
  }) {
    const upload = this.get(uploadId);
    if (upload.finished) {
      throw new Error(`Upload ${uploadId} is already finished; start a new upload to change it.`);
    }
    if (index < upload.nextIndex) {
      throw new Error(
        `Chunk ${index} was already received. The next chunk is ${upload.nextIndex}.`,
      );
    }
    if (index > upload.nextIndex) {
      throw new Error(
        `Chunk ${index} is out of order. Chunks must be sent in order; the next chunk is ${upload.nextIndex}.`,
      );
    }
    if (dataBase64.length === 0) {
      throw new Error("A chunk must not be empty.");
    }
    if (dataBase64.length > this.limits.maxChunkBase64Chars) {
      throw new Error(
        `Chunk is ${dataBase64.length} base64 characters, above the ${this.limits.maxChunkBase64Chars}-character limit.`,
      );
    }

    const data = decodeBase64Strict(dataBase64, `Chunk ${index}`);
    const receivedBytes = upload.receivedBytes + data.byteLength;
    const limit = Math.min(upload.expectedBytes ?? Infinity, this.limits.maxUploadBytes);
    if (receivedBytes > limit) {
      throw new Error(
        upload.expectedBytes !== undefined && upload.expectedBytes < this.limits.maxUploadBytes
          ? `Chunk ${index} would make the upload ${receivedBytes} bytes, more than the declared totalBytes ${upload.expectedBytes}.`
          : `Chunk ${index} would make the upload ${receivedBytes} bytes, above the ${this.limits.maxUploadBytes}-byte per-upload limit.`,
      );
    }
    if (this.stagedBytes() + data.byteLength > this.limits.maxStagedBytes) {
      throw new Error(
        `Staging memory is full (${this.limits.maxStagedBytes} bytes across all uploads). Send or let other uploads expire first.`,
      );
    }

    upload.chunks.push(data);
    upload.receivedBytes = receivedBytes;
    upload.nextIndex += 1;
    upload.lastActivity = this.now();
    return {
      uploadId,
      receivedBytes,
      nextIndex: upload.nextIndex,
      expiresAt: this.expiresAt(upload),
    };
  }

  finish(uploadId: string) {
    const upload = this.get(uploadId);
    if (!upload.finished) {
      if (upload.receivedBytes === 0) {
        throw new Error(`Upload ${uploadId} has no data; stage at least one chunk first.`);
      }
      const content = Buffer.concat(upload.chunks, upload.receivedBytes);
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (upload.expectedBytes !== undefined && content.byteLength !== upload.expectedBytes) {
        throw new Error(
          `Upload has ${content.byteLength} bytes but totalBytes was ${upload.expectedBytes}. Stage the remaining chunks starting at index ${upload.nextIndex}.`,
        );
      }
      if (upload.expectedSha256 !== undefined && sha256 !== upload.expectedSha256) {
        // The content can't be repaired chunk by chunk, so drop it.
        this.uploads.delete(uploadId);
        throw new Error(
          `Upload sha256 ${sha256} does not match the declared ${upload.expectedSha256}. The upload was discarded; start again.`,
        );
      }
      upload.finished = { content, sha256 };
      upload.chunks = [];
    }
    upload.lastActivity = this.now();
    return {
      uploadId,
      filename: upload.filename,
      contentType: upload.contentType,
      size: upload.finished.content.byteLength,
      sha256: upload.finished.sha256,
      expiresAt: this.expiresAt(upload),
    };
  }

  /** Returns finished uploads without changing them, so a failed send can be retried. */
  resolve(uploadIds: readonly string[]): OutgoingAttachment[] {
    if (new Set(uploadIds).size !== uploadIds.length) {
      throw new Error("attachmentUploadIds contains the same upload more than once.");
    }
    return uploadIds.map((uploadId) => {
      const upload = this.get(uploadId);
      if (!upload.finished) {
        throw new Error(
          `Upload ${uploadId} is not finished. Call finish_attachment_upload before send_email.`,
        );
      }
      return {
        filename: upload.filename,
        contentType: upload.contentType,
        content: upload.finished.content,
      };
    });
  }

  remove(uploadIds: readonly string[]) {
    for (const uploadId of uploadIds) this.uploads.delete(uploadId);
  }

  has(uploadId: string) {
    this.sweep();
    return this.uploads.has(uploadId);
  }

  private get(uploadId: string) {
    this.sweep();
    const upload = this.uploads.get(uploadId);
    if (!upload) {
      throw new Error(
        `Unknown or expired upload ${JSON.stringify(uploadId.slice(0, 64))}. Uploads expire ${this.limits.idleTimeoutMs / 60_000} minutes after their last activity; start a new one.`,
      );
    }
    return upload;
  }

  private stagedBytes() {
    let total = 0;
    for (const upload of this.uploads.values()) total += upload.receivedBytes;
    return total;
  }

  private expiresAt(upload: Upload) {
    return new Date(upload.lastActivity + this.limits.idleTimeoutMs).toISOString();
  }

  /** Drops uploads idle for longer than the timeout. Runs on every access. */
  private sweep() {
    const cutoff = this.now() - this.limits.idleTimeoutMs;
    for (const [id, upload] of this.uploads) {
      if (upload.lastActivity <= cutoff) this.uploads.delete(id);
    }
  }
}

/** One store per process, shared by every per-request MCP server. */
export const sharedAttachmentUploads = new AttachmentUploadStore();

export interface InlineAttachment {
  filename: string;
  contentType?: string;
  contentBase64: string;
}

/**
 * Validates inline attachments and finished uploads together against the
 * per-email count and size limits. Has no side effects.
 */
export function prepareOutgoingAttachments(
  store: AttachmentUploadStore,
  inline: readonly InlineAttachment[] = [],
  uploadIds: readonly string[] = [],
): OutgoingAttachment[] {
  const { limits } = store;
  const count = inline.length + uploadIds.length;
  if (count > limits.maxAttachmentsPerEmail) {
    throw new Error(
      `An email can carry at most ${limits.maxAttachmentsPerEmail} attachments; ${count} were given.`,
    );
  }

  const prepared: OutgoingAttachment[] = inline.map((attachment, index) => {
    if (attachment.contentBase64.length > Math.ceil(limits.maxEmailBytes / 3) * 4) {
      throw new Error(`attachments[${index}] is above the ${limits.maxEmailBytes}-byte limit.`);
    }
    return {
      filename: sanitizeFilename(attachment.filename, limits.maxFilenameLength),
      contentType: normalizeContentType(attachment.contentType),
      content: decodeBase64Strict(attachment.contentBase64, `attachments[${index}].contentBase64`),
    };
  });
  prepared.push(...store.resolve(uploadIds));

  const total = prepared.reduce((sum, attachment) => sum + attachment.content.byteLength, 0);
  if (total > limits.maxEmailBytes) {
    throw new Error(
      `Attachments total ${total} bytes, above the ${limits.maxEmailBytes}-byte per-email limit.`,
    );
  }
  return prepared;
}
