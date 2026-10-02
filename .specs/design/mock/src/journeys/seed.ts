/*
 * The team and repository every journey starts from: a small team at an early
 * company (mvp.md §1.1) on one private repository. Each journey copies this
 * world and adjusts it to its own starting point.
 */
import type { CodeLine, Entry, FlowStep, Member, Setup, State, Todo, Viewer, World } from "../world"

export const MAYA = "maya"
export const BEN = "ben"
export const ALICE = "alice"

export const MEMBERS: ReadonlyArray<Member> = [
  { id: MAYA, name: "Maya Chen", login: "mayachen", initials: "MC", lane: 2, role: "owner" },
  { id: BEN, name: "Ben Ortiz", login: "benortiz", initials: "BO", lane: 0, role: "maintainer" },
  { id: ALICE, name: "Alice Park", login: "alicepark", initials: "AP", lane: 1, role: "member" }
]

export const TODO_FLOW: ReadonlyArray<FlowStep> = [
  { id: "plan", title: "Plan" },
  { id: "implement", title: "Implement" },
  { id: "verify", title: "Verify" },
  { id: "review", title: "Review" },
  { id: "propose", title: "Propose" }
]

/**
 * The address the team opens, which the owner sets in Settings (mvp.md J1.8, §6.1). HTTPS comes from whatever the
 * team puts in front (here `tailscale serve`); the install itself serves plain HTTP, and our UI names no front.
 */
export const INSTALL_ADDRESS = "https://maya-mini.tail1234.ts.net"

/** The install every journey after J1 runs on: J1 ends with exactly this. */
const installedSetup = (): Setup => ({
  listen: "network", addresses: [INSTALL_ADDRESS], memory: "32 GB",
  github: "app-installed", repository: "acme/api", provider: "Anthropic",
  fastKey: "saved", codingKey: "saved", gatewayKey: "saved", obsidian: "~/Obsidian/acme-api",
  source: "ready", sourcePct: 100, machine: "ready", machinePct: 100
})

export const RETRY_FILE = "src/webhooks/retry.ts"

const code = (text: string): Array<CodeLine> => text.split("\n").map((line, index) => ({ n: index + 1, text: line }))

export const retrySource = (): Array<CodeLine> => code(`import { backoff } from "../lib/backoff"
import { post, sleep } from "../lib/http"

export async function deliver(event: WebhookEvent) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await post(event.url, event.body)
    if (response.ok) return
    await sleep(30_000)
  }
  throw new DeliveryFailed(event.id)
}

export async function redeliver(event: WebhookEvent) {
  await sleep(30_000)
  return deliver(event)
}`)

export const STRIPE: Todo = {
  id: "t-stripe", ref: "T8", title: "Upgrade the Stripe SDK to v17", owner: MAYA, branch: "b-stripe", state: "in-review", pr: 88,
  prompt: "Upgrade stripe to v17. Keep the webhook signature check working.",
  evidence: {
    files: 4, added: 38, removed: 21,
    checks: [{ name: "typecheck", state: "passed", took: "14s" }, { name: "test", state: "passed", took: "1m 12s" }, { name: "lint", state: "passed", took: "9s" }],
    github: { passed: 5, total: 5 },
    review: "No blocking issues. Webhook signatures verified against v17 fixtures."
  }
}

export const RETRY: Todo = {
  id: "t-retry", ref: "T9", title: "Retry failed webhooks with backoff", owner: BEN, branch: "b-retry", state: "needs-you", issue: 212, step: "verify",
  prompt: "Failed webhook deliveries should retry up to 5 times with backoff, then mark the event failed. Fixes #212.",
  question: { text: "Each retry waits 30 s, so the retry test times out. Switch to exponential backoff, or raise the test timeout?" },
  elapsed: "12m"
}

export const CHECKOUT: Todo = {
  id: "t-checkout", ref: "T10", title: "Fix the flaky checkout test", owner: ALICE, branch: "b-checkout", state: "working", step: "implement",
  prompt: "checkout.test.ts fails about 1 run in 10 on CI. Find the race and fix it.", elapsed: "6m"
}

export const flowVersion = (id: string, label: string, state: "active" | "proposed" | "merged-syncing" | "merged-failed" | "previous", steps: ReadonlyArray<FlowStep>) =>
  ({ id, label, state, steps: steps.map(step => ({ ...step })) })

export const LOGGING: Todo = {
  id: "t-log", ref: "T11", title: "Log every webhook retry attempt", owner: MAYA, branch: "b-log", state: "queued", queue: 1,
  prompt: "Log each retry attempt with the event id, attempt number and delay."
}

/* A person's `transcript` is the conversation of the branch they are in: an accessor, so every journey reads and writes the shared one. */
export const viewerOf = (world: World, id: string): Viewer => {
  const screen = { id, at: "main", views: {}, composerOpen: false, draft: "" } as Omit<Viewer, "transcript"> as Viewer
  Object.defineProperty(screen, "transcript", {
    enumerable: true,
    get: () => (world.conversations[screen.at] ??= []),
    set: (entries: Array<Entry>) => { world.conversations[screen.at] = entries }
  })
  return screen
}

export const seedWorld = (): World => ({
  repo: "acme/api",
  members: [...MEMBERS],
  stack: [STRIPE.id, RETRY.id, CHECKOUT.id, LOGGING.id],
  todos: [structuredClone(STRIPE), structuredClone(RETRY), structuredClone(CHECKOUT), structuredClone(LOGGING)],
  branches: [
    { id: "b-stripe", name: "upgrade-stripe", item: STRIPE.id, from: "main", machine: "asleep", presence: [], activity: [], terminals: [] },
    {
      id: "b-retry", name: "retry-webhooks", item: RETRY.id, from: "main", machine: "awake",
      presence: [{ who: ALICE, where: { kind: "file", path: RETRY_FILE } }, { who: "agent:b-retry", where: { kind: "step", step: "verify" } }],
      activity: [
        { id: "a1", who: "agent:b-retry", kind: "step", text: "Planned: retry with backoff, give up after 5 attempts", tone: "ok", seq: 0 },
        { id: "a2", who: "agent:b-retry", kind: "step", text: "Edited src/webhooks/retry.ts", tone: "ok", seq: 0 },
        { id: "a3", who: "agent:b-retry", kind: "step", text: "pnpm test webhooks · 1 failed", tone: "fail", seq: 0 },
        { id: "a4", who: "agent:b-retry", kind: "question", text: RETRY.question!.text, seq: 0 }
      ],
      terminals: []
    },
    {
      id: "b-checkout", name: "fix-checkout-race", item: CHECKOUT.id, from: "main", machine: "awake",
      presence: [{ who: "agent:b-checkout", where: { kind: "step", step: "implement" } }], activity: [], terminals: []
    },
    { id: "b-log", name: "log-retries", item: LOGGING.id, from: "main", machine: "waiting", waitPosition: 1, presence: [], activity: [], terminals: [] }
  ],
  terminals: [],
  files: [{ path: RETRY_FILE, branch: "b-retry", lines: retrySource() }],
  issues: [],
  flow: TODO_FLOW.map(step => ({ ...step })),
  capacity: 3,
  parallel: 2,
  setup: installedSetup(),
  mergedSinceLook: 5,
  drafts: [],
  runs: [],
  flowVersions: [],
  syncedAgo: 40,
  proposals: [],
  reviews: [],
  acts: [],
  secrets: [],
  github: [],
  traces: [],
  wiki: [],
  conversations: { main: [] }
})

export const seedState = (viewers: ReadonlyArray<string>): State => {
  const world = seedWorld()
  return { world, viewers: Object.fromEntries(viewers.map(id => [id, viewerOf(world, id)])), seq: 0 }
}
