import type { FetchMessageObject, MessageAddressObject } from "imapflow";
import type { AddressObject } from "mailparser";

export interface EmailSummary {
  uid: number;
  messageId: string | null;
  subject: string;
  from: string[];
  to: string[];
  cc: string[];
  date: string | null;
  flags: string[];
  unread: boolean;
  flagged: boolean;
  size: number | null;
}

export function formatEnvelopeAddresses(addresses: MessageAddressObject[] | undefined): string[] {
  return (addresses ?? []).map(({ address, name }) => {
    if (name && address) {
      return `${name} <${address}>`;
    }

    return address ?? name ?? "";
  });
}

export function formatParsedAddresses(
  addresses: AddressObject | AddressObject[] | undefined,
): string[] {
  if (!addresses) {
    return [];
  }

  return (Array.isArray(addresses) ? addresses : [addresses]).flatMap((address) =>
    address.value.map((entry) => entry.address ?? entry.name),
  );
}

export function toEmailSummary(message: FetchMessageObject): EmailSummary {
  const flags = [...(message.flags ?? [])].sort();

  return {
    uid: message.uid,
    messageId: message.envelope?.messageId ?? null,
    subject: message.envelope?.subject ?? "(no subject)",
    from: formatEnvelopeAddresses(message.envelope?.from),
    to: formatEnvelopeAddresses(message.envelope?.to),
    cc: formatEnvelopeAddresses(message.envelope?.cc),
    date:
      message.envelope?.date?.toISOString() ??
      (message.internalDate ? new Date(message.internalDate).toISOString() : null),
    flags,
    unread: !flags.includes("\\Seen"),
    flagged: flags.includes("\\Flagged"),
    size: message.size ?? null,
  };
}

export function truncate(value: string, maxCharacters: number) {
  if (value.length <= maxCharacters) {
    return { value, truncated: false };
  }

  return {
    value: `${value.slice(0, maxCharacters)}\n\n[truncated]`,
    truncated: true,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
