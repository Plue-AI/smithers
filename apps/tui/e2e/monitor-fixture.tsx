/**
 * A monitor on a worker tab, delivered through the real App. Jev is scripted:
 * `MONITOR_NOTABLE=1` calls the worker finishing notable, otherwise nothing is.
 * Each verdict is appended to `judged.log` so a test knows Jev was asked.
 */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { appendFileSync } from "node:fs"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"

const notable = process.env.MONITOR_NOTABLE === "1"
const host: Host.Host = {
  cwd: process.cwd(),
  judged: true,
  dispose: async () => {},
  monitor: {
    judge: async ({ after }) => {
      const verdict = notable && after.includes("status: done")
      appendFileSync("judged.log", `${JSON.stringify({ verdict, done: after.includes("status: done") })}\n`)
      return verdict
    },
    compose: async () => "Build failed on main."
  },
  run: (input) => {
    if (input.role === "worker") {
      return {
        done: new Promise((resolve) => setTimeout(() => resolve({ _tag: "done", answer: "Build failed." }), 1_500)),
        cancel: () => {}
      }
    }
    let answer = "Still here."
    if (input.prompt === "watch a slow shell") {
      input.runtime!.monitors!.create({
        id: "shell",
        title: "Shell",
        watch: "the command changes",
        source: { kind: "shell", command: "trap '' TERM; echo $$ > monitor.pid; sleep 30" }
      })
      answer = "Watching the shell."
    }
    if (input.prompt === "stop the shell watch") {
      input.runtime!.monitors!.stop("shell")
      answer = "Shell watch stopped."
    }
    if (input.prompt === "watch the build") {
      input.runtime!.delegate!({ id: "build", title: "Build", prompt: "Run the build." })
      input.runtime!.monitors!.create({
        id: "ci",
        title: "CI",
        watch: "the build fails",
        source: { kind: "tab", id: "build" }
      })
      answer = "Watching the build."
    }
    queueMicrotask(() =>
      input.onEvent(
        {
          _tag: "resolved",
          eventType: "flows.harness.resolved.v1",
          message: { role: "assistant", content: [{ type: "text", text: answer }] }
        } as never
      )
    )
    return { done: Promise.resolve({ _tag: "done", answer }), cancel: () => {} }
  }
}
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
createRoot(renderer).render(
  <App host={host} seat="test:chat" workerSeat="test:worker" models={[]} contextWindow={() => 128_000} />
)
