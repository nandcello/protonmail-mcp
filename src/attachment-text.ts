import { simpleParser } from "mailparser";
import { extractText, getDocumentProxy } from "unpdf";
import { htmlToText, stripEmbeddedData } from "./full-email.ts";

export interface ExtractedText {
  text: string | null;
  /** Why no text was produced, or how it was produced. */
  note: string;
  pages?: number;
}

const TEXT_LIKE_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/yaml",
  "application/csv",
  "application/ics",
]);

function isPdf(contentType: string, filename: string | null) {
  return contentType === "application/pdf" || /\.pdf$/i.test(filename ?? "");
}

/** Extracts readable text from a decoded attachment. Never executes or renders content. */
export async function extractAttachmentText(
  content: Buffer,
  contentType: string,
  filename: string | null,
): Promise<ExtractedText> {
  const type = contentType.toLowerCase();

  if (isPdf(type, filename)) {
    try {
      // unpdf transfers the buffer to pdf.js, so give it a private copy.
      const pdf = await getDocumentProxy(new Uint8Array(content));
      try {
        const { totalPages, text } = await extractText(pdf, { mergePages: true });
        const trimmed = text.trim();
        return trimmed
          ? { text: trimmed, note: "Extracted from PDF text layer.", pages: totalPages }
          : {
              text: null,
              note: "The PDF has no text layer (it may be scanned images).",
              pages: totalPages,
            };
      } finally {
        await pdf.loadingTask.destroy();
      }
    } catch (error) {
      return {
        text: null,
        note: `PDF text extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (type === "text/html") {
    return { text: htmlToText(content.toString("utf8"), []), note: "Converted from HTML." };
  }

  if (type.startsWith("text/") || TEXT_LIKE_TYPES.has(type)) {
    return { text: stripEmbeddedData(content.toString("utf8")), note: "Decoded as UTF-8 text." };
  }

  if (type === "message/rfc822") {
    const parsed = await simpleParser(content, { skipImageLinks: true });
    const body = parsed.text
      ? stripEmbeddedData(parsed.text)
      : typeof parsed.html === "string"
        ? htmlToText(parsed.html, [])
        : "";
    const header = [
      `From: ${parsed.from?.text ?? ""}`,
      `To: ${[parsed.to]
        .flat()
        .map((address) => address?.text ?? "")
        .join(", ")}`,
      `Date: ${parsed.date?.toISOString() ?? ""}`,
      `Subject: ${parsed.subject ?? ""}`,
    ].join("\n");
    return { text: `${header}\n\n${body}`, note: "Embedded email message." };
  }

  return {
    text: null,
    note: `No text extraction for ${type}. Pass saveToFile=true to write it to a file.`,
  };
}
