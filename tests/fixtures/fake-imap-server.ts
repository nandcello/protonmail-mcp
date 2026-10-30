import { createServer, type Server, type Socket } from "node:net";

/**
 * A deliberately small IMAP4rev1 server for exercising the real ImapFlow client.
 * It behaves like a strict server for read state: any non-PEEK BODY[] or
 * RFC822 fetch, and any STORE, sets \Seen even under EXAMINE, so a test that
 * finds \Seen unset proves the client only ever peeked.
 */

export interface MimeLeaf {
  type: string;
  subtype: string;
  params?: Record<string, string>;
  id?: string;
  encoding: "7BIT" | "BASE64" | "QUOTED-PRINTABLE";
  disposition?: { type: "INLINE" | "ATTACHMENT"; params?: Record<string, string> };
  /** Already transfer-encoded body. */
  body: string;
}

export interface MimeMultipart {
  subtype: string;
  boundary: string;
  children: MimeNode[];
}

export type MimeNode = MimeLeaf | MimeMultipart;

export interface FakeMessage {
  uid: number;
  messageId: string;
  subject: string;
  from: { name: string; mailbox: string; host: string };
  to: { mailbox: string; host: string };
  date: string;
  flags: Set<string>;
  root: MimeNode;
}

const isMultipart = (node: MimeNode): node is MimeMultipart => "children" in node;

function paramsHeader(params: Record<string, string> | undefined) {
  return Object.entries(params ?? {})
    .map(([key, value]) => `; ${key}="${value}"`)
    .join("");
}

function nodeHeaders(node: MimeNode) {
  if (isMultipart(node)) {
    return `Content-Type: multipart/${node.subtype}; boundary="${node.boundary}"`;
  }
  const lines = [
    `Content-Type: ${node.type}/${node.subtype}${paramsHeader(node.params)}`,
    `Content-Transfer-Encoding: ${node.encoding}`,
  ];
  if (node.id) lines.push(`Content-ID: ${node.id}`);
  if (node.disposition) {
    lines.push(
      `Content-Disposition: ${node.disposition.type.toLowerCase()}${paramsHeader(node.disposition.params)}`,
    );
  }
  return lines.join("\r\n");
}

function nodeBody(node: MimeNode): string {
  if (!isMultipart(node)) return node.body;
  return (
    node.children
      .map((child) => `--${node.boundary}\r\n${nodeHeaders(child)}\r\n\r\n${nodeBody(child)}\r\n`)
      .join("") + `--${node.boundary}--\r\n`
  );
}

function quote(value: string | undefined | null) {
  return value === undefined || value === null ? "NIL" : `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function paramList(params: Record<string, string> | undefined) {
  const entries = Object.entries(params ?? {});
  return entries.length === 0
    ? "NIL"
    : `(${entries.map(([key, value]) => `${quote(key.toUpperCase())} ${quote(value)}`).join(" ")})`;
}

function bodyStructure(node: MimeNode): string {
  if (isMultipart(node)) {
    return `(${node.children.map(bodyStructure).join("")} ${quote(node.subtype.toUpperCase())} ("BOUNDARY" ${quote(node.boundary)}) NIL NIL NIL)`;
  }
  const disposition = node.disposition
    ? `(${quote(node.disposition.type)} ${paramList(node.disposition.params)})`
    : "NIL";
  const size = Buffer.byteLength(node.body);
  const lines = node.type.toLowerCase() === "text" ? ` ${node.body.split("\r\n").length}` : "";
  return `(${quote(node.type.toUpperCase())} ${quote(node.subtype.toUpperCase())} ${paramList(node.params)} ${quote(node.id)} NIL ${quote(node.encoding)} ${size}${lines} NIL ${disposition} NIL NIL)`;
}

/** Maps IMAP section names ("1.2", "1.2.MIME", "TEXT", "HEADER", "") to bytes. */
function sections(message: FakeMessage) {
  const topHeaders = [
    `Message-ID: ${message.messageId}`,
    `Date: ${message.date}`,
    `From: "${message.from.name}" <${message.from.mailbox}@${message.from.host}>`,
    `To: <${message.to.mailbox}@${message.to.host}>`,
    `Subject: ${message.subject}`,
    "MIME-Version: 1.0",
    nodeHeaders(message.root),
  ].join("\r\n");
  const map = new Map<string, string>();
  map.set("HEADER", `${topHeaders}\r\n\r\n`);
  map.set("TEXT", nodeBody(message.root));
  map.set("", `${topHeaders}\r\n\r\n${nodeBody(message.root)}`);

  const visit = (node: MimeNode, path: string) => {
    if (isMultipart(node)) {
      node.children.forEach((child, index) =>
        visit(child, path ? `${path}.${index + 1}` : `${index + 1}`),
      );
    } else {
      map.set(path, node.body);
    }
    if (path) map.set(`${path}.MIME`, `${nodeHeaders(node)}\r\n\r\n`);
  };
  if (isMultipart(message.root)) visit(message.root, "");
  else map.set("1", message.root.body);
  return map;
}

function envelope(message: FakeMessage) {
  const from = `((${quote(message.from.name)} NIL ${quote(message.from.mailbox)} ${quote(message.from.host)}))`;
  const to = `((NIL NIL ${quote(message.to.mailbox)} ${quote(message.to.host)}))`;
  return `(${quote(message.date)} ${quote(message.subject)} ${from} ${from} ${from} ${to} NIL NIL NIL ${quote(message.messageId)})`;
}

export interface FakeImapServer {
  port: number;
  /** Every command line received, without tags. */
  commands: string[];
  /** Section names served for BODY[...] fetches, e.g. "1.2". */
  sectionsServed: string[];
  /** Peak number of sessions between LOGIN and LOGOUT. */
  maxConcurrentSessions: number;
  close(): Promise<void>;
}

export async function startFakeImapServer(
  mailboxes: Record<string, FakeMessage[]>,
  options: { responseDelayMs?: number } = {},
): Promise<FakeImapServer> {
  const sockets = new Set<Socket>();
  let open = 0;
  const state: Omit<FakeImapServer, "port" | "close"> = {
    commands: [],
    sectionsServed: [],
    maxConcurrentSessions: 0,
  };
  const delay = () =>
    new Promise<void>((resolve) => setTimeout(resolve, options.responseDelayMs ?? 0));

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let loggedIn = false;
    const endSession = () => {
      if (loggedIn) open -= 1;
      loggedIn = false;
    };
    socket.on("close", () => {
      sockets.delete(socket);
      endSession();
    });
    socket.on("error", () => undefined);

    let selected: FakeMessage[] = [];
    let buffer = Buffer.alloc(0);
    let pendingLine = "";
    let literalBytes = 0;
    let queue = Promise.resolve();

    const write = (text: string) => {
      if (!socket.destroyed) socket.write(text);
    };

    const handle = async (line: string) => {
      const match = /^(\S+) (\S+)(?: (.*))?$/s.exec(line);
      if (!match) return;
      const [, tag, rawCommand, rawArgs = ""] = match;
      let command = rawCommand.toUpperCase();
      let args = rawArgs;
      let uidMode = false;
      if (command === "UID") {
        uidMode = true;
        const split = /^(\S+) ?(.*)$/s.exec(args);
        command = (split?.[1] ?? "").toUpperCase();
        args = split?.[2] ?? "";
      }
      state.commands.push(`${uidMode ? "UID " : ""}${command} ${args}`.trim());
      await delay();

      switch (command) {
        case "CAPABILITY":
          write("* CAPABILITY IMAP4rev1\r\n");
          return write(`${tag} OK done\r\n`);
        case "LOGIN":
          loggedIn = true;
          open += 1;
          state.maxConcurrentSessions = Math.max(state.maxConcurrentSessions, open);
          return write(`${tag} OK [CAPABILITY IMAP4rev1] logged in\r\n`);
        case "LOGOUT":
          endSession();
          write("* BYE bye\r\n");
          write(`${tag} OK bye\r\n`);
          socket.end();
          return;
        case "LIST":
        case "LSUB": {
          const pattern = /"([^"]*)"\s*$/.exec(args)?.[1] ?? "";
          if (pattern === "") {
            // Delimiter discovery: the root has no name.
            write(`* ${command} (\\Noselect) "/" ""\r\n`);
          } else {
            const matcher = new RegExp(
              `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[*%]/g, ".*")}$`,
            );
            for (const name of Object.keys(mailboxes).filter((name) => matcher.test(name))) {
              write(`* ${command} () "/" ${quote(name)}\r\n`);
            }
          }
          return write(`${tag} OK done\r\n`);
        }
        case "SELECT":
        case "EXAMINE": {
          const name = args.replace(/^"|"$/g, "");
          selected = mailboxes[name] ?? [];
          write("* FLAGS (\\Seen \\Flagged \\Deleted \\Draft \\Answered)\r\n");
          write(`* ${selected.length} EXISTS\r\n`);
          write("* OK [UIDVALIDITY 7] ok\r\n");
          write(`* OK [UIDNEXT ${Math.max(0, ...selected.map((m) => m.uid)) + 1}] ok\r\n`);
          const mode = command === "EXAMINE" ? "READ-ONLY" : "READ-WRITE";
          return write(`${tag} OK [${mode}] selected\r\n`);
        }
        case "SEARCH": {
          const hits = selected.filter((message) =>
            /HEADER/i.test(args) ? args.includes(message.messageId.replace(/^<|>$/g, "")) : true,
          );
          write(`* SEARCH${hits.map((message) => ` ${message.uid}`).join("")}\r\n`);
          return write(`${tag} OK done\r\n`);
        }
        case "STORE": {
          for (const message of selected) message.flags.add("\\Seen");
          return write(`${tag} OK stored\r\n`);
        }
        case "FETCH": {
          const [range = "", ...rest] = args.split(" ");
          const items = rest.join(" ");
          const index = selected.findIndex((message) =>
            uidMode
              ? String(message.uid) === range
              : String(selected.indexOf(message) + 1) === range,
          );
          const message = selected[index];
          if (message) {
            const marksSeen = /BODY\[/i.test(items) || /\bRFC822(?!\.SIZE|\.HEADER)\b/i.test(items);
            if (marksSeen) message.flags.add("\\Seen");

            const parts: string[] = [`UID ${message.uid}`];
            const literal = (key: string, value: string) =>
              `${key} {${Buffer.byteLength(value)}}\r\n${value}`;
            if (/\bFLAGS\b/i.test(items)) parts.push(`FLAGS (${[...message.flags].join(" ")})`);
            const content = sections(message);
            if (/RFC822\.SIZE/i.test(items))
              parts.push(`RFC822.SIZE ${Buffer.byteLength(content.get("") ?? "")}`);
            if (/INTERNALDATE/i.test(items))
              parts.push(`INTERNALDATE "27-Oct-2026 10:00:00 +0800"`);
            if (/ENVELOPE/i.test(items)) parts.push(`ENVELOPE ${envelope(message)}`);
            if (/BODYSTRUCTURE/i.test(items))
              parts.push(`BODYSTRUCTURE ${bodyStructure(message.root)}`);
            for (const section of items.matchAll(
              /BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/gi,
            )) {
              const name = section[1].toUpperCase();
              state.sectionsServed.push(name);
              const whole = content.get(name) ?? "";
              const start = section[2] === undefined ? undefined : Number(section[2]);
              const value =
                start === undefined ? whole : whole.slice(start, start + Number(section[3]));
              parts.push(literal(`BODY[${name}]${start === undefined ? "" : `<${start}>`}`, value));
            }
            write(`* ${index + 1} FETCH (${parts.join(" ")})\r\n`);
          }
          return write(`${tag} OK fetched\r\n`);
        }
        default:
          return write(`${tag} OK ${command.toLowerCase()} done\r\n`);
      }
    };

    socket.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, Buffer.from(data)]);
      while (buffer.length > 0) {
        if (literalBytes > 0) {
          if (buffer.length < literalBytes) return;
          pendingLine += buffer.subarray(0, literalBytes).toString("utf8");
          buffer = buffer.subarray(literalBytes);
          literalBytes = 0;
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end === -1) return;
        const line = pendingLine + buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 2);
        const literal = /\{(\d+)\}$/.exec(line);
        if (literal) {
          pendingLine = line.slice(0, literal.index);
          literalBytes = Number(literal[1]);
          write("+ go ahead\r\n");
          continue;
        }
        pendingLine = "";
        queue = queue.then(() => handle(line));
      }
    });

    write("* OK [CAPABILITY IMAP4rev1] fake bridge ready\r\n");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    get commands() {
      return state.commands;
    },
    get sectionsServed() {
      return state.sectionsServed;
    },
    get maxConcurrentSessions() {
      return state.maxConcurrentSessions;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
