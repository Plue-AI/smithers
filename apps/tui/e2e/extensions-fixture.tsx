/**
 * Deterministic host for PTY coverage of contributed UI. Discovery is the
 * real registry over the working directory's `flows/`, so `metadata.tui` is
 * read exactly as a user's repository declares it. A run never resolves until
 * the chat says `finish`, so the toast and the card can be checked while it runs.
 */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Schema } from "effect"
import { App } from "../src/app.tsx"
import * as FlowControl from "../src/flow-control.ts"
import type * as Flows from "../src/flows.ts"
import type * as Host from "../src/host.ts"

let settle = (_: Flows.Settled) => {}
const host: Host.Host = {
  cwd: process.cwd(),
  judged: false,
  compaction: async () => undefined,
  dispose: async () => {},
  run: (input) => {
    let answer = "Still here."
    if (input.prompt === "plan release") {
      input.runtime!.publish({
        kind: "panel",
        placement: "card",
        panel: {
          id: "release",
          title: "Release plan",
          summary: "Two steps left.",
          rows: [
            { id: "changelog", label: "Changelog", status: "done", details: [] },
            { id: "tag", label: "Tag", status: "running", details: [] },
            {
              id: "publish",
              label: "Publish",
              details: [],
              action: { label: "Publish", action: { kind: "flow", flow: "review" } }
            }
          ]
        }
      })
      input.runtime!.publish({ kind: "status", status: { id: "ci", text: "CI ✓", tone: "success" } })
      answer = "Planned."
    }
    if (input.prompt === "finish") {
      settle({ kind: "done", answer: "Approved." })
      answer = "Finished."
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
const real = FlowControl.make({
  cwd: process.cwd(),
  environment: process.env,
  approvals: {} as NonNullable<Host.Host["approvals"]>
})
const flows: Flows.Port = {
  discover: real.discover,
  body: real.body,
  input: async () => Schema.Struct({}),
  plan: async () => ({ all: false, raw: {} }),
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
  <App host={host} seat="test:chat" workerSeat="test:worker" models={[]} contextWindow={() => 128_000} flows={flows} />
)
