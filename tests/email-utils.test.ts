import type { FetchMessageObject } from "imapflow";
import { describe, expect, test } from "vite-plus/test";
import { toEmailSummary, truncate } from "../src/email-utils.ts";

describe("email helpers", () => {
  test("turns an IMAP envelope into safe summary metadata", () => {
    const message: FetchMessageObject = {
      seq: 7,
      uid: 42,
      size: 1_024,
      flags: new Set(["\\Seen", "\\Flagged"]),
      envelope: {
        subject: "Hello",
        messageId: "<message@example.com>",
        date: new Date("2026-07-23T12:00:00.000Z"),
        from: [{ name: "Sender", address: "sender@example.com" }],
        to: [{ address: "recipient@example.com" }],
      },
    };

    expect(toEmailSummary(message)).toEqual({
      uid: 42,
      messageId: "<message@example.com>",
      subject: "Hello",
      from: ["Sender <sender@example.com>"],
      to: ["recipient@example.com"],
      cc: [],
      date: "2026-07-23T12:00:00.000Z",
      flags: ["\\Flagged", "\\Seen"],
      unread: false,
      flagged: true,
      size: 1_024,
    });
  });

  test("marks truncated message bodies", () => {
    expect(truncate("abcdef", 3)).toEqual({
      value: "abc\n\n[truncated]",
      truncated: true,
    });
    expect(truncate("abc", 3)).toEqual({
      value: "abc",
      truncated: false,
    });
  });
});
