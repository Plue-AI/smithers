/** Deterministic host for PTY coverage of chat while a worker remains unresolved. */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Schema } from "effect"
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { App } from "../src/app.tsx"
import * as Changes from "../src/changes.ts"
import type * as Flows from "../src/flows.ts"
import type * as Host from "../src/host.ts"
import type * as Models from "../src/models.ts"

/**
 * `SMITHERS_FIXTURE_MODELS` names the detected providers (`openai`, `anthropic`);
 * `SMITHERS_FIXTURE_COMPLETE`, when set, is a one-shot model that appends each
 * seat it is asked for to that file and answers, or throws when the seat's
 * provider was not detected.
 */
const detected: Record<string, ReadonlyArray<Models.Model>> = {
  openai: [{ seat: "openai:gpt-6-sol", label: "GPT-6 Sol", provider: "OpenAI" }],
  anthropic: [{ seat: "anthropic:claude-opus-5-5", label: "Claude Opus 5.5", provider: "Anthropic" }]
}
const models = (process.env.SMITHERS_FIXTURE_MODELS ?? "").split(",").flatMap((name) => detected[name] ?? [])
const calls = process.env.SMITHERS_FIXTURE_COMPLETE
const complete: Host.Host["complete"] = calls === undefined ? undefined : async ({ seat }) => {
  appendFileSync(calls, `${seat}\n`)
  if (!models.some((model) => model.seat.split(":")[0] === seat.split(":")[0])) {
    throw new Error(`Set OPENAI_API_KEY to use ${seat}`)
  }
  if (process.env.SMITHERS_FIXTURE_COMPLETE_FAILS === "1") throw new Error("Estimate provider outage")
  return JSON.stringify({ minutes: 90, tokens: 1000 })
}
const host: Host.Host = {
  cwd: process.cwd(),
  judged: false,
  ...(complete === undefined ? {} : { complete }),
  dispose: async () => {
    await real?.dispose()
  },
  run: (input) => {
    if (input.role === "worker" && input.prompt === "Fix math.js.") {
      // A worker cell whose `edit` call changes math.js, captured like the host's flows.
      const identity = { session: "fixture", frame: 1, cell: 1, ordinal: 0 }
      const before = readFileSync("math.js", "utf8")
      const after = before.replace("a - b", "a + b")
      input.onEvent({ _tag: "cell-produced", cell: { text: "await ctx.call(\"edit\")" } } as any)
      input.onEvent(
        { _tag: "cell-call-started", call: { flowName: "edit", input: { path: "math.js" }, identity } } as any
      )
      writeFileSync("math.js", after)
      input.onPatch!({ call: Changes.identity(identity as any), patches: [Changes.patch("math.js", before, after)!] })
      input.onEvent(
        { _tag: "cell-call-settled", flowName: "edit", identity, result: { outcome: "success", value: {} } } as any
      )
      input.onEvent({ _tag: "cell-settled", outcome: { _tag: "settled" } } as any)
      return { done: Promise.resolve({ _tag: "done", answer: "Fixed." }), cancel: () => {} }
    }
    if (input.role === "worker") {
      return {
        done: new Promise((resolve) => {
          cancelled = () => resolve({ _tag: "cancelled" })
        }),
        cancel: () => cancelled()
      }
    }
    if (input.prompt === "what is the ETA on all tasks") {
      // A real coordinator turn: the recorded model's cell calls `tab.eta` through the runtime binding.
      // Loaded on demand: the real host's import must not slow every other test's first draw.
      const turn = import("../src/host.ts").then((Real) =>
        (real ??= Real.make({ cwd: process.cwd(), environment: {} }))
          .run({ ...input, seat: `replay:${etaReplay()}` })
      )
      return { done: turn.then((started) => started.done), cancel: () => void turn.then((started) => started.cancel()) }
    }
    let answer = "Still here."
    if (input.prompt === "delegate fix") {
      input.runtime!.delegate!({ id: "fixer", title: "Fixer", prompt: "Fix math.js." })
      answer = "Requested the fix."
    }
    if (input.prompt === "investigate") {
      const request = { id: "investigation", title: "Investigation", prompt: "Investigate the failing check." }
      const first = input.runtime!.delegate!(request)
      input.runtime!.delegate!(request)
      answer = `Requested the investigation.`
      if ((first as { status: string }).status !== "requested") throw new Error("Expected request receipt")
    }
    queueMicrotask(() =>
      input.onEvent(
        {
          _tag: "resolved",
          eventType: "flows.harness.resolved.v1",
          message: { role: "assistant", content: [{ type: "text", text: answer }] }
        } as any
      )
    )
    return { done: Promise.resolve({ _tag: "done", answer }), cancel: () => {} }
  }
}
let cancelled = () => {}
let real: Host.Host | undefined
/** A recorded coordinator reply whose one cell asks `tab.eta` and answers with it. */
const etaReplay = (): string => {
  const file = join(mkdtempSync(join(tmpdir(), "tui-eta-replay-")), "eta.jsonl")
  const delta = (value: object) => JSON.stringify({ at: 0, event: { _tag: "model-delta", delta: value } })
  const cell = "const eta = await ctx.call(\"tab.eta\", {})\n" +
    "ctx.done(\"ETA \" + eta.tasks.map((task) => task.id + \":\" + task.status + \":\" + task.method).join(\",\"))"
  writeFileSync(
    file,
    [
      JSON.stringify({ at: 0, event: { _tag: "model-requested" } }),
      delta({ type: "text-start", id: "cell" }),
      delta({ type: "text-delta", id: "cell", text: `\`\`\`cell\n${cell}\n\`\`\`` }),
      delta({ type: "text-end", id: "cell" }),
      JSON.stringify({ at: 0, event: { _tag: "model-settled", message: { stopReason: "stop" } } })
    ].join("\n")
  )
  return file
}
/** One flow that needs `{title}`; its run settles only when stopped. */
let settle = (_: Flows.Settled) => {}
const flows: Flows.Port = {
  discover: async () => [
    {
      name: "review",
      description: "Review a change",
      modelInvocable: true,
      kind: "module",
      flows: [],
      capabilities: [],
      path: "flows/review/flow.ts"
    }
  ],
  body: async (flow) => {
    throw new Error(`${flow} is a module flow`)
  },
  input: async () => Schema.Struct({ title: Schema.String }),
  plan: async () => ({ raw: {} }),
  start: async () => "run-1",
  resume: async (runId) => ({ runId }),
  watch: () => ({
    done: new Promise((resolve) => {
      settle = resolve
    }),
    close: () => {}
  }),
  events: async () => [],
  cancel: async () => settle({ kind: "cancelled" }),
  dispose: async () => {}
}
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
createRoot(renderer).render(
  <App
    host={host}
    seat="test:chat"
    workerSeat="test:worker"
    models={models}
    contextWindow={() => 128_000}
    flows={flows}
  />
)
