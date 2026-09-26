/** A single approval that settles the turn with the actual keyboard choice. */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "../src/app.tsx"
import type * as Approvals from "../src/approvals.ts"
import type * as Host from "../src/host.ts"

let settle = (_: Host.Outcome) => {}
let pending = false
const request: Approvals.Pending = {
  requestId: "req-1",
  flow: "bash",
  subject: process.env.TUI_APPROVAL_SUBJECT ?? "true",
  source: "chat",
  action: "proc:spawn",
  tier: "irreversible",
  always: true
}
const host: Host.Host = {
  cwd: process.cwd(),
  judged: false,
  compaction: async () => undefined,
  dispose: async () => {},
  run: (input) => {
    pending = true
    input.onEvent({ _tag: "cell-produced", cell: { text: "await ctx.call('bash')" } } as never)
    return {
      done: new Promise((resolve) => {
        settle = resolve
      }),
      cancel: () => {
        pending = false
        settle({ _tag: "cancelled" })
      }
    }
  },
  approvals: {
    authorize: async () => {},
    mode: "ask",
    pending: async () => pending ? [request] : [],
    reply: async (_, choice) => {
      pending = false
      settle({ _tag: "done", answer: `Choice: ${choice}` })
      return undefined
    }
  }
}
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
createRoot(renderer).render(<App host={host} seat="test" models={[]} contextWindow={() => 128_000} />)
