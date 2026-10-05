import * as Model from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import type { JsonObject, ModelRequest } from "@smthrs/model/ModelRequest"
import { commandsToolSpec } from "@smthrs/rpc/AgentCommands"
import { MAX_TOOL_LEGS } from "@smthrs/rpc/AgentToolResult"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnCursor } from "@smthrs/rpc/AgentTurnJournal"
import { AgentTurnFrameSchema } from "@smthrs/rpc/NativeAgent"
import type { AgentTurnFrame, FetchLike, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
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

interface SourceCall {
  readonly authorization: string | null
  readonly body: unknown
}

/** The producer's journal and source read callback, recording what the host sent. */
const producer = (answer: (path: string) => Response) => {
  const frames: Array<AgentTurnFrame> = []
  const reads: Array<SourceCall> = []
  let expected = cursor
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === "/internal/chat/provider-started") return new Response(null, { status: 204 })
    const body = JSON.parse(String(init?.body))
    if (url.pathname === "/internal/chat/source/read") {
      reads.push({ authorization: new Headers(init?.headers).get("authorization"), body })
      return answer(body.path)
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
  return { frames, reads, fetchImpl }
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
