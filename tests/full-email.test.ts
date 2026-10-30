import { describe, expect, test } from "vite-plus/test";
import { extractAttachmentText } from "../src/attachment-text.ts";
import {
  cleanPlainText,
  describeStructure,
  htmlToText,
  stripEmbeddedData,
  type AttachmentInfo,
} from "../src/full-email.ts";
import { makePdf } from "./fixtures/messages.ts";

const inlineImage: AttachmentInfo = {
  id: "1.2",
  filename: "image.png",
  contentType: "image/png",
  size: 99 * 1024,
  encodedSize: 135_000,
  inline: true,
  contentId: "image001.png@bpi",
};

describe("describeStructure", () => {
  test("treats a single-part message as body part 1", () => {
    expect(describeStructure({ type: "text/plain", size: 10 })).toEqual({
      plain: [{ id: "1", contentType: "text/plain" }],
      html: [],
      attachments: [],
    });
  });

  test("separates body text from inline images, attachments, and named text files", () => {
    const layout = describeStructure({
      type: "multipart/mixed",
      childNodes: [
        {
          part: "1",
          type: "multipart/alternative",
          childNodes: [
            { part: "1.1", type: "text/plain" },
            { part: "1.2", type: "text/html" },
          ],
        },
        { part: "2", type: "image/png", id: "<cid1>", encoding: "base64", size: 78 },
        {
          part: "3",
          type: "text/plain",
          disposition: "attachment",
          dispositionParameters: { filename: "notes.txt" },
          size: 5,
        },
        { part: "4", type: "message/rfc822", size: 50 },
      ],
    });

    expect(layout.plain).toEqual([{ id: "1.1", contentType: "text/plain" }]);
    expect(layout.html).toEqual([{ id: "1.2", contentType: "text/html" }]);
    expect(layout.attachments).toEqual([
      expect.objectContaining({ id: "2", size: 57, inline: true, contentId: "cid1" }),
      expect.objectContaining({ id: "3", filename: "notes.txt", inline: false }),
      expect.objectContaining({ id: "4", contentType: "message/rfc822" }),
    ]);
  });
});

describe("embedded data stripping", () => {
  test("replaces data: URIs and long base64 runs with placeholders", () => {
    const blob = "A".repeat(4_000);
    expect(stripEmbeddedData(`see data:image/png;base64,${blob} end`)).toBe(
      "see [inline image: image/png, 3 KB] end",
    );
    expect(stripEmbeddedData(`x ${blob} y`)).toBe("x [base64 data removed, 3 KB] y");
    expect(stripEmbeddedData("short normal text stays")).toBe("short normal text stays");
  });

  test("names cid image references in plain text", () => {
    expect(cleanPlainText("Hi [cid:image001.png@bpi] there", [inlineImage])).toBe(
      "Hi [inline image: image.png, 99 KB] there",
    );
  });

  test("converts HTML to text with image placeholders", () => {
    const text = htmlToText(
      '<style>p{}</style><p>Hello <b>you</b></p><img src="cid:image001.png@bpi"><img alt="logo" src="https://x/y.png">',
      [inlineImage],
    );
    expect(text).toContain("Hello you");
    expect(text).toContain("[inline image: image.png, 99 KB]");
    expect(text).toContain("[image: logo]");
    expect(text).not.toContain("p{}");
  });
});

describe("extractAttachmentText", () => {
  test("extracts PDF text", async () => {
    const result = await extractAttachmentText(makePdf("Hello PDF"), "application/pdf", "a.pdf");
    expect(result).toMatchObject({ text: "Hello PDF", pages: 1 });
  });

  test("reports a broken PDF instead of throwing", async () => {
    const result = await extractAttachmentText(Buffer.from("not a pdf"), "application/pdf", null);
    expect(result.text).toBeNull();
    expect(result.note).toMatch(/PDF text extraction failed/);
  });

  test("returns no text for binary types", async () => {
    const result = await extractAttachmentText(Buffer.from([1, 2, 3]), "image/png", "x.png");
    expect(result.text).toBeNull();
    expect(result.note).toMatch(/saveToFile/);
  });
});
