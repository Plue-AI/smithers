import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"

const host: Host.Host = {
  cwd: process.cwd(),
  judged: false,
  dispose: async () => {},
  run: (input) => {
    if (input.role === "coordinator") {
      input.runtime!.delegate!({ id: "review", title: "Recursive review", prompt: "Review" })
      input.runtime!.publish({
        kind: "panel",
        placement: "tab",
        panel: {
          id: "review",
          title: "Recursive review",
          summary: "Review in progress.",
          placement: "main",
          bind: { tree: "review" },
          rows: []
        }
      })
      return { done: Promise.resolve({ _tag: "done", answer: "Requested the review." }), cancel: () => {} }
    }
    if (input.source === "review") {
      input.runtime!.delegate!({ id: "agent", title: "Agent package", prompt: "Review agent" })
      input.runtime!.delegate!({ id: "tui", title: "TUI app", prompt: "Review TUI" })
    }
    return { done: new Promise(() => {}), cancel: () => {} }
  }
}
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
createRoot(renderer).render(
  <App host={host} seat="test:chat" workerSeat="test:worker" models={[]} contextWindow={() => 128_000} />
)
