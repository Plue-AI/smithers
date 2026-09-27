/**
 * Gmail sync, search, durable actions and reconciliation against a fake
 * mailbox served by a real `node:http` server.
 *
 * The fake keeps real state: messages with labels and history ids, a history
 * log with a retention floor (a start id below it answers 404, as Gmail
 * does), and drafts and sends parsed from the raw RFC 2822 text the client
 * wrote. A send can be made to store the message and then lose the answer,
 * which is the ambiguous write the actions must report as `outcomeUnknown`
 * and the reconciliation must find. No live Gmail account is involved.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Layer, Redacted } from "effect"
import type { ServerResponse } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import type { AccessTokenSource } from "../src/core/AccessToken.ts"
import { IntegrationFailure } from "../src/core/ActionFailure.ts"
import type { Connection } from "../src/core/Connection.ts"
import type { IntegrationError } from "../src/core/IntegrationError.ts"
import type { Changes, SyncAdapter } from "../src/core/Sync.ts"
import * as Actions from "../src/gmail/Actions.ts"
import * as Capabilities from "../src/gmail/Capabilities.ts"
import * as GmailClient from "../src/gmail/GmailClient.ts"
import { KEY_HEADER, messageIdFor } from "../src/gmail/Mime.ts"
import { findByKey, queryFor } from "../src/gmail/Reconcile.ts"
import * as Records from "../src/gmail/Records.ts"
import { decodeCursor, encodeCursor, mailbox, search } from "../src/gmail/Sync.ts"
import { type Fixture, json, type Recorded, startFixture } from "./Fixture.ts"

interface Stored {
  readonly id: string
  readonly threadId: string
  labelIds: Array<string>
  historyId: number
  readonly internalDate: number
  readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>
  readonly snippet: string
}

type Change = { readonly message: { readonly id: string; readonly threadId: string; readonly labelIds: Array<string> } }

interface HistoryEntry {
  readonly id: number
  readonly messagesAdded?: Array<Change>
  readonly messagesDeleted?: Array<Change>
  readonly labelsAdded?: Array<Change & { readonly labelIds: Array<string> }>
  readonly labelsRemoved?: Array<Change & { readonly labelIds: Array<string> }>
}

/** A mailbox with state, spoken to over HTTP. */
class FakeMailbox {
  readonly messages = new Map<string, Stored>()
  readonly history: Array<HistoryEntry> = []
  historyId = 1000
  /** History at or below this id is gone: a read starting there answers 404. */
  floor = 1000
  /** Listed but answering 404 when read, as if deleted in between. */
  readonly vanished = new Set<string>()
  /** Store the next write, then answer this way instead of with the message. */
  loseNextWrite: "500" | "drop" | undefined
  /** Answer reads without labels and writes with the id alone, as Gmail may. */
  bare = false
  historyless = false
  private sequence = 0

  private nextId(): string {
    this.sequence += 1
    return `m${String(this.sequence).padStart(4, "0")}`
  }

  private ref(stored: Stored) {
    return { id: stored.id, threadId: stored.threadId, labelIds: [...stored.labelIds] }
  }

  add(subject: string, labels: Array<string> = ["INBOX"], extra: Partial<Stored> = {}): Stored {
    this.historyId += 1
    const id = this.nextId()
    const stored: Stored = {
      id,
      threadId: `t${id}`,
      labelIds: labels,
      historyId: this.historyId,
      internalDate: 1_790_000_000_000 + this.sequence,
      headers: [
        { name: "From", value: `"Sender ${this.sequence}" <sender${this.sequence}@example.test>` },
        { name: "Subject", value: subject },
        { name: "Message-ID", value: `<${id}@mail.example.test>` }
      ],
      snippet: `About ${subject}`,
      ...extra
    }
    this.messages.set(id, stored)
    this.history.push({ id: this.historyId, messagesAdded: [{ message: this.ref(stored) }] })
    return stored
  }

  relabel(id: string, add: Array<string>, remove: Array<string>): void {
    const stored = this.messages.get(id)!
    this.historyId += 1
    stored.labelIds = [...stored.labelIds.filter((label) => !remove.includes(label)), ...add]
    stored.historyId = this.historyId
    this.history.push({
      id: this.historyId,
      ...(add.length === 0 ? {} : { labelsAdded: [{ message: this.ref(stored), labelIds: add }] }),
      ...(remove.length === 0 ? {} : { labelsRemoved: [{ message: this.ref(stored), labelIds: remove }] })
    })
  }

  remove(id: string): void {
    const stored = this.messages.get(id)!
    this.historyId += 1
    this.messages.delete(id)
    this.history.push({ id: this.historyId, messagesDeleted: [{ message: this.ref(stored) }] })
  }

  /** Parses a raw RFC 2822 write and stores it under `label`. */
  store(raw: string, label: string, threadId: string | undefined): Stored {
    const text = Buffer.from(raw, "base64url").toString("utf8")
    const head = text.slice(0, text.indexOf("\r\n\r\n")).replace(/\r\n /g, " ")
    const headers = head.split("\r\n").map((line) => {
      const colon = line.indexOf(":")
      return { name: line.slice(0, colon), value: line.slice(colon + 2) }
    })
    const subject = headers.find((header) => header.name === "Subject")?.value ?? ""
    return this.add(subject, [label], {
      headers,
      ...(threadId === undefined ? {} : { threadId })
    })
  }

  private listed(query: URLSearchParams): Array<Stored> {
    const labels = query.getAll("labelIds")
    const includeSpamTrash = query.get("includeSpamTrash") === "true"
    const q = query.get("q")
    return [...this.messages.values()]
      .filter((stored) => includeSpamTrash || (!stored.labelIds.includes("TRASH") && !stored.labelIds.includes("SPAM")))
      .filter((stored) => labels.every((label) => stored.labelIds.includes(label)))
      .filter((stored) => {
        if (q === null) return true
        if (q.startsWith("rfc822msgid:")) {
          const wanted = `<${q.slice("rfc822msgid:".length)}>`
          return stored.headers.some((header) => header.name === "Message-ID" && header.value === wanted)
        }
        return stored.headers.some((header) => header.name === "Subject" && header.value.includes(q))
      })
      .sort((a, b) => b.id.localeCompare(a.id))
  }

  private page<A>(items: ReadonlyArray<A>, query: URLSearchParams) {
    const offset = Number(query.get("pageToken") ?? "0")
    const size = Number(query.get("maxResults") ?? "100")
    const slice = items.slice(offset, offset + size)
    const next = offset + size < items.length ? String(offset + size) : undefined
    return { slice, next }
  }

  readonly handle = (request: Recorded, response: ServerResponse): void => {
    const url = new URL(`http://fixture${request.url}`)
    const path = url.pathname.replace("/gmail/v1/users/me", "")
    const query = url.searchParams
    if (request.headers["authorization"] !== "Bearer mail-token") {
      json(response, 401, { error: { message: "Invalid Credentials" } })
      return
    }
    if (request.method === "GET" && path === "/profile") {
      json(response, 200, { emailAddress: "assistant@example.test", historyId: String(this.historyId) })
      return
    }
    if (request.method === "GET" && path === "/messages") {
      const { slice, next } = this.page(this.listed(query), query)
      json(response, 200, {
        ...(slice.length === 0
          ? {}
          : { messages: slice.map((stored) => ({ id: stored.id, threadId: stored.threadId })) }),
        ...(next === undefined ? {} : { nextPageToken: next }),
        resultSizeEstimate: slice.length
      })
      return
    }
    if (request.method === "GET" && path.startsWith("/messages/")) {
      const id = path.slice("/messages/".length)
      const stored = this.messages.get(id)
      if (stored === undefined || this.vanished.has(id)) {
        json(response, 404, { error: { code: 404, message: "Requested entity was not found." } })
        return
      }
      const wanted = query.getAll("metadataHeaders").map((name) => name.toLowerCase())
      json(response, 200, {
        id: stored.id,
        threadId: stored.threadId,
        ...(this.bare ? {} : { labelIds: stored.labelIds }),
        snippet: stored.snippet,
        ...(this.historyless ? {} : { historyId: String(stored.historyId) }),
        internalDate: String(stored.internalDate),
        payload: {
          mimeType: "text/plain",
          headers: stored.headers.filter((header) =>
            query.get("format") !== "metadata" || wanted.includes(header.name.toLowerCase())
          )
        }
      })
      return
    }
    if (request.method === "GET" && path === "/history") {
      const start = Number(query.get("startHistoryId"))
      if (start < this.floor) {
        json(response, 404, { error: { code: 404, message: "Requested entity was not found." } })
        return
      }
      const label = query.get("labelId")
      const entries = this.history
        .filter((entry) => entry.id > start)
        .filter((entry) =>
          label === null ||
          [entry.messagesAdded, entry.messagesDeleted, entry.labelsAdded, entry.labelsRemoved]
            .flatMap((changes) => changes ?? [])
            .some((change) =>
              change.message.labelIds.includes(label) ||
              ("labelIds" in change && (change as { labelIds: Array<string> }).labelIds.includes(label))
            )
        )
        .map((entry) => ({ ...entry, id: String(entry.id) }))
      const { slice, next } = this.page(entries, query)
      json(response, 200, {
        ...(slice.length === 0 ? {} : { history: slice }),
        ...(next === undefined ? {} : { nextPageToken: next }),
        historyId: String(this.historyId)
      })
      return
    }
    if (request.method === "POST" && (path === "/drafts" || path === "/messages/send")) {
      const body = JSON.parse(request.body) as {
        raw?: string
        threadId?: string
        message?: { raw: string; threadId?: string }
      }
      const write = body.message ?? (body as { raw: string; threadId?: string })
      const stored = this.store(write.raw, path === "/drafts" ? "DRAFT" : "SENT", write.threadId)
      const lose = this.loseNextWrite
      this.loseNextWrite = undefined
      if (lose === "500") {
        json(response, 500, { error: { code: 500, message: "Backend Error" } })
        return
      }
      if (lose === "drop") {
        response.socket?.destroy()
        return
      }
      const message = this.bare
        ? { id: stored.id }
        : { id: stored.id, threadId: stored.threadId, labelIds: stored.labelIds }
      json(response, 200, path === "/drafts" ? { id: `r-${stored.id}`, message } : message)
      return
    }
    json(response, 400, { error: { message: `unexpected ${request.method} ${path}` } })
  }
}

let fixture: Fixture | undefined
let box: FakeMailbox

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

const token: AccessTokenSource = { token: Effect.succeed(Redacted.make("mail-token")), invalidate: Effect.void }

const connection = (scopes: ReadonlyArray<string> = [Capabilities.SCOPE_FULL]): Connection => ({
  id: "assistant-mail",
  provider: "gmail",
  label: "Assistant mailbox",
  credential: { id: "cred-mail", name: "assistant-mail" },
  scopes,
  personal: true,
  containers: ["me"]
})

const start = async (): Promise<FakeMailbox> => {
  box = new FakeMailbox()
  fixture = await startFixture((request, response) => box.handle(request, response))
  return box
}

/** A client bound to `bound`, or to no connection when it is `null`. */
const client = (bound: Connection | null = connection()) =>
  GmailClient.make(
    { token, connection: bound ?? undefined, apiBaseUrl: (fixture as Fixture).origin, maxRetries: 0 },
    {}
  )

const run = <A>(effect: Effect.Effect<A, IntegrationError>): Promise<A> => Effect.runPromise(effect)
const flip = <A>(effect: Effect.Effect<A, IntegrationError>): Promise<IntegrationError> =>
  Effect.runPromise(Effect.flip(effect))

/** Calls `changes` until `done`, collecting every page. */
const drain = async (adapter: SyncAdapter, cursor: string | null): Promise<Array<Changes>> => {
  const pages: Array<Changes> = []
  let current = cursor
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await run(adapter.changes(current))
    pages.push(page)
    current = page.cursor
    if (page.done) return pages
  }
  throw new Error("sync never finished")
}

const ids = (pages: ReadonlyArray<Changes>) =>
  pages.flatMap((page) => page.records.map((record) => `${record.deleted ? "-" : "+"}${record.externalId}`))

describe("Gmail mailbox sync", () => {
  it("lists page by page from the profile's history id, then catches up and finishes", async () => {
    await start()
    box.add("one")
    box.add("two")
    box.add("three")
    const adapter = await run(mailbox({ client: client(), pageSize: 2 }))
    expect(adapter).toMatchObject({ provider: "gmail", connectionId: "assistant-mail", stream: "mailbox" })

    const pages = await drain(adapter, null)
    expect(pages.map((page) => [page.reset, page.done])).toEqual([[false, false], [false, false], [false, true]])
    expect(ids(pages)).toEqual(["+m0003", "+m0002", "+m0001"])
    const first = await run(decodeCursor(pages[0]!.cursor!))
    expect(first).toEqual({ v: 1, mode: "list", start: "1003", page: "2" })
    expect(await run(decodeCursor(pages[1]!.cursor!))).toEqual({ v: 1, mode: "history", start: "1003" })
    expect(await run(decodeCursor(pages[2]!.cursor!))).toEqual({ v: 1, mode: "history", start: "1003" })

    const record = pages[0]!.records[0]!
    expect(record).toMatchObject({
      provider: "gmail",
      connectionId: "assistant-mail",
      kind: "message",
      access: { scope: "private", containerId: "me" },
      thread: { containerId: "me", threadId: "tm0003" },
      author: { id: "sender3@example.test", label: "Sender 3" },
      version: "00000000000000001003"
    })
    expect(record.text).toContain("Subject: three")
    // Headers only: a sync never asks for bodies.
    const reads = fixture!.requests.filter((request) => request.url.startsWith("/gmail/v1/users/me/messages/"))
    expect(reads.every((request) => request.url.includes("format=metadata"))).toBe(true)
  })

  it("reads additions, trash and deletions from history and advances the cursor", async () => {
    await start()
    const kept = box.add("kept")
    const trashed = box.add("trashed")
    const deleted = box.add("deleted")
    const adapter = await run(mailbox({ client: client() }))
    const initial = await drain(adapter, null)
    const cursor = initial.at(-1)!.cursor

    const added = box.add("new")
    box.relabel(trashed.id, ["TRASH"], ["INBOX"])
    box.remove(deleted.id)
    box.relabel(kept.id, ["STARRED"], [])

    const [page] = await drain(adapter, cursor)
    expect(page!.done).toBe(true)
    const byId = new Map(page!.records.map((record) => [record.externalId, record]))
    expect(byId.get(added.id)).toMatchObject({ deleted: false })
    expect(byId.get(trashed.id)).toMatchObject({ deleted: true, text: "", payload: null })
    expect(byId.get(deleted.id)).toMatchObject({ deleted: true, version: "00000000000000001006" })
    expect(byId.get(kept.id)?.payload).toMatchObject({ labelIds: ["INBOX", "STARRED"] })
    expect(await run(decodeCursor(page!.cursor!))).toEqual({ v: 1, mode: "history", start: String(box.historyId) })

    // Nothing new: the same cursor comes back, done, with no records.
    const [idle] = await drain(adapter, page!.cursor)
    expect(idle).toMatchObject({ records: [], cursor: page!.cursor, done: true, reset: false })
  })

  it("versions a trashed message by its history record when the read omits a history id (#2175)", async () => {
    await start()
    const trashed = box.add("trashed")
    const adapter = await run(mailbox({ client: client() }))
    const cursor = (await drain(adapter, null)).at(-1)!.cursor
    box.relabel(trashed.id, ["TRASH"], ["INBOX"])
    box.historyless = true
    const [page] = await drain(adapter, cursor)
    const record = page!.records.find((record) => record.externalId === trashed.id)
    expect(record).toMatchObject({ deleted: true, version: Records.version(String(box.historyId)) })
  })

  it("pages history without moving the start, and resumes the same page after a crash", async () => {
    await start()
    const adapter = await run(mailbox({ client: client(), pageSize: 1 }))
    const initial = await drain(adapter, null)
    const cursor = initial.at(-1)!.cursor
    box.add("a")
    box.add("b")
    box.add("c")

    const first = await run(adapter.changes(cursor))
    expect(first.done).toBe(false)
    expect(await run(decodeCursor(first.cursor!))).toEqual({ v: 1, mode: "history", start: "1000", page: "1" })
    // A crash before the batch and cursor were stored re-reads the page: the
    // same records again, never a skipped one.
    const again = await run(adapter.changes(cursor))
    expect(ids([again])).toEqual(ids([first]))
    const rest = await drain(adapter, first.cursor)
    expect(ids([first, ...rest])).toEqual(["+m0001", "+m0002", "+m0003"])
    expect(rest.at(-1)!.done).toBe(true)
    expect(await run(decodeCursor(rest.at(-1)!.cursor!))).toEqual({ v: 1, mode: "history", start: "1003" })
  })

  it("starts a fresh listing with reset when the history id is too old", async () => {
    await start()
    box.add("one")
    box.add("two")
    box.add("three")
    const adapter = await run(mailbox({ client: client(), pageSize: 2 }))
    box.floor = 2000
    box.historyId = 2000
    const pages = await drain(adapter, encodeCursor({ v: 1, mode: "history", start: "1001" }))
    expect(pages.map((page) => page.reset)).toEqual([true, false, false])
    expect(ids(pages)).toEqual(["+m0003", "+m0002", "+m0001"])
    expect(await run(decodeCursor(pages[0]!.cursor!))).toEqual({ v: 1, mode: "list", start: "2000", page: "2" })
  })

  it("turns a message deleted between listing and reading into a tombstone", async () => {
    await start()
    box.add("one")
    const gone = box.add("two")
    box.vanished.add(gone.id)
    const pages = await drain(await run(mailbox({ client: client() })), null)
    expect(ids(pages)).toEqual(["-m0002", "+m0001"])
    expect(pages[0]!.records[0]).toMatchObject({ version: "00000000000000001002", thread: { threadId: "tm0002" } })
  })

  it("narrows the listing and history by label, and tombstones a message that leaves it", async () => {
    await start()
    const inbox = box.add("inbox")
    box.add("archived", ["CATEGORY_UPDATES"])
    const adapter = await run(mailbox({ client: client(), labelId: "INBOX", container: "assistant@example.test" }))
    expect(adapter.stream).toBe("label:INBOX")
    const initial = await drain(adapter, null)
    expect(ids(initial)).toEqual(["+m0001"])
    expect(initial[0]!.records[0]!.access.containerId).toBe("assistant@example.test")
    const listing = fixture!.requests.find((request) => request.url.startsWith("/gmail/v1/users/me/messages?"))!
    expect(new URL(`http://x${listing.url}`).searchParams.getAll("labelIds")).toEqual(["INBOX"])

    box.relabel(inbox.id, [], ["INBOX"])
    const [page] = await drain(adapter, initial.at(-1)!.cursor)
    expect(ids([page!])).toEqual(["-m0001"])
    const history = fixture!.requests.filter((request) => request.url.startsWith("/gmail/v1/users/me/history"))
    expect(history.every((request) => request.url.includes("labelId=INBOX"))).toBe(true)
  })

  it("applies a search query to the listing only", async () => {
    await start()
    box.add("invoice 1")
    box.add("newsletter")
    const adapter = await run(mailbox({ client: client(), query: "invoice", stream: "invoices" }))
    expect(adapter.stream).toBe("invoices")
    const initial = await drain(adapter, null)
    expect(ids(initial)).toEqual(["+m0001"])
    box.add("other")
    const [page] = await drain(adapter, initial.at(-1)!.cursor)
    expect(ids([page!])).toEqual(["+m0003"])
    const history = fixture!.requests.filter((request) => request.url.includes("/history"))
    expect(history.some((request) => request.url.includes("q="))).toBe(false)
  })

  it("refuses a corrupt cursor instead of starting over", async () => {
    await start()
    const adapter = await run(mailbox({ client: client() }))
    for (const cursor of ["not json", "{}", JSON.stringify({ v: 2, mode: "history", start: "1" })]) {
      expect((await flip(adapter.changes(cursor))).reason).toBe("decode-failed")
    }
    expect(fixture!.requests).toHaveLength(0)
  })

  it("refuses an unbound client, an empty container and a bad concurrency", async () => {
    await start()
    expect((await flip(mailbox({ client: client(null) }))).reason).toBe("invalid-config")
    expect((await flip(mailbox({ client: client(), container: " " }))).reason).toBe("invalid-config")
    for (const fetchConcurrency of [0, 17, 1.5]) {
      expect((await flip(mailbox({ client: client(), fetchConcurrency }))).reason).toBe("invalid-config")
    }
    expect((await flip(search({ client: client(null), query: "x" }))).reason).toBe("invalid-config")
  })

  it("fails visibly when the grant cannot read the mailbox", async () => {
    await start()
    const adapter = await run(mailbox({ client: client(connection([Capabilities.SCOPE_SEND])) }))
    const error = await flip(adapter.changes(null))
    expect(error.reason).toBe("permission-denied")
    expect(fixture!.requests).toHaveLength(0)
  })
})

describe("Gmail search", () => {
  it("returns matching messages as records, leaving out one deleted meanwhile", async () => {
    await start()
    box.add("quarterly report")
    const gone = box.add("quarterly plan")
    box.add("lunch")
    box.vanished.add(gone.id)
    const page = await run(search({ client: client(), query: "quarterly", maxResults: 5, fetchConcurrency: 2 }))
    expect(page.records.map((record) => record.externalId)).toEqual(["m0001"])
    expect(page.nextPageToken).toBeNull()
    const more = await run(search({ client: client(), query: "quarterly", maxResults: 1 }))
    expect(more.nextPageToken).toBe("1")
    const none = await run(search({ client: client(), query: "nothing matches this" }))
    expect(none).toEqual({ records: [], nextPageToken: null })
    const listing = new URL(`http://x${fixture!.requests.at(-1)!.url}`).searchParams
    expect(listing.get("maxResults")).toBe("50")
    expect((await flip(search({ client: client(connection([Capabilities.SCOPE_METADATA])), query: "x" }))).reason)
      .toBe("permission-denied")
  })
})

const runAction = <Success>(
  declaration: {
    readonly name: string
    readonly payloadSchema: unknown
    readonly successSchema: unknown
    readonly errorSchema: unknown
    readonly call: (payload: never) => unknown
  },
  payload: Record<string, unknown>,
  bound: Connection = connection()
): Promise<Success> => {
  const flow = Flow.make(`${declaration.name}/test-flow`, {
    payload: declaration.payloadSchema as never,
    success: declaration.successSchema as never,
    error: declaration.errorSchema as never,
    body: (input: never) => declaration.call(input) as never
  })
  const clientLayer = GmailClient.layer(
    { token, connection: bound, apiBaseUrl: (fixture as Fixture).origin, maxRetries: 0 },
    {}
  )
  const layer = Layer.mergeAll(Actions.layer, Interpreter.layer(flow)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, clientLayer, NodeCrypto.layer))
  )
  return Effect.runPromise(
    flow.execute(payload as never, { executionId: `run-${declaration.name}-${Math.random()}` }).pipe(
      Effect.provide(layer as never),
      Effect.scoped
    ) as unknown as Effect.Effect<Success, unknown>
  )
}

const rejected = async (promise: Promise<unknown>): Promise<any> => {
  const failure: any = await promise.then(() => undefined, (error: unknown) => error)
  return failure?.cause?.error ?? failure?.error ?? failure
}

const compose = (extra: Record<string, unknown> = {}) => ({
  connectionId: "assistant-mail",
  key: "assistant/weekly-summary/2026-09-25",
  to: [{ address: "lead@example.test", name: "Lead" }],
  subject: "Weekly summary",
  text: "Three items shipped.",
  ...extra
})

describe("Gmail durable actions", () => {
  it("sends a message and journals its identity", async () => {
    await start()
    const sent = await runAction<typeof Actions.MessageSent.Type>(Actions.SendMessage, compose())
    const rfc822MessageId = messageIdFor("assistant/weekly-summary/2026-09-25")
    expect(sent).toEqual({
      connectionId: "assistant-mail",
      messageId: "m0001",
      threadId: "tm0001",
      labelIds: ["SENT"],
      rfc822MessageId,
      key: "assistant/weekly-summary/2026-09-25"
    })
    const stored = box.messages.get("m0001")!
    expect(stored.headers).toContainEqual({ name: KEY_HEADER, value: "assistant/weekly-summary/2026-09-25" })
    expect(stored.headers).toContainEqual({ name: "Message-ID", value: rfc822MessageId })
    expect(stored.headers).toContainEqual({ name: "To", value: "\"Lead\" <lead@example.test>" })
  })

  it("creates a draft in a thread", async () => {
    await start()
    const draft = await runAction<typeof Actions.DraftCreated.Type>(
      Actions.CreateDraft,
      compose({ threadId: "t42", key: "assistant/draft-1" })
    )
    expect(draft).toMatchObject({ draftId: "r-m0001", messageId: "m0001", threadId: "t42", key: "assistant/draft-1" })
    expect(JSON.parse(fixture!.requests[0]!.body).message.threadId).toBe("t42")
    expect(box.messages.get("m0001")!.labelIds).toEqual(["DRAFT"])
  })

  for (const lose of ["500", "drop"] as const) {
    it(`reports a lost answer (${lose}) as outcomeUnknown, never resends, and reconciles by key`, async () => {
      await start()
      box.loseNextWrite = lose
      const failure = await rejected(runAction(Actions.SendMessage, compose()))
      expect(failure).toBeInstanceOf(IntegrationFailure)
      expect(failure.outcomeUnknown).toBe(true)
      expect(failure.retryable).toBe(false)
      expect(fixture!.requests.filter((request) => request.method === "POST")).toHaveLength(1)

      // The write happened. The lookup finds exactly it, by key.
      const found = await runAction<typeof Actions.Found.Type>(Actions.FindByKey, {
        connectionId: "assistant-mail",
        key: "assistant/weekly-summary/2026-09-25"
      })
      expect(found).toEqual({
        connectionId: "assistant-mail",
        key: "assistant/weekly-summary/2026-09-25",
        rfc822MessageId: messageIdFor("assistant/weekly-summary/2026-09-25"),
        matches: [{ messageId: "m0001", threadId: "tm0001", labelIds: ["SENT"] }]
      })
      const lookup = fixture!.requests.find((request) => request.url.includes("q="))!
      const params = new URL(`http://x${lookup.url}`).searchParams
      expect(params.get("q")).toBe(queryFor("assistant/weekly-summary/2026-09-25"))
      expect(params.get("includeSpamTrash")).toBe("true")
    })
  }

  it("journals a receipt when Gmail answers with the id alone", async () => {
    await start()
    box.bare = true
    const sent = await runAction<typeof Actions.MessageSent.Type>(Actions.SendMessage, compose())
    expect(sent).toMatchObject({ messageId: "m0001", threadId: null, labelIds: [] })
    const draft = await runAction<typeof Actions.DraftCreated.Type>(
      Actions.CreateDraft,
      compose({ key: "assistant/d" })
    )
    expect(draft).toMatchObject({ draftId: "r-m0002", messageId: "m0002", threadId: null })
    const found = await runAction<typeof Actions.Found.Type>(Actions.FindByKey, {
      connectionId: "assistant-mail",
      key: "assistant/d"
    })
    expect(found.matches).toEqual([{ messageId: "m0002", threadId: "tm0002", labelIds: [] }])
  })

  it("finds nothing for a key never written, and ignores a message whose key header differs", async () => {
    await start()
    const key = "assistant/other"
    box.add("forged", ["INBOX"], {
      headers: [{ name: "Message-ID", value: messageIdFor(key) }, { name: KEY_HEADER, value: "someone-else" }]
    })
    const found = await runAction<typeof Actions.Found.Type>(Actions.FindByKey, { connectionId: "assistant-mail", key })
    expect(found.matches).toEqual([])
    const none = await runAction<typeof Actions.Found.Type>(Actions.FindByKey, {
      connectionId: "assistant-mail",
      key: "assistant/never"
    })
    expect(none.matches).toEqual([])
  })

  it("skips a hit deleted between the search and the read, and refuses a malformed key", async () => {
    await start()
    const key = "assistant/vanishing"
    const stored = box.add("x", ["SENT"], {
      headers: [{ name: "Message-ID", value: messageIdFor(key) }, { name: KEY_HEADER, value: key }]
    })
    box.vanished.add(stored.id)
    expect(await run(findByKey(client(), key))).toEqual([])
    expect((await flip(findByKey(client(), "bad key\r\n"))).reason).toBe("invalid-config")
  })

  it("refuses a CR or LF in a subject or address before anything is sent", async () => {
    await start()
    for (
      const extra of [
        { subject: "Hi\r\nBcc: attacker@example.test" },
        { to: [{ address: "lead@example.test\r\nBcc: attacker@example.test" }] },
        { to: [{ address: "lead@example.test", name: "Lead\nBcc: attacker@example.test" }] }
      ]
    ) {
      const failure = await rejected(runAction(Actions.SendMessage, compose(extra)))
      expect(failure).toBeDefined()
    }
    expect(fixture!.requests).toHaveLength(0)
    expect(box.messages.size).toBe(0)
  })

  it("refuses a payload naming a connection the client is not bound to", async () => {
    await start()
    for (const declaration of [Actions.SendMessage, Actions.CreateDraft]) {
      const failure = await rejected(runAction(declaration, compose({ connectionId: "someone-elses-mail" })))
      expect(failure).toBeInstanceOf(IntegrationFailure)
      expect(failure.reason).toBe("permission-denied")
    }
    const lookup = await rejected(runAction(Actions.FindByKey, { connectionId: "other", key: "k" }))
    expect(lookup.reason).toBe("permission-denied")
    expect(fixture!.requests).toHaveLength(0)
  })

  it("refuses a send the connection's grant does not allow", async () => {
    await start()
    const failure = await rejected(
      runAction(Actions.SendMessage, compose(), connection([Capabilities.SCOPE_READONLY]))
    )
    expect(failure.reason).toBe("permission-denied")
    expect(failure.message).toContain("gmail.send")
    expect(fixture!.requests).toHaveLength(0)
  })

  it("declares its writes irreversible and its lookup sealed", () => {
    expect(Actions.SendMessage.tier).toBe("irreversible")
    expect(Actions.CreateDraft.tier).toBe("irreversible")
    expect(Actions.FindByKey.tier).toBe("sealed")
    expect(Actions.FindByKey.nondeterministic).toBe(true)
  })
})
