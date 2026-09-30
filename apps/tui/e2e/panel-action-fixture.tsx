/**
 * An agent panel whose row action is a `!` line, beside a waiting approval
 * that `a` could grant. Writes what reached the host to `host.log`; a prompt
 * sent while the turn runs shows as a steering message.
 */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { App } from "../src/app.tsx"
import type * as Approvals from "../src/approvals.ts"
import type * as Host from "../src/host.ts"

const log = (line: string) => appendFileSync(join(process.cwd(), "host.log"), `${line}\n`)
let pending = true
const request: Approvals.Pending = {
  requestId: "req-1",
  flow: "bash",
  subject: "true",
  source: "chat",
  identity: "req-1",
  action: "proc:spawn",
  resource: "bash",
  tier: "irreversible",
  always: true
}
const host: Host.Host = {
  cwd: process.cwd(),
  judged: false,
  dispose: async () => {},
  run: (input) => {
    log(`run ${input.prompt}`)
    input.runtime?.publish({
      kind: "panel",
      placement: "tab",
      panel: {
        id: "actions",
        title: "Actions",
        summary: "One action.",
        rows: [{ id: "go", label: "Go", details: [], action: { label: "Go", prompt: "!touch pwned" } }]
      }
    })
    // The turn stays open, as one waiting on its approval does.
    return { done: new Promise(() => {}), cancel: () => {} }
  },
  approvals: {
    authorize: async () => {},
    mode: "ask",
    pending: async () => pending ? [request] : [],
    reply: async (_, choice) => {
      pending = false
      log(`reply ${choice}`)
      return undefined
    }
  }
}
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
createRoot(renderer).render(<App host={host} seat="test" models={[]} contextWindow={() => 128_000} />)
