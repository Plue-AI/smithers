import * as Model from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import type { JsonObject, ModelRequest } from "@smthrs/model/ModelRequest"
import { commandsToolSpec, unknownCommandResult } from "@smthrs/rpc/AgentCommands"
import { MAX_TOOL_LEGS } from "@smthrs/rpc/AgentToolResult"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnCursor } from "@smthrs/rpc/AgentTurnJournal"
import { fixtures } from "@smthrs/rpc/fixtures/Todo"
import { AgentTurnFrameSchema } from "@smthrs/rpc/NativeAgent"
import type { AgentTurnFrame, FetchLike, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import { Effect, Stream } from "effect"
import { createHash } from "node:crypto"
import { describe, expect, test } from "vitest"
import { runDurableChatTurn } from "../src/DurableChatProducer.ts"
import type { DurableChatGrant } from "../src/DurableChatProducer.ts"

// Literal fixtures: the question, main's commit and JOURNEY.md's one line.
const COMMIT = "0123456789abcdef0123456789abcdef01234567"
const JOURNEY = "Add a greeting to JOURNEY.md\n"
const question: StartAgentTurnRequest = {
  runId: "run",
  instructions: "Answer briefly using file cards.",
  messages: [{ role: "user", content: "What is in JOURNEY.md?" }]
}
const cursor: AgentTurnCursor = { version: 1, runId: "run", legId: "leg", batch: 0, position: 0, hash: "a".repeat(64) }
const grant: DurableChatGrant = {
  turnId: "0b6c3f6e-56f1-4ad4-9f87-0d1c3c1f7a10",
  ownerId: 7,
  runId: "run",
  legId: "leg",
  generation: 2,
  token: "producer_capability_producer_capability_1234",
  cursor,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  request: question,
  producerBaseUrl: "http://callback.test/",
  source: { repository: "acme/app" }
}

/** The grant before Source is ready for the author: it names no source. */
const { source: _source, ...sourceless } = grant

/** An install turn its author's browser session admitted: it reads main and the install's TODOs as them. */
const install: DurableChatGrant = { ...grant, api: { author: "ben" } }

interface SourceCall {
  readonly authorization: string | null
  readonly body: unknown
}

/** The install's TODO routes as the API callback answers them: the route's status and body. */
const routes = (todos: Record<string, readonly [number, unknown]>) => (path: string): Response => {
  const [status, body] = todos[path] ?? [404, { code: "not_found", class: "user", message: "Not Found" }]
  return Response.json({ status, body })
}

/** The producer's journal and its source read and API callbacks, recording what the host sent. */
const producer = (answer: (path: string) => Response, api: (path: string) => Response = routes({})) => {
  const frames: Array<AgentTurnFrame> = []
  const reads: Array<SourceCall> = []
  const calls: Array<SourceCall> = []
  let expected = cursor
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === "/internal/chat/provider-started") return new Response(null, { status: 204 })
    const body = JSON.parse(String(init?.body))
    if (url.pathname === "/internal/chat/source/read") {
      reads.push({ authorization: new Headers(init?.headers).get("authorization"), body })
      return answer(body.path)
    }
    if (url.pathname === "/internal/chat/api") {
      calls.push({ authorization: new Headers(init?.headers).get("authorization"), body })
      return api(body.path)
    }
    const frame = body.frames[0] as AgentTurnFrame
    frames.push(frame)
    const unsigned = {
      version: 1 as const,
      runId: "run",
      legId: "leg",
      batch: expected.batch + 1,
      from: expected.position + 1,
      previousHash: expected.hash,
      frames: [frame]
    }
    const hash = createHash("sha256").update(agentTurnJournalDigestInput("batch", unsigned)).digest("hex")
    expected = { version: 1, runId: "run", legId: "leg", batch: unsigned.batch, position: unsigned.from, hash }
    return Response.json({ status: "committed", batch: { ...unsigned, hash }, cursor: expected })
  }
  return { frames, reads, calls, fetchImpl }
}

const file = (path: string, content: string, binary = false): Response =>
  Response.json({ repository: "acme/app", path, commit: COMMIT, content, binary })

interface LegUsage {
  readonly tool?: ModelEvent.UsageEvent | undefined
  readonly answer?: ModelEvent.UsageEvent | undefined
}

const reported: LegUsage = {
  tool: { type: "usage", inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
  answer: { type: "usage", inputTokens: 30, outputTokens: 5 }
}

/** A provider that asks for one tool call per leg until a tool result is in its context, then answers from it. */
const model = (
  calls: ReadonlyArray<{ readonly name: string; readonly arguments: string }>,
  usage: LegUsage = reported
) => {
  const requests: Array<ModelRequest> = []
  const leg = (request: ModelRequest): ReadonlyArray<ModelEvent.ModelEvent> => {
    const results = request.messages.flatMap((message) => message.role === "tool" ? [message] : [])
    const call = calls[results.length]
    if (call === undefined) {
      const said = results.at(-1)?.content.at(-1)?.content ?? "nothing read"
      return [
        { type: "text-delta", id: "t", text: `From the source: ${said}` },
        ...(usage.answer === undefined ? [] : [usage.answer]),
        { type: "settle", stopReason: "stop" }
      ]
    }
    const id = `call-${results.length}`
    return [
      { type: "tool-call-start", id, name: call.name },
      { type: "tool-call-end", id, arguments: call.arguments },
      ...(usage.tool === undefined ? [] : [usage.tool]),
      { type: "settle", stopReason: "tool-calls" }
    ]
  }
  return {
    requests,
    model: Model.make({
      stream: (request) => {
        requests.push(request)
        return Stream.fromIterable(leg(request))
      }
    })
  }
}

const run = (turn: DurableChatGrant, provider: ReturnType<typeof model>, journal: ReturnType<typeof producer>) =>
  Effect.runPromise(
    runDurableChatTurn(provider.model, turn, { modelId: "m" }, "http://callback.test", journal.fetchImpl)
  )

const toolNames = (request: ModelRequest | undefined): ReadonlyArray<string> =>
  (request?.tools ?? []).map((tool) => tool.name)

/** A `commands` call that executes one command with argument text. */
const execute = (name: string, args?: string) => ({
  name: "commands",
  arguments: JSON.stringify({ action: "execute", name, ...(args === undefined ? {} : { args }) })
})
const readCall = (args: string) => execute("files.read", args)

const answerText = (frames: ReadonlyArray<AgentTurnFrame>): string =>
  frames.flatMap((frame) => frame.type === "delta" && frame.kind === "text" ? [frame.text] : []).join("")

const systemText = (request: ModelRequest | undefined): string =>
  (request?.system ?? []).map((part) => part.text).join("\n")

/** The model's copy of each tool result, in the order the last leg read them. */
const toolOutputs = (provider: ReturnType<typeof model>): ReadonlyArray<string> =>
  provider.requests.at(-1)?.messages.flatMap((message) =>
    message.role === "tool" ? message.content.map((part) => String(part.content)) : []
  ) ?? []

/** Literal TODO models, as the install's routes serve them: T12 queued, T13 merged, T14 dropped, T15 working. */
const queued: TodoCard = fixtures.queued.model
const merged: TodoCard = { ...fixtures.merged.model, n: 13, title: "Merged work" }
const dropped: TodoCard = { ...fixtures.dropped.model, n: 14, title: "Dropped work" }
const working: TodoCard = { ...fixtures.working.model, n: 15, title: "Log retry counts", place: 2 }
const stackRoutes = routes({
  "/api/todos": [200, [queued, merged, dropped, working]],
  "/api/todos/12": [200, queued],
  "/api/todos/99": [404, { code: "todo_not_found", class: "user", message: "TODO not found" }]
})

/** The instructions' command lines for each grant, literal. */
const FILES_LINE =
  "- /files.read <path>[:<line>[:<col>]] [owner/repo] [--ref <revision>] — Read a file from a repository"
const TODO_LINES = [
  "- /stack — Show the stack and background runs",
  "- /todo <Tn> — Open a TODO",
  "- /todo.new [text] — Write and place a TODO (asks the person: it shows them what to confirm and files nothing)"
]
const commandLines = (text: string): ReadonlyArray<string> => text.split("\n").filter((line) => line.startsWith("- /"))

describe("host-owned turns run their tool calls on the host", () => {
  test("a question reads main through the producer, shows a File card and answers from the file", async () => {
    const journal = producer((path) => file(path, JOURNEY))
    const provider = model([readCall("JOURNEY.md")])
    await run(grant, provider, journal)

    expect(journal.reads).toEqual([{
      authorization: "Bearer producer_capability_producer_capability_1234",
      body: { turnId: grant.turnId, generation: 2, path: "JOURNEY.md" }
    }])
    expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "card", "call.settled", "delta", "done"])
    for (const frame of journal.frames) expect(AgentTurnFrameSchema.safeParse(frame).success).toBe(true)
    expect(journal.frames[0]).toEqual({ runId: "run", type: "call.started", link: 0, ordinal: 0, name: "files.read" })
    expect(journal.frames[1]).toMatchObject({
      runId: "run",
      type: "card",
      card: {
        id: "file-acme/app-JOURNEY.md",
        kind: "file",
        title: "File · acme/app · JOURNEY.md",
        status: "active",
        ordinal: 0,
        payload: {
          repo: "acme/app",
          path: "JOURNEY.md",
          content: JOURNEY,
          truncated: false,
          address: "/acme/app/JOURNEY.md",
          readAt: { changeId: null, commitId: COMMIT, source: "head" }
        }
      }
    })
    expect(journal.frames[2]).toEqual({
      runId: "run",
      type: "call.settled",
      link: 0,
      ordinal: 0,
      name: "files.read",
      verdict: "run"
    })
    // The continuation carries the call and the file's text, so the answer is grounded in it.
    expect(answerText(journal.frames)).toBe(`From the source: JOURNEY.md in acme/app:\n${JOURNEY}`)
    expect(journal.frames.at(-1)).toEqual({
      runId: "run",
      type: "done",
      reason: "stop",
      usage: { inputTokens: 40, outputTokens: 7, cachedInputTokens: 4 }
    })
    expect(provider.requests).toHaveLength(2)
    // The app agent's one tool, the same contract the browser offers.
    expect(provider.requests[0]?.tools).toHaveLength(1)
    expect(toolNames(provider.requests[0])).toEqual(["commands"])
    expect(provider.requests[0]?.tools[0]?.parameters as JsonObject).toEqual(commandsToolSpec.parameters)
    expect(provider.requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    // No renderer tool loop is asked to continue: no tool_call frame is committed.
    expect(journal.frames.some((frame) => frame.type === "tool_call")).toBe(false)
  })

  test("the list action answers the commands this host runs", async () => {
    const listing = JSON.stringify({
      commands: [{
        name: "files.read",
        summary: "Read a file from a repository",
        args: "<path>[:<line>[:<col>]] [owner/repo] [--ref <revision>]"
      }]
    })
    for (
      const [listed, answer] of [
        [{ action: "list" }, listing],
        [{ action: "list", namespace: "files" }, listing],
        [{ action: "list", namespace: "/files." }, listing],
        [{ action: "list", query: "read a file" }, listing],
        [{ action: "list", namespace: "repo" }, JSON.stringify({ commands: [] })]
      ] as const
    ) {
      const journal = producer((path) => file(path, JOURNEY))
      await run(grant, model([{ name: "commands", arguments: JSON.stringify(listed) }]), journal)
      expect(journal.reads).toEqual([])
      expect(journal.frames.map((frame) => frame.type)).toEqual(["delta", "done"])
      expect(answerText(journal.frames)).toBe(`From the source: ${answer}`)
    }
  })

  test("the command takes the flow's own arguments: a slash name, a line anchor and a quoted path", async () => {
    const journal = producer((path) => file(path, JOURNEY))
    await run(
      grant,
      model([execute("/files.read", "docs/guide.md:3:2 acme/app"), execute("files.read", "\"docs/Meeting Notes.md\"")]),
      journal
    )
    expect(journal.reads.map((call) => (call.body as { path: string }).path)).toEqual([
      "docs/guide.md",
      "docs/Meeting Notes.md"
    ])
    const cards = journal.frames.flatMap((frame) => frame.type === "card" ? [frame.card] : [])
    expect(cards.map((card) => [card.id, card.payload])).toMatchObject([
      ["file-acme/app-docs/guide.md", { path: "docs/guide.md", line: 3, column: 2 }],
      ["file-acme/app-docs/Meeting Notes.md", { path: "docs/Meeting Notes.md" }]
    ])
    expect(cards[1]?.payload).not.toHaveProperty("line")
  })

  test("binary files are stated and long files are cut at the card cap", async () => {
    const long = "x".repeat(16 * 1024 + 9)
    const journal = producer((path) => path === "logo.png" ? file(path, "", true) : file(path, long))
    const provider = model([readCall("logo.png:4"), readCall("big.txt")])
    await run(grant, provider, journal)
    const cards = journal.frames.flatMap((frame) => frame.type === "card" ? [frame.card] : [])
    expect(cards.map((card) => card.payload)).toEqual([
      {
        repo: "acme/app",
        path: "logo.png",
        content: "",
        truncated: false,
        binary: true,
        address: "/acme/app/logo.png",
        readAt: { changeId: null, commitId: COMMIT, source: "head" }
      },
      {
        repo: "acme/app",
        path: "big.txt",
        content: "x".repeat(16 * 1024),
        truncated: true,
        address: "/acme/app/big.txt",
        readAt: { changeId: null, commitId: COMMIT, source: "head" }
      }
    ])
    expect(cards.map((card) => card.ordinal)).toEqual([0, 1])
    const outputs =
      provider.requests[2]?.messages.flatMap((message) =>
        message.role === "tool" ? message.content.map((part) => part.content) : []
      ) ?? []
    expect(outputs[0]).toBe("logo.png in acme/app is a binary file; its bytes are not shown.")
    // The model's copy is bounded to the shared tool result limit.
    expect(new TextEncoder().encode(outputs[1]).byteLength).toBeLessThanOrEqual(16 * 1024)
    expect(outputs[1]).toContain(
      "big.txt in acme/app (truncated at the card cap; the rest stays in the repository):\nxxx"
    )
    expect(outputs[1]).toContain("Tool result truncated")
  })

  test("each refusal is stated to the model and the conversation, and the turn answers", async () => {
    const codes: Record<string, [number, string]> = {
      "../secret": [400, "path_refused"],
      "link": [404, "not_found"],
      "big.bin": [413, "too_large"],
      "private.md": [403, "forbidden"],
      "mirror.md": [409, "source_not_ready"],
      "down.md": [503, "source_failed"]
    }
    const said: Record<string, string> = {
      "../secret":
        "../secret is not a path inside this repository. Name a file by its path from the repository root, for example src/index.ts.",
      "link": "link is not a file on main.",
      "big.bin": "big.bin is larger than the repository read limit, so it is not shown.",
      "private.md": "The person who asked can't read this repository.",
      "mirror.md":
        "The repository's source isn't ready yet: setup is still mirroring main. Ask again once Source ready shows in setup.",
      "down.md": "The repository read did not answer. Ask again."
    }
    for (const [path, [status, code]] of Object.entries(codes)) {
      const journal = producer(() => Response.json({ status: "error", code }, { status }))
      const provider = model([readCall(path)])
      await run(grant, provider, journal)
      expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "gate.rejected", "delta", "done"])
      expect(journal.frames[1]).toEqual({
        runId: "run",
        type: "gate.rejected",
        link: 0,
        kind: "call_failed",
        message: said[path]
      })
      expect(answerText(journal.frames)).toBe(`From the source: failed: ${said[path]}`)
      expect(journal.frames.at(-1)).toMatchObject({ type: "done", reason: "stop" })
    }
  })

  test("a read that does not answer is stated, and the turn answers", async () => {
    const unanswered = "failed: The repository read did not answer. Ask again."
    const answers: ReadonlyArray<() => Response> = [
      () => {
        throw new TypeError("fetch failed")
      },
      () => new Response("<html>bad gateway</html>", { status: 502 }),
      () => Response.json({ repository: "acme/app", path: "JOURNEY.md" })
    ]
    for (const answer of answers) {
      const journal = producer(answer)
      await run(grant, model([readCall("JOURNEY.md")]), journal)
      expect(journal.reads).toHaveLength(1)
      expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "gate.rejected", "delta", "done"])
      expect(answerText(journal.frames)).toBe(`From the source: ${unanswered}`)
    }
    // A refused path is quoted by its head, never whole.
    const long = "a/".repeat(150) + "b"
    const journal = producer(() => Response.json({ status: "error", code: "path_refused" }, { status: 400 }))
    await run(grant, model([readCall(long)]), journal)
    expect(journal.frames[1]).toMatchObject({
      type: "gate.rejected",
      message: `${
        long.slice(0, 200)
      }… is not a path inside this repository. Name a file by its path from the repository root, for example src/index.ts.`
    })
  })

  test("the terminal frame states the counts every leg reported", async () => {
    const read = readCall("JOURNEY.md")
    const cases: ReadonlyArray<[LegUsage, unknown]> = [
      [{ tool: reported.tool }, { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 }],
      [{ answer: reported.answer }, { inputTokens: 30, outputTokens: 5 }],
      [{ tool: { type: "usage", inputTokens: 10, outputTokens: 2 }, answer: reported.answer }, {
        inputTokens: 40,
        outputTokens: 7
      }],
      [
        {
          tool: { type: "usage", inputTokens: 10, outputTokens: 2 },
          answer: { type: "usage", inputTokens: 30, outputTokens: 5, cachedInputTokens: 3 }
        },
        { inputTokens: 40, outputTokens: 7, cachedInputTokens: 3 }
      ],
      [{}, undefined]
    ]
    for (const [usage, total] of cases) {
      const journal = producer((path) => file(path, JOURNEY))
      await run(grant, model([read], usage), journal)
      expect(journal.frames.at(-1)).toEqual({
        runId: "run",
        type: "done",
        reason: "stop",
        ...(total === undefined ? {} : { usage: total })
      })
    }
  })

  test("calls the host cannot run never reach the producer", async () => {
    const commandFailures: ReadonlyArray<[{ readonly name: string; readonly arguments: string }, string]> = [
      [{ name: "commands", arguments: "not json" }, "failed: the commands tool arguments were not valid JSON"],
      [{ name: "commands", arguments: "[]" }, "failed: the commands tool arguments must be an object"],
      [
        { name: "commands", arguments: JSON.stringify({ action: "run" }) },
        "failed: the commands tool action must be \"list\" or \"execute\""
      ],
      [
        { name: "commands", arguments: JSON.stringify({ action: "execute", name: "/" }) },
        "failed: the execute action requires a command name"
      ],
      [
        execute("files.write", "JOURNEY.md"),
        "unknown-command: files.write — no command has that name; use the list action for every command callable right now"
      ],
      [{ name: "shell", arguments: JSON.stringify({ command: "rm -rf /" }) }, "unknown-tool: shell"],
      [{ name: "files_read", arguments: JSON.stringify({ path: "JOURNEY.md" }) }, "unknown-tool: files_read"]
    ]
    for (const [call, output] of commandFailures) {
      const journal = producer((path) => file(path, JOURNEY))
      await run(grant, model([call]), journal)
      expect(journal.reads).toEqual([])
      // Nothing ran, so the journal records no call.
      expect(journal.frames.map((frame) => frame.type)).toEqual(["delta", "done"])
      expect(answerText(journal.frames)).toBe(`From the source: ${output}`)
    }
    const refusedReads: ReadonlyArray<[string | undefined, string]> = [
      [undefined, "files.read needs a file path"],
      ["\"unfinished", "Close the quoted file argument before the next argument."],
      ["a b c", "files.read takes a path and optionally an owner/repo"],
      ["JOURNEY.md:0", "files.read lines and columns count from 1: /files.read <path>[:<line>[:<col>]]"],
      ["JOURNEY.md other/repo", "This question reads acme/app only; name a file in it."],
      ["JOURNEY.md --ref feature", "This question reads main only; ask without --ref."]
    ]
    for (const [args, message] of refusedReads) {
      const journal = producer((path) => file(path, JOURNEY))
      await run(grant, model([execute("files.read", args)]), journal)
      expect(journal.reads).toEqual([])
      expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "gate.rejected", "delta", "done"])
      expect(journal.frames[1]).toMatchObject({ type: "gate.rejected", kind: "call_failed", message })
      expect(answerText(journal.frames)).toBe(`From the source: failed: ${message}`)
    }
  })

  test("a turn whose grant names no source is offered no tool and runs none", async () => {
    const journal = producer((path) => file(path, JOURNEY))
    const provider = model([readCall("JOURNEY.md")])
    await run(sourceless, provider, journal)
    expect(toolNames(provider.requests[0])).toEqual([])
    expect(journal.reads).toEqual([])
    expect(journal.frames.map((frame) => frame.type)).toEqual(["delta", "done"])
    expect(answerText(journal.frames)).toBe("From the source: unknown-tool: commands")
  })

  test("a turn still calling tools after the leg bound ends at the tool limit", async () => {
    const journal = producer((path) => file(path, JOURNEY))
    const provider = model(Array.from({ length: MAX_TOOL_LEGS + 1 }, () => readCall("JOURNEY.md")))
    await run(grant, provider, journal)
    expect(provider.requests).toHaveLength(MAX_TOOL_LEGS)
    expect(journal.reads).toHaveLength(MAX_TOOL_LEGS - 1)
    expect(journal.frames.at(-1)).toEqual({
      runId: "run",
      type: "done",
      reason: "tool_limit",
      usage: {
        inputTokens: 10 * MAX_TOOL_LEGS,
        outputTokens: 2 * MAX_TOOL_LEGS,
        cachedInputTokens: 4 * MAX_TOOL_LEGS
      }
    })
    // A provider that reports no counts ends the turn without any.
    const silent = producer((path) => file(path, JOURNEY))
    await run(grant, model(Array.from({ length: MAX_TOOL_LEGS }, () => readCall("JOURNEY.md")), {}), silent)
    expect(silent.frames.at(-1)).toEqual({ runId: "run", type: "done", reason: "tool_limit" })
  })

  test("a renderer's turn offers no host tool and keeps its tool calls", async () => {
    const journal = producer((path) => file(path, JOURNEY))
    const provider = model([{ name: "commands", arguments: JSON.stringify({ action: "list" }) }])
    await run({ ...grant, request: { ...question, tools: [commandsToolSpec] } }, provider, journal)
    expect(toolNames(provider.requests[0])).toEqual(["commands"])
    expect(provider.requests).toHaveLength(1)
    expect(journal.reads).toEqual([])
    expect(journal.frames.map((frame) => frame.type)).toEqual(["tool_call", "done"])
    expect(journal.frames.at(-1)).toMatchObject({ type: "done", reason: "tool_call" })
  })
})

describe("an install's host runs the catalog commands its grant allows, as the turn's author", () => {
  test("the instructions and the list name exactly the commands the grant runs, never the request's own", async () => {
    const cases: ReadonlyArray<[DurableChatGrant, ReadonlyArray<string>]> = [
      [install, [FILES_LINE, ...TODO_LINES]],
      [grant, [FILES_LINE]],
      [{ ...sourceless, api: { author: "ben" } }, TODO_LINES]
    ]
    for (const [turn, lines] of cases) {
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      const provider = model([{ name: "commands", arguments: JSON.stringify({ action: "list" }) }])
      await run(turn, provider, journal)
      const system = systemText(provider.requests[0])
      expect(commandLines(system)).toEqual(lines)
      expect(system).not.toContain(question.instructions)
      expect(toolNames(provider.requests[0])).toEqual(["commands"])
      const listed = JSON.parse(toolOutputs(provider)[0]!) as { commands: ReadonlyArray<{ name: string }> }
      expect(listed.commands.map((command) => command.name)).toEqual(
        lines.map((line) => line.slice(3).split(" ")[0])
      )
    }
    // A turn whose grant runs nothing is told so, and offered no tool.
    const journal = producer((path) => file(path, JOURNEY))
    const provider = model([])
    await run(sourceless, provider, journal)
    expect(commandLines(systemText(provider.requests[0]))).toEqual([])
    expect(systemText(provider.requests[0])).toContain("No command runs for you in this conversation")
    expect(toolNames(provider.requests[0])).toEqual([])
  })

  test("the list action narrows the install's commands by namespace", async () => {
    const journal = producer((path) => file(path, JOURNEY), stackRoutes)
    const provider = model([{ name: "commands", arguments: JSON.stringify({ action: "list", namespace: "todo" }) }])
    await run(install, provider, journal)
    expect(JSON.parse(toolOutputs(provider)[0]!)).toEqual({
      commands: [
        { name: "todo", summary: "Open a TODO", args: "<Tn>" },
        { name: "todo.new", summary: "Write and place a TODO", args: "[text]" }
      ]
    })
    expect(journal.calls).toEqual([])
  })

  test("/stack reads the install's TODOs as the turn's author and shows each open one's TODO card", async () => {
    const journal = producer((path) => file(path, JOURNEY), stackRoutes)
    const provider = model([execute("/stack")])
    await run(install, provider, journal)
    expect(journal.calls).toEqual([{
      authorization: "Bearer producer_capability_producer_capability_1234",
      body: { turnId: install.turnId, generation: 2, method: "GET", path: "/api/todos" }
    }])
    expect(journal.reads).toEqual([])
    expect(journal.frames.map((frame) => frame.type)).toEqual([
      "call.started",
      "card",
      "card",
      "call.settled",
      "delta",
      "done"
    ])
    for (const frame of journal.frames) expect(AgentTurnFrameSchema.safeParse(frame).success).toBe(true)
    expect(journal.frames[0]).toEqual({ runId: "run", type: "call.started", link: 0, ordinal: 0, name: "stack" })
    const cards = journal.frames.flatMap((frame) => frame.type === "card" ? [frame.card] : [])
    // Merged and dropped TODOs are not on the stack; each open one is its TODO card, as the person's /todo shows it.
    expect(cards).toEqual([queued, working].map((todo) => ({
      id: `todo:${todo.n}`,
      kind: "todo",
      title: todo.title,
      status: "active",
      createdAt: cards[0]!.createdAt,
      ordinal: 0,
      payload: { n: todo.n, model: todo, requests: [] }
    })))
    expect(journal.frames[3]).toEqual({
      runId: "run",
      type: "call.settled",
      link: 0,
      ordinal: 0,
      name: "stack",
      verdict: "run"
    })
    const rows = {
      todos: [
        { n: 12, title: "Card model contracts", state: "queued", owner: "ben", place: 1 },
        { n: 13, title: "Merged work", state: "merged", owner: "ben" },
        { n: 14, title: "Dropped work", state: "dropped", owner: "ben" },
        { n: 15, title: "Log retry counts", state: "working", owner: "ben", place: 2 }
      ]
    }
    expect(JSON.parse(toolOutputs(provider)[0]!)).toEqual(rows)
    expect(answerText(journal.frames)).toBe(`From the source: ${JSON.stringify(rows)}`)
    // An empty stack shows no card and says so.
    const empty = producer((path) => file(path, JOURNEY), routes({ "/api/todos": [200, []] }))
    const quiet = model([execute("stack", "  ")])
    await run(install, quiet, empty)
    expect(empty.frames.map((frame) => frame.type)).toEqual(["call.started", "call.settled", "delta", "done"])
    expect(toolOutputs(quiet)).toEqual(["{\"todos\":[]}"])
  })

  test("/todo Tn reads one TODO and shows its TODO card", async () => {
    for (const args of ["T12", "12", "{\"n\":12}"]) {
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      const provider = model([execute("/todo", args)])
      await run(install, provider, journal)
      expect(journal.calls.map((call) => call.body)).toEqual([
        { turnId: install.turnId, generation: 2, method: "GET", path: "/api/todos/12" }
      ])
      expect(journal.frames.map((frame) => frame.type)).toEqual([
        "call.started",
        "card",
        "call.settled",
        "delta",
        "done"
      ])
      expect(journal.frames[1]).toMatchObject({
        type: "card",
        card: {
          id: "todo:12",
          kind: "todo",
          title: "Card model contracts",
          payload: { n: 12, model: queued, requests: [] }
        }
      })
      expect(JSON.parse(toolOutputs(provider)[0]!)).toEqual(queued)
    }
  })

  test("todo.new shows its author a private Draft and files nothing", async () => {
    const journal = producer((path) => file(path, JOURNEY), stackRoutes)
    const provider = model([
      execute("todo.new", "Log retry counts\nin the worker"),
      execute(
        "todo.new",
        JSON.stringify({ text: "Retry", title: "Retry counts", acceptance: ["Counts log"], before: 12 })
      ),
      execute("todo.new")
    ])
    await run(install, provider, journal)
    // The Draft is the confirmation: no route is called, so no TODO exists until the person commits it.
    expect(journal.calls).toEqual([])
    expect(journal.frames.map((frame) => frame.type)).toEqual([
      "call.started",
      "card",
      "call.settled",
      "call.started",
      "card",
      "call.settled",
      "call.started",
      "card",
      "call.settled",
      "delta",
      "done"
    ])
    for (const frame of journal.frames) expect(AgentTurnFrameSchema.safeParse(frame).success).toBe(true)
    const drafts = journal.frames.flatMap((frame) =>
      frame.type === "card" && frame.card.kind === "draft" ? [frame.card] : []
    )
    expect(drafts).toHaveLength(3)
    expect(drafts[0]).toMatchObject({
      kind: "draft",
      audience_member_id: "ben",
      title: "Log retry counts",
      ordinal: 0,
      payload: {
        title: "Log retry counts",
        prompt: "Log retry counts\nin the worker",
        acceptance: [],
        place: { mode: "append", options: [] },
        private: true
      }
    })
    expect(drafts[1]).toMatchObject({
      audience_member_id: "ben",
      title: "Retry counts",
      ordinal: 1,
      payload: { prompt: "Retry", acceptance: ["Counts log"], place: { mode: "before", n: 12, options: [] } }
    })
    // An empty Draft is the person's to fill on the card.
    expect(drafts[2]).toMatchObject({ title: "", payload: { title: "", prompt: "" } })
    // Each Draft is its own entry with its own key.
    expect(new Set(drafts.map((draft) => draft.id)).size).toBe(3)
    expect(new Set(drafts.map((draft) => draft.payload.idempotencyKey)).size).toBe(3)
    for (const draft of drafts) expect(draft.id).toMatch(/^draft:[0-9a-f-]{36}$/)
    expect(toolOutputs(provider)).toEqual(
      Array.from(
        { length: 3 },
        () =>
          "Drafted: the Draft is on the person's screen. Nothing is filed until they press Commit, so never say the TODO exists."
      )
    )
  })

  test("each refusal is stated to the model and the conversation, and the turn answers", async () => {
    const refusals: ReadonlyArray<[ReturnType<typeof execute>, (path: string) => Response, string]> = [
      // The route's own refusal, as the person's browser reads it.
      [
        execute("stack"),
        routes({
          "/api/todos": [403, { code: "permission", class: "permission", message: "Install owner session required" }]
        }),
        "Install owner session required"
      ],
      [execute("todo", "T99"), stackRoutes, "TODO not found"],
      [
        execute("todo", "T12"),
        routes({ "/api/todos/12": [503, "upstream"] }),
        "The TODO read did not answer. Ask again."
      ],
      // The callback's refusal: the admitting credential no longer acts for its author.
      [
        execute("stack"),
        () => Response.json({ status: "error", code: "forbidden" }, { status: 403 }),
        "The person who asked can't use this install's TODOs now."
      ],
      [
        execute("stack"),
        () => Response.json({ status: "error", code: "producer_fenced" }, { status: 401 }),
        "The TODO read did not answer. Ask again."
      ],
      [
        execute("stack"),
        () => new Response("<html>bad gateway</html>", { status: 502 }),
        "The TODO read did not answer. Ask again."
      ],
      [
        execute("stack"),
        () => {
          throw new TypeError("fetch failed")
        },
        "The TODO read did not answer. Ask again."
      ],
      [execute("stack"), () => Response.json({ status: 200 }), "The TODO read did not answer. Ask again."],
      [execute("stack"), () => Response.json({ rows: [] }), "The TODO read did not answer. Ask again."],
      [
        execute("todo", "T12"),
        routes({ "/api/todos/12": [200, { n: 12 }] }),
        "The TODO read did not answer. Ask again."
      ],
      // Arguments the commands' own grammar refuses never reach the install.
      [execute("stack", "everything"), stackRoutes, "/stack takes no arguments."],
      [execute("todo", "twelve"), stackRoutes, "Name the TODO by its number: /todo T12."],
      [execute("todo", "{\"n\":-1}"), stackRoutes, "Name the TODO by its number: /todo T12."],
      [execute("todo", "{broken"), stackRoutes, "Invalid TODO input"],
      [execute("todo.new", "{broken"), stackRoutes, "Invalid TODO input"],
      [
        execute("todo.new", JSON.stringify({ text: "x", cardId: "draft:1" })),
        stackRoutes,
        "Only the person commits a Draft: they press Commit on it."
      ],
      [
        execute("todo.new", JSON.stringify({ text: "x", idempotencyKey: "k" })),
        stackRoutes,
        "todo.new takes the TODO's text, and optionally its title and acceptance."
      ],
      [
        execute("todo.new", JSON.stringify({ text: "x", before: 0 })),
        stackRoutes,
        "todo.new takes the TODO's text, and optionally its title and acceptance."
      ]
    ]
    for (const [call, api, message] of refusals) {
      const journal = producer((path) => file(path, JOURNEY), api)
      await run(install, model([call]), journal)
      expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "gate.rejected", "delta", "done"])
      expect(journal.frames[1]).toEqual({ runId: "run", type: "gate.rejected", link: 0, kind: "call_failed", message })
      expect(answerText(journal.frames)).toBe(`From the source: failed: ${message}`)
    }
  })

  test("a command the host does not run, or whose rule is never, runs nothing and answers unknown-command", async () => {
    for (const name of ["merge", "approval.approve", "members.remove", "todo.drop", "theme", "todo.erase"]) {
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      await run(install, model([execute(name, "T12")]), journal)
      expect(journal.calls).toEqual([])
      expect(journal.frames.map((frame) => frame.type)).toEqual(["delta", "done"])
      expect(answerText(journal.frames)).toBe(`From the source: ${unknownCommandResult(name)}`)
    }
    // A grant without the install's API runs no TODO command, though it reads main.
    for (const name of ["stack", "todo", "todo.new"]) {
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      await run(grant, model([execute(name, "T12")]), journal)
      expect(journal.calls).toEqual([])
      expect(answerText(journal.frames)).toBe(`From the source: ${unknownCommandResult(name)}`)
    }
  })
})
