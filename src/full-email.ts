import { convert } from "html-to-text";
import type { MessageStructureObject } from "imapflow";

/** A non-body MIME leaf. `id` is its IMAP body part path, stable for the message. */
export interface AttachmentInfo {
  id: string;
  filename: string | null;
  contentType: string;
  /** Decoded size in bytes; estimated from the encoded size for base64/quoted-printable. */
  size: number;
  encodedSize: number;
  inline: boolean;
  contentId: string | null;
}

export interface BodyPart {
  id: string;
  contentType: "text/plain" | "text/html";
}

export interface MessageLayout {
  /** Inline text/plain parts in document order. */
  plain: BodyPart[];
  /** Inline text/html parts in document order; only used when there is no plain text. */
  html: BodyPart[];
  attachments: AttachmentInfo[];
}

function estimateDecodedSize(node: MessageStructureObject) {
  const encoded = node.size ?? 0;
  switch (node.encoding?.toLowerCase()) {
    // 76 base64 characters per line plus CRLF encode 57 bytes.
    case "base64":
      return Math.floor((encoded * 57) / 78);
    case "quoted-printable":
      return Math.floor(encoded * 0.9);
    default:
      return encoded;
  }
}

function filenameOf(node: MessageStructureObject) {
  return node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
}

function stripAngles(value: string | undefined) {
  return value ? value.replace(/^<|>$/g, "") : null;
}

/**
 * Splits a BODYSTRUCTURE into readable body parts and everything else. Parts
 * with an attachment disposition or a filename are attachments even when they
 * are text; embedded messages are attachments and are not descended into.
 */
export function describeStructure(root: MessageStructureObject): MessageLayout {
  const layout: MessageLayout = { plain: [], html: [], attachments: [] };

  const visit = (node: MessageStructureObject, id: string) => {
    const type = node.type.toLowerCase();
    if (type.startsWith("multipart/")) {
      (node.childNodes ?? []).forEach((child, index) =>
        visit(child, child.part ?? (id === "" ? `${index + 1}` : `${id}.${index + 1}`)),
      );
      return;
    }

    const disposition = node.disposition?.toLowerCase();
    const filename = filenameOf(node);
    const isBodyText =
      (type === "text/plain" || type === "text/html") &&
      disposition !== "attachment" &&
      filename === null;

    if (isBodyText) {
      (type === "text/plain" ? layout.plain : layout.html).push({ id, contentType: type });
      return;
    }

    layout.attachments.push({
      id,
      filename,
      contentType: type,
      size: estimateDecodedSize(node),
      encodedSize: node.size ?? 0,
      inline: disposition === "inline" || (disposition === undefined && node.id !== undefined),
      contentId: stripAngles(node.id),
    });
  };

  // A single-part message has no part number; IMAP addresses its body as part 1.
  visit(root, root.part ?? (root.type.toLowerCase().startsWith("multipart/") ? "" : "1"));
  return layout;
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function inlineImagePlaceholder(name: string | null, bytes: number) {
  return `[inline image: ${name ?? "unnamed"}, ${formatSize(bytes)}]`;
}

const DATA_URI = /data:([\w.+-]+\/[\w.+-]+)?(?:;[\w.+-]+=[^;,\s"')]*)*(;base64)?,[^\s"')<>]*/gi;
/** Long unbroken base64 runs that are not part of a data: URI, e.g. a pasted blob. */
const BASE64_RUN = /(?:[A-Za-z0-9+/]{76}\r?\n?){4,}[A-Za-z0-9+/]*={0,2}|[A-Za-z0-9+/]{400,}={0,2}/g;

function base64Bytes(encoded: string) {
  return Math.floor((encoded.replace(/[^A-Za-z0-9+/]/g, "").length * 3) / 4);
}

/** Replaces data: URIs and long base64 runs with short placeholders. */
export function stripEmbeddedData(text: string) {
  return text
    .replace(DATA_URI, (match, mime: string | undefined, isBase64: string | undefined) => {
      const payload = match.slice(match.indexOf(",") + 1);
      const bytes = isBase64 ? base64Bytes(payload) : payload.length;
      return mime?.toLowerCase().startsWith("image/")
        ? inlineImagePlaceholder(mime.toLowerCase(), bytes)
        : `[embedded data: ${mime?.toLowerCase() ?? "unknown"}, ${formatSize(bytes)}]`;
    })
    .replace(BASE64_RUN, (match) => `[base64 data removed, ${formatSize(base64Bytes(match))}]`);
}

function attachmentByCid(attachments: AttachmentInfo[], cid: string) {
  const wanted = cid.replace(/^cid:/i, "").replace(/^<|>$/g, "").toLowerCase();
  return attachments.find((attachment) => attachment.contentId?.toLowerCase() === wanted);
}

function placeholderForCid(attachments: AttachmentInfo[], cid: string) {
  const attachment = attachmentByCid(attachments, cid);
  return attachment
    ? inlineImagePlaceholder(attachment.filename ?? attachment.contentId, attachment.size)
    : `[inline image: ${cid.replace(/^cid:/i, "")}]`;
}

/** Plain-text bodies often reference inline images as `[cid:image001.png@...]`. */
export function cleanPlainText(text: string, attachments: AttachmentInfo[]) {
  return stripEmbeddedData(text).replace(/\[cid:([^\]\s]+)\]/gi, (_match, cid: string) =>
    placeholderForCid(attachments, cid),
  );
}

/** Converts HTML to text, turning every image into a placeholder instead of its data. */
export function htmlToText(html: string, attachments: AttachmentInfo[]) {
  const withPlaceholders = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1] ?? "";
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? null;
    if (/^cid:/i.test(src)) return ` ${placeholderForCid(attachments, src)} `;
    if (/^data:/i.test(src)) {
      const isBase64 = /^data:[^,]*;base64,/i.test(src);
      const payload = src.slice(src.indexOf(",") + 1);
      return ` ${inlineImagePlaceholder(alt || "data URI", isBase64 ? base64Bytes(payload) : payload.length)} `;
    }
    return alt ? ` [image: ${alt}] ` : " ";
  });

  const text = convert(stripEmbeddedData(withPlaceholders), {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "script", format: "skip" },
    ],
  });
  return stripEmbeddedData(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncateWithNotice(value: string, maxCharacters: number) {
  if (value.length <= maxCharacters) {
    return { value, truncated: false, totalCharacters: value.length };
  }
  return {
    value: `${value.slice(0, maxCharacters)}\n\n[truncated: showing ${maxCharacters} of ${value.length} characters]`,
    truncated: true,
    totalCharacters: value.length,
  };
}
