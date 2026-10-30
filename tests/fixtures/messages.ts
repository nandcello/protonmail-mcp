import { PNG } from "pngjs";
import { deflateSync } from "node:zlib";
import type { FakeMessage } from "./fake-imap-server.ts";

/** Builds a one-page PDF whose text layer contains `text`. */
export function makePdf(text: string) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

function base64Lines(content: Buffer) {
  return (content.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

export const LOAN_PDF_NAME = "Housing Loan Application Form_INDV_2022 (1)(2).pdf";
export const LOAN_BODY_TEXT =
  "Dear Client, we are pleased to inform you that your housing loan has been conditionally approved.";

/**
 * Mirrors the shape of the real BPI message: a short text body next to a
 * ~99 KB inline PNG that is also embedded in the HTML alternative as a data:
 * URI, plus a PDF attachment.
 */
export function loanApprovalMessage(uid = 1350): FakeMessage {
  const image = Buffer.alloc(99 * 1024, 7);
  const imageBase64 = base64Lines(image);
  return {
    uid,
    messageId: "<approval-1350@bpi.example>",
    subject: "Conditional Approval Loan Details",
    from: { name: "BPI", mailbox: "noreply", host: "bpi.example" },
    to: { mailbox: "me", host: "example.com" },
    date: "Mon, 27 Oct 2026 10:00:00 +0800",
    flags: new Set(),
    root: {
      subtype: "MIXED",
      boundary: "mixed-boundary",
      children: [
        {
          subtype: "RELATED",
          boundary: "related-boundary",
          children: [
            {
              subtype: "ALTERNATIVE",
              boundary: "alt-boundary",
              children: [
                {
                  type: "text",
                  subtype: "plain",
                  params: { charset: "utf-8" },
                  encoding: "7BIT",
                  body: `${LOAN_BODY_TEXT}\r\n[cid:image001.png@bpi]\r\nPlease review the attached form.`,
                },
                {
                  type: "text",
                  subtype: "html",
                  params: { charset: "utf-8" },
                  encoding: "7BIT",
                  body: `<p>${LOAN_BODY_TEXT}</p><img src="data:image/png;base64,${image.toString("base64")}"><p>Please review the attached form.</p>`,
                },
              ],
            },
            {
              type: "image",
              subtype: "png",
              params: { name: "image.png" },
              id: "<image001.png@bpi>",
              encoding: "BASE64",
              disposition: { type: "INLINE", params: { filename: "image.png" } },
              body: imageBase64,
            },
          ],
        },
        {
          type: "application",
          subtype: "pdf",
          params: { name: LOAN_PDF_NAME },
          encoding: "BASE64",
          disposition: { type: "ATTACHMENT", params: { filename: LOAN_PDF_NAME } },
          body: base64Lines(makePdf("Housing Loan Application Form")),
        },
      ],
    },
  };
}

/** The same message with only the HTML alternative, to exercise the HTML fallback. */
export function htmlOnlyMessage(uid = 1351): FakeMessage {
  const message = loanApprovalMessage(uid);
  message.messageId = "<html-only@bpi.example>";
  const mixed = message.root as Extract<FakeMessage["root"], { children: unknown }>;
  const related = mixed.children[0] as typeof mixed;
  const alternative = related.children[0] as typeof mixed;
  alternative.children = [alternative.children[1]];
  return message;
}

/** A deterministic RGB PNG; `noisy` makes it nearly incompressible. */
export function makePng(width: number, height: number, noisy = false) {
  const png = new PNG({ width, height });
  let seed = 1;
  for (let index = 0; index < png.data.length; index += 4) {
    const pixel = index / 4;
    if (noisy) {
      for (let channel = 0; channel < 3; channel += 1) {
        seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
        png.data[index + channel] = seed >> 16;
      }
    } else {
      png.data[index] = pixel % 256;
      png.data[index + 1] = (pixel >> 8) % 256;
      png.data[index + 2] = 128;
    }
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** An image-only PDF (no text layer), like a scanned form. */
export function makeScannedPdf(pages: number, width = 120, height = 160) {
  // Smooth gradients with dark bands, closer to a scanned form than noise.
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const shade = y % 20 < 2 ? 40 : 200 + ((x + y) % 50);
      pixels.fill(shade, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
  const image = deflateSync(pixels);
  const objects: Buffer[] = [Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"), Buffer.alloc(0)];
  const kids: string[] = [];
  for (let page = 0; page < pages; page += 1) {
    const first = 3 + page * 3;
    const drawing = "q 612 0 0 792 0 0 cm /Im0 Do Q";
    kids.push(`${first} 0 R`);
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${first + 1} 0 R /Resources << /XObject << /Im0 ${first + 2} 0 R >> >> >>`,
      ),
      Buffer.from(`<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`),
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`,
        ),
        image,
        Buffer.from("\nendstream"),
      ]),
    );
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`);

  const parts = [Buffer.from("%PDF-1.4\n")];
  let length = parts[0].length;
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(length);
    const encoded = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(encoded);
    length += encoded.length;
  });
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

export const INLINE_PNG = makePng(64, 48);
export const LARGE_PNG = makePng(700, 700, true);
export const SCANNED_PDF = makeScannedPdf(3);

function leaf(
  type: string,
  subtype: string,
  filename: string,
  content: Buffer,
  disposition: "INLINE" | "ATTACHMENT",
  id?: string,
) {
  return {
    type,
    subtype,
    params: { name: filename },
    ...(id === undefined ? {} : { id }),
    encoding: "BASE64" as const,
    disposition: { type: disposition, params: { filename } },
    body: base64Lines(content),
  };
}

/**
 * Mirrors the BPI case where the content is only in images: an inline PNG
 * (1.2) and a scanned PDF (2), plus a large PNG, a GIF, and an SVG.
 */
export function imageAttachmentsMessage(uid = 1400): FakeMessage {
  return {
    uid,
    messageId: `<images-${uid}@bpi.example>`,
    subject: "Scanned documents",
    from: { name: "BPI", mailbox: "noreply", host: "bpi.example" },
    to: { mailbox: "me", host: "example.com" },
    date: "Mon, 27 Oct 2026 10:00:00 +0800",
    flags: new Set(),
    root: {
      subtype: "MIXED",
      boundary: "mixed-images",
      children: [
        {
          subtype: "RELATED",
          boundary: "related-images",
          children: [
            {
              type: "text",
              subtype: "plain",
              params: { charset: "utf-8" },
              encoding: "7BIT",
              body: "See the image below.\r\n[cid:image001.png@bpi]",
            },
            leaf("image", "png", "image.png", INLINE_PNG, "INLINE", "<image001.png@bpi>"),
          ],
        },
        leaf("application", "pdf", "scan.pdf", SCANNED_PDF, "ATTACHMENT"),
        leaf("image", "png", "large.png", LARGE_PNG, "ATTACHMENT"),
        leaf("image", "gif", "large.gif", Buffer.alloc(30_000, 1), "ATTACHMENT"),
        leaf(
          "image",
          "svg+xml",
          "logo.svg",
          Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
          "ATTACHMENT",
        ),
      ],
    },
  };
}
