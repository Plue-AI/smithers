/**
 * Messages a Telegram bot has received, read through the Bot API's
 * `getUpdates` and merged into a note's "Telegram" section. The flow owns one
 * marked block there: its opening marker records the bot, the update cursor
 * and when the bot was last polled; each message is one line naming its time,
 * chat, sender and the ids that identify it. A message already listed is not
 * added again, lines already in the block stay as written, and the flow's own
 * failure lines are replaced each run. The bot token is never written.
 *
 * `getUpdates` is the only update call: it reads, and the cursor lives in the
 * note, so a run that fails before the note is written leaves Telegram to
 * deliver the same updates again.
 */
import { Schema } from "effect"
import { get, type Host, readNote, resolveNote, writeNote } from "../note.ts"

export const Payload = {
  /** The note, relative to the workspace root. */
  note: Schema.String,
  /** The chat ids to keep; every chat the bot can see when absent. */
  chats: Schema.optional(Schema.Array(Schema.Int))
}
export type Payload = Schema.Struct<typeof Payload>["Type"]

export const Receipt = Schema.Struct({
  note: Schema.String,
  added: Schema.Int,
  cursor: Schema.Int,
  changed: Schema.Boolean,
  failures: Schema.Array(Schema.String)
})
export type Receipt = typeof Receipt.Type

/** What the telegram flow's host binds: the note boundary and the Bot API. */
export interface TelegramHost extends Host {
  /** The Bot API origin, `https://api.telegram.org` in production. */
  readonly api: string
  /** The bot token, read where the host runs; never part of a payload. */
  readonly token: () => string | undefined
}

export const heading = "## Telegram"
const startPrefix = "<!-- telegram"
export const end = "<!-- /telegram -->"

/** One message as the note lists it. */
export interface Message {
  readonly at: Date
  readonly chat: number
  readonly title: string
  readonly from: string
  readonly id: number
  readonly text: string
}

/** Markdown-inert text: one line, with link, markup and comment brackets escaped. */
const inert = (text: string) => text.replace(/\s+/g, " ").trim().replace(/([\\[\]<>`*_|(])/g, "\\$1")

/** A sender or chat name: as {@link inert}, leaving the underscores of `@user_name` alone. */
const name = (text: string) => inert(text).replace(/\\_/g, "_")

const stamp = (at: Date) => at.toISOString().slice(0, 16).replace("T", " ")

export const line = (message: Message) =>
  `- ${stamp(message.at)} · ${name(message.title)} · ${name(message.from)}: ${inert(message.text).slice(0, 1000)} ` +
  `(chat ${message.chat} · msg ${message.id})`

const idTail = /\(chat (-?\d+) · msg (\d+)\)$/
const failurePrefix = "- failed "

/** The chat and message ids a listed line ends with. */
const key = (text: string) => {
  const match = idTail.exec(text)
  return match === null ? undefined : `${match[1]}:${match[2]}`
}

/** The header the block opens with. */
export const header = (bot: string, cursor: number, polled: Date) =>
  `${startPrefix} bot=${bot} cursor=${cursor} polled=${polled.toISOString().slice(0, 16)}Z -->`

const headerPattern = /^<!-- telegram bot=(\S*) cursor=(\d+) polled=(\S+) -->$/

/** The cursor the note's block records, or 0 when it has none. */
export const cursorOf = (text: string) => {
  for (const candidate of text.split("\n")) {
    const match = headerPattern.exec(candidate)
    if (match !== null) return Number(match[2])
  }
  return 0
}

/**
 * Merges `messages` and today's `failures` into the note's block, recording
 * `bot`, `cursor` and `polled` in its header when the poll succeeded (a failed
 * poll keeps the header it had). Returns the new text and how many messages
 * were added.
 */
export const merge = (
  text: string,
  update: { readonly bot: string; readonly cursor: number; readonly polled: Date } | undefined,
  messages: ReadonlyArray<Message>,
  failures: ReadonlyArray<string>,
  today: string
) => {
  let lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n")
  let open = lines.findIndex((candidate) => headerPattern.test(candidate))
  let close = open === -1 ? -1 : lines.indexOf(end, open + 1)
  if (open === -1 || close === -1) {
    const at = lines.indexOf(heading)
    if (at === -1) {
      lines = [...lines, ...(lines.length === 0 ? [] : [""]), heading, ""]
      open = lines.length
    } else {
      open = at + 1
    }
    lines.splice(open, 0, header("", 0, new Date(0)), end)
    close = open + 1
  }
  const block = lines.slice(open + 1, close).filter((candidate) => !candidate.startsWith(failurePrefix))
  const listed = new Set(block.map(key))
  const fresh: Array<Message> = []
  for (const message of messages) {
    const id = `${message.chat}:${message.id}`
    if (listed.has(id)) continue
    listed.add(id)
    fresh.push(message)
  }
  const kept = [...block, ...fresh.map(line)].toSorted((a, b) => a.slice(0, 18).localeCompare(b.slice(0, 18)))
  const previous = headerPattern.exec(lines[open]!)!
  const opening = update === undefined
    ? lines[open]!
    : header(update.bot, Math.max(update.cursor, Number(previous[2])), update.polled)
  lines.splice(open, close - open, opening, ...kept, ...failures.map((reason) => `${failurePrefix}${today}: ${reason}`))
  return { text: lines.join("\n") + "\n", added: fresh.length }
}

const maximumBatches = 10
const tokenPattern = /^\d{1,20}:[A-Za-z0-9_-]{1,100}$/

interface Raw {
  readonly update_id?: unknown
  readonly message?: unknown
  readonly channel_post?: unknown
}

const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)

/** The message an update carries, when it is a text or caption post in a wanted chat. */
const messageOf = (raw: Raw, chats: ReadonlyArray<number> | undefined): Message | undefined => {
  const post = (raw.message ?? raw.channel_post) as
    | {
      readonly message_id?: unknown
      readonly date?: unknown
      readonly text?: unknown
      readonly caption?: unknown
      readonly chat?: {
        readonly id?: unknown
        readonly title?: unknown
        readonly username?: unknown
        readonly first_name?: unknown
      }
      readonly from?: { readonly username?: unknown; readonly first_name?: unknown }
      readonly sender_chat?: { readonly title?: unknown }
    }
    | undefined
  if (post === undefined || post === null || typeof post !== "object" || post.chat === undefined) return undefined
  const text = typeof post.text === "string" ? post.text : typeof post.caption === "string" ? post.caption : ""
  const chat = post.chat.id
  if (text.trim().length === 0 || !integer(chat) || !integer(post.message_id) || !integer(post.date)) return undefined
  if (chats !== undefined && !chats.includes(chat)) return undefined
  const nonEmpty = (value: unknown) => typeof value === "string" && value.trim().length > 0 ? value : undefined
  return {
    at: new Date(post.date * 1000),
    chat,
    title: nonEmpty(post.chat.title) ?? nonEmpty(post.chat.username) ?? nonEmpty(post.chat.first_name) ??
      `chat ${chat}`,
    from: nonEmpty(post.from?.username) === undefined
      ? nonEmpty(post.from?.first_name) ?? nonEmpty(post.sender_chat?.title) ?? "unknown"
      : `@${post.from!.username as string}`,
    id: post.message_id,
    text
  }
}

type Polled =
  | { readonly ok: true; readonly bot: string; readonly cursor: number; readonly messages: Array<Message> }
  | { readonly ok: false; readonly reason: string }

/** One Bot API method, its result, or the fixed phrase naming why not. */
const call = async (host: TelegramHost, token: string, method: string, query: string) => {
  const got = await get(host, `${host.api}/bot${token}/${method}${query}`, "application/json")
  if (!got.ok) return got
  try {
    const body = JSON.parse(got.text) as { readonly ok?: unknown; readonly result?: unknown }
    return body.ok === true
      ? { ok: true as const, result: body.result }
      : { ok: false as const, reason: "refused by Telegram" }
  } catch {
    return { ok: false as const, reason: "not a Telegram response" }
  }
}

/** Reads the bot's identity, then every pending update from `cursor`. */
const poll = async (
  host: TelegramHost,
  token: string,
  cursor: number,
  chats: ReadonlyArray<number> | undefined
): Promise<Polled> => {
  const me = await call(host, token, "getMe", "")
  if (!me.ok) return me
  const username = (me.result as { readonly username?: unknown } | null)?.username
  const bot = typeof username === "string" && /^[A-Za-z0-9_]{1,64}$/.test(username) ? `@${username}` : "@unknown"
  const messages: Array<Message> = []
  let next = cursor
  for (let batch = 0; batch < maximumBatches; batch++) {
    const got = await call(
      host,
      token,
      "getUpdates",
      `?offset=${next}&limit=100&timeout=0&allowed_updates=${encodeURIComponent("[\"message\",\"channel_post\"]")}`
    )
    if (!got.ok) return got
    if (!Array.isArray(got.result)) return { ok: false, reason: "not a Telegram response" }
    for (const raw of got.result as Array<Raw>) {
      if (raw === null || typeof raw !== "object" || !integer(raw.update_id)) continue
      next = Math.max(next, raw.update_id + 1)
      const message = messageOf(raw, chats)
      if (message !== undefined) messages.push(message)
    }
    if (got.result.length < 100) break
  }
  return { ok: true, bot, cursor: next, messages }
}

/**
 * Polls the bot and merges the messages into the note. A refused payload or
 * note is a string failure; a failed poll is written to the note first and
 * then fails the run with its receipt.
 */
export const ingest = async (
  host: TelegramHost,
  payload: Payload
): Promise<
  { readonly ok: true; readonly receipt: Receipt } | { readonly ok: false; readonly error: Receipt | string }
> => {
  if (payload.chats !== undefined && payload.chats.some((chat) => !integer(chat))) {
    return { ok: false, error: "chats must be integer chat ids" }
  }
  const path = await resolveNote(host.root, payload.note)
  if (typeof path !== "string") return { ok: false, error: path.refused }
  const now = host.now()
  const before = await readNote(path)
  const token = host.token()?.trim()
  const polled: Polled = token === undefined || token === ""
    ? { ok: false, reason: "no bot token" }
    : !tokenPattern.test(token)
    ? { ok: false, reason: "invalid bot token" }
    : await poll(host, token, cursorOf(before), payload.chats)
  const merged = polled.ok
    ? merge(
      before,
      { bot: polled.bot, cursor: polled.cursor, polled: now },
      polled.messages,
      [],
      now.toISOString().slice(0, 10)
    )
    : merge(before, undefined, [], [polled.reason], now.toISOString().slice(0, 10))
  const changed = merged.text !== before
  if (changed) await writeNote(path, merged.text)
  const receipt: Receipt = {
    note: payload.note,
    added: merged.added,
    cursor: cursorOf(merged.text),
    changed,
    failures: polled.ok ? [] : [polled.reason]
  }
  return polled.ok ? { ok: true, receipt } : { ok: false, error: receipt }
}
