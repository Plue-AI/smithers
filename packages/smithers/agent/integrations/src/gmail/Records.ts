/**
 * Gmail messages as provenance-carrying source records.
 *
 * A message becomes one `SourceRecord` of kind `message`, scoped `private` to
 * its mailbox: mail is one person's data, whatever it says. Its text is the
 * sender, the subject and Google's snippet, which is what retrieval needs to
 * find a message without keeping bodies; the payload keeps a bounded subset
 * of the message (ids, labels, a few headers, the snippet), never its MIME
 * tree. A deleted, trashed or spam message, or one that left the synced
 * label, becomes a tombstone.
 *
 * `version` is the message's history id, zero-padded to twenty digits so that
 * comparing two versions as strings orders them the way the mailbox does.
 * Messages have no public link, so `url` is `null`.
 *
 * @since 1.0.0
 */
import type { SourceRecord } from "../core/SourceRecord.ts"
import type { Message, MessagePart } from "./GmailClient.ts"

/**
 * The record provider name.
 *
 * @category constants
 * @since 1.0.0
 */
export const PROVIDER = "gmail"

/**
 * The record kind.
 *
 * @category constants
 * @since 1.0.0
 */
export const KIND = "message"

/**
 * The headers a record keeps, and a sync reads in `metadata` format.
 *
 * @category constants
 * @since 1.0.0
 */
export const HEADERS: ReadonlyArray<string> = ["From", "To", "Cc", "Subject", "Date", "Message-ID"]

/**
 * Where a record came from.
 *
 * @category models
 * @since 1.0.0
 */
export interface Context {
  readonly connectionId: string
  /** The mailbox container the records belong to. */
  readonly container: string
  readonly retrievedAtMs: number
}

/**
 * A history id as a record version: zero-padded to twenty digits.
 *
 * @category conversions
 * @since 1.0.0
 */
export const version = (historyId: string | undefined): string | null =>
  historyId === undefined ? null : historyId.padStart(20, "0")

/**
 * The first value of header `name`, matched without regard to case.
 *
 * @category getters
 * @since 1.0.0
 */
export const header = (message: Message, name: string): string | undefined => {
  const wanted = name.toLowerCase()
  return message.payload?.headers?.find((entry) => entry.name.toLowerCase() === wanted)?.value
}

/**
 * The address and display name in a `From` value such as
 * `"Ada" <ada@example.test>` or `ada@example.test`, or `null` when it has no
 * address.
 *
 * @category conversions
 * @since 1.0.0
 */
export const parseMailbox = (value: string): { readonly address: string; readonly name: string | null } | null => {
  const angle = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value)
  if (angle !== null) {
    const name = angle[1]!.replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim()
    return { address: angle[2]!.toLowerCase(), name: name.length === 0 ? null : name }
  }
  const bare = /^\s*([^<>\s]+@[^<>\s]+)\s*$/.exec(value)
  return bare === null ? null : { address: bare[1]!.toLowerCase(), name: null }
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }

/**
 * Google's snippet with its HTML character references decoded.
 *
 * @category conversions
 * @since 1.0.0
 */
export const decodeSnippet = (snippet: string): string =>
  snippet.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]+);/g, (entity, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity
    }
    return ENTITIES[body] ?? entity
  })

/**
 * The first `text/plain` body in a `full` message, decoded, or `null` when it
 * has none inline.
 *
 * @category getters
 * @since 1.0.0
 */
export const bodyText = (message: Message): string | null => {
  const visit = (part: MessagePart): string | null => {
    if (part.mimeType === "text/plain" && part.body?.data !== undefined) {
      return Buffer.from(part.body.data, "base64url").toString("utf8")
    }
    for (const child of part.parts ?? []) {
      const found = visit(child)
      if (found !== null) return found
    }
    return null
  }
  return message.payload === undefined ? null : visit(message.payload)
}

/**
 * Whether a message no longer belongs in a mirror of the mailbox (or of
 * `labelId`): it is in the trash or spam, or it lost the label.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isGone = (message: Message, labelId?: string): boolean => {
  const labels = message.labelIds ?? []
  return labels.includes("TRASH") || labels.includes("SPAM") ||
    (labelId !== undefined && !labels.includes(labelId))
}

/**
 * A message as a record.
 *
 * @category conversions
 * @since 1.0.0
 */
export const fromMessage = (message: Message, context: Context): SourceRecord => {
  const from = header(message, "From")
  const subject = header(message, "Subject")
  const snippet = decodeSnippet(message.snippet ?? "")
  const sender = from === undefined ? null : parseMailbox(from)
  const received = Number(message.internalDate)
  const at = message.internalDate !== undefined && Number.isFinite(received) ? received : null
  return {
    provider: PROVIDER,
    connectionId: context.connectionId,
    externalId: message.id,
    kind: KIND,
    url: null,
    author: sender === null ? null : { id: sender.address, label: sender.name },
    createdAtMs: at,
    // Gmail has no change time: internalDate is when the message arrived. The
    // history id orders every copy, deletions and restorations included.
    updatedAtMs: null,
    version: version(message.historyId),
    retrievedAtMs: context.retrievedAtMs,
    access: { scope: "private", containerId: context.container },
    thread: { containerId: context.container, threadId: message.threadId, parentId: null },
    text: [`From: ${from ?? ""}`, `Subject: ${subject ?? ""}`, "", snippet].join("\n"),
    deleted: false,
    payload: {
      id: message.id,
      threadId: message.threadId,
      labelIds: [...(message.labelIds ?? [])],
      snippet: message.snippet ?? "",
      historyId: message.historyId ?? null,
      internalDate: message.internalDate ?? null,
      headers: Object.fromEntries(HEADERS.map((name) => [name, header(message, name) ?? null]))
    }
  }
}

/**
 * A tombstone for a message that is gone.
 *
 * @category constructors
 * @since 1.0.0
 */
export const tombstone = (
  message: { readonly id: string; readonly threadId?: string | undefined },
  historyId: string | undefined,
  context: Context
): SourceRecord => ({
  provider: PROVIDER,
  connectionId: context.connectionId,
  externalId: message.id,
  kind: KIND,
  url: null,
  author: null,
  createdAtMs: null,
  updatedAtMs: null,
  version: version(historyId),
  retrievedAtMs: context.retrievedAtMs,
  access: { scope: "private", containerId: context.container },
  thread: { containerId: context.container, threadId: message.threadId ?? null, parentId: null },
  text: "",
  deleted: true,
  payload: null
})
