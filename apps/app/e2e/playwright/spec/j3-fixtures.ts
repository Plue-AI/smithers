import type { BranchCard } from "@smthrs/rpc/BranchCard"
import type { Actor } from "@smthrs/rpc/CardPrimitives"
import type { Page } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { identityRoute } from "../identity"

export const alice: Actor = { kind: "person", login: "alice", name: "Alice", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 1 }
export const maya: Actor = { kind: "person", login: "maya", name: "Maya", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 2, via: "ssh" }
export const ben: Actor = { kind: "person", login: "ben", name: "Ben", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 0 }
export const coding: Actor = { kind: "agent", id: "coding-run", agent: "coding", run_id: "coding-run", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 0, for_member: ben }
export const claude: Actor = { kind: "agent", id: "claude-session", agent: "claude-code", session_id: "claude-session", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 0, for_member: ben }
export const smithers: Actor = { kind: "agent", id: "smithers-turn", agent: "smithers", session_id: "smithers-turn", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 0, for_member: ben }
export const reviewer: Actor = { kind: "agent", id: "review-run", agent: "reviewer", run_id: "review-run", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 0, for_member: ben }

export const branch = (presence: BranchCard["presence"] = [], state: "awake" | "asleep" = "awake"): BranchCard => ({
  id: "j3-branch", name: "smithers/retry-webhooks", item: { n: 2, title: "Retry webhooks", state: "working", place: 2 },
  machine: { state }, presence, terminals: [{ id: "ben-shell", title: "Ben's terminal", owner: ben, agents: [], watchers: [], frozen: false }],
  activity: [], changed_files: [], ssh_line: "ssh -p 2222 retry-webhooks@maya-mini.tail1234.ts.net"
})

// Controlled HTTP/live transport projection, through the production app seam.
// No claim of actual leases, SSH authentication or reference-host execution.
export async function liveBranch(page: Page, initial: BranchCard) {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  // Install live subscriptions require the browser session, independently of
  // the delegated /api/user identity used by non-install fixtures.
  await page.route("**/api/auth/session", identityRoute())
  let current = initial
  const subscribers = new Set<() => void>()
  await page.route("**/api/branches", route => route.fulfill({ json: [{ name: current.name, kind: "item", state: current.machine.state, machine: { id: current.id } }] }))
  await page.route("**/api/todos/2", route => route.fulfill({ json: { branch: { name: current.name } } }))
  await page.route("**/api/branches/smithers%2Fretry-webhooks", route => route.fulfill({ json: { name: current.name, machine: { id: current.id } } }))
  await page.routeWebSocket("**/api/live", socket => {
    const own = new Set<() => void>()
    socket.onClose(() => { for (const publish of own) subscribers.delete(publish) })
    socket.onMessage(raw => {
      if (typeof raw !== "string") return
      const frame = JSON.parse(raw)
      if (frame.t !== "sub") return
      let cursor = 0
      if (frame.topic === "branch:j3-branch" || frame.topic === "branch:smithers/retry-webhooks" || frame.topic === "branch:j3-branch:activity") {
        const publish = () => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: ++cursor, data: frame.topic.endsWith(":activity") ? current.activity : current }))
        own.add(publish)
        subscribers.add(publish)
        publish()
      } else if (frame.topic === "branch:main") socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: 1, data: {
        ...current, id: "main", name: "main", machine: { state: "awake" }, presence: []
      } }))
      else socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" }))
    })
  })
  return (next: BranchCard) => {
    current = next
    for (const publish of subscribers) publish()
  }
}
