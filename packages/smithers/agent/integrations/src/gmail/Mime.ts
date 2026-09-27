/**
 * RFC 2822 message composition for Gmail's `raw` field.
 *
 * A header is a line, and a header value that carries a CR or LF ends that
 * line and starts another: a subject of `"hi\r\nBcc: someone"` adds a
 * recipient nobody approved. So nothing here escapes a control character; it
 * refuses one. Addresses must be plain `local@domain` forms, display names and
 * the subject may hold any text except control characters, and message ids
 * and the reconciliation key have fixed shapes. The same schemas decode an
 * action's payload, so a bad value is refused before a durable step records
 * it, and {@link compose} checks again for a caller that builds a message
 * directly.
 *
 * Non-ASCII text in a header is written as RFC 2047 encoded words on folded
 * lines of at most 76 characters, never splitting a character, and the body is
 * `text/plain; charset=UTF-8` in base64 with CRLF line ends, so no body line
 * can be read as a header or a boundary.
 *
 * Every message carries `X-Smithers-Key` and a `Message-ID` derived from the
 * same key. A send whose answer was lost is reconciled by searching the
 * mailbox for that Message-ID (`rfc822msgid:`) and comparing the key header.
 *
 * @since 1.0.0
 */

import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { IntegrationError } from "../core/IntegrationError.ts"

// Every C0 control except tab, and DEL: the characters that could end or fold
// a header line. A code-point scan keeps control characters out of a regex.
const hasControl = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true
  }
  return false
}

const noControl = Schema.makeFilter<string>((value) =>
  !hasControl(value) || "must not contain control characters such as CR or LF"
)

/**
 * Header text: a subject or a display name. Any characters except C0 controls
 * (tab excepted) and DEL.
 *
 * @category schemas
 * @since 1.0.0
 */
export const HeaderText = Schema.String.check(noControl, Schema.isMaxLength(2000))

/**
 * A plain `local@domain` address: a dot-atom local part and a DNS host name.
 * Quoted local parts, address literals and non-ASCII domains (use the
 * punycode form) are refused.
 *
 * @category schemas
 * @since 1.0.0
 */
export const EmailAddress = Schema.String.check(
  Schema.isPattern(
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
  ),
  Schema.isMaxLength(254)
)

/**
 * A mailbox: an address and an optional display name.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Address = Schema.Struct({
  address: EmailAddress,
  name: Schema.optionalKey(HeaderText.check(Schema.isMaxLength(200)))
})

/**
 * A mailbox.
 *
 * @category models
 * @since 1.0.0
 */
export type Address = typeof Address.Type

/**
 * An RFC 2822 message id, angle brackets included.
 *
 * @category schemas
 * @since 1.0.0
 */
export const MessageId = Schema.String.check(
  Schema.isPattern(/^<[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+>$/),
  Schema.isMaxLength(250)
)

/**
 * The caller's identity for one write, carried in `X-Smithers-Key`. Distinct
 * writes need distinct keys.
 *
 * @category schemas
 * @since 1.0.0
 */
export const SmithersKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,199}$/))

/**
 * The header that carries the key.
 *
 * @category constants
 * @since 1.0.0
 */
export const KEY_HEADER = "X-Smithers-Key"

/**
 * The domain half of every derived Message-ID. `.invalid` is reserved, so it
 * cannot collide with a real host's ids.
 *
 * @category constants
 * @since 1.0.0
 */
export const MESSAGE_ID_DOMAIN = "smithers.invalid"

/**
 * The largest body this package sends, in UTF-8 bytes. A package bound, not a
 * Gmail limit.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_TEXT_BYTES = 1_048_576

/**
 * What a message says.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Draft = Schema.Struct({
  key: SmithersKey,
  from: Schema.optionalKey(Address),
  to: Schema.Array(Address).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  cc: Schema.optionalKey(Schema.Array(Address).check(Schema.isMaxLength(100))),
  bcc: Schema.optionalKey(Schema.Array(Address).check(Schema.isMaxLength(100))),
  subject: HeaderText,
  text: Schema.String,
  inReplyTo: Schema.optionalKey(MessageId),
  references: Schema.optionalKey(Schema.Array(MessageId).check(Schema.isMaxLength(100)))
})

/**
 * What a message says.
 *
 * @category models
 * @since 1.0.0
 */
export type Draft = typeof Draft.Type

/**
 * A composed message.
 *
 * @category models
 * @since 1.0.0
 */
export interface Composed {
  /** The RFC 2822 text, CRLF line ends. */
  readonly raw: string
  /** The Message-ID header value, derived from the key. */
  readonly messageId: string
  readonly key: string
}

/**
 * The Message-ID a key always produces.
 *
 * @category constructors
 * @since 1.0.0
 */
export const messageIdFor = (key: string): string =>
  `<smithers.${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 40)}@${MESSAGE_ID_DOMAIN}>`

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const pad = (value: number): string => String(value).padStart(2, "0")

/**
 * An RFC 2822 date in UTC: `Fri, 25 Sep 2026 22:00:00 +0000`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const formatDate = (epochMs: number): string => {
  const date = new Date(epochMs)
  return `${WEEKDAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${
    MONTHS[date.getUTCMonth()]
  } ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
}

/**
 * RFC 2047 `B` encoded words for `text`, each at most 60 characters, never
 * splitting a character. Empty text has none.
 *
 * @category constructors
 * @since 1.0.0
 */
export const encodedWords = (text: string): ReadonlyArray<string> => {
  const words: Array<string> = []
  let chunk: Array<Buffer> = []
  let size = 0
  const flush = () => {
    words.push(`=?UTF-8?B?${Buffer.concat(chunk).toString("base64")}?=`)
    chunk = []
    size = 0
  }
  for (const character of text) {
    const bytes = Buffer.from(character, "utf8")
    // 36 bytes are 48 base64 characters, and 48 plus the 12 of `=?UTF-8?B?`
    // and `?=` is 60: inside the 75 a word may use, and short enough that
    // `Subject: ` and a word stay inside the 76 a line holding one may use.
    if (size + bytes.length > 36) flush()
    chunk.push(bytes)
    size += bytes.length
  }
  if (size > 0) flush()
  return words
}

const PRINTABLE = /^[ -~]*$/

// Plain ASCII passes through; anything else, or ASCII that a reader would take
// for an encoded word, becomes encoded words folded onto continuation lines.
const headerText = (text: string, limit: number): string =>
  PRINTABLE.test(text) && !text.includes("=?") && text.length <= limit
    ? text
    : encodedWords(text).join("\r\n ")

// An encoded name puts the address on a continuation line of its own, so no
// line holding an encoded word also holds an address of unbounded length.
const mailbox = (address: Address): string => {
  const name = address.name
  if (name === undefined || name.length === 0) return address.address
  return PRINTABLE.test(name) && !name.includes("=?")
    ? `"${name.replace(/[\\"]/g, "\\$&")}" <${address.address}>`
    : `${encodedWords(name).join("\r\n ")}\r\n <${address.address}>`
}

const addressList = (addresses: ReadonlyArray<Address>): string => addresses.map(mailbox).join(",\r\n ")

const refused = (message: string): IntegrationError =>
  new IntegrationError("invalid-config", `Gmail message refused: ${message}`, { retryable: false })

const decodeDraft = Schema.decodeUnknownEffect(Draft)

/**
 * Composes `draft` into RFC 2822 text dated `dateMs`.
 *
 * Fails `invalid-config`, before anything is sent, for a control character in
 * a header value, an address or message id outside its shape, a missing
 * recipient, or a body over {@link MAX_TEXT_BYTES}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const compose = (draft: Draft, dateMs: number): Effect.Effect<Composed, IntegrationError> =>
  decodeDraft(draft).pipe(
    Effect.mapError((error) => refused(error.message.slice(0, 400))),
    Effect.flatMap((valid) => {
      const body = Buffer.from(valid.text.replace(/\r\n|\r|\n/g, "\r\n"), "utf8")
      if (body.length > MAX_TEXT_BYTES) {
        return Effect.fail(refused(`the body is ${body.length} bytes; the limit is ${MAX_TEXT_BYTES}.`))
      }
      const messageId = messageIdFor(valid.key)
      const headers = [
        "MIME-Version: 1.0",
        `Date: ${formatDate(dateMs)}`,
        `Message-ID: ${messageId}`,
        ...(valid.from === undefined ? [] : [`From: ${mailbox(valid.from)}`]),
        `To: ${addressList(valid.to)}`,
        ...(valid.cc === undefined || valid.cc.length === 0 ? [] : [`Cc: ${addressList(valid.cc)}`]),
        ...(valid.bcc === undefined || valid.bcc.length === 0 ? [] : [`Bcc: ${addressList(valid.bcc)}`]),
        `Subject: ${headerText(valid.subject, 900)}`,
        ...(valid.inReplyTo === undefined ? [] : [`In-Reply-To: ${valid.inReplyTo}`]),
        ...(valid.references === undefined || valid.references.length === 0
          ? []
          : [`References: ${valid.references.join("\r\n ")}`]),
        `${KEY_HEADER}: ${valid.key}`,
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64"
      ]
      const encoded = body.toString("base64").match(/.{1,76}/g) ?? []
      return Effect.succeed({
        raw: `${headers.join("\r\n")}\r\n\r\n${encoded.join("\r\n")}\r\n`,
        messageId,
        key: valid.key
      })
    })
  )
