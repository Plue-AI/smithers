import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as LlmLint from "../src/LlmLint.ts"

const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY"] as const
let root: string
let store: string
let saved: ReadonlyArray<string | undefined>

const write = async (relative: string, text: string): Promise<void> => {
  const path = Path.join(root, relative)
  await Fs.mkdir(Path.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

beforeEach(async () => {
  // A seat transport is the only credential route: no API key is on the box.
  saved = keys.map((name) => process.env[name])
  for (const name of keys) delete process.env[name]
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "review-transport-")))
  store = await Fs.mkdtemp(Path.join(Os.tmpdir(), "review-transport-store-"))
  await write("src/a.ts", "export const a = 1\n")
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root })
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base"], { cwd: root })
  await write("src/a.ts", "export const a = 2\n")
})

afterEach(async () => {
  keys.forEach((name, index) => {
    const value = saved[index]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  })
  await Fs.rm(root, { recursive: true, force: true })
  await Fs.rm(store, { recursive: true, force: true })
})

const payload = (overrides: Partial<LlmLint.Payload> = {}): LlmLint.Payload => ({
  base: "HEAD",
  include: [Input.glob("src/**")],
  context: [],
  prompt: "Review",
  rubric: "Rubric",
  engine: "claude",
  model: "claude-opus-5-5",
  batchSize: 1,
  failOn: "error",
  ...overrides
})

const completion = (findings: ReadonlyArray<unknown> = []) =>
  JSON.stringify({
    status: "completed",
    coverage: [{ checkId: "general", status: "completed", evidence: "Inspected src/a.ts." }],
    missingContext: [],
    findings
  })

type Seen = { seat: LlmLint.ReviewSeat; request: ModelRequest.ModelRequest }

/** A scripted seat model that answers every request with `answer` and records what it was sent. */
const seats = (
  answer: string | ((seat: LlmLint.ReviewSeat) => ReadonlyArray<ModelEvent.ModelEvent>),
  seen: Array<Seen>
): LlmLint.ReviewTransport =>
(seat) =>
  Effect.succeed({
    modelId: `resolved/${seat.model}`,
    model: Model.make({
      stream: (request) =>
        Stream.suspend(() => {
          seen.push({ seat, request })
          return Stream.fromIterable(
            typeof answer === "function" ? answer(seat) : [
              ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t", text: answer }),
              ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
            ]
          )
        })
    })
  })

describe("LlmLint.review seat transport", () => {
  it("runs every security pass through the host's seats with no API key and records the seat transport", async () => {
    const seen: Array<Seen> = []
    const report = await Effect.runPromise(LlmLint.review(
      { workspaceRoot: root, transport: seats(completion(), seen), store: { directory: store, owner: "//:security" } },
      payload({ securityChecks: ["general"], required: true })
    ))
    expect(report.files).toEqual(["src/a.ts"])
    expect(report.findings).toEqual([])
    // Selected family, the other family, then the selected family again.
    expect(seen.map(({ seat }) => seat)).toEqual([
      { engine: "claude", model: "claude-opus-5-5" },
      { engine: "codex", model: "gpt-6-sol" },
      { engine: "claude", model: "claude-opus-5-5" }
    ])
    for (const { seat, request } of seen) {
      expect(request.modelId).toBe(`resolved/${seat.model}`)
      expect(request.tools).toEqual([])
      expect(request.toolChoice).toBe("none")
      expect(request.system.map((part) => part.text).join("\n")).toContain("Rubric:\nRubric")
    }
    expect(report.manifest?.engine.transport).toBe("seat")
    expect(report.manifest?.engine.executable).toBeUndefined()
  })

  it("fails a required review when a seat is unavailable instead of skipping it", async () => {
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
      { workspaceRoot: root, transport: () => Effect.fail(new Error("Claude Code is signed out")) },
      payload({ securityChecks: ["general"], required: true })
    )))
    expect(failure).toBeInstanceOf(LlmLint.LlmReviewError)
    expect(failure.message).toBe("Review seat unavailable: Claude Code is signed out")
  })

  it("returns a generic review's findings from the seat answer", async () => {
    const seen: Array<Seen> = []
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
      {
        workspaceRoot: root,
        transport: seats(JSON.stringify([{ file: "src/a.ts", line: 1, severity: "error", message: "bad" }]), seen)
      },
      payload()
    )))
    expect(failure).toBeInstanceOf(LlmLint.FindingsError)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.seat).toEqual({ engine: "claude", model: "claude-opus-5-5" })
  })

  it.each(
    [
      [
        "a tool call",
        [
          ModelEvent.ModelEvent.ToolCallStart({ type: "tool-call-start", id: "c", name: "shell" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "tool-calls" })
        ]
      ],
      ["an unsettled stream", [ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t", text: "[]" })]],
      [
        "a token-limited answer",
        [
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t", text: "[" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "length" })
        ]
      ]
    ] as const
  )("rejects %s from a seat like any provider answer", async (_name, events) => {
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
      { workspaceRoot: root, transport: seats(() => events, []) },
      payload()
    )))
    expect(failure.message).toBe("Review inference failed or returned an incomplete response")
  })

  it("reports a seat's content filter as a refusal, never a clean review", async () => {
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
      {
        workspaceRoot: root,
        transport: seats(() => [ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "content-filter" })], [])
      },
      payload()
    )))
    expect(failure.message).toBe("Review provider refused the request")
  })

  it("refuses an executable override beside a seat transport", async () => {
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
      { workspaceRoot: root, executable: "claude", transport: seats("[]", []) },
      payload()
    )))
    expect(failure.message).toBe("LLM review takes an executable override or a seat transport, not both")
  })
})
