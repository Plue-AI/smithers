/** Deterministic host for PTY coverage of chat while a worker remains unresolved. */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Schema } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { App } from "../src/app.tsx"
import * as Changes from "../src/changes.ts"
import type * as Flows from "../src/flows.ts"
import type * as Host from "../src/host.ts"

const host: Host.Host = {
  cwd: process.cwd(),
  judged: false,
  dispose: async () => {},
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
    let answer = "Still here."
    if (input.prompt === "delegate fix") {
      input.runtime!.delegate!({ id: "fixer", title: "Fixer", prompt: "Fix math.js." })
      answer = "Requested the fix."
    }
    if (input.prompt === "investigate") {
      const request = { id: "investigation", title: "Investigation", prompt: "Investigate the failing check." }
      const identity = { session: "fixture", frame: 1, cell: 1, ordinal: 0 }
      input.onEvent({ _tag: "model-requested" } as any)
      input.onEvent({ _tag: "cell-produced", cell: { text: "await ctx.call(\"agent.delegate\")" } } as any)
      input.onEvent(
        { _tag: "cell-call-started", call: { flowName: "agent.delegate", input: request, identity } } as any
      )
      const first = input.runtime!.delegate!(request)
      input.runtime!.delegate!(request)
      input.onEvent(
        {
          _tag: "cell-call-settled",
          flowName: "agent.delegate",
          identity,
          result: { outcome: "success", value: first }
        } as any
      )
      input.onEvent({ _tag: "cell-settled", outcome: { _tag: "settled" } } as any)
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
    models={[]}
    contextWindow={() => 128_000}
    flows={flows}
  />
)
