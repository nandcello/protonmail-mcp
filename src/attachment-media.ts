import { PDFiumLibrary } from "@hyzyla/pdfium";
import { createHash } from "node:crypto";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { formatSize } from "./full-email.ts";

/** Image types returned as MCP image content. Others (SVG, TIFF, ...) are never rendered. */
export const SAFE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Rendered PDF pages: ~150 DPI, but never wider than this. */
const RENDER_DPI = 150;
const RENDER_MAX_WIDTH = 1_600;
/** Re-encoding never shrinks an image below this width. */
const MIN_WIDTH = 200;
/** Refuse to decode anything larger, regardless of its compressed size. */
const MAX_DECODED_PIXELS = 50_000_000;
const JPEG_QUALITY = 82;
const LOW_JPEG_QUALITY = 55;
const MAX_ENCODE_ATTEMPTS = 6;

export const MAX_RENDER_PAGES = 10;
/** Combined size of all page images returned by one call. */
export const MAX_RENDER_TOTAL_BYTES = 10 * 1_024 * 1_024;

export interface ImageOutput {
  mimeType: string;
  data: Buffer;
  width: number | null;
  height: number | null;
  /** True when the image was downscaled or re-encoded to fit. */
  reencoded: boolean;
}

export function normalizeImageType(contentType: string) {
  const type = contentType.toLowerCase();
  return type === "image/jpg" || type === "image/pjpeg" ? "image/jpeg" : type;
}

interface Rgba {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Same size: only composites transparency onto white. */
function flattenOntoWhite(source: Rgba): Rgba {
  const output = new Uint8Array(source.width * source.height * 4);
  for (let index = 0; index < output.length; index += 4) {
    const alpha = source.data[index + 3] / 255;
    output[index] = Math.round(source.data[index] * alpha + 255 * (1 - alpha));
    output[index + 1] = Math.round(source.data[index + 1] * alpha + 255 * (1 - alpha));
    output[index + 2] = Math.round(source.data[index + 2] * alpha + 255 * (1 - alpha));
    output[index + 3] = 255;
  }
  return { data: output, width: source.width, height: source.height };
}

/** Box-filter downscale, compositing transparency onto white because JPEG has no alpha. */
function resizeOntoWhite(source: Rgba, width: number, height: number): Rgba {
  const output = new Uint8Array(width * height * 4);
  const xRatio = source.width / width;
  const yRatio = source.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yRatio));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xRatio));
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const index = (sy * source.width + sx) * 4;
          const alpha = source.data[index + 3] / 255;
          red += source.data[index] * alpha + 255 * (1 - alpha);
          green += source.data[index + 1] * alpha + 255 * (1 - alpha);
          blue += source.data[index + 2] * alpha + 255 * (1 - alpha);
          count += 1;
        }
      }
      const target = (y * width + x) * 4;
      output[target] = Math.round(red / count);
      output[target + 1] = Math.round(green / count);
      output[target + 2] = Math.round(blue / count);
      output[target + 3] = 255;
    }
  }
  return { data: output, width, height };
}

/**
 * Encodes RGBA pixels as a JPEG no larger than maxBytes. JPEG size scales
 * roughly with pixel count, so each miss shrinks the width by the square root
 * of the overshoot; a near miss first drops the quality instead. Returns null
 * when even MIN_WIDTH at the lowest quality does not fit.
 */
function encodeJpegToFit(source: Rgba, maxBytes: number) {
  const minWidth = Math.min(MIN_WIDTH, source.width);
  let width = source.width;
  let quality = JPEG_QUALITY;
  for (let attempt = 0; attempt < MAX_ENCODE_ATTEMPTS; attempt += 1) {
    const height = Math.max(1, Math.round((source.height * width) / source.width));
    const pixels =
      width === source.width ? flattenOntoWhite(source) : resizeOntoWhite(source, width, height);
    const encoded = jpeg.encode({ data: Buffer.from(pixels.data.buffer), width, height }, quality);
    const size = encoded.data.byteLength;
    if (size <= maxBytes) return { data: Buffer.from(encoded.data), width, height };

    if (quality > LOW_JPEG_QUALITY && size <= maxBytes * 1.6) {
      quality = LOW_JPEG_QUALITY;
    } else if (width > minWidth) {
      width = Math.max(minWidth, Math.floor(width * Math.sqrt(maxBytes / size) * 0.92));
    } else if (quality > LOW_JPEG_QUALITY) {
      quality = LOW_JPEG_QUALITY;
    } else {
      return null;
    }
  }
  return null;
}

function pngDimensions(content: Buffer) {
  // The IHDR chunk always comes first: width and height at bytes 16-23.
  if (content.byteLength < 24 || content.toString("latin1", 12, 16) !== "IHDR") {
    throw new Error("Not a valid PNG file.");
  }
  return { width: content.readUInt32BE(16), height: content.readUInt32BE(20) };
}

function decodeImage(content: Buffer, mimeType: string): Rgba {
  if (mimeType === "image/png") {
    const { width, height } = pngDimensions(content);
    if (width * height > MAX_DECODED_PIXELS) {
      throw new Error(`PNG is ${width}x${height}, too large to decode safely.`);
    }
    const png = PNG.sync.read(content);
    return { data: png.data, width: png.width, height: png.height };
  }
  const decoded = jpeg.decode(content, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: MAX_DECODED_PIXELS / 1_000_000,
    maxMemoryUsageInMB: 512,
  });
  return { data: decoded.data, width: decoded.width, height: decoded.height };
}

/**
 * Returns an image attachment unchanged when it fits in maxBytes. Otherwise
 * PNG and JPEG are downscaled and re-encoded as JPEG; GIF and WebP have no
 * pure-JS codec here, so they are refused with a clear message.
 */
export function fitImage(
  content: Buffer,
  contentType: string,
  filename: string | null,
  maxBytes: number,
): ImageOutput {
  const mimeType = normalizeImageType(contentType);
  if (!SAFE_IMAGE_TYPES.has(mimeType)) {
    throw new Error(`${mimeType} is not returned as image content.`);
  }
  if (content.byteLength <= maxBytes) {
    return { mimeType, data: content, width: null, height: null, reencoded: false };
  }

  const label = `${filename ?? "Image"} is ${formatSize(content.byteLength)} (${content.byteLength} bytes), above maxImageBytes ${maxBytes}`;
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
    throw new Error(
      `${label}, and ${mimeType} cannot be downscaled here. Fetch the raw bytes with byteOffset/byteLength instead.`,
    );
  }

  const fitted = encodeJpegToFit(decodeImage(content, mimeType), maxBytes);
  if (!fitted) {
    throw new Error(
      `${label}, and it does not fit even at ${MIN_WIDTH}px wide. Raise maxImageBytes or fetch the raw bytes with byteOffset/byteLength.`,
    );
  }
  return { mimeType: "image/jpeg", ...fitted, reencoded: true };
}

let pdfiumLibrary: Promise<PDFiumLibrary> | undefined;

/** PDFium runs as WebAssembly, so an untrusted PDF never reaches native code. */
function loadPdfium() {
  pdfiumLibrary ??= PDFiumLibrary.init().catch((error: unknown) => {
    pdfiumLibrary = undefined;
    throw error;
  });
  return pdfiumLibrary;
}

export interface RenderedPage extends ImageOutput {
  page: number;
}

export interface RenderResult {
  totalPages: number;
  rendered: RenderedPage[];
  skipped: Array<{ page: number; reason: string }>;
  /** Pages after the first N that were not requested. */
  notRequested: number;
}

export type PageSelection = { page: number } | { first: number };

/**
 * Renders one page or the first N pages (1-based) to JPEG at ~150 DPI, at most
 * 1600px wide, each shrunk to fit maxImageBytes. A missing page, a page over
 * the per-page size, or one past the combined byte budget is reported as skipped.
 */
export async function renderPdfPages(
  content: Buffer,
  selection: PageSelection,
  maxImageBytes: number,
  totalBytes = MAX_RENDER_TOTAL_BYTES,
): Promise<RenderResult> {
  const library = await loadPdfium();
  const document = await library.loadDocument(new Uint8Array(content));
  try {
    const totalPages = document.getPageCount();
    const pages =
      "page" in selection
        ? [selection.page]
        : Array.from({ length: Math.min(selection.first, totalPages) }, (_, index) => index + 1);
    const result: RenderResult = {
      totalPages,
      rendered: [],
      skipped: [],
      notRequested: "page" in selection ? 0 : Math.max(0, totalPages - selection.first),
    };
    let used = 0;

    for (const number of pages) {
      if (number > totalPages) {
        result.skipped.push({ page: number, reason: `The PDF has only ${totalPages} page(s).` });
        continue;
      }
      const page = document.getPage(number - 1);
      try {
        const { originalWidth } = page.getOriginalSize();
        const scale = Math.min(RENDER_DPI / 72, RENDER_MAX_WIDTH / originalWidth);
        const bitmap = await page.render({ scale, colorSpace: "RGBA" });
        // Each page fits maxImageBytes on its own, so page=N alone yields the same bytes.
        const fitted = encodeJpegToFit(bitmap, maxImageBytes);
        if (!fitted) {
          result.skipped.push({
            page: number,
            reason: `The page does not fit in maxImageBytes ${maxImageBytes} even at ${MIN_WIDTH}px wide.`,
          });
          continue;
        }
        if (used + fitted.data.byteLength > totalBytes) {
          result.skipped.push({
            page: number,
            reason: `The combined ${formatSize(totalBytes)} image budget for one call is used up. Request this page on its own with page=${number}.`,
          });
          continue;
        }
        used += fitted.data.byteLength;
        result.rendered.push({ page: number, mimeType: "image/jpeg", ...fitted, reencoded: true });
      } finally {
        page.close();
      }
    }
    return result;
  } finally {
    document.destroy();
  }
}

export interface ByteChunk {
  mimeType: string;
  offset: number;
  length: number;
  totalBytes: number;
  /** SHA-256 of all totalBytes, for verifying a reassembled file. */
  sha256: string;
  done: boolean;
  nextOffset: number | null;
  base64: string;
}

export function chunkBytes(content: Buffer, mimeType: string, offset: number, length: number) {
  if (offset > content.byteLength) {
    throw new Error(`byteOffset ${offset} is past the end (${content.byteLength} bytes).`);
  }
  const slice = content.subarray(offset, Math.min(content.byteLength, offset + length));
  const end = offset + slice.byteLength;
  return {
    mimeType,
    offset,
    length: slice.byteLength,
    totalBytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    done: end >= content.byteLength,
    nextOffset: end >= content.byteLength ? null : end,
    base64: slice.toString("base64"),
  } satisfies ByteChunk;
}
