import * as Model from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import type { JsonObject, ModelRequest } from "@smthrs/model/ModelRequest"
import { commandsToolSpec, unknownCommandResult } from "@smthrs/rpc/AgentCommands"
import { AGENT_RUNTIME_CONTEXT_VERSION, composeAgentInstructions } from "@smthrs/rpc/AgentContext"
import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import {
  ACCOUNT_NUMBERS_LINE,
  AGENT_NAME_LINE,
  FAILED_RESULT_LINE,
  RUN_IS_NOT_RESULT_LINE,
  WORKFLOW_LAUNDERING_RULE
} from "@smthrs/rpc/AgentInstructions"
import { MAX_TOOL_LEGS } from "@smthrs/rpc/AgentToolResult"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnCursor } from "@smthrs/rpc/AgentTurnJournal"
import { fixtures as homeFixtures } from "@smthrs/rpc/fixtures/Home"
import { fixtures } from "@smthrs/rpc/fixtures/Todo"
import { AgentTurnFrameSchema } from "@smthrs/rpc/NativeAgent"
import type { AgentTurnFrame, FetchLike, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import { Effect, Stream } from "effect"
import { createHash } from "node:crypto"
import { describe, expect, test } from "vitest"
import { runDurableChatTurn } from "../src/DurableChatProducer.ts"
import type { DurableChatGrant } from "../src/DurableChatProducer.ts"
import { apiCaller, runHostTurn } from "../src/HostTools.ts"

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
const install: DurableChatGrant = { ...grant, api: { author: "ben", token: "smithers_" + "a".repeat(40) } }

interface SourceCall {
  readonly authorization: string | null
  readonly body: unknown
}

/** The install's TODO routes as the API callback answers them: the route's status and body. */
const routes = (todos: Record<string, readonly [number, unknown]>) => (path: string): Response => {
  const [status, body] = todos[path] ?? [404, { code: "not_found", class: "user", message: "Not Found" }]
  return Response.json(body, { status })
}

/** No directory: what the list callback answers a test that lists nothing. */
const noDirectory = (): Response => Response.json({ status: "error", code: "not_found" }, { status: 404 })

/** The producer's journal and its source read, source list and API callbacks, recording what the host sent. */
const producer = (
  answer: (path: string) => Response,
  api: (path: string, init?: RequestInit) => Response = routes({}),
  list: (path: string) => Response = noDirectory
) => {
  const frames: Array<AgentTurnFrame> = []
  const reads: Array<SourceCall> = []
  const lists: Array<SourceCall> = []
  const calls: Array<SourceCall> = []
  let expected = cursor
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === "/internal/chat/provider-started") return new Response(null, { status: 204 })
    if (url.pathname.startsWith("/api/")) {
      calls.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: {
          method: init?.method,
          path: url.pathname + url.search,
          ...(init?.method === "GET" ? {} : {
            payload: JSON.parse(String(init?.body)),
            key: new Headers(init?.headers).get("Idempotency-Key")
          })
        }
      })
      expect(new Headers(init?.headers).get("smithers-via")).toBe("smithers")
      expect(new Headers(init?.headers).get("x-forwarded-host")).toBe("127.0.0.1:4000")
      expect(init?.redirect).toBe("manual")
      return api(url.pathname + url.search, init)
    }
    const body = JSON.parse(String(init?.body))
    if (url.pathname === "/internal/chat/source/read") {
      reads.push({ authorization: new Headers(init?.headers).get("authorization"), body })
      return answer(body.path)
    }
    if (url.pathname === "/internal/chat/source/list") {
      lists.push({ authorization: new Headers(init?.headers).get("authorization"), body })
      return list(body.path)
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
  return { frames, reads, lists, calls, fetchImpl }
}

const file = (path: string, content: string, binary = false): Response =>
  Response.json({ repository: "acme/app", path, commit: COMMIT, content, binary })

/** One directory as the list callback answers it, in the repository host's order. */
const directory = (
  path: string,
  entries: ReadonlyArray<readonly [string, "file" | "dir"]>,
  truncated = false
): Response =>
  Response.json({
    repository: "acme/app",
    path,
    commit: COMMIT,
    entries: entries.map(([name, kind]) => ({ name, kind })),
    truncated
  })

/** The scratch repository the J1 question asks about: a package.json, a README and one test file. */
const scratchTree = (path: string): Response =>
  path === ""
    ? directory("", [["README.md", "file"], ["package.json", "file"], ["test", "dir"]])
    : path === "test"
    ? directory("test", [["smoke.test.mjs", "file"]])
    : noDirectory()
const SMOKE = "import test from \"node:test\"\ntest(\"greets\", () => {})\n"

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
const listCall = (args?: string) => execute("files.list", args)

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
const stackHome = {
  ...homeFixtures.fresh.model,
  items: [
    { ...homeFixtures.active.model.items[0]!, ...queued, branch: { id: "todo-12", name: "todo/12" } },
    { ...homeFixtures.active.model.items[0]!, n: 13, state: "merged" as const },
    { ...homeFixtures.active.model.items[0]!, n: 14, state: "dropped" as const }
  ]
}
const stackRoutes = routes({
  "/api/stack": [200, stackHome],
  "/api/todos/12": [200, queued],
  "/api/todos/99": [404, { code: "todo_not_found", class: "user", message: "TODO not found" }]
})

/** The instructions' command lines for each grant, literal. */
const FILES_LINES = [
  "- /files.list [path] [owner/repo] — List a repository directory",
  "- /files.read <path>[:<line>[:<col>]] [owner/repo] [--ref <revision>] — Read a file from a repository"
]
// Literal Appendix B HTTP/file commands; unavailable UI providers stay dark.
const HOST_COMMANDS = [
  "agent",
  "agents",
  "branch",
  "branch.add-to-stack",
  "branch.discard-foreign",
  "branch.fork",
  "branch.rebase",
  "branches",
  "files.list",
  "files.read",
  "flow",
  "flow.edit",
  "flow.new",
  "flow.run",
  "flows",
  "github",
  "github.retry",
  "issue",
  "issue.comment",
  "issue.new",
  "issues",
  "learning.accept",
  "learning.dismiss",
  "monitor",
  "run",
  "run.inspect",
  "runs",
  "search",
  "stack",
  "stack.move",
  "theme",
  "todo",
  "todo.amend",
  "todo.answer",
  "todo.drop",
  "todo.new",
  "todo.resume",
  "todo.retry",
  "todo.steer",
  "todo.stop"
]
const commandLines = (text: string): ReadonlyArray<string> => text.split("\n").filter((line) => line.startsWith("- /"))

/**
 * The runtime context the browser sends with its turns (apps/app turns.ts):
 * its capability and limitation lines, the tutorial, the Cloud session and the
 * repository check each name commands only the browser runs.
 */
const browserContext: AgentRuntimeContext = {
  version: AGENT_RUNTIME_CONTEXT_VERSION,
  product: "smithers",
  capturedAt: 1,
  revision: 3,
  surface: "chat",
  theme: "light",
  selectedWorldDocument: null,
  connectors: [],
  repositories: [{ id: "acme/app", name: "acme/app" }],
  activeRepository: "acme/app",
  github: { connected: true, login: "ben", repositories: 1, repositoryNames: ["acme/app"] },
  cloud: { state: "signed-out", username: null },
  repositoryUpdate: {
    repo: "acme/app",
    checkedAt: 1,
    openIssues: 0,
    openPrs: 0,
    problems: [],
    items: [],
    truncated: false
  },
  onboarding: { step: 0, stepCount: 3, transcript: ["Welcome to Smithers."] },
  worldState: { documentCount: 0, documents: [] },
  capabilities: [
    "Hold a streaming conversation in this chat and read its visible transcript.",
    "Run app commands through the \"commands\" tool — the same code path as the UI buttons and slash commands.",
    "Render structured cards (plans, approvals, statuses, recommendations) in the transcript.",
    "Create, list, and run Smithers flows on the user's loaded repositories (flow.create, flow.list, flow.run). Runs report live as embedded cards in this chat."
  ],
  limitations: [
    "Cannot see or control the host environment beyond what this context block states.",
    "The visitor is signed out, exploring acme/app: anything that writes needs GitHub sign-in, so when they ask for one execute auth.prompt instead.",
    "Flow runs execute on the user's workspace gateway; any outbound act a run wants (pushes, PRs) pauses for the human's explicit approval. Never promise one landed without it.",
    "This host cannot connect local repositories."
  ]
}

/** Commands the browser's context and instructions name that the install's host does not run. */
const BROWSER_ONLY = [
  "flow.create",
  "flow.list",
  "auth.prompt",
  "cloud.prompt",
  "onboarding.act",
  "repo.update",
  "repo.overview",
  "debug.errors",
  "the same code path as the UI buttons"
]

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

  test("an open question lists the repository, then reads the file the listing shows", async () => {
    const journal = producer((path) => file(path, SMOKE), routes({}), scratchTree)
    const provider = model([listCall(), listCall("test"), readCall("test/smoke.test.mjs")])
    await run(
      {
        ...grant,
        request: { ...question, messages: [{ role: "user", content: "What does the test in this repository check?" }] }
      },
      provider,
      journal
    )

    const capability = "Bearer producer_capability_producer_capability_1234"
    expect(journal.lists).toEqual([
      { authorization: capability, body: { turnId: grant.turnId, generation: 2, path: "" } },
      { authorization: capability, body: { turnId: grant.turnId, generation: 2, path: "test" } }
    ])
    expect(journal.reads.map((call) => (call.body as { path: string }).path)).toEqual(["test/smoke.test.mjs"])
    expect(journal.frames.map((frame) => frame.type)).toEqual([
      ...["call.started", "card", "call.settled"],
      ...["call.started", "card", "call.settled"],
      ...["call.started", "card", "call.settled"],
      "delta",
      "done"
    ])
    for (const frame of journal.frames) expect(AgentTurnFrameSchema.safeParse(frame).success).toBe(true)
    const cards = journal.frames.flatMap((frame) => frame.type === "card" ? [frame.card] : [])
    expect(cards.map((card) => [card.id, card.kind, card.title, card.ordinal])).toEqual([
      ["files-acme/app-/", "file-list", "Files · acme/app · /", 0],
      ["files-acme/app-test", "file-list", "Files · acme/app · test", 1],
      ["file-acme/app-test/smoke.test.mjs", "file", "File · acme/app · test/smoke.test.mjs", 2]
    ])
    // The card lists the directory in the one listing order, at main's commit.
    expect(cards[0]?.payload).toEqual({
      repo: "acme/app",
      path: "",
      entries: [{ name: "test", kind: "dir" }, { name: "package.json", kind: "file" }, {
        name: "README.md",
        kind: "file"
      }],
      address: "/acme/app/",
      readAt: { changeId: null, commitId: COMMIT, source: "head" }
    })
    expect(journal.frames.filter((frame) => frame.type === "call.settled")).toEqual(
      ["files.list", "files.list", "files.read"].map((name, ordinal) => ({
        runId: "run",
        type: "call.settled",
        link: ordinal,
        ordinal,
        name,
        verdict: "run"
      }))
    )
    // Each continuation carries what the card shows, so the answer is grounded in the file.
    expect(toolOutputs(provider)).toEqual([
      "/ in acme/app:\ntest/\npackage.json\nREADME.md",
      "test in acme/app:\nsmoke.test.mjs",
      `test/smoke.test.mjs in acme/app:\n${SMOKE}`
    ])
    expect(answerText(journal.frames)).toBe(`From the source: test/smoke.test.mjs in acme/app:\n${SMOKE}`)
    expect(journal.frames.at(-1)).toMatchObject({ type: "done", reason: "stop" })
    // A turn that can list is told to list, never to guess a path.
    expect(systemText(provider.requests[0])).toContain(
      "Asked about the repository's code without a file named, run files.list with no argument to list the root, then list or read the paths it shows; never guess a path."
    )
  })

  test("a listing takes the flow's own arguments: the root as no path or a slash, a quoted directory, the turn's repository", async () => {
    const journal = producer(
      (path) => file(path, JOURNEY),
      routes({}),
      (path) => directory(path, [["a.md", "file"]], path === "Meeting Notes")
    )
    const provider = model([
      listCall(),
      listCall("/"),
      execute("/files.list", "/docs/"),
      listCall("\"Meeting Notes\" acme/app")
    ])
    await run(grant, provider, journal)
    expect(journal.lists.map((call) => (call.body as { path: string }).path)).toEqual([
      "",
      "",
      "docs",
      "Meeting Notes"
    ])
    const cards = journal.frames.flatMap((frame) => frame.type === "card" ? [frame.card] : [])
    expect(cards.map((card) => card.id)).toEqual([
      "files-acme/app-/",
      "files-acme/app-/",
      "files-acme/app-docs",
      "files-acme/app-Meeting Notes"
    ])
    // A directory the host cut short says so on its card and to the model.
    expect(cards[3]?.payload).toMatchObject({ path: "Meeting Notes", truncated: true })
    expect(cards[0]?.payload).not.toHaveProperty("truncated")
    expect(toolOutputs(provider)[3]).toBe(
      "Meeting Notes in acme/app:\na.md\n(The directory has more entries than one listing shows.)"
    )
  })

  test("a path may name the turn's repository, start with ./ or be ., as a model writes them", async () => {
    // Each call a real model made on an install, refused before: `.`, and the repository as the path.
    const listings = producer((path) => file(path, JOURNEY), routes({}), (path) => directory(path, [["a.md", "file"]]))
    await run(
      grant,
      model([
        listCall("."),
        listCall("acme/app"),
        listCall("/acme/app/docs/"),
        listCall("./docs"),
        listCall("docs app"),
        listCall("acme/application")
      ]),
      listings
    )
    expect(listings.lists.map((call) => (call.body as { path: string }).path)).toEqual([
      "",
      "",
      "docs",
      "docs",
      "docs",
      "acme/application"
    ])
    const reads = producer((path) => file(path, JOURNEY))
    await run(
      grant,
      model([
        readCall("acme/app/JOURNEY.md"),
        readCall("./docs/guide.md:2"),
        readCall("JOURNEY.md app"),
        readCall("acme/app"),
        readCall("./")
      ]),
      reads
    )
    expect(reads.reads.map((call) => (call.body as { path: string }).path)).toEqual([
      "JOURNEY.md",
      "docs/guide.md",
      "JOURNEY.md"
    ])
    // A path that names no file once the repository is taken off it is refused before any read.
    const refused = reads.frames.flatMap((frame) => frame.type === "gate.rejected" ? [frame.message] : [])
    expect(refused).toEqual(["files.read needs a file path", "files.read needs a file path"])
  })

  test("each listing refusal is stated to the model and the conversation, and the turn answers", async () => {
    const codes: Record<string, [number, string]> = {
      "../secret": [400, "path_refused"],
      "JOURNEY.md": [404, "not_found"],
      "private": [403, "forbidden"],
      "src": [409, "source_not_ready"],
      "down": [503, "source_failed"]
    }
    const said: Record<string, string> = {
      "../secret":
        "../secret is not a path inside this repository. Name a directory by its path from the repository root, for example src, or list the root with no path.",
      "JOURNEY.md": "JOURNEY.md is not a directory on main.",
      "private": "The person who asked can't read this repository.",
      "src":
        "The repository's source isn't ready yet: setup is still mirroring main. Ask again once Source ready shows in setup.",
      "down": "The repository read did not answer. Ask again."
    }
    for (const [path, [status, code]] of Object.entries(codes)) {
      const journal = producer(
        (read) => file(read, JOURNEY),
        routes({}),
        () => Response.json({ status: "error", code }, { status })
      )
      await run(grant, model([listCall(path)]), journal)
      expect(journal.lists).toHaveLength(1)
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
    // A callback that does not answer a directory is stated the same way.
    const unanswered: ReadonlyArray<() => Response> = [
      () => {
        throw new TypeError("fetch failed")
      },
      () => new Response("<html>bad gateway</html>", { status: 502 }),
      () =>
        Response.json({
          repository: "acme/app",
          path: "",
          commit: COMMIT,
          entries: [{ name: "x", kind: "link" }],
          truncated: false
        }),
      () => file("JOURNEY.md", JOURNEY)
    ]
    for (const answer of unanswered) {
      const journal = producer((read) => file(read, JOURNEY), routes({}), answer)
      await run(grant, model([listCall()]), journal)
      expect(journal.lists).toHaveLength(1)
      expect(answerText(journal.frames)).toBe("From the source: failed: The repository read did not answer. Ask again.")
    }
    // Arguments the grammar or the turn refuses never reach the producer.
    for (
      const [args, message] of [
        ["a b c", "files.list takes a path and optionally an owner/repo"],
        ["\"unfinished", "Close the quoted file argument before the next argument."],
        ["src other/repo", "This question reads acme/app only; name a directory in it."]
      ] as const
    ) {
      const journal = producer((read) => file(read, JOURNEY), routes({}), scratchTree)
      await run(grant, model([listCall(args)]), journal)
      expect(journal.lists).toEqual([])
      expect(journal.frames[1]).toMatchObject({ type: "gate.rejected", kind: "call_failed", message })
    }
  })

  test("the list action answers the commands this host runs", async () => {
    const listing = JSON.stringify({
      commands: [{
        name: "files.list",
        summary: "List a repository directory",
        args: "[path] [owner/repo]"
      }, {
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
        [{ action: "list", namespace: "files.read" }, JSON.stringify({ commands: [JSON.parse(listing).commands[1]] })],
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
      [install, HOST_COMMANDS],
      [grant, ["files.list", "files.read"]],
      [{ ...sourceless, api: install.api! }, HOST_COMMANDS.filter((name) => !name.startsWith("files."))]
    ]
    for (const [turn, names] of cases) {
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      const provider = model([{ name: "commands", arguments: JSON.stringify({ action: "list" }) }])
      await run(turn, provider, journal)
      const system = systemText(provider.requests[0])
      expect(commandLines(system).map((line) => line.slice(3).split(" ")[0])).toEqual(names)
      expect(system).not.toContain(question.instructions)
      expect(toolNames(provider.requests[0])).toEqual(["commands"])
      const listed = JSON.parse(toolOutputs(provider)[0]!) as { commands: ReadonlyArray<{ name: string }> }
      expect(listed.commands.map((command) => command.name)).toEqual(names)
      expect(journal.calls).toEqual([])
    }
    const provider = model([])
    await run(install, provider, producer((path) => file(path, JOURNEY)))
    const lines = commandLines(systemText(provider.requests[0]))
    expect(lines).toContain("- /todo.stop — Pause a working TODO")
    expect(lines.find((line) => line.startsWith("- /todo.drop "))).toContain("asks the person")
    expect(lines.some((line) => line.startsWith("- /merge "))).toBe(false)
    expect(lines.filter((line) => line.startsWith("- /files."))).toEqual(FILES_LINES)
  })

  test("the instructions keep the app agent's standing rules beside the install's commands", async () => {
    const cases: ReadonlyArray<[DurableChatGrant, string]> = [
      [install, "through files.list and files.read"],
      [
        { ...sourceless, api: { author: "ben", token: "smithers_" + "a".repeat(40) } },
        "read arbitrary files off the user's machine; push"
      ]
    ]
    for (const [turn, files] of cases) {
      const provider = model([])
      await run(turn, provider, producer((path) => file(path, JOURNEY), stackRoutes))
      const system = systemText(provider.requests[0])
      for (const line of [AGENT_NAME_LINE, RUN_IS_NOT_RESULT_LINE, FAILED_RESULT_LINE, ACCOUNT_NUMBERS_LINE]) {
        expect(system).toContain(line)
      }
      for (const line of WORKFLOW_LAUNDERING_RULE) expect(system).toContain(line)
      expect(system).toContain("Everything this list lacks is a can't-yet. You cannot send or draft email")
      expect(system).toContain(files)
    }
    // A turn that cannot list is never told to.
    const provider = model([])
    await run(
      { ...sourceless, api: { author: "ben", token: "smithers_" + "a".repeat(40) } },
      provider,
      producer((path) => file(path, JOURNEY), stackRoutes)
    )
    expect(systemText(provider.requests[0])).not.toContain("files.list")
  })

  test("an install turn's context states the host's capabilities and names no command the host does not run", async () => {
    for (
      const turn of [install, grant, { ...sourceless, api: { author: "ben", token: "smithers_" + "a".repeat(40) } }]
    ) {
      const provider = model([])
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      await run({ ...turn, request: { ...question, context: browserContext } }, provider, journal)
      const system = systemText(provider.requests[0])
      for (const name of BROWSER_ONLY) expect(system).not.toContain(name)
      expect(system).toContain(
        "Run the commands the instructions list through the \"commands\" tool, as the person who asked; read the returned status before claiming success. Pending confirmations require the person to act."
      )
      expect(system).toContain(
        "Runs no command the instructions do not list: any other answers unknown-command, and nothing runs."
      )
      // The client's facts stay.
      expect(system).toContain("GitHub: CONNECTED as ben")
      expect(system).toContain("Active repository: acme/app")
    }
  })

  test("a turn whose grant runs nothing keeps its request's own instructions and context, and is offered no tool", async () => {
    for (const request of [question, { ...question, context: browserContext }]) {
      const journal = producer((path) => file(path, JOURNEY))
      const provider = model([])
      await run({ ...sourceless, request }, provider, journal)
      expect(systemText(provider.requests[0])).toBe(composeAgentInstructions(request.instructions, request.context))
      expect(toolNames(provider.requests[0])).toEqual([])
    }
  })

  test("the list action narrows the install's commands by namespace", async () => {
    const journal = producer((path) => file(path, JOURNEY), stackRoutes)
    const provider = model([{ name: "commands", arguments: JSON.stringify({ action: "list", namespace: "todo" }) }])
    await run(install, provider, journal)
    const listed = JSON.parse(toolOutputs(provider)[0]!)
    expect(listed.commands.map((row: { name: string }) => row.name)).toEqual([
      "todo",
      "todo.amend",
      "todo.answer",
      "todo.drop",
      "todo.new",
      "todo.resume",
      "todo.retry",
      "todo.steer",
      "todo.stop"
    ])
    const stop = listed.commands.find((row: { name: string }) => row.name === "todo.stop")
    expect(JSON.parse(stop.args)).toEqual({
      type: "object",
      properties: { n: { type: "integer", minimum: 1 } },
      required: ["n"],
      additionalProperties: false,
      $defs: {}
    })
    expect(journal.calls).toEqual([])
  })

  test("/stack reads the shared Home projection through the catalog endpoint", async () => {
    const journal = producer((path) => file(path, JOURNEY), stackRoutes)
    const provider = model([execute("stack", "  ")])
    await run(install, provider, journal)
    expect(journal.calls).toEqual([{
      authorization: "Bearer smithers_" + "a".repeat(40),
      body: { method: "GET", path: "/api/stack" }
    }, {
      authorization: "Bearer smithers_" + "a".repeat(40),
      body: { method: "GET", path: "/api/todos/12" }
    }])
    expect(journal.frames[1]).toMatchObject({ type: "card", card: { id: "todo:12", kind: "todo", payload: { n: 12, model: queued } } })
    expect(journal.reads).toEqual([])
    expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "card", "call.settled", "delta", "done"])
    for (const frame of journal.frames) expect(AgentTurnFrameSchema.safeParse(frame).success).toBe(true)
    expect(JSON.parse(toolOutputs(provider)[0]!)).toMatchObject({ items: [{ n: 12 }, { n: 13 }, { n: 14 }] })
  })

  test("an empty stack needs no detail requests; a failed or mismatched detail refuses", async () => {
    const empty = producer(path => file(path, JOURNEY), routes({ "/api/stack": [200, homeFixtures.fresh.model] }))
    const provider = model([execute("stack")])
    await run(install, provider, empty)
    expect(empty.calls).toHaveLength(1)
    expect(empty.frames.some(frame => frame.type === "card")).toBe(false)
    expect(JSON.parse(toolOutputs(provider)[0]!)).toEqual(homeFixtures.fresh.model)
    for (const detail of [[403, { code: "forbidden" }], [200, { ...queued, n: 99 }], [200, {}]] as const) {
      const journal = producer(path => file(path, JOURNEY), routes({ "/api/stack": [200, stackHome], "/api/todos/12": detail }))
      const provider = model([execute("stack")])
      await run(install, provider, journal)
      expect(journal.calls).toHaveLength(2)
      expect(journal.frames.some(frame => frame.type === "card")).toBe(false)
      expect(toolOutputs(provider)).toEqual(["failed: Invalid TODO response"])
    }
  })

  test("/todo Tn reads one TODO and shows its TODO card", async () => {
    for (const args of ["T12", "{\"n\":12}"]) {
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      const provider = model([execute("/todo", args)])
      await run(install, provider, journal)
      expect(journal.calls.map((call) => call.body)).toEqual([
        { method: "GET", path: "/api/todos/12" }
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

  test("catalog mutations use literal HTTP bindings and host-owned idempotency keys", async () => {
    const cases = [
      ["todo.stop", "T12", "POST", "/api/todos/12", { op: "stop" }],
      ["todo.resume", "T12", "POST", "/api/todos/12", { op: "resume" }],
      ["todo.retry", "T12", "POST", "/api/todos/12", { op: "retry" }],
      ["todo.steer", "T12 Keep the greeting", "POST", "/api/todos/12", { steer: "Keep the greeting" }],
      ["todo.amend", "T12 New prompt", "PATCH", "/api/todos/12", { prompt: "New prompt" }],
      ["stack.move", "T12 down", "POST", "/api/todos/12", { op: "move", direction: "down" }],
      ["todo.answer", "{\"n\":12,\"answer\":\"Yes\",\"wait\":\"w1\"}", "POST", "/api/todos/12/answer", {
        answer: "Yes",
        wait: "w1"
      }],
      ["branch.fork", "{\"from\":\"main\",\"name\":\"greeting\"}", "POST", "/api/branches", {
        from: "main",
        name: "greeting"
      }],
      ["github.retry", undefined, "POST", "/api/github/sync", {}]
    ] as const
    for (const [name, args, method, path, payload] of cases) {
      const journal = producer((path) => file(path, JOURNEY), () =>
        name === "todo.amend"
          ? Response.json({ confirmation: "confirm-amend", state: "pending" }, { status: 202 })
          : new Response(null, { status: 204 }))
      const provider = model([execute(name, args)])
      await run(install, provider, journal)
      expect(journal.calls, name).toEqual([{
        authorization: "Bearer smithers_" + "a".repeat(40),
        body: { method, path, payload, key: `chat:${install.turnId}:0` }
      }])
      expect(toolOutputs(provider), name).toEqual([
        name === "todo.amend"
          ? "{\"confirmation\":\"confirm-amend\",\"state\":\"pending\"}" :
          "{\"status\":204,\"body\":null}"
      ])
    }
  })

  test("todo.new shows its author a private Draft and files nothing", async () => {
    const journal = producer((path) => file(path, JOURNEY), stackRoutes)
    const provider = model([
      execute("todo.new", "Log retry counts\nin the worker"),
      execute("todo.new", JSON.stringify({ text: "Retry", title: "Retry counts", acceptance: ["Counts log"] })),
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
      payload: { prompt: "Retry", acceptance: ["Counts log"], place: { mode: "append", options: [] } }
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

  test("shared prompts retain the author's server Confirm instead of an invisible private Draft", async () => {
    const turn = { ...install, request: { ...install.request, sharedConversation: true } }
    const journal = producer(path => file(path, JOURNEY), () => Response.json({ confirmation: "confirm-1", state: "pending" }, { status: 202 }))
    const provider = model([execute("todo.new", "Add a greeting"), execute("merge", "T12")])
    await Effect.runPromise(runHostTurn(provider.model, turn, { modelId: "m" }, frame => Effect.sync(() => { journal.frames.push(frame) }), {
      read: () => Effect.succeed({ code: "unused" }),
      list: () => Effect.succeed({ code: "unused" }),
      api: apiCaller("http://callback.test", turn, journal.fetchImpl)
    }))
    expect(journal.calls.map(call => call.body)).toEqual([
      { method: "POST", path: "/api/todos", payload: { prompt: "Add a greeting", place: { mode: "append" } }, key: `chat:${turn.turnId}:0` },
      { method: "POST", path: "/api/todos/12/merge", payload: {}, key: `chat:${turn.turnId}:1` }
    ])
    expect(journal.frames.some(frame => frame.type === "card")).toBe(false)
    expect(toolOutputs(provider)).toEqual(Array(2).fill('{"confirmation":"confirm-1","state":"pending"}'))
  })

  test("confirmation commands return pending status without copying the private Confirm into shared frames", async () => {
    const cases = [
      ["todo.drop", "T12", "/api/todos/12", { op: "drop" }],
      ["issue.comment", "{\"number\":5,\"body\":\"Please check\"}", "/api/issues/5/comments", { body: "Please check" }]
    ] as const
    for (const [name, args, path, payload] of cases) {
      const journal = producer((path) => file(path, JOURNEY), () =>
        Response.json({
          confirmation: "confirm-1",
          state: "pending",
          private: "AUTHOR ONLY"
        }, { status: 202 }))
      const provider = model([execute(name, args)])
      await run(install, provider, journal)
      expect(journal.calls, name).toEqual([{
        authorization: "Bearer smithers_" + "a".repeat(40),
        body: { method: "POST", path, payload, key: `chat:${install.turnId}:0` }
      }])
      expect(toolOutputs(provider)).toEqual(["{\"confirmation\":\"confirm-1\",\"state\":\"pending\"}"])
      expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "call.settled", "delta", "done"])
      expect(JSON.stringify(journal.frames)).not.toContain("AUTHOR ONLY")
      expect(JSON.stringify(provider.requests)).not.toContain("AUTHOR ONLY")
    }
  })

  test("success and unavailable repository dispatch return the API result without executing a local fallback", async () => {
    const journal = producer(
      (path) => file(path, JOURNEY),
      routes({
        "/api/search/code?q=hello+world": [200, { matches: [] }],
        "/api/flows/verify/run": [503, { code: "machine_unavailable", class: "infra" }]
      })
    )
    const provider = model([
      execute("search", "{\"query\":\"hello world\"}"),
      execute("flow.run", "{\"name\":\"verify\"}")
    ])
    await run(install, provider, journal)
    expect(journal.calls.map((call) => call.body)).toEqual([
      { method: "GET", path: "/api/search/code?q=hello+world" },
      { method: "POST", path: "/api/flows/verify/run", payload: {}, key: `chat:${install.turnId}:1` }
    ])
    expect(toolOutputs(provider)).toEqual([
      "{\"status\":200,\"body\":{\"matches\":[]}}",
      "failed: {\"status\":503,\"body\":{\"code\":\"machine_unavailable\",\"class\":\"infra\"}}"
    ])
    expect(journal.reads).toEqual([])
  })

  test("each refusal is stated to the model and the conversation, and the turn answers", async () => {
    const refusals: ReadonlyArray<[ReturnType<typeof execute>, (path: string) => Response, string]> = [
      [
        execute("stack"),
        routes({ "/api/stack": [403, { code: "permission", class: "permission" }] }),
        "{\"status\":403,\"body\":{\"code\":\"permission\",\"class\":\"permission\"}}"
      ],
      [
        execute("todo", "T99"),
        stackRoutes,
        "{\"status\":404,\"body\":{\"code\":\"todo_not_found\",\"class\":\"user\",\"message\":\"TODO not found\"}}"
      ],
      [
        execute("todo", "T12"),
        routes({ "/api/todos/12": [503, "upstream"] }),
        "{\"status\":503,\"body\":\"upstream\"}"
      ],
      [
        execute("stack"),
        () => Response.json({ code: "producer_fenced" }, { status: 401 }),
        "{\"status\":401,\"body\":{\"code\":\"producer_fenced\"}}"
      ],
      [execute("stack"), () => new Response("<html>bad gateway</html>", { status: 502 }), "invalid_answer"],
      [execute("stack"), () => {
        throw new TypeError("fetch failed")
      }, "unreachable"],
      [execute("stack"), () => Response.json({ rows: [] }), "Invalid stack response"],
      [execute("todo", "T12"), () => Response.json({ n: 12 }), "Invalid TODO response"]
    ]
    for (const [call, api, message] of refusals) {
      const journal = producer((path) => file(path, JOURNEY), api)
      await run(install, model([call]), journal)
      expect(journal.frames.map((frame) => frame.type)).toEqual(["call.started", "gate.rejected", "delta", "done"])
      expect(journal.frames[1]).toEqual({ runId: "run", type: "gate.rejected", link: 0, kind: "call_failed", message })
      expect(answerText(journal.frames)).toBe(`From the source: failed: ${message}`)
    }
  })

  test("a single named argument encodes a path segment without broadening the endpoint", async () => {
    const journal = producer((path) => file(path, JOURNEY), () => Response.json({ name: "check/types" }))
    const provider = model([execute("flow", "check/types")])
    await run(install, provider, journal)
    expect(journal.calls.map((call) => call.body)).toEqual([{ method: "GET", path: "/api/flows/check%2Ftypes" }])
    expect(toolOutputs(provider)).toEqual(["{\"status\":200,\"body\":{\"name\":\"check/types\"}}"])
  })

  test("confirmation replay returns its current state without exposing private payload", async () => {
    for (const state of ["approved", "rejected", "expired"] as const) {
      const journal = producer((path) => file(path, JOURNEY), () =>
        Response.json({
          confirmation: "confirm-replay",
          state,
          payload: { secret: "PRIVATE" }
        }, { status: 202 }))
      const provider = model([execute("todo.drop", "T12")])
      await run(install, provider, journal)
      expect(toolOutputs(provider)).toEqual([JSON.stringify({ confirmation: "confirm-replay", state })])
      expect(JSON.stringify(journal.frames)).not.toContain("PRIVATE")
      expect(JSON.stringify(provider.requests)).not.toContain("PRIVATE")
    }
  })

  test("malformed confirmation acknowledgments expose no private payload or false success", async () => {
    for (
      const [status, body] of [
        [202, { confirmation: "", state: "pending", secret: "PRIVATE" }],
        [202, { confirmation: "confirm-1", state: "executed", secret: "PRIVATE" }],
        [200, { confirmation: "confirm-1", state: "pending", secret: "PRIVATE" }]
      ] as const
    ) {
      const journal = producer((path) => file(path, JOURNEY), () => Response.json(body, { status }))
      const provider = model([execute("todo.drop", "T12")])
      await run(install, provider, journal)
      expect(toolOutputs(provider)).toEqual(["failed: Invalid confirmation response"])
      expect(JSON.stringify(journal.frames)).not.toContain("PRIVATE")
      expect(journal.frames.some((frame) => frame.type === "call.settled")).toBe(false)
    }
  })

  test("each call has its own stable key across a producer-generation retry", async () => {
    const keys: unknown[][] = []
    for (const generation of [2, 3]) {
      const journal = producer(
        (path) => file(path, JOURNEY),
        () => Response.json({ state: "requested" }, { status: 202 })
      )
      const provider = model([execute("todo.stop", "T12"), execute("todo.stop", "T12")])
      await run({ ...install, generation }, provider, journal)
      keys.push(journal.calls.map((call) => (call.body as { key: string }).key))
      expect(toolOutputs(provider)).toEqual([
        "{\"status\":202,\"body\":{\"state\":\"requested\"}}",
        "{\"status\":202,\"body\":{\"state\":\"requested\"}}"
      ])
    }
    expect(keys).toEqual([
      [`chat:${install.turnId}:0`, `chat:${install.turnId}:1`],
      [`chat:${install.turnId}:0`, `chat:${install.turnId}:1`]
    ])
  })

  test("theme commits an explicit private instruction without an HTTP command or card", async () => {
    const journal = producer(path => file(path, JOURNEY), stackRoutes)
    const provider = model([execute("theme", "dark")])
    await run(install, provider, journal)
    expect(journal.calls).toEqual([])
    expect(journal.frames.filter(frame => frame.type === "call.settled")).toEqual([
      { runId: install.request.runId, type: "call.settled", link: 0, ordinal: 0, name: "theme", verdict: "run", ui: { command: "theme", mode: "dark" } }
    ])
    expect(toolOutputs(provider)).toEqual(["Requested /theme dark on the author's screen."])
  })

  test("theme refuses toggles, unknown modes and extra authority fields", async () => {
    for (const args of [undefined, "pink", "{broken", '{"mode":null}', '{"mode":"dark","command":"todo.drop"}']) {
      const journal = producer(path => file(path, JOURNEY), stackRoutes)
      const provider = model([execute("theme", args)])
      await run(install, provider, journal)
      expect(journal.calls).toEqual([])
      expect(journal.frames.filter(frame => frame.type === "call.settled")).toEqual([])
      expect(toolOutputs(provider)).toEqual(["failed: Invalid arguments for theme; use light or dark."])
    }
  })

  test("merge stays a person's action and forged Draft authority refuses", async () => {
    for (const args of ['{"text":"x","cardId":"forged"}', '{"text":"x","idempotencyKey":"forged"}', '{"text":"x","before":12}']) {
      const journal = producer(path => file(path, JOURNEY), stackRoutes)
      const provider = model([execute("todo.new", args)])
      await run(install, provider, journal)
      expect(journal.calls).toEqual([])
      expect(journal.frames.some(frame => frame.type === "card")).toBe(false)
      expect(toolOutputs(provider)[0]).toMatch(/^failed:/)
    }
    const journal = producer(path => file(path, JOURNEY), stackRoutes)
    const provider = model([execute("merge", "T12")])
    await run(install, provider, journal)
    expect(journal.calls).toEqual([])
    expect(toolOutputs(provider)[0]).toContain("unknown-command")
  })

  test("schema and argument errors refuse before transport", async () => {
    for (
      const [name, args] of [
        ["stack", "everything"],
        ["todo", "12"],
        ["todo", "twelve"],
        ["todo", "{\"n\":-1}"],
        ["todo", "{broken"],
        ["todo", "T12 unwanted"],
        ["todo", "T9007199254740992"],
        ["todo.new", "{\"text\":\"x\",\"extra\":true}"],
        ["todo.new", "{\"before\":0}"],
        ["stack.move", "T12 sideways"],
        ["branch.fork", "main"],
        ["todo.stop", "{\"n\":12,\"op\":\"drop\"}"]
      ]
    ) {
      const journal = producer((path) => file(path, JOURNEY), stackRoutes)
      const provider = model([execute(name!, args)])
      await run(install, provider, journal)
      expect(journal.calls, `${name} ${args}`).toEqual([])
      expect(toolOutputs(provider)).toEqual([name === "todo.new" ? "failed: todo.new takes the TODO's text, and optionally its title and acceptance." : `failed: Invalid arguments for ${name}; use its declared payload.`])
    }
  })

  test("a command the host does not run, or whose rule is never, runs nothing and answers unknown-command", async () => {
    for (
      const name of [
        "approval.approve",
        "members.remove",
        "todo.erase",
        "flow.list",
        "files.write",
        "settings"
      ]
    ) {
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

describe("delegated public API transport", () => {
  test("writes require the host key, send JSON once, and accept empty 204 only for writes", async () => {
    const requests: Array<RequestInit | undefined> = []
    const call = apiCaller("http://callback.test", install, async (_url, init) => {
      requests.push(init)
      return new Response(null, { status: 204 })
    })
    expect(await Effect.runPromise(call("/api/todos/12", { method: "POST", body: { op: "stop" } }))).toEqual({
      code: "call_refused"
    })
    expect(requests).toEqual([])
    expect(
      await Effect.runPromise(call("/api/todos/12", { method: "POST", body: { op: "stop" }, idempotencyKey: "host-1" }))
    )
      .toEqual({ status: 204, body: null })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body).toBe("{\"op\":\"stop\"}")
    expect(new Headers(requests[0]?.headers).get("Idempotency-Key")).toBe("host-1")
    expect(new Headers(requests[0]?.headers).get("Content-Type")).toBe("application/json")
    expect(await Effect.runPromise(call("/api/github/sync", { method: "POST", idempotencyKey: "host-2" })))
      .toEqual({ status: 204, body: null })
    expect(requests[1]?.body).toBe("{}")
    expect(await Effect.runPromise(call("/api/todos/12"))).toEqual({ code: "invalid_answer" })
  })

  test("interrupting an API read aborts its outstanding request", async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let observed: AbortSignal | undefined
    let calls = 0
    const read = apiCaller("http://callback.test", install, (_input, init) => {
      calls++
      return new Promise((_resolve, reject) => {
        observed = init?.signal as AbortSignal
        observed.addEventListener("abort", () => reject(new Error("interrupted")))
        entered()
      })
    })
    const abort = new AbortController()
    const pending = Effect.runPromiseExit(read("/api/todos"), { signal: abort.signal })
    await started
    abort.abort()
    expect((await pending)._tag).toBe("Failure")
    expect(observed?.aborted).toBe(true)
    expect(calls).toBe(1)
  })
  test("decodes multibyte characters across stream boundaries", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ title: "café 日本 🐈" }))
    const read = apiCaller("http://callback.test", install, async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
            controller.close()
          }
        })
      ))
    expect(await Effect.runPromise(read("/api/todos"))).toEqual({ status: 200, body: { title: "café 日本 🐈" } })
  })
  test("refuses absent authority and non-API destinations before transport", async () => {
    let fetched = false
    const fetchImpl: FetchLike = async () => {
      fetched = true
      return Response.json({})
    }
    expect(await Effect.runPromise(apiCaller("http://callback.test", grant, fetchImpl)("/api/todos")))
      .toEqual({ code: "forbidden" })
    for (
      const path of [
        "/private",
        "https://other.test/api/todos",
        "//other.test/api/todos",
        "/api/../private",
        "/api/x#fragment",
        "/api/\\private"
      ]
    ) {
      expect(await Effect.runPromise(apiCaller("http://callback.test", install, fetchImpl)(path)))
        .toEqual({ code: "call_refused" })
    }
    expect(fetched).toBe(false)
  })
  test("uses the pinned origin and redacts literal and escaped bearer reflections", async () => {
    const token = install.api!.token
    const read = apiCaller("http://callback.test", install, async (input, init) => {
      expect(String(input)).toBe("http://callback.test/api/todos?q=one")
      expect(init?.method).toBe("GET")
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`)
      expect(new Headers(init?.headers).get("smithers-via")).toBe("smithers")
      expect(init?.redirect).toBe("manual")
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response(`{"plain":"${token}","escaped":"\\u0073${token.slice(1)}"}`)
    })
    expect(await Effect.runPromise(read("/api/todos?q=one")))
      .toEqual({ status: 200, body: { plain: "[redacted]", escaped: "[redacted]" } })
  })
  test("refuses redirects, empty responses and invalid UTF-8", async () => {
    const redirected = Response.json({})
    Object.defineProperty(redirected, "redirected", { value: true })
    for (
      const [response, code] of [
        [Response.redirect("https://other.test", 302), "call_refused"],
        [redirected, "call_refused"],
        [new Response(null, { status: 204 }), "invalid_answer"],
        [new Response(new Uint8Array([255])), "invalid_answer"]
      ] as const
    ) {
      expect(await Effect.runPromise(apiCaller("http://callback.test", install, async () => response)("/api/todos")))
        .toEqual({ code })
    }
  })
  test("bounds decoded API bodies at four MiB and cancels an oversized stream", async () => {
    const boundary = JSON.stringify("x".repeat(4 * 1024 * 1024 - 2))
    const valid = await Effect.runPromise(
      apiCaller("http://callback.test", install, async () => new Response(boundary))("/api/todos")
    )
    expect("status" in valid && valid.status).toBe(200)
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(boundary + " "))
        },
        cancel() {
          cancelled = true
          throw new Error("upstream cancellation failed")
        }
      })
    )
    expect(await Effect.runPromise(apiCaller("http://callback.test", install, async () => response)("/api/todos")))
      .toEqual({ code: "invalid_answer" })
    expect(cancelled).toBe(true)
  })
})
