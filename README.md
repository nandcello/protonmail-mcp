# Proton Mail MCP

An unofficial, local [Model Context Protocol](https://modelcontextprotocol.io/)
server for [Proton Mail Bridge](https://proton.me/mail/bridge). It lets an MCP
client list, search, and read mail over Bridge's local IMAP server and send mail
from a Proton address or alias over Bridge's local SMTP server.

The server uses Bun at runtime and Vite+ for formatting, linting, type checking,
testing, and packaging.

## Tools

| Tool                             | Purpose                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| `connection_status`              | Check configuration plus IMAP and SMTP authentication           |
| `list_sender_aliases`            | Show the sender identities configured for this MCP              |
| `create_inbox_subscription`      | Explicitly opt a consumer into filtered inbox events            |
| `list_inbox_subscriptions`       | List persistent notification subscriptions                      |
| `update_inbox_subscription`      | Change a subscription's consumer or filters                     |
| `set_inbox_subscription_enabled` | Pause or resume a subscription                                  |
| `delete_inbox_subscription`      | Permanently delete a subscription                               |
| `list_mailboxes`                 | List folders and their message/unread counts                    |
| `list_emails`                    | List recent message metadata without changing read state        |
| `search_emails`                  | Search one mailbox by text, sender, recipient, subject, or date |
| `read_email`                     | Read a message by mailbox and UID without changing read state   |
| `read_email_full`                | Read one whole message by UID or Message-ID, read-only          |
| `get_email_attachment`           | Read one attachment as text, images, or byte chunks, read-only  |
| `move_email`                     | Move a message by mailbox and UID to another existing mailbox   |
| `send_email`                     | Send a confirmed message from a Proton address or alias         |

`send_email` requires `confirmed: true`. The MCP instructions tell clients to
show the exact sender, recipients, subject, and body and obtain explicit user
approval first.

`move_email` moves one message (`mailbox`, default `INBOX`, plus `uid`) to a
`destination` that already exists when the call is made: `INBOX`, `Archive`,
`Trash`, or a user `Folders/...` or `Labels/...` mailbox. Any other destination,
or one equal to the source, is refused, and mailboxes are never created. It uses
IMAP `UID MOVE`; if Bridge lacks `MOVE` it falls back to `UID COPY` plus a
`UID EXPUNGE` of that single UID, and refuses outright when `UIDPLUS` is also
missing rather than risk a mailbox-wide `EXPUNGE`. Nothing is ever permanently
deleted: moving to Trash is allowed because Proton keeps the message there, and
the fallback refuses to expunge from Trash. The result is
`{ moved, from, to, uid, newUid? }`, where `newUid` is the message's UID in the
destination when Bridge reports it.

### Reading full messages and attachments

`read_email_full` takes `mailbox` plus `uid`, or a `messageId` (searched in
`All Mail` unless `mailbox` is given). It returns from/to/cc/date/subject, the
plain-text body (or the HTML body converted to text when there is no plain
part), and every attachment as `{ id, filename, contentType, size, encodedSize,
inline, contentId }`. The `id` is the IMAP MIME part path (for example `2` or
`1.2`), which is stable for that message. Only the body text parts are
downloaded; inline images and `data:`/base64 blobs become placeholders such as
`[inline image: image.png, 99 KB]`. `maxCharacters` (default 50,000, max
200,000) caps the body, and a truncated body ends with
`[truncated: showing N of M characters]`.

```json
{ "mailbox": "All Mail", "uid": 1350 }
```

`get_email_attachment` takes the same locator plus `attachmentId`. It extracts
text from PDFs (via `unpdf`), text, HTML, and attached emails, with the same
`maxCharacters` cap and notice. Other types return `text: null` and a note.
`saveToFile: true` also writes the raw file (mode 0600) into
`PROTON_ATTACHMENT_DIR`; without that absolute directory configured, saving is
refused.

```json
{ "mailbox": "All Mail", "uid": 1350, "attachmentId": "2" }
```

Images and scanned PDFs:

- PNG, JPEG, GIF, and WebP attachments are also returned as MCP `image`
  content after the JSON metadata. An image over `maxImageBytes` (default and
  ceiling `PROTON_MAX_IMAGE_BYTES`, 5 MiB) is downscaled and re-encoded as JPEG
  if it is PNG or JPEG, and refused with its name, size, and the limit if it is
  GIF or WebP. Other image types (SVG, TIFF, ...) are never returned as images.
- `renderPages: true` renders the first `maxPages` (default 5, at most 10) PDF
  pages as JPEG `image` content at about 150 DPI and at most 1600 px wide, each
  fitted to `maxImageBytes`; `page: N` renders one page. One call returns at
  most 10 MiB of page images. Skipped and unrequested pages are listed in
  `renderedPages` and the `note`. Rendering uses PDFium compiled to
  WebAssembly, so untrusted PDFs never reach native code.

```json
{ "mailbox": "All Mail", "uid": 1350, "attachmentId": "1.2" }
{ "mailbox": "All Mail", "uid": 1350, "attachmentId": "2", "renderPages": true }
```

Chunk mode is for callers that can only pass small JSON values along, such as
an Executor `execute` program with a 64 KB output cap. Passing `byteOffset`
and/or `byteLength` (default 40,000 bytes, about 53 KB of base64) returns no
text or image content, only a `chunk`:

```json
{
  "source": "page",
  "page": 1,
  "mimeType": "image/jpeg",
  "offset": 0,
  "length": 40000,
  "totalBytes": 47424,
  "sha256": "<hash of all 47424 bytes>",
  "done": false,
  "nextOffset": 40000,
  "base64": "..."
}
```

The chunked bytes are one rendered page when `page` is set, the downscaled
image when `maxImageBytes` is set on an image, and otherwise the raw
attachment. Rendering and encoding are deterministic, so repeat the call with
`byteOffset: nextOffset` until `done`, concatenate, and compare the SHA-256.
For a single-call image, ask for `maxImageBytes: 40000, byteOffset: 0`.

Both tools open the mailbox with `EXAMINE` and fetch only with `BODY.PEEK`, so
they never set `\Seen`; they never send, move, delete, or flag mail. Attachments
larger than `PROTON_MAX_MESSAGE_BYTES` are refused. Decoding and rendering
happen after the IMAP session is released.

### Concurrent requests

Every tool call opens its own IMAP session. All sessions in one process share a
FIFO gate of `PROTON_IMAP_MAX_CONNECTIONS` (default 3) concurrent Bridge
sessions; extra calls wait up to `PROTON_IMAP_QUEUE_TIMEOUT_MS` (default 45 s)
and then fail with a clear "Proton Bridge is busy" error. A failed connect is
retried twice with exponential backoff, except authentication failures. Only
the connect step is retried, so a retry never repeats a move.

### Inbox notification subscriptions

Subscriptions are persistent configuration for a future IMAP inbox watcher.
This MCP does not start that watcher or deliver events itself. It also never
creates a subscription automatically: a new installation has no subscriptions,
so notifications are off.

`create_inbox_subscription` requires:

- a `consumer_id` listed in the comma-separated `PROTON_INBOX_CONSUMERS`
  setting;
- a retry-stable `idempotency_key`; and
- at least one `include` filter rule, or the explicit
  `all_inbox_mail: true` opt-in.

An exclusion-only subscription is rejected because it would otherwise imply
opting into almost all mail. A filter rule supports `sender`, `recipient`,
`subject`, and `mailbox` arrays. Values within one field are alternatives;
different populated fields in one rule are combined. Sender, recipient, and
subject matching is case-insensitive substring matching. Mailbox/folder matching
is case-insensitive equality. Include rules are alternatives, and any matching
exclude rule wins. Paused subscriptions never match.

For example, this subscribes a configured desktop consumer to urgent build mail
while filtering expected failures:

```json
{
  "idempotency_key": "desktop-build-alerts-v1",
  "consumer_id": "desktop-notifier",
  "filter_rules": [
    {
      "action": "include",
      "sender": ["builds@example.com"],
      "subject": ["failed"],
      "mailbox": ["INBOX"]
    },
    {
      "action": "exclude",
      "subject": ["expected failure"]
    }
  ]
}
```

Creation retries with the same key and normalized request return the original
subscription instead of creating a duplicate. Keys stay reserved after deletion
so a late retry cannot recreate a deleted subscription. Updates, pause/resume,
and deletion accept `expected_revision` for optimistic concurrency. Repeating a
no-op update does not increment the revision, and repeating deletion returns
`deleted: false`. Rule and matcher order do not affect request identity.

By default, subscription state is stored at
`$XDG_DATA_HOME/protonmail-mcp/inbox-subscriptions.json`, falling back to
`~/.local/share/protonmail-mcp/inbox-subscriptions.json`. Override it with
`PROTON_INBOX_SUBSCRIPTIONS_FILE`; both overrides must be absolute paths.
Mutations hold a cross-process lock for the complete read-modify-write
transaction, then use a same-directory temporary file and atomic rename so
concurrent MCP instances cannot lose updates and a watcher cannot observe a
partially written document.

## Prerequisites

- Bun
- Vite+ (`vp`)
- A paid Proton Mail plan with Proton Mail Bridge
- Proton Mail Bridge signed in and running

In Proton Mail Bridge, open the account's **Mailbox details** and copy the IMAP/
SMTP username and password. The password is generated by Bridge; do not use your
normal Proton account password.

## Setup

Install dependencies:

```bash
vp install
```

Create local configuration:

```bash
cp .env.example .env
```

At minimum, fill in:

```dotenv
PROTON_BRIDGE_USERNAME=the-username-shown-by-bridge
PROTON_BRIDGE_PASSWORD=the-password-shown-by-bridge
PROTON_DEFAULT_FROM=you@proton.me
PROTON_ALLOWED_SENDERS=you@proton.me,your-alias@example.com
```

Bun automatically reads `.env` when it starts the server. `.env` is ignored by
Git.

The defaults match Proton Mail Bridge on this machine:

```dotenv
PROTON_BRIDGE_HOST=127.0.0.1
PROTON_BRIDGE_IMAP_PORT=1143
PROTON_BRIDGE_SMTP_PORT=1025
PROTON_BRIDGE_SECURITY=starttls
```

If you changed ports or connection mode in Bridge, update them here too.

Configure the opaque IDs that subscriptions may target:

```dotenv
PROTON_INBOX_CONSUMERS=desktop-notifier,build-alerts
```

To put persistent inbox subscription state somewhere else, configure an
absolute path:

```dotenv
PROTON_INBOX_SUBSCRIPTIONS_FILE=/absolute/path/to/inbox-subscriptions.json
```

### TLS certificate

Bridge normally uses a self-signed certificate for its loopback-only IMAP and
SMTP services, so the example disables certificate verification while also
refusing any non-loopback host. For strict verification, export Bridge's
certificate and configure:

```dotenv
PROTON_BRIDGE_CA_FILE=/absolute/path/to/bridge-certificate.pem
PROTON_BRIDGE_TLS_REJECT_UNAUTHORIZED=true
```

## Connect an MCP client

Build the server:

```bash
bun run build
```

Use an absolute command and project path in the MCP client's configuration. A
typical stdio configuration looks like:

```json
{
  "mcpServers": {
    "protonmail": {
      "command": "/Users/you/.bun/bin/bun",
      "args": ["run", "/absolute/path/to/protonmail-mcp/src/index.ts"],
      "env": {
        "PROTON_BRIDGE_USERNAME": "the-username-shown-by-bridge",
        "PROTON_BRIDGE_PASSWORD": "the-password-shown-by-bridge",
        "PROTON_DEFAULT_FROM": "you@proton.me",
        "PROTON_ALLOWED_SENDERS": "you@proton.me,your-alias@example.com",
        "PROTON_INBOX_CONSUMERS": "desktop-notifier"
      }
    }
  }
}
```

Passing secrets through the client's environment is preferable when the client
has secure environment-variable storage. If the client preserves the project
working directory, the local `.env` file is also sufficient.

Start with `connection_status`, then `list_mailboxes`. A UID is only meaningful
inside its mailbox, so pass both values from `list_emails` or `search_emails`
into `read_email`.

## Development

```bash
bun run check
bun run test
bun run build
```

To exercise the server interactively with the MCP Inspector:

```bash
bun run inspect
```

The server writes protocol messages only to stdout. Runtime diagnostics go to
stderr so they do not corrupt the stdio MCP connection.

## Security notes

- Bridge listens only on the local loopback interface; keep this MCP local too.
- Mail bodies are untrusted input. The server instructs clients not to follow
  commands found inside messages.
- `read_email` only returns attachment names, MIME types, and sizes.
  Attachment contents are only returned by `get_email_attachment`, as extracted
  text capped by `maxCharacters`, and only written to disk when
  `PROTON_ATTACHMENT_DIR` is configured.
- Messages larger than `PROTON_MAX_MESSAGE_BYTES` are refused before parsing.
- When `PROTON_ALLOWED_SENDERS` is populated, `send_email` rejects any other
  `from` address. Proton Bridge performs its own sender validation as well.
- Searching is scoped to one mailbox because IMAP search operates on the
  selected mailbox. Search multiple mailboxes separately when needed.
- Inbox notifications remain disabled until a subscription is explicitly
  created and enabled. `all_inbox_mail: true` is the only filter-free opt-in.
- Subscription consumers must be opaque identifiers configured in
  `PROTON_INBOX_CONSUMERS`, not arbitrary callback URLs. The persistence file
  contains filters and identifiers but no Proton Bridge credentials.
