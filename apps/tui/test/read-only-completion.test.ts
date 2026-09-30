/** #2937: truthful answers survive an unchanged workspace through the shipped TUI host. */
import * as NodeControl from "@smthrs/cli/NodeControl"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as CompletionClaim from "@smthrs/harness/CompletionClaim"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { afterEach, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"
import * as Subagents from "../src/subagents.ts"
import * as Tabs from "../src/tabs.ts"
import { Workspace } from "../src/workspace.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const expected = [
  ["Fix an issue", "issue.implement"],
  ["Review a PR", "prs.triage"],
  ["Ask the codebase", "wiki.ask"],
  ["Run it every night", "triggers.register"]
] as const
const answer = expected.map(([title, flow]) => `${title}: ${flow}`).join("\n")
const prompt =
  "Read .smithers/FACTORY.ts and tell me the names of its four home apps and their flow IDs. Do not edit files, run shell commands, or spawn workers."
const read = "const source = await ctx.call(\"read\", { path: \".smithers/FACTORY.ts\" }); console.log(source.content)"
const complete = `ctx.done(${JSON.stringify(answer)})`
const incompleteReply = "I could not edit the factory because writes were denied. No files changed."
const deniedEdit =
  "try { await ctx.call(\"edit\", { path: \".smithers/FACTORY.ts\", oldString: \"Fix an issue\", newString: \"Fix\" }) } catch {}"
const incompleteReading = () => probabilities({ complete: 0.01, reportsLimitation: 0.99 })
// Frozen input from the live incident; it is part of this suite's declared target inputs.
const factory = readFileSync(join(import.meta.dir, "fixtures/read-only-factory.txt"), "utf8")

const project = (cells: ReadonlyArray<string>) => {
  const root = mkdtempSync(join(tmpdir(), "tui-read-only-"))
  roots.push(root)
  const cwd = join(root, "project")
  mkdirSync(join(cwd, ".smithers"), { recursive: true })
  writeFileSync(join(cwd, ".smithers", "FACTORY.ts"), factory)
  writeFileSync(join(cwd, "README.md"), "# Read-only product audit\n")
  // Keep the replay outside the measured project. Its cells execute real guarded filesystem flows.
  const replay = join(root, "replay.jsonl")
  writeFileSync(
    replay,
    cells.flatMap((cell, index) => [
      { at: 0, event: { _tag: "model-requested" } },
      { at: 0, event: { _tag: "model-delta", delta: { type: "text-start", id: "cell" } } },
      {
        at: 0,
        event: { _tag: "model-delta", delta: { type: "text-delta", id: "cell", text: `\`\`\`cell\n${cell}\n\`\`\`` } }
      },
      { at: 0, event: { _tag: "model-delta", delta: { type: "text-end", id: "cell" } } },
      // Reproduce the two successful calls from the live 20k incident. A third admission cannot fit.
      {
        at: 0,
        event: {
          _tag: "model-delta",
          delta: {
            type: "usage",
            inputTokens: index === 0 ? 6878 : 8404,
            outputTokens: index === 0 ? 80 : 82,
            totalTokens: index === 0 ? 6958 : 8486
          }
        }
      },
      { at: 0, event: { _tag: "model-settled", message: { stopReason: "stop" } } }
    ]).map((event) => JSON.stringify(event)).join("\n")
  )
  return { root, cwd, replay }
}

const probabilities = (extra: Partial<Record<string, number>> = {}): Record<string, number | undefined> => ({
  complete: 0.99,
  overclaims: 0.01,
  invented: 0.01,
  requiresWorkspaceChange: 0.01,
  reportsLimitation: 0.01,
  ...extra
})

/** Only the model and judgment are scripted; host, filesystem, observer and budget are production services. */
const judge = (
  readings: Array<CompletionClaim.Evidence>,
  values = probabilities()
) =>
  Evaluator.layerScripted((request) => {
    if ("complete" in request.questions) {
      const evidence = Schema.decodeUnknownSync(CompletionClaim.Evidence)(request.state)
      readings.push(evidence)
      // Assert real receipts rather than allowing a scripted successful answer to hide a failed read.
      if (evidence.task.includes(".smithers/FACTORY.ts")) {
        expect(evidence.callsRun).toContainEqual(expect.objectContaining({
          flow: "read",
          input: expect.stringContaining(".smithers/FACTORY.ts"),
          ok: true
        }))
      }
      return Object.fromEntries(Object.keys(request.questions).map((id) => [id, { probability: values[id] ?? 0.01 }]))
    }
    return Object.fromEntries(
      Object.keys(request.questions).map((id) => [id, {
        probability: id.startsWith("sentence") ? values.invented ?? 0.01 : 0.01
      }])
    )
  })

const run = async (
  where: ReturnType<typeof project>,
  request: string,
  evaluator: Layer.Layer<Evaluator.Evaluator>,
  role?: "worker",
  tokenCeiling = 20000
) => {
  const events: Array<AgentEvent.AgentEvent> = []
  const host = Host.make({
    cwd: where.cwd,
    environment: {},
    approvals: "deny",
    budget: { tokens: { max: tokenCeiling } },
    judge: evaluator
  })
  try {
    const outcome = await host.run({
      prompt: request,
      ...(role === undefined ? {} : { role }),
      seat: `replay:${where.replay}`,
      history: [],
      onEvent: (event) => events.push(event)
    }).done
    expect(readFileSync(join(where.cwd, ".smithers/FACTORY.ts"), "utf8")).toBe(factory)
    expect(readdirSync(where.cwd).sort()).toEqual([".smithers", "README.md"])
    return { outcome, events }
  } finally {
    await host.dispose()
  }
}

for (const role of [undefined, "worker"] as const) {
  test(`the ${role ?? "print"} host delivers a real read's answer before a third model admission`, async () => {
    const readings: Array<CompletionClaim.Evidence> = []
    const { outcome, events } = await run(project([read, complete]), prompt, judge(readings), role)
    expect(outcome).toEqual({ _tag: "done", answer })
    expect(events.filter((event) => event._tag === "model-requested")).toHaveLength(2)
    expect(events.filter((event) => event._tag === "cell-call-settled").map((event) => event.flowName)).toEqual([
      "read"
    ])
    const settledRead = events.find((event) => event._tag === "cell-call-settled" && event.flowName === "read")
    expect(settledRead?._tag === "cell-call-settled" && settledRead.result)
      .toMatchObject({
        outcome: "success",
        value: { content: factory.endsWith("\n") ? factory.slice(0, -1) : factory, truncated: false }
      })
    const mutations = events.filter((event) => event._tag === "mutation-observed")
    expect(mutations).toHaveLength(2)
    expect(mutations.every((event) => event.basis === "observed" && !event.mutated)).toBe(true)
    expect(readings).toHaveLength(1)
    expect(readings[0]!.treeMoved).toBe(false)
    expect(readings[0]!.claim).toBe(answer)
    expect(events.some((event) => event._tag === "unmoved-demanded")).toBe(false)
    expect(events.some((event) => event._tag === "claim-demanded" && (event.demanded || event.refused))).toBe(false)
  })
}

test("a conversational reply finishes without touching the workspace or calling a flow", async () => {
  const readings: Array<CompletionClaim.Evidence> = []
  const reply = "Hello."
  const { outcome, events } = await run(project([`ctx.done(${JSON.stringify(reply)})`]), "Say hello.", judge(readings))
  expect(outcome).toEqual({ _tag: "done", answer: reply })
  expect(events.filter((event) => event._tag === "model-requested")).toHaveLength(1)
  expect(events.some((event) => event._tag === "cell-call-settled")).toBe(false)
  expect(events.some((event) => event._tag === "unmoved-demanded")).toBe(false)
  expect(readings[0]!.treeMoved).toBe(false)
})

test("an honest incomplete outcome fails once with its exact explanation and no extra model admission", async () => {
  const readings: Array<CompletionClaim.Evidence> = []
  const { outcome, events } = await run(
    project([deniedEdit, `ctx.done(${JSON.stringify(incompleteReply)})`]),
    "Edit the factory homepage title.",
    judge(readings, incompleteReading())
  )
  expect(outcome).toMatchObject({
    _tag: "failed",
    message: incompleteReply,
    error: { code: "completion_incomplete", message: incompleteReply }
  })
  expect(events.filter((event) => event._tag === "model-requested")).toHaveLength(2)
  expect(readings).toHaveLength(1)
  const denied = events.find((event) => event._tag === "cell-call-settled" && event.flowName === "edit")
  expect(denied?._tag === "cell-call-settled" && denied.result.outcome).toBe("failure")
  expect(readings[0]!.callsRun).toContainEqual(expect.objectContaining({ flow: "edit", ok: false }))
  expect(events.some((event) => event._tag === "unmoved-demanded")).toBe(false)
  expect(events.some((event) => event._tag === "claim-demanded" && (event.demanded || event.refused))).toBe(false)
  expect(events.some((event) => event._tag === "resolved")).toBe(false)
  expect(readings[0]!.treeMoved).toBe(false)
})

test("an incomplete worker persists failed and retryable through the actual workspace and reload", async () => {
  const where = project([deniedEdit, `ctx.done(${JSON.stringify(incompleteReply)})`])
  const seat = `replay:${where.replay}`
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = join(where.root, "sessions")
  const readings: Array<CompletionClaim.Evidence> = []
  const records: Array<Session.Record> = []
  const host = Host.make({
    cwd: where.cwd,
    environment: { SMITHERS_TUI_WORKER_SEAT: seat },
    approvals: "deny",
    budget: { tokens: { max: 20000 } },
    judge: judge(readings, incompleteReading())
  })
  const workspace = new Workspace({
    host,
    workerSeat: seat,
    history: () => [],
    persist: (record) => records.push(record)
  })
  let restored: Workspace | undefined
  try {
    expect(workspace.request({ id: "edit", title: "Edit homepage", prompt: "Edit the factory homepage title." }))
      .toEqual({ id: "edit", status: "requested" })
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {}
      const deadline = setTimeout(() => {
        unsubscribe()
        reject(new Error("The incomplete worker did not settle"))
      }, 5000)
      const check = () => {
        if (workspace.read("edit").status !== "failed") return
        clearTimeout(deadline)
        unsubscribe()
        resolve()
      }
      unsubscribe = workspace.subscribe(check)
      check()
    })
    const tab = workspace.snapshot().tabs[0]!
    expect(tab).toMatchObject({ status: "failed", message: incompleteReply, failure: { headline: "Work incomplete" } })
    expect(tab.answer).toBeUndefined()
    expect(workspace.panel("edit").summary).toBe("Work incomplete")
    expect(Subagents.subagent(tab, workspace.transcript(tab.id), []).status).toBe("failed")
    expect(Tabs.actions(tab).map((action) => action.id)).toContain("retry")
    const outcomes = Session.load(tab.file).filter((record) => record.type === "outcome")
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({
      outcome: { _tag: "failed", message: incompleteReply, headline: "Work incomplete" }
    })
    expect(records.filter((record) => record.type === "tab").some((record) => record.tab.status === "done")).toBe(false)
    restored = new Workspace({
      host,
      workerSeat: seat,
      history: () => [],
      persist: () => {},
      restored: workspace.snapshot()
    })
    expect(restored.read("edit")).toMatchObject({ status: "failed", message: incompleteReply })
    expect(restored.panel("edit").summary).toBe("Work incomplete")
    expect(Tabs.actions(restored.snapshot().tabs[0]!).map((action) => action.id)).toContain("retry")
    expect(readings).toHaveLength(1)
    expect(
      Session.load(tab.file).filter((record) => record.type === "event" && record.event._tag === "model-requested")
    )
      .toHaveLength(2)
    expect(Session.load(tab.file).some((record) => record.type === "event" && record.event._tag === "resolved")).toBe(
      false
    )
    expect(readFileSync(join(where.cwd, ".smithers/FACTORY.ts"), "utf8")).toBe(factory)
  } finally {
    restored?.dispose()
    workspace.dispose()
    await host.dispose()
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
  }
})

test.each(
  [
    ["I changed the factory homepage title and saved the file.", 0.01],
    ["I changed the factory homepage title, but could not verify it.", 0.99]
  ] as const
)("a fabricated edit is refused even with an explicit limitation: %s", async (claim, reportsLimitation) => {
  const readings: Array<CompletionClaim.Evidence> = []
  const { outcome, events } = await run(
    project([`ctx.done(${JSON.stringify(claim)})`]),
    "Edit the factory homepage title.",
    judge(
      readings,
      probabilities({
        requiresWorkspaceChange: 0.99,
        invented: 0.99,
        complete: 0.01,
        overclaims: 0.99,
        reportsLimitation
      })
    ),
    undefined,
    100000
  )
  expect(outcome).toMatchObject({ _tag: "failed", error: { code: "claim_unproven" } })
  expect(events.some((event) => event._tag === "unmoved-demanded")).toBe(true)
  expect(events.some((event) => event._tag === "claim-demanded" && event.refused)).toBe(true)
  expect(events.some((event) => event._tag === "resolved")).toBe(false)
  expect(readings.every((evidence) => !evidence.treeMoved)).toBe(true)
})

test("an unavailable judge fails once with its typed refusal instead of another model attempt", async () => {
  let completions = 0
  const unavailable = Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
    evaluate: (request) => {
      if ("complete" in request.questions) completions++
      return Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "Judge unavailable" }))
    }
  }))
  const { outcome, events } = await run(project(["ctx.done(\"Hello.\")"]), "Say hello.", unavailable)
  expect(outcome).toMatchObject({ _tag: "failed", error: { code: "completion_unjudged" } })
  expect(events.filter((event) => event._tag === "model-requested")).toHaveLength(1)
  expect(completions).toBe(1)
  expect(events.some((event) => event._tag === "resolved")).toBe(false)
})

test("a subscription-pool judgment delivers the read-only answer without an AI gateway key", async () => {
  const sent: Array<string> = []
  const readings: Array<CompletionClaim.Evidence> = []
  const executor = RequestExecutor.RequestExecutor.of({
    execute: (request) => {
      sent.push(request.url)
      if (request.url.endsWith("/routes")) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ routes: ["chatgpt"] })))
      }
      if (request.body._tag !== "Uint8Array") throw new Error("Expected the subscription's JSON request")
      const body = JSON.parse(new TextDecoder().decode(request.body.body)) as {
        input: ReadonlyArray<{ role: string; content: ReadonlyArray<{ text?: string }> }>
      }
      const user = body.input.findLast((message) => message.role === "user")
      const question = JSON.parse(user!.content.find((part) => part.text !== undefined)!.text!) as Evaluator.Request
      const values = probabilities()
      if ("complete" in question.questions) {
        readings.push(Schema.decodeUnknownSync(CompletionClaim.Evidence)(question.state))
      }
      const answers = Object.fromEntries(
        Object.entries(question.questions).map(([id, item]) => [
          id,
          item.type === "boolean" ?
            { type: "boolean", probability: values[id] ?? 0.01 }
            : item.type === "choice" ?
            { type: "choice", choice: Object.keys(item.criteria)[0]! }
            : { type: "score", score: 0 }
        ])
      )
      const text = JSON.stringify({ answers })
      const events = [
        { type: "response.output_text.delta", item_id: "answer", output_index: 0, content_index: 0, delta: text },
        { type: "response.completed", response: { id: "response", status: "completed", usage: {} } }
      ]
      return Effect.succeed(HttpClientResponse.fromWeb(
        request,
        new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } }
        )
      ))
    }
  })
  // The HTTP responses are controlled to prove real subscription selection/protocol wiring without model spend.
  const evaluator = NodeControl.layerSeatEvaluator({
    SMITHERS_ACCOUNT_POOL_URL: "https://pool.example",
    SMITHERS_ACCOUNT_POOL_KEY: "test-credential",
    SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt",
    CODEX_HOME: "/nonexistent"
  }).pipe(Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor)))
  const { outcome, events } = await run(project([read, complete]), prompt, evaluator)
  expect(outcome).toEqual({ _tag: "done", answer })
  expect(events.filter((event) => event._tag === "model-requested")).toHaveLength(2)
  expect(readings).toHaveLength(1)
  expect(readings[0]!.treeMoved).toBe(false)
  expect(readings[0]!.callsRun).toContainEqual(expect.objectContaining({ flow: "read", ok: true }))
  expect(sent.some((url) => url.endsWith("/chatgpt/codex/responses"))).toBe(true)
  expect(sent.every((url) => url.startsWith("https://pool.example/"))).toBe(true)
})

const print = (where: ReturnType<typeof project>, request: string, values = probabilities()) => {
  const preload = join(where.root, "judge.ts")
  // The replay fixture's generic judge is conservative. This explicit fixture supplies the
  // measured question-answer verdict while leaving the production print entry unchanged.
  writeFileSync(
    preload,
    `import { mock } from "bun:test";
import * as Evaluator from ${
      JSON.stringify(resolve(import.meta.dir, "../../../packages/smithers/agent/model/src/Evaluator.ts"))
    };
const values = ${JSON.stringify(values)};
const layer = Evaluator.layerScripted(request => Object.fromEntries(Object.keys(request.questions).map(id => [id, {probability: values[id] ?? 0.01}])));
mock.module("@smthrs/agent/ScriptedJudge", () => ({layerAll: layer}));
`
  )
  const child = spawnSync(process.execPath, [
    "--preload",
    preload,
    resolve(import.meta.dir, "../src/main.tsx"),
    where.cwd,
    "--print",
    request,
    "--approve",
    "deny",
    "--budget-tokens",
    "20000"
  ], {
    cwd: where.cwd,
    env: {
      ...process.env,
      SMITHERS_TUI_REPLAY: where.replay,
      SMITHERS_TUI_SESSION_DIR: join(where.root, "sessions"),
      AI_GATEWAY_API_KEY: ""
    },
    encoding: "utf8",
    timeout: 15000
  })
  expect(child.error).toBeUndefined()
  expect(readFileSync(join(where.cwd, ".smithers/FACTORY.ts"), "utf8")).toBe(factory)
  expect(readdirSync(where.cwd).sort()).toEqual([".smithers", "README.md"])
  return child
}

test("the source TUI print command returns the useful answer under deny with the same bounded budget", () => {
  const child = print(project([read, complete]), prompt)
  expect(child.status).toBe(0)
  expect(child.stderr).toBe("")
  expect(child.stdout.trim()).toBe(answer)
})

test("the source TUI print command exits nonzero with the preserved explanation for incomplete work", () => {
  const child = print(
    project([deniedEdit, `ctx.done(${JSON.stringify(incompleteReply)})`]),
    "Edit the factory homepage title.",
    incompleteReading()
  )
  expect(child.status).toBe(1)
  expect(child.stdout).toBe("")
  expect(child.stderr.trim()).toBe(`denied edit; SMITHERS_TUI_APPROVE=all allows\nWork incomplete\n${incompleteReply}`)
})
