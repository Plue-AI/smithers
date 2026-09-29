/**
 * The claude-code seat's model over a scripted Claude Code: what it tells
 * Claude Code, how a conversation maps onto one session's user turns, and how
 * it recovers when a request is a retry, breaks the prefix, fails, or is
 * interrupted.
 */
import type * as Sdk from "@anthropic-ai/claude-agent-sdk"
import { query } from "@anthropic-ai/claude-agent-sdk"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Effect, Fiber, Stream } from "effect"
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import * as ClaudeCode from "../src/internal/ClaudeCode.ts"
import * as Providers from "../src/Providers.ts"

type Reply =
  | { readonly text: string }
  | { readonly error: Sdk.SDKAssistantMessageError }
  | { readonly hang: true }

/** An async queue the fake session's messages are read from. */
const queue = <A>() => {
  const items: Array<A> = []
  const readers: Array<(item: IteratorResult<A>) => void> = []
  return {
    push: (item: A) => {
      const reader = readers.shift()
      if (reader === undefined) items.push(item)
      else reader({ value: item, done: false })
    },
    iterator: (): AsyncIterator<A> => ({
      next: () =>
        items.length > 0
          ? Promise.resolve({ value: items.shift()!, done: false })
          : new Promise((resolve) => readers.push(resolve))
    })
  }
}

interface Started {
  readonly options: Sdk.Options
  /** Every user turn Claude read, in order. */
  readonly turns: Array<string>
  interrupts: number
  closed: boolean
}

/** A scripted Claude Code: `answer` sees each user turn and says what Claude does. */
const scripted = (answer: (turn: string) => Reply) => {
  const started: Array<Started> = []
  const start: ClaudeCode.Start = ({ options, prompt }) => {
    const messages = queue<Sdk.SDKMessage>()
    const record: Started = { options, turns: [], interrupts: 0, closed: false }
    started.push(record)
    const emit = (message: object) => messages.push(message as Sdk.SDKMessage)
    const turns: AsyncIterable<string> = typeof prompt === "string"
      ? (async function*() {
        yield prompt
      })()
      : (async function*() {
        for await (const turn of prompt) yield String(turn.message.content)
      })()
    void (async () => {
      for await (const turn of turns) {
        record.turns.push(turn)
        const reply = answer(turn)
        if ("hang" in reply) return
        const id = `msg_${started.length}_${record.turns.length}`
        emit({
          type: "assistant",
          parent_tool_use_id: null,
          ...("error" in reply ? { error: reply.error } : {}),
          message: { id, content: [{ type: "text", text: "text" in reply ? reply.text : "API Error" }] }
        })
        emit({
          type: "result",
          subtype: "success",
          session_id: `sess_${started.length}`,
          is_error: "error" in reply,
          result: "text" in reply ? reply.text : "API Error",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7 }
        })
      }
    })()
    return {
      [Symbol.asyncIterator]: messages.iterator,
      interrupt: async () => {
        record.interrupts++
      },
      close: () => {
        record.closed = true
      }
    }
  }
  return { start, started }
}

const model = (start: ClaudeCode.Start, hijackable?: boolean) =>
  ClaudeCode.make({
    hijackable,
    model: "claude-opus-5-5",
    executable: "/opt/bin/claude",
    environment: { HOME: "/home/op" },
    cwd: "/work",
    start
  })

const user = (text: string) => ModelRequest.Message.user(text)

const request = (messages: ReadonlyArray<ModelRequest.Message>, overrides: Partial<ModelRequest.ModelRequest> = {}) =>
  ModelRequest.ModelRequest.make({
    modelId: "claude-opus-5-5",
    system: [ModelRequest.SystemPart.make({ text: "teach" }), ModelRequest.SystemPart.make({ text: "task" })],
    messages,
    tools: [],
    toolChoice: "none",
    params: ModelRequest.GenerationParams.make({ reasoningEffort: "xhigh", temperature: 0.2 }),
    cacheKey: "run-1",
    ...overrides
  })

const run = (seat: ReturnType<typeof model>, input: ModelRequest.ModelRequest) =>
  Effect.runPromise(Stream.runCollect(seat.stream(input)).pipe(Effect.map((events) => Array.from(events))))

const settled = (events: ReadonlyArray<ModelEvent.ModelEvent>) => ModelEvent.ModelEvent.settledMessage(events).message

const cell = (code: string) => `\`\`\`cell\n${code}\n\`\`\``

describe("ClaudeCode.make", () => {
  it("starts a locked-down session and passes Claude's reply through as text", async () => {
    const claude = scripted(() => ({ text: `I will list.\n${cell("await ctx.call('ls')")}` }))
    const events = await run(model(claude.start), request([user("do the task")]))

    expect(events).toEqual([
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", text: `I will list.\n${cell("await ctx.call('ls')")}` },
      { type: "text-end", id: "text" },
      {
        type: "usage",
        inputTokens: 105,
        outputTokens: 7,
        cachedInputTokens: 90,
        cacheWriteTokens: 5,
        totalTokens: 112
      },
      { type: "settle", stopReason: "stop", responseId: "msg_1_1", sessionId: "sess_1" }
    ])
    expect(claude.started).toHaveLength(1)
    expect(claude.started[0]!.turns).toEqual(["do the task"])
    expect(claude.started[0]!.options).toEqual({
      model: "claude-opus-5-5",
      pathToClaudeCodeExecutable: "/opt/bin/claude",
      cwd: "/work",
      env: { HOME: "/home/op", CLAUDE_AGENT_SDK_CLIENT_APP: "smithers", ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
      systemPrompt: { type: "custom", prompt: ["teach", "task"] },
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      plugins: [],
      skills: [],
      permissionMode: "dontAsk",
      persistSession: false,
      title: "Smithers",
      effort: "xhigh"
    })
  })

  it("keeps the transcript for `claude --resume <sessionId>` only when the seat is hijackable", async () => {
    for (const hijackable of [undefined, false, true]) {
      const claude = scripted(() => ({ text: "ok" }))
      const events = await run(model(claude.start, hijackable), request([user("task")]))
      expect(claude.started[0]!.options.persistSession).toBe(hijackable === true)
      expect(events.at(-1)).toMatchObject({ type: "settle", sessionId: "sess_1" })
    }
  })

  it("sends the next request's new messages as one user turn on the same session", async () => {
    const claude = scripted((turn) => ({ text: cell(`seen(${JSON.stringify(turn)})`) }))
    const seat = model(claude.start)
    const first = request([user("task")])
    const answer = settled(await run(seat, first))
    const second = await run(seat, request([...first.messages, answer, user("frame 1 ran"), user("also do Y")]))

    expect(settled(second).content).toEqual([{ type: "text", text: cell(`seen("frame 1 ran\\n\\nalso do Y")`) }])
    expect(claude.started).toHaveLength(1)
    expect(claude.started[0]!.turns).toEqual(["task", "frame 1 ran\n\nalso do Y"])
  })

  it("passes a reply with no cell through like any other text", async () => {
    const claude = scripted(() => ({ text: "Done, nothing to run." }))
    const events = await run(model(claude.start), request([user("task")]))
    expect(settled(events).content).toEqual([{ type: "text", text: "Done, nothing to run." }])
  })

  it("answers a retried request from the record without advancing Claude", async () => {
    let calls = 0
    const claude = scripted(() => ({ text: cell(`call ${++calls}`) }))
    const seat = model(claude.start)
    const first = request([user("task")])
    const once = await run(seat, first)
    const next = request([...first.messages, settled(once), user("result")])
    const answered = await run(seat, next)

    expect(await run(seat, next)).toEqual(answered)
    expect(await run(seat, next)).toEqual(answered)
    expect(calls).toBe(2)
    expect(claude.started).toHaveLength(1)
  })

  const reply = cell("x")
  it.each(
    [
      [
        "an earlier message changed",
        (answer: ModelRequest.Message) => [user("other task"), answer, user("result")],
        `<user>\nother task\n</user>\n\n<assistant>\n${reply}\n</assistant>\n\n<user>\nresult\n</user>`
      ],
      ["no reply sits between the frames", () => [user("task"), user("result")], "task\n\nresult"],
      [
        "the new messages hold a reply of their own",
        (answer: ModelRequest.Message) => [user("task"), answer, user("result"), answer],
        `<user>\ntask\n</user>\n\n<assistant>\n${reply}\n</assistant>\n\n<user>\nresult\n</user>\n\n<assistant>\n${reply}\n</assistant>`
      ]
    ] as const
  )("starts a fresh session with the history flattened when %s", async (_case, history, prompt) => {
    const claude = scripted(() => ({ text: reply }))
    const seat = model(claude.start)
    const answer = settled(await run(seat, request([user("task")])))
    await run(seat, request(history(answer)))

    expect(claude.started).toHaveLength(2)
    expect(claude.started[0]!.closed).toBe(true)
    expect(claude.started[1]!.turns).toEqual([prompt])
  })

  it("starts a fresh session when the system prompt or parameters change", async () => {
    const claude = scripted(() => ({ text: reply }))
    const seat = model(claude.start)
    const first = request([user("task")])
    const answer = settled(await run(seat, first))
    await run(
      seat,
      request([...first.messages, answer, user("result")], {
        params: ModelRequest.GenerationParams.make({ reasoningEffort: "low" })
      })
    )

    expect(claude.started).toHaveLength(2)
    expect(claude.started[1]!.options.effort).toBe("low")
  })

  it("keeps separate conversations on separate sessions", async () => {
    const claude = scripted(() => ({ text: reply }))
    const seat = model(claude.start)
    await run(seat, request([user("a")], { cacheKey: "run-a" }))
    await run(seat, request([user("b")], { cacheKey: "run-b" }))

    expect(claude.started.map((session) => [session.turns, session.closed])).toEqual([[["a"], false], [["b"], false]])
  })

  it.each(
    [
      ["rate_limit", "rate_limited"],
      ["authentication_failed", "authentication"],
      ["billing_error", "quota_exceeded"],
      ["overloaded", "provider_internal"]
    ] as const
  )("maps Claude Code's %s failure to %s and drops the session", async (error, code) => {
    let turn = 0
    const claude = scripted(() => turn++ === 0 ? { error } : { text: reply })
    const seat = model(claude.start)
    const failure = await Effect.runPromise(Effect.flip(Stream.runCollect(seat.stream(request([user("task")])))))

    expect(failure).toMatchObject({ code })
    expect(claude.started[0]!.closed).toBe(true)
    await run(seat, request([user("task")]))
    expect(claude.started).toHaveLength(2)
  })

  it("interrupts Claude Code, then closes the session, when the stream is interrupted", async () => {
    const claude = scripted(() => ({ hang: true }))
    const seat = model(claude.start)
    await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Stream.runCollect(seat.stream(request([user("task")]))))
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
        yield* Fiber.interrupt(fiber)
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(claude.started[0]).toMatchObject({ interrupts: 1, closed: true })
    // The retry cannot trust the interrupted session, so it starts another.
    await Effect.runPromise(
      Effect.timeout(Stream.runCollect(seat.stream(request([user("task")]))), "10 millis").pipe(Effect.ignore)
    )
    expect(claude.started).toHaveLength(2)
  })

  it("answers a request with no conversation from a one-turn session", async () => {
    const claude = scripted(() => ({ text: "the summary" }))
    const events = await run(model(claude.start), request([user("summarize")], { cacheKey: undefined }))

    expect(settled(events).content).toEqual([{ type: "text", text: "the summary" }])
    expect(claude.started[0]!.options).toMatchObject({ tools: [], mcpServers: {}, maxTurns: 1 })
    expect(claude.started[0]!.closed).toBe(true)
  })

  it.each([
    ["provider-run tools", { serverTools: [{ type: "web_search" as const }] }],
    ["declared tools", {
      tools: [ModelRequest.ToolDefinition.make({ name: "t", description: "d", parameters: { type: "object" } })]
    }]
  ])("refuses %s without starting Claude Code", async (_case, overrides) => {
    const claude = scripted(() => ({ text: reply }))
    const failure = await Effect.runPromise(
      Effect.flip(Stream.runCollect(model(claude.start).stream(request([user("task")], overrides))))
    )
    expect(failure).toMatchObject({ code: "invalid_request" })
    expect(claude.started).toHaveLength(0)
  })
})

describe("ClaudeCode.route", () => {
  it("seals the request itself under the claude-code route", async () => {
    const input = request([user("task")])
    const prepared = await Effect.runPromise(ClaudeCode.route("claude-opus-5-5").prepare(input))

    expect(prepared).toMatchObject({ routeId: "claude-code", url: "claude-code:claude-opus-5-5", publicHeaders: {} })
    expect(JSON.parse(prepared.bodyText)).toMatchObject({ cacheKey: "run-1", messages: [{ role: "user" }] })
    expect(new TextDecoder().decode(prepared.body)).toBe(prepared.bodyText)
  })
})

// Opt-in: three frames through the real, signed-in Claude Code on this
// machine, the last carrying the person's steering. It spends the operator's
// subscription, so it never runs by default.
describe.runIf(process.env.SMITHERS_CLAUDE_CODE_SMOKE === "1")("ClaudeCode against the installed Claude Code", () => {
  it("runs cell frames on one session and obeys steering sent as a user turn", { timeout: 300_000 }, async () => {
    const login = await Providers.claudeCodeLogin(process.env)
    expect(
      await Providers.claudeCode({
        environment: process.env,
        homeDirectory: "",
        readFile: () => undefined,
        claudeCode: () => login
      })
    ).toMatchObject({ available: true })
    const sessionId = randomUUID()
    const seat = ClaudeCode.make({
      model: Providers.claudeCodeModel(process.env.SMITHERS_CLAUDE_CODE_SMOKE_MODEL ?? "sonnet"),
      executable: login!.executable,
      environment: process.env,
      idleMillis: 500,
      // Kept on disk, under this id, so the transcript can be read afterwards.
      start: ({ options, prompt }) => query({ prompt, options: { ...options, persistSession: true, sessionId } })
    })
    const system = [ModelRequest.SystemPart.make({
      text:
        "You drive a JavaScript runtime one cell at a time. Reply with exactly one fenced ```cell block holding the next cell's program, and nothing else. Each user message after the first reports what the last cell returned."
    })]
    const turn = (messages: ReadonlyArray<ModelRequest.Message>) =>
      run(seat, request(messages, { system, cacheKey: sessionId })).then(settled)
    const opening = [user("Compute 1 + 1 in one cell. After it returns, run a cell that returns 'done'.")]
    const one = await turn(opening)
    const afterOne = [...opening, one, user("The cell returned 2.")]
    const two = await turn(afterOne)
    const three = await turn([
      ...afterOne,
      two,
      user("The cell returned 'done'."),
      user("Change of plan from me: run one more cell that returns the string 'steered'.")
    ])
    // Let the idle session close before the worker exits.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const texts = [one, two, three].map((message) => JSON.stringify(message.content))
    process.stderr.write(`${JSON.stringify({ sessionId, texts })}\n`)
    expect(texts[0]).toContain("```cell")
    expect(texts[0]).toContain("1 + 1")
    expect(texts[1]).toContain("done")
    expect(texts[2]).toContain("steered")
  })
})
