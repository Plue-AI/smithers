import { NodeCrypto } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import * as TelegramFlowFile from "../notes/telegram/flow.ts"
import TelegramFlow from "../notes/telegram/flow.ts"
import { cursorOf, header, merge, type Message } from "../notes/telegram/messages.ts"

const fixture = (name: string) => readFile(new URL(`fixtures/${name}`, import.meta.url), "utf8")

/** A dummy token in the Bot API's shape. It is not a credential. */
const token = "123456:TEST_token-not-a-secret"

type Reply = { status: number; body: string }

/**
 * A real local HTTP server that speaks the Bot API's `getMe` and `getUpdates`
 * from recorded fixtures. Like Telegram it drops updates below the requested
 * offset unless `redeliver` is set, and it records every request.
 */
const bot = async (t: TestContext) => {
  const state = {
    updates: (JSON.parse(await fixture("telegram-updates.json")) as { result: Array<{ update_id: number }> }).result,
    me: { status: 200, body: await fixture("telegram-getme.json") } as Reply,
    fail: undefined as Reply | undefined,
    redeliver: false,
    requests: [] as Array<string>
  }
  const server: Server = createServer((request, response) => {
    state.requests.push(`${request.method} ${request.url}`)
    const url = new URL(request.url ?? "/", "http://local")
    const reply = (found: Reply) => {
      response.writeHead(found.status, { "content-type": "application/json" })
      response.end(found.body)
    }
    if (url.pathname !== `/bot${token}/getMe` && url.pathname !== `/bot${token}/getUpdates`) {
      return reply({ status: 404, body: `{"ok":false,"error_code":404,"description":"Not Found"}` })
    }
    if (state.fail !== undefined) return reply(state.fail)
    if (url.pathname.endsWith("/getMe")) return reply(state.me)
    const offset = Number(url.searchParams.get("offset"))
    const limit = Number(url.searchParams.get("limit"))
    const pending = state.updates.filter((update) => state.redeliver || update.update_id >= offset).slice(0, limit)
    reply({ status: 200, body: JSON.stringify({ ok: true, result: pending }) })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { ...state, state, api: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const workspace = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "telegram-flow-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

/** A real in-memory engine running the flow with `implementation`. */
const engine = (t: TestContext, implementation: Layer.Layer<any, never, any>) => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(Interpreter.layer(TelegramFlow), implementation).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    ) as Layer.Layer<any, never, never>
  )
  t.after(() => runtime.dispose())
  return runtime
}

const errorOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  const found = Exit.findErrorOption(exit)
  return found._tag === "Some" ? found.value : undefined
}

const message = (id: number, text: string, chat = -1, at = "2026-09-30T16:00:00Z"): Message => ({
  at: new Date(at),
  chat,
  title: "Chat",
  from: "@a",
  id,
  text
})

const polled = new Date("2026-09-30T17:00:00Z")

test("merge creates its section, lists a message once, keeps hand edits, and replaces failure lines", () => {
  const created = merge("", { bot: "@b", cursor: 5, polled }, [message(1, "hi")], [], "2026-09-30")
  assert.equal(
    created.text,
    `## Telegram\n\n${
      header("@b", 5, polled)
    }\n- 2026-09-30 16:00 · Chat · @a: hi (chat -1 · msg 1)\n<!-- /telegram -->\n`
  )
  assert.equal(created.added, 1)
  assert.equal(cursorOf(created.text), 5)
  assert.equal(cursorOf("# nothing\n"), 0)

  // A message delivered again, in one batch or across runs, is not listed twice.
  const again = merge(
    created.text,
    { bot: "@b", cursor: 5, polled },
    [message(1, "hi"), message(1, "hi")],
    [],
    "2026-09-30"
  )
  assert.deepEqual([again.added, again.text], [0, created.text])

  // The same message id in another chat is another message.
  const other = merge(created.text, { bot: "@b", cursor: 6, polled }, [message(1, "hi", -2)], [], "2026-09-30")
  assert.equal(other.added, 1)

  // Hand edits inside the block and prose around it survive, and lines stay in time order.
  const edited = created.text.replace("hi (chat", "hi ✔ (chat").replace("## Telegram\n", "# T\n\n## Telegram\nMine.\n")
  const next = merge(
    edited,
    { bot: "@b", cursor: 8, polled },
    [message(2, "early", -1, "2026-09-30T15:00:00Z")],
    [],
    "2026-09-30"
  )
  assert.match(next.text, /^# T\n\n## Telegram\nMine\.\n\n<!-- telegram bot=@b cursor=8 /)
  assert.match(next.text, /15:00 · Chat · @a: early[^\n]*\n- 2026-09-30 16:00 · Chat · @a: hi ✔ \(chat/)

  // A failed poll keeps the header and its cursor, adds one failure line, and the next success clears it.
  const failed = merge(next.text, undefined, [], ["HTTP 503"], "2026-10-01")
  assert.match(failed.text, /cursor=8 [^\n]*\n[\s\S]*\n- failed 2026-10-01: HTTP 503\n<!-- \/telegram -->/)
  assert.equal(merge(failed.text, undefined, [], ["HTTP 503"], "2026-10-01").text, failed.text)
  const recovered = merge(failed.text, { bot: "@b", cursor: 8, polled }, [], [], "2026-10-01")
  assert.doesNotMatch(recovered.text, /failed/)

  // The cursor never moves backwards.
  assert.equal(cursorOf(merge(next.text, { bot: "@b", cursor: 2, polled }, [], [], "2026-10-01").text), 8)
})

test("the flow records messages once, advances the cursor, and stays idempotent", { timeout: 60_000 }, async (t) => {
  const root = await workspace(t)
  const telegram = await bot(t)
  let now = new Date("2026-09-30T17:00:00Z")
  const runtime = engine(
    t,
    TelegramFlowFile.make({ root, fetch: globalThis.fetch, now: () => now, api: telegram.api, token: () => token })
  )
  await writeFile(join(root, "Telegram.md"), "# Telegram\n")
  const payload = { note: "Telegram.md" }

  const first = await runtime.runPromise(TelegramFlow.execute(payload, { executionId: "telegram-1" }))
  assert.deepEqual(first, { note: "Telegram.md", added: 4, cursor: 900007, changed: true, failures: [] })
  const written = await readFile(join(root, "Telegram.md"), "utf8")
  assert.equal(
    written,
    `# Telegram\n\n## Telegram\n\n<!-- telegram bot=@smithers_community_bot cursor=900007 polled=2026-09-30T17:00Z -->\n` +
      `- 2026-09-30 16:02 · Smithers Community · @alice_dev: How do I resume a run after a restart? (chat -1001234567890 · msg 41)\n` +
      `- 2026-09-30 16:05 · Smithers Community · Bob: Try \\\`smthrs runs resume\\\` — see \\[docs\\]\\(https://evil.example) \\<!-- /telegram --\\> (chat -1001234567890 · msg 42)\n` +
      `- 2026-09-30 16:06 · Will · Will: private note to the bot (chat 333 · msg 7)\n` +
      `- 2026-09-30 16:08 · Smithers News · Smithers News: Release 1.0 photo (chat -1009876543210 · msg 9)\n` +
      `<!-- /telegram -->\n`
  )
  assert.doesNotMatch(written, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.equal(written.split("<!-- /telegram -->").length, 2)

  // A repeated input at the same instant edits nothing and asks only for what follows the cursor.
  const repeat = await runtime.runPromise(TelegramFlow.execute(payload, { executionId: "telegram-2" }))
  assert.deepEqual(repeat, { note: "Telegram.md", added: 0, cursor: 900007, changed: false, failures: [] })
  assert.equal(await readFile(join(root, "Telegram.md"), "utf8"), written)
  assert.match(telegram.requests.at(-1)!, /getUpdates\?offset=900007&limit=100&timeout=0&allowed_updates=/)

  // A later poll refreshes freshness only; a new message is the only line added.
  now = new Date("2026-09-30T23:00:00Z")
  telegram.updates.push(JSON.parse(
    `{"update_id":900007,"message":{"message_id":44,"from":{"id":111,"is_bot":false,"first_name":"Alice","username":"alice_dev"},"chat":{"id":-1001234567890,"title":"Smithers Community","type":"supergroup"},"date":1790809200,"text":"Thanks, that worked"}}`
  ))
  const later = await runtime.runPromise(TelegramFlow.execute(payload, { executionId: "telegram-3" }))
  assert.deepEqual(later, { note: "Telegram.md", added: 1, cursor: 900008, changed: true, failures: [] })
  const note = await readFile(join(root, "Telegram.md"), "utf8")
  assert.match(note, /cursor=900008 polled=2026-09-30T23:00Z/)
  assert.equal(note.match(/\(chat -?\d+ · msg \d+\)/g)?.length, 5)

  // Every request was a read, and only the two read methods were used.
  assert.equal(telegram.requests.every((request) => request.startsWith("GET ")), true)
  assert.equal(telegram.requests.every((request) => /\/(getMe|getUpdates)(\?|$)/.test(request)), true)
})

test(
  "a poll that failed before the note was written is redelivered without duplicates",
  { timeout: 60_000 },
  async (t) => {
    const root = await workspace(t)
    const telegram = await bot(t)
    telegram.state.redeliver = true // Telegram has not seen a higher offset, so it sends the same updates again.
    const runtime = engine(
      t,
      TelegramFlowFile.make({
        root,
        fetch: globalThis.fetch,
        now: () => new Date("2026-09-30T17:00:00Z"),
        api: telegram.api,
        token: () => token
      })
    )
    const run = (id: string) => runtime.runPromise(TelegramFlow.execute({ note: "T.md" }, { executionId: id }))
    const first = await run("redeliver-1")
    const written = await readFile(join(root, "T.md"), "utf8")
    const second = await run("redeliver-2")
    assert.equal(first.added, 4)
    assert.equal(second.added, 0)
    assert.equal(await readFile(join(root, "T.md"), "utf8"), written)
  }
)

test(
  "a chat allowlist keeps only those chats but still moves the cursor past the rest",
  { timeout: 60_000 },
  async (t) => {
    const root = await workspace(t)
    const telegram = await bot(t)
    const runtime = engine(
      t,
      TelegramFlowFile.make({
        root,
        fetch: globalThis.fetch,
        now: () => new Date("2026-09-30T17:00:00Z"),
        api: telegram.api,
        token: () => token
      })
    )
    const receipt = await runtime.runPromise(
      TelegramFlow.execute({ note: "T.md", chats: [333] }, { executionId: "chats-1" })
    )
    assert.deepEqual([receipt.added, receipt.cursor], [1, 900007])
    const note = await readFile(join(root, "T.md"), "utf8")
    assert.match(note, /private note to the bot/)
    assert.doesNotMatch(note, /Smithers Community|Smithers News/)
  }
)

test("a full batch is followed by the next one", { timeout: 60_000 }, async (t) => {
  const root = await workspace(t)
  const telegram = await bot(t)
  telegram.state.updates = Array.from({ length: 150 }, (_, index) => ({
    update_id: 1000 + index,
    message: {
      message_id: index + 1,
      from: { username: "u" },
      chat: { id: 5, title: "Big" },
      date: 1790784120 + index,
      text: `m${index}`
    }
  }))
  const runtime = engine(
    t,
    TelegramFlowFile.make({
      root,
      fetch: globalThis.fetch,
      now: () => new Date("2026-09-30T17:00:00Z"),
      api: telegram.api,
      token: () => token
    })
  )
  const receipt = await runtime.runPromise(TelegramFlow.execute({ note: "T.md" }, { executionId: "batch-1" }))
  assert.deepEqual([receipt.added, receipt.cursor], [150, 1150])
  assert.deepEqual(
    telegram.requests.filter((request) => request.includes("getUpdates")).map((request) =>
      /offset=(\d+)/.exec(request)![1]
    ),
    ["0", "1100"]
  )
})

test("a failed poll is visible in the note and fails the run, without token or response text", {
  timeout: 60_000
}, async (t) => {
  const root = await workspace(t)
  const telegram = await bot(t)
  let now = new Date("2026-09-30T17:00:00Z")
  const implementation = (fetch: typeof globalThis.fetch, secret: string | undefined) =>
    TelegramFlowFile.make({ root, fetch, now: () => now, api: telegram.api, token: () => secret })
  let runtime = engine(t, implementation(globalThis.fetch, token))
  const payload = { note: "T.md" }
  const clean = await runtime.runPromise(TelegramFlow.execute(payload, { executionId: "fail-0" }))
  const before = await readFile(join(root, "T.md"), "utf8")

  now = new Date("2026-10-01T09:00:00Z")
  telegram.state.fail = { status: 401, body: `{"ok":false,"error_code":401,"description":"Unauthorized ${token}"}` }
  const failed = await runtime.runPromiseExit(TelegramFlow.execute(payload, { executionId: "fail-1" }))
  assert.deepEqual(errorOf(failed), {
    note: "T.md",
    added: 0,
    cursor: clean.cursor,
    changed: true,
    failures: ["HTTP 401"]
  })
  const note = await readFile(join(root, "T.md"), "utf8")
  assert.equal(note, before.replace("<!-- /telegram -->", "- failed 2026-10-01: HTTP 401\n<!-- /telegram -->"))
  assert.doesNotMatch(note, /Unauthorized/)

  // A 200 that is not the Bot API's shape, and one Telegram refuses, are named as such.
  telegram.state.fail = { status: 200, body: "<html>proxy</html>" }
  assert.deepEqual(
    (errorOf(await runtime.runPromiseExit(TelegramFlow.execute(payload, { executionId: "fail-2" }))) as any).failures,
    ["not a Telegram response"]
  )
  telegram.state.fail = { status: 200, body: `{"ok":false,"description":"Conflict"}` }
  assert.deepEqual(
    (errorOf(await runtime.runPromiseExit(TelegramFlow.execute(payload, { executionId: "fail-3" }))) as any).failures,
    ["refused by Telegram"]
  )
  telegram.state.fail = { status: 200, body: `{"ok":true,"result":{"not":"a list"}}` }
  telegram.state.me = { status: 200, body: `{"ok":true,"result":{"username":"bad name!"}}` }
  assert.deepEqual(
    (errorOf(await runtime.runPromiseExit(TelegramFlow.execute(payload, { executionId: "fail-4" }))) as any).failures,
    ["not a Telegram response"]
  )

  // The source recovers: the failure line is gone and nothing else was lost.
  telegram.state.fail = undefined
  telegram.state.me = { status: 200, body: await fixture("telegram-getme.json") }
  const recovered = await runtime.runPromise(TelegramFlow.execute(payload, { executionId: "fail-5" }))
  assert.deepEqual([recovered.added, recovered.failures], [0, []])
  const healed = await readFile(join(root, "T.md"), "utf8")
  assert.doesNotMatch(healed, /failed/)
  assert.equal(healed.match(/\(chat -?\d+ · msg \d+\)/g)?.length, 4)

  // An unreachable Bot API is named without any error text.
  runtime = engine(
    t,
    TelegramFlowFile.make({
      root,
      fetch: globalThis.fetch,
      now: () => now,
      api: "http://127.0.0.1:1",
      token: () => token
    })
  )
  const down = await runtime.runPromiseExit(TelegramFlow.execute(payload, { executionId: "fail-6" }))
  assert.deepEqual((errorOf(down) as any).failures, ["unreachable"])
  assert.doesNotMatch(await readFile(join(root, "T.md"), "utf8"), /127\.0\.0\.1/)
})

test("a missing or malformed token fails visibly and sends no request", { timeout: 60_000 }, async (t) => {
  const root = await workspace(t)
  const telegram = await bot(t)
  for (
    const [secret, reason] of [[undefined, "no bot token"], ["  ", "no bot token"], [
      "x/../y",
      "invalid bot token"
    ]] as const
  ) {
    const runtime = engine(
      t,
      TelegramFlowFile.make({
        root,
        fetch: globalThis.fetch,
        now: () => new Date("2026-09-30T17:00:00Z"),
        api: telegram.api,
        token: () => secret
      })
    )
    const exit = await runtime.runPromiseExit(
      TelegramFlow.execute({ note: "T.md" }, { executionId: `token-${reason}-${secret}` })
    )
    assert.deepEqual((errorOf(exit) as any).failures, [reason])
  }
  assert.deepEqual(telegram.requests, [])
  assert.match(await readFile(join(root, "T.md"), "utf8"), /- failed 2026-09-30: invalid bot token/)
})

test("the telegram flow refuses notes outside the workspace before any request", { timeout: 60_000 }, async (t) => {
  const root = await workspace(t)
  const outside = await workspace(t)
  await mkdir(join(root, "linked"))
  await symlink(outside, join(root, "escape"))
  await symlink(join(outside, "x.md"), join(root, "linked", "x.md"))
  const telegram = await bot(t)
  const runtime = engine(
    t,
    TelegramFlowFile.make({
      root,
      fetch: globalThis.fetch,
      now: () => new Date(),
      api: telegram.api,
      token: () => token
    })
  )
  const refused = async (payload: { note: string; chats?: Array<number> }, id: string) =>
    errorOf(await runtime.runPromiseExit(TelegramFlow.execute(payload, { executionId: id })))
  assert.equal(await refused({ note: "../x.md" }, "r1"), "note must stay inside the workspace")
  assert.equal(await refused({ note: join(outside, "x.md") }, "r2"), "note must be a relative .md path")
  assert.equal(await refused({ note: "escape/x.md" }, "r3"), "note must stay inside the workspace")
  assert.equal(await refused({ note: "linked/x.md" }, "r4"), "note must be a regular file")
  assert.equal(await refused({ note: "T.txt" }, "r5"), "note must be a relative .md path")
  assert.equal(await refused({ note: "T.md", chats: [1.5] }, "r6") !== undefined, true)
  assert.deepEqual(telegram.requests, [])
  await assert.rejects(readFile(join(outside, "x.md")), { code: "ENOENT" })
})
