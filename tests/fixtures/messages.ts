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
