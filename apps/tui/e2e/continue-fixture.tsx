/** A deterministic host for submitting follow-ups from settled worker tabs. */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"

const host: Host.Host = {
  cwd: process.cwd(),
  judged: false,
  compaction: async () => undefined,
  dispose: async () => {},
  run: (input) => {
    if (input.role === "worker") {
      if (input.prompt === "Initial stopped work") {
        let stop: (outcome: Host.Outcome) => void = () => {}
        return {
          done: new Promise<Host.Outcome>((resolve) => {
            stop = resolve
          }),
          cancel: () => stop({ _tag: "cancelled" })
        }
      }
      if (input.prompt === "Initial failed work") {
        return { done: Promise.resolve({ _tag: "failed", message: "Fixture failure", detail: "" }), cancel: () => {} }
      }
      const answer = input.prompt === "Initial done work" ? "Initial answer" : `Continued: ${input.prompt}`
      queueMicrotask(() =>
        input.onEvent({
          _tag: "resolved",
          eventType: "flows.harness.resolved.v1",
          message: { role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop" }
        })
      )
      return { done: Promise.resolve({ _tag: "done", answer }), cancel: () => {} }
    }
    const kind = input.prompt.match(/^start (done|failed|stopped)$/)?.[1]
    if (kind !== undefined) {
      input.runtime!.delegate!({ id: "review", title: "Review", prompt: `Initial ${kind} work` })
    }
    const answer = kind === undefined ? `Chat handled: ${input.prompt}` : "Requested review."
    queueMicrotask(() =>
      input.onEvent({
        _tag: "resolved",
        eventType: "flows.harness.resolved.v1",
        message: { role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop" }
      })
    )
    return { done: Promise.resolve({ _tag: "done", answer }), cancel: () => {} }
  }
}

const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
createRoot(renderer).render(
  <App host={host} seat="test:chat" workerSeat="test:worker" models={[]} contextWindow={() => 128_000} />
)
