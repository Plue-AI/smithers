/**
 * RFC 2822 composition and record mapping for Gmail.
 *
 * Composition is pure, so these cases read the exact text a send would carry
 * and parse it back: header lines, folding, encoded words and the base64 body.
 * The injection cases are the reason the module exists: a CR or LF in any
 * header value must be refused, never escaped into a second header.
 */
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { IntegrationError } from "../src/core/IntegrationError.ts"
import * as SourceRecord from "../src/core/SourceRecord.ts"
import type { Message } from "../src/gmail/GmailClient.ts"
import {
  compose,
  type Draft,
  encodedWords,
  formatDate,
  KEY_HEADER,
  MAX_TEXT_BYTES,
  MESSAGE_ID_DOMAIN,
  messageIdFor
} from "../src/gmail/Mime.ts"
import * as Records from "../src/gmail/Records.ts"

const DATE = Date.UTC(2026, 8, 25, 22, 5, 9)

const draft = (extra: Partial<Draft> = {}): Draft => ({
  key: "assistant/reply-1",
  to: [{ address: "ada@example.test", name: "Ada Lovelace" }],
  subject: "Status",
  text: "Line one\nLine two",
  ...extra
})

const composed = (extra: Partial<Draft> = {}) => Effect.runPromise(compose(draft(extra), DATE))

const refused = (extra: Record<string, unknown>): Promise<IntegrationError> =>
  Effect.runPromise(Effect.flip(compose({ ...draft(), ...extra } as Draft, DATE)))

/** Splits raw text into unfolded headers and the decoded body. */
const parse = (raw: string) => {
  const [head, body] = raw.split("\r\n\r\n") as [string, string]
  const headers = new Map<string, string>()
  for (const line of head.replace(/\r\n /g, " ").split("\r\n")) {
    const colon = line.indexOf(":")
    headers.set(line.slice(0, colon), line.slice(colon + 2))
  }
  return { head, headers, body: Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), bodyLines: body }
}

/** Decodes RFC 2047 B words the way a mail reader does. */
const decodeWords = (value: string) =>
  value.replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/g, (_word, data: string) => Buffer.from(data, "base64").toString("utf8"))

describe("Gmail message composition", () => {
  it("writes the headers, the key and a base64 body with CRLF line ends", async () => {
    const message = await composed({
      from: { address: "assistant@example.test" },
      cc: [{ address: "grace@example.test" }],
      bcc: [{ address: "audit@example.test", name: "" }],
      inReplyTo: "<abc@mail.example.test>",
      references: ["<root@mail.example.test>", "<abc@mail.example.test>"]
    })
    const { head, headers, body } = parse(message.raw)
    expect(head.split("\r\n")[0]).toBe("MIME-Version: 1.0")
    expect(headers.get("Date")).toBe("Fri, 25 Sep 2026 22:05:09 +0000")
    expect(headers.get("Message-ID")).toBe(message.messageId)
    expect(headers.get("From")).toBe("assistant@example.test")
    expect(headers.get("To")).toBe("\"Ada Lovelace\" <ada@example.test>")
    expect(headers.get("Cc")).toBe("grace@example.test")
    expect(headers.get("Bcc")).toBe("audit@example.test")
    expect(headers.get("Subject")).toBe("Status")
    expect(headers.get("In-Reply-To")).toBe("<abc@mail.example.test>")
    expect(headers.get("References")).toBe("<root@mail.example.test> <abc@mail.example.test>")
    expect(headers.get(KEY_HEADER)).toBe("assistant/reply-1")
    expect(headers.get("Content-Type")).toBe("text/plain; charset=UTF-8")
    expect(headers.get("Content-Transfer-Encoding")).toBe("base64")
    expect(body).toBe("Line one\r\nLine two")
    expect(message.key).toBe("assistant/reply-1")
    // No bare LF anywhere: every line ends CRLF.
    expect(message.raw.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/)
  })

  it("leaves out empty optional headers", async () => {
    const { headers } = parse((await composed({ cc: [], bcc: [], references: [] })).raw)
    expect([...headers.keys()]).toEqual([
      "MIME-Version",
      "Date",
      "Message-ID",
      "To",
      "Subject",
      KEY_HEADER,
      "Content-Type",
      "Content-Transfer-Encoding"
    ])
  })

  it("derives the same Message-ID from the same key, and a different one from another", async () => {
    const first = await composed()
    expect(first.messageId).toBe(messageIdFor("assistant/reply-1"))
    expect(first.messageId).toMatch(new RegExp(`^<smithers\\.[0-9a-f]{40}@${MESSAGE_ID_DOMAIN.replace(".", "\\.")}>$`))
    expect((await composed()).messageId).toBe(first.messageId)
    expect((await composed({ key: "assistant/reply-2" })).messageId).not.toBe(first.messageId)
  })

  it("encodes a non-ASCII subject and name as folded encoded words", async () => {
    const subject = "Réunion à 15 h — ordre du jour ✓ ".repeat(4)
    const message = await composed({ subject, to: [{ address: "zoe@example.test", name: "Zoë \"Z\" Ñ" }] })
    const { head, headers } = parse(message.raw)
    // RFC 2047: a line holding an encoded word is at most 76 characters.
    for (const line of head.split("\r\n").filter((line) => line.includes("=?"))) {
      expect(line.length).toBeLessThanOrEqual(76)
    }
    expect(message.raw).toContain("\r\n <zoe@example.test>\r\n")
    expect(decodeWords(headers.get("Subject")!)).toBe(subject)
    expect(headers.get("Subject")!.startsWith("=?UTF-8?B?")).toBe(true)
    expect(decodeWords(headers.get("To")!)).toBe("Zoë \"Z\" Ñ<zoe@example.test>")
  })

  it("quotes an ASCII display name and escapes its quotes", async () => {
    const { headers } = parse(
      (await composed({ to: [{ address: "a@example.test", name: "Smith, \"Al\" \\ Jr" }] })).raw
    )
    expect(headers.get("To")).toBe("\"Smith, \\\"Al\\\" \\\\ Jr\" <a@example.test>")
  })

  it("encodes ASCII that a reader would take for an encoded word, and an over-long subject", async () => {
    const tricky = await composed({ subject: "=?UTF-8?B?SGk=?=" })
    expect(decodeWords(parse(tricky.raw).headers.get("Subject")!)).toBe("=?UTF-8?B?SGk=?=")
    const long = "a".repeat(950)
    const folded = await composed({ subject: long, to: [{ address: "a@example.test", name: "=?x?=" }] })
    const { headers } = parse(folded.raw)
    expect(decodeWords(headers.get("Subject")!)).toBe(long)
    expect(decodeWords(headers.get("To")!)).toBe("=?x?=<a@example.test>")
  })

  it("folds several recipients onto continuation lines", async () => {
    const message = await composed({ to: [{ address: "a@example.test" }, { address: "b@example.test" }] })
    expect(message.raw).toContain("To: a@example.test,\r\n b@example.test\r\n")
  })

  it("wraps a long body at 76 characters and sends an empty one", async () => {
    const long = await composed({ text: "x".repeat(300) })
    const { bodyLines, body } = parse(long.raw)
    for (const line of bodyLines.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76)
    expect(body).toBe("x".repeat(300))
    const empty = await composed({ text: "" })
    expect(empty.raw.endsWith("Content-Transfer-Encoding: base64\r\n\r\n\r\n")).toBe(true)
  })

  it("normalizes lone CR and LF in the body to CRLF", async () => {
    expect(parse((await composed({ text: "a\rb\nc\r\nd" })).raw).body).toBe("a\r\nb\r\nc\r\nd")
  })

  it("refuses a CR or LF in the subject, a name, or an address", async () => {
    const injections: ReadonlyArray<Record<string, unknown>> = [
      { subject: "Hello\r\nBcc: attacker@example.test" },
      { subject: "Hello\nX-Other: 1" },
      { subject: "Hello\u0000" },
      { to: [{ address: "ada@example.test\r\nBcc: attacker@example.test" }] },
      { to: [{ address: "ada@example.test", name: "Ada\r\nBcc: attacker@example.test" }] },
      { cc: [{ address: "a@example.test, b@example.test" }] },
      { from: { address: "<a@example.test>" } },
      { inReplyTo: "<a@example.test>\r\nBcc: x@example.test" },
      { references: ["not-a-message-id"] },
      { key: "key\r\nBcc: x@example.test" },
      { key: "" },
      { to: [] }
    ]
    for (const injection of injections) {
      const error = await refused(injection)
      expect(error.reason, JSON.stringify(injection)).toBe("invalid-config")
      expect(error.summary).toContain("Gmail message refused")
    }
  })

  it("refuses a body over the size bound", async () => {
    const error = await refused({ text: "é".repeat(MAX_TEXT_BYTES / 2 + 1) })
    expect(error.summary).toContain(`limit is ${MAX_TEXT_BYTES}`)
  })

  it("never splits a character across encoded words, and encodes nothing for empty text", () => {
    const words = encodedWords("😀".repeat(30))
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(60)
      const data = /^=\?UTF-8\?B\?(.*)\?=$/.exec(word)![1]!
      expect(Buffer.from(data, "base64").toString("utf8")).toMatch(/^(😀)+$/u)
    }
    expect(encodedWords("")).toEqual([])
  })

  it("formats dates in UTC with a numeric zone", () => {
    expect(formatDate(Date.UTC(2027, 0, 3, 4, 5, 6))).toBe("Sun, 03 Jan 2027 04:05:06 +0000")
  })
})

const message = (extra: Partial<Message> = {}): Message => ({
  id: "18c0a1",
  threadId: "18c0a0",
  labelIds: ["INBOX", "UNREAD"],
  snippet: "Can we move Friday&#39;s sync? Tom &amp; Jerry &lt;3 &hearts; &#x1F600; &#9999999;",
  historyId: "4242",
  internalDate: "1790000000000",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "\"Ada Lovelace\" <Ada@Example.test>" },
      { name: "To", value: "assistant@example.test" },
      { name: "subject", value: "Friday sync" }
    ]
  },
  ...extra
})

const context = { connectionId: "assistant-mail", container: "me", retrievedAtMs: 1_790_000_100_000 }

describe("Gmail records", () => {
  it("maps a message to a private record with provenance", async () => {
    const record = Records.fromMessage(message(), context)
    await Effect.runPromise(SourceRecord.decode(record))
    expect(record).toMatchObject({
      provider: "gmail",
      connectionId: "assistant-mail",
      externalId: "18c0a1",
      kind: "message",
      url: null,
      author: { id: "ada@example.test", label: "Ada Lovelace" },
      createdAtMs: 1_790_000_000_000,
      updatedAtMs: null,
      version: "00000000000000004242",
      retrievedAtMs: 1_790_000_100_000,
      access: { scope: "private", containerId: "me" },
      thread: { containerId: "me", threadId: "18c0a0", parentId: null },
      deleted: false
    })
    expect(record.text).toBe(
      "From: \"Ada Lovelace\" <Ada@Example.test>\nSubject: Friday sync\n\nCan we move Friday's sync? Tom & Jerry <3 &hearts; 😀 &#9999999;"
    )
    expect(record.payload).toEqual({
      id: "18c0a1",
      threadId: "18c0a0",
      labelIds: ["INBOX", "UNREAD"],
      snippet: message().snippet,
      historyId: "4242",
      internalDate: "1790000000000",
      headers: {
        From: "\"Ada Lovelace\" <Ada@Example.test>",
        To: "assistant@example.test",
        Cc: null,
        Subject: "Friday sync",
        Date: null,
        "Message-ID": null
      }
    })
  })

  it("maps a bare message with no headers, dates or labels", async () => {
    const record = Records.fromMessage({ id: "m1", threadId: "t1" }, context)
    await Effect.runPromise(SourceRecord.decode(record))
    expect(record).toMatchObject({ author: null, createdAtMs: null, version: null, text: "From: \nSubject: \n\n" })
    expect(record.payload).toMatchObject({ labelIds: [], snippet: "", historyId: null, internalDate: null })
    expect(Records.fromMessage({ id: "m1", threadId: "t1", internalDate: "soon" }, context).createdAtMs).toBeNull()
  })

  it("orders padded versions the way the mailbox does", () => {
    expect(Records.version("99")! < Records.version("100")!).toBe(true)
    expect(Records.version(undefined)).toBeNull()
  })

  it("builds a tombstone with no text or payload", async () => {
    const record = Records.tombstone({ id: "m1", threadId: "t1" }, "500", context)
    await Effect.runPromise(SourceRecord.decode(record))
    expect(record).toMatchObject({ deleted: true, text: "", payload: null, version: "00000000000000000500" })
    expect(Records.tombstone({ id: "m1" }, undefined, context).thread.threadId).toBeNull()
  })

  it("parses mailbox forms", () => {
    expect(Records.parseMailbox("ada@example.test")).toEqual({ address: "ada@example.test", name: null })
    expect(Records.parseMailbox("<ada@example.test>")).toEqual({ address: "ada@example.test", name: null })
    expect(Records.parseMailbox("Ada <ada@example.test>")).toEqual({ address: "ada@example.test", name: "Ada" })
    expect(Records.parseMailbox("\"A \\\"B\\\"\" <ada@example.test>")).toEqual({
      address: "ada@example.test",
      name: "A \"B\""
    })
    expect(Records.parseMailbox("undisclosed-recipients:;")).toBeNull()
    expect(Records.fromMessage(message({ payload: { headers: [{ name: "From", value: "nobody" }] } }), context).author)
      .toBeNull()
  })

  it("finds the first inline text/plain body", () => {
    const encode = (text: string) => Buffer.from(text).toString("base64url")
    const full = message({
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: encode("<b>x</b>") } }] },
          { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: encode("plain ✓") } }] },
          { mimeType: "text/plain", body: { data: encode("second") } }
        ]
      }
    })
    expect(Records.bodyText(full)).toBe("plain ✓")
    expect(Records.bodyText(message({ payload: { mimeType: "text/plain", body: { attachmentId: "a1" } } }))).toBeNull()
    expect(Records.bodyText({ id: "m1", threadId: "t1" })).toBeNull()
  })

  it("treats trash, spam and a lost label as gone", () => {
    expect(Records.isGone(message())).toBe(false)
    expect(Records.isGone(message({ labelIds: ["TRASH"] }))).toBe(true)
    expect(Records.isGone(message({ labelIds: ["SPAM"] }))).toBe(true)
    expect(Records.isGone(message(), "INBOX")).toBe(false)
    expect(Records.isGone(message(), "Label_7")).toBe(true)
    expect(Records.isGone({ id: "m1", threadId: "t1" })).toBe(false)
  })

  it("decodes the record schema it produces", () => {
    expect(Schema.is(SourceRecord.SourceRecord)(Records.fromMessage(message(), context))).toBe(true)
  })
})
