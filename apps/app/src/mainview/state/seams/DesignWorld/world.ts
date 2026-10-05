/*
 * MOCK SEED (delete with ./index.ts). The design world's rows and its seed,
 * ported from .specs/design/mock/src/world.ts and journeys/{seed,states,
 * j1-data,j4-data,j5-data,j7-data,ask,agent,run}.ts. Row shapes follow the
 * design mock, not the rpc wire models: card files map them to View props.
 */

export type ActorId = string

export interface DesignMember {
  readonly id: ActorId
  readonly name: string
  readonly login: string
  readonly initials: string
  /** --lane-0..5 */
  readonly lane: number
  readonly role: "owner" | "maintainer" | "member"
  readonly needsAccess?: boolean
  readonly suspended?: boolean
  readonly permission?: "admin" | "maintain" | "write"
}

export type DesignTodoState = "queued" | "starting" | "working" | "needs-you" | "paused" | "in-review" | "merged" | "failed" | "dropped"

export interface DesignCheck { readonly name: string; readonly state: "passed" | "failed" | "running"; readonly took?: string }

export interface DesignEvidence {
  readonly rev?: string
  readonly files: number
  readonly added: number
  readonly removed: number
  readonly checks: ReadonlyArray<DesignCheck>
  readonly github: { readonly passed: number; readonly total: number; readonly failing?: string }
  readonly review: string
  readonly reviewing?: boolean
  readonly previous?: { readonly rev: string; readonly review: string }
}

export interface DesignFlowStep { readonly id: string; readonly title: string; readonly detail?: string }

export interface DesignTodo {
  readonly id: string
  readonly ref: string
  readonly title: string
  readonly prompt: string
  readonly owner: ActorId
  readonly branch: string
  readonly state: DesignTodoState
  readonly queue?: number
  readonly step?: string
  readonly steps?: ReadonlyArray<DesignFlowStep>
  readonly flowVersion?: string
  readonly attempts?: number
  readonly question?: {
    readonly text: string
    readonly answer?: { readonly by: ActorId; readonly text: string }
    readonly late?: { readonly by: ActorId; readonly text: string }
  }
  readonly needs?: "question" | "approval" | "conflict" | "moved_off" | "order" | "foreign_push" | "force_push"
  readonly pushedBy?: ActorId
  readonly issue?: number
  readonly fixes?: boolean
  readonly amendments?: ReadonlyArray<{ readonly by: ActorId; readonly text: string }>
  readonly pr?: number
  readonly mergeBlock?: string
  readonly mergedVia?: string
  readonly evidence?: DesignEvidence
  readonly approvedRev?: string
  readonly approvalCleared?: boolean
  readonly lessons?: number
  readonly elapsed?: string
  readonly failure?: string
  readonly steers?: ReadonlyArray<{ readonly by: ActorId; readonly text: string }>
  /** Freshness: the world version that last changed the row. */
  readonly seq?: number
}

export type DesignWhere =
  | { readonly kind: "terminal"; readonly id: string; readonly watching?: boolean }
  | { readonly kind: "file"; readonly path: string; readonly line?: number }
  | { readonly kind: "reading"; readonly path: string; readonly line?: number }
  | { readonly kind: "step"; readonly step: string }
  | { readonly kind: "branch" }

export interface DesignPresence { readonly who: ActorId; readonly where: DesignWhere; readonly watching?: string }

export interface DesignActivity {
  readonly id: string
  readonly who: ActorId
  readonly kind: "step" | "steer" | "question" | "answer" | "edit" | "change" | "read" | "context"
  readonly text: string
  readonly files?: number
  readonly items?: ReadonlyArray<string>
  readonly tone?: "ok" | "fail" | "run"
  readonly github?: boolean
  readonly asked?: ActorId
  readonly seq?: number
}

export type DesignMachine = "awake" | "asleep" | "waking" | "waiting" | "closed"

export interface DesignBranch {
  readonly id: string
  readonly name: string
  /** Absent on a scratch branch. */
  readonly item?: string
  /** "main" or the branch a scratch branch forked from. */
  readonly from: string
  readonly machine: DesignMachine
  readonly waitPosition?: number
  readonly rebasePending?: string
  readonly movedOff?: { readonly by: ActorId; readonly item: string }
  readonly presence: ReadonlyArray<DesignPresence>
  readonly activity: ReadonlyArray<DesignActivity>
  readonly terminals: ReadonlyArray<string>
}

export interface DesignTerminal {
  readonly id: string
  readonly branch: string
  readonly title: string
  readonly owner: ActorId
  readonly running?: string
  readonly prompt?: string
  readonly lines: ReadonlyArray<{ readonly text: string; readonly tone?: "prompt" | "ok" | "fail" | "dim" }>
  readonly watchers: ReadonlyArray<ActorId>
  readonly offer?: string
}

export interface DesignCodeLine { readonly n: number; readonly text: string; readonly by?: ActorId; readonly was?: string }

export interface DesignFile {
  /** `${branch}:${path}` */
  readonly id: string
  readonly path: string
  readonly branch: string
  readonly lines: ReadonlyArray<DesignCodeLine>
  readonly editors?: ReadonlyArray<{ readonly who: ActorId; readonly line: number }>
  readonly gone?: { readonly kind: "deleted" | "renamed"; readonly by: ActorId; readonly to?: string }
  readonly outside?: { readonly line: number; readonly text: string }
}

export interface DesignIssue {
  readonly number: number
  readonly title: string
  readonly author: ActorId
  readonly body: string
  readonly age: string
  readonly comments: ReadonlyArray<{ readonly who: ActorId; readonly text: string; readonly age: string }>
  readonly open: boolean
  readonly todo?: string
  readonly fixes?: boolean
  readonly labeled?: { readonly by: ActorId; readonly age: string }
}

export type DesignPlace = { readonly kind: "append" } | { readonly kind: "before"; readonly id: string } | { readonly kind: "amend"; readonly id: string }

export interface DesignDraft {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly issue?: number
  readonly fixes: boolean
  readonly place: DesignPlace
  readonly committed?: string
  readonly by: ActorId
}

export interface DesignRun {
  readonly id: string
  readonly title: string
  readonly state: "running" | "done" | "failed"
  readonly detail?: string
  readonly todo?: string
  readonly queue?: number
  readonly lessons?: ReadonlyArray<string>
}

export interface DesignFlowVersion {
  readonly id: string
  /** The flow's name: "todo", "merge". */
  readonly flow: string
  readonly label: string
  readonly state: "active" | "proposed" | "merged-syncing" | "merged-failed" | "previous"
  readonly todo?: string
  readonly steps: ReadonlyArray<DesignFlowStep>
  readonly error?: string
  readonly system?: boolean
  readonly by?: ActorId
}

export interface DesignCell {
  readonly id: string
  readonly kind: "context" | "read" | "edit" | "run" | "think" | "ask" | "answer" | "steer" | "reviewer" | "rebase"
  readonly explain: string
  readonly quote?: string
  readonly code?: string
  readonly output?: ReadonlyArray<string>
  readonly tone?: "ok" | "fail" | "wait"
  readonly took?: string
  readonly tokens?: string
  readonly who?: ActorId
}

export interface DesignPhase {
  readonly id: string
  readonly step: string
  readonly title: string
  readonly summary: string
  readonly took?: number
  readonly tone?: "thrash" | "wait" | "live" | "ok" | "fail"
  readonly indicator?: string
  readonly cells: ReadonlyArray<DesignCell>
}

export interface DesignTrace {
  readonly id: string
  readonly title: string
  readonly todo?: string
  readonly attempt: number
  readonly branch: string
  readonly state: "running" | "waiting" | "held" | "merged" | "failed"
  readonly held?: { readonly since: string }
  readonly phases: ReadonlyArray<DesignPhase>
}

export interface DesignWikiPage {
  readonly id: string
  readonly title: string
  readonly rev: number
  readonly authors: ReadonlyArray<ActorId>
  readonly lines: ReadonlyArray<DesignCodeLine>
  readonly editors?: ReadonlyArray<{ readonly who: ActorId; readonly line: number }>
  readonly decision?: { readonly from: number; readonly to: number; readonly by: ActorId; readonly change: number }
  readonly cited?: ReadonlyArray<{ readonly todo: string; readonly rev: number }>
}

export interface DesignPr {
  readonly number: number
  readonly todo: string
  readonly title: string
  readonly base: string
  readonly head: string
  /** The head commit, 40 hex: what Merge binds to. */
  readonly sha: string
  readonly state: "open" | "merged" | "closed"
  readonly draftAfter?: string
  readonly requestedBy: ActorId
  readonly body: ReadonlyArray<string>
  readonly approvals: ReadonlyArray<ActorId>
  readonly required: number
  readonly mergedBy?: ActorId
}

export interface DesignSecret { readonly name: string; readonly scope: "all branches" | "main only" }

export interface DesignAgent {
  readonly id: string
  readonly steps: ReadonlyArray<string>
  readonly instructions: string
  readonly model: string
  readonly changed?: { readonly from: string; readonly by: ActorId }
}

/** A✓: a one-click confirmation only its asker can press (ConfirmView one_click). */
export interface DesignAct {
  readonly id: string
  readonly by: ActorId
  readonly verb: string
  readonly target: string
  readonly text?: string
  readonly receipt: string
  readonly todo?: string
  readonly asker?: ActorId
  /** The flow the press runs, as the person, with its input: `todo.drop` `{ n: 11 }`. */
  readonly tag?: string
  readonly args?: Record<string, unknown>
  readonly state: "asked" | "done" | "cancelled"
}

export interface DesignReview {
  readonly id: string
  readonly branch: string
  readonly by: ActorId
  readonly verdict: "clean" | "changes"
  readonly rev?: string
  readonly findings: ReadonlyArray<{ readonly severity: "blocker" | "fix" | "note"; readonly path: string; readonly line: number; readonly text: string; readonly acted?: "fix" | "not-useful" }>
}

export interface DesignProposal { readonly id: string; readonly title: string; readonly evidence: string; readonly refs: ReadonlyArray<number>; readonly todo?: string }

export interface DesignForm {
  readonly id: string
  readonly title: string
  readonly submit: string
  readonly fields: ReadonlyArray<{ readonly id: string; readonly label: string; readonly value: string; readonly required?: boolean; readonly multiline?: boolean }>
  readonly receipt?: string
}

export interface DesignSetup {
  readonly listen: "mac" | "network"
  readonly addresses: ReadonlyArray<string>
  readonly memory: string
  readonly github: "todo" | "signed-in" | "app-installed" | "app-failed"
  readonly appCreated?: boolean
  readonly appError?: string
  readonly squash?: boolean
  readonly upgrade?: string
  readonly fastKey?: "validating" | "saved" | "failed"
  readonly codingKey?: "validating" | "saved" | "failed"
  readonly gatewayKey?: "validating" | "saved" | "failed"
  readonly provider: string
  readonly keyError?: string
  readonly obsidian: string
  readonly repository?: string
  readonly source: "waiting" | "mirroring" | "ready"
  readonly sourcePct?: number
  readonly machine: "waiting" | "building" | "ready"
  readonly machinePct?: number
  readonly machineNote?: string
  readonly machineError?: string
  readonly addressChange?: { readonly from: string; readonly to: string; readonly reason: string }
}

/** The repository's one row: the stack order, main, machines and the install. */
export interface DesignRepo {
  readonly id: "repo"
  readonly repo: string
  /** TODO ids in merge order, next to merge first. */
  readonly stack: ReadonlyArray<string>
  /** The active TODO flow's steps. */
  readonly flow: ReadonlyArray<DesignFlowStep>
  readonly capacity: number
  readonly parallel: number
  readonly mergedSinceLook: number
  readonly syncedAgo: number
  /** main's head commit, 40 hex. */
  readonly mainSha: string
  readonly mainHead?: { readonly text: string }
  readonly mainHealth?: { readonly state: "refused" | "limited"; readonly cause: string; readonly retryAt?: string }
  readonly nextPr: number
  readonly setup: DesignSetup
}

export interface DesignWorldRows {
  readonly repo: DesignRepo
  readonly members: ReadonlyArray<DesignMember>
  readonly todos: ReadonlyArray<DesignTodo>
  readonly branches: ReadonlyArray<DesignBranch>
  readonly terminals: ReadonlyArray<DesignTerminal>
  readonly files: ReadonlyArray<DesignFile>
  readonly issues: ReadonlyArray<DesignIssue>
  readonly drafts: ReadonlyArray<DesignDraft>
  readonly runs: ReadonlyArray<DesignRun>
  readonly flowVersions: ReadonlyArray<DesignFlowVersion>
  readonly traces: ReadonlyArray<DesignTrace>
  readonly wiki: ReadonlyArray<DesignWikiPage>
  readonly prs: ReadonlyArray<DesignPr>
  readonly secrets: ReadonlyArray<DesignSecret>
  readonly agents: ReadonlyArray<DesignAgent>
  readonly acts: ReadonlyArray<DesignAct>
  readonly reviews: ReadonlyArray<DesignReview>
  readonly proposals: ReadonlyArray<DesignProposal>
  readonly forms: ReadonlyArray<DesignForm>
}

/* ── Actors (world.ts) ─────────────────────────────────────── */

export const MAYA = "maya"
export const BEN = "ben"
export const ALICE = "alice"
/** The stack service. */
export const STACK = "smithers"
/** An unattributable write. */
export const OUTSIDE = "outside"
/** A branch's coding agent: `agent:<branchId>`. */
export const agentOf = (branch: string): ActorId => `agent:${branch}`

/* ── Seed (journeys/seed.ts, j1 world) ─────────────────────── */

const code = (text: string): ReadonlyArray<DesignCodeLine> => text.split("\n").map((line, index) => ({ n: index + 1, text: line }))

export const TODO_FLOW: ReadonlyArray<DesignFlowStep> = [
  { id: "plan", title: "Plan", detail: "Read the TODO and the wiki, then write a plan." },
  { id: "implement", title: "Implement", detail: "Edit the branch until the plan is done." },
  { id: "verify", title: "Verify", detail: "Run typecheck and the tests the change touches." },
  { id: "review", title: "Review", detail: "Review the diff and run lint." },
  { id: "propose", title: "Propose", detail: "Open or update the pull request with its evidence." }
]

export const INSTALL_ADDRESS = "https://maya-mini.tail1234.ts.net"
export const RETRY_FILE = "src/webhooks/retry.ts"
export const RETRY_QUESTION = "Each retry waits 30 s, so the retry test times out. Switch to exponential backoff, or raise the test timeout?"

const passed = (name: string, took: string): DesignCheck => ({ name, state: "passed", took })

const STRIPE_EVIDENCE: DesignEvidence = {
  rev: "3f9a2c1", files: 4, added: 38, removed: 21,
  checks: [passed("typecheck", "14s"), passed("test", "1m 12s"), passed("lint", "9s")],
  github: { passed: 5, total: 5 },
  review: "No blocking issues. Webhook signatures verified against v17 fixtures."
}

/** Deterministic 40-hex commit ids for seeded and simulated commits. */
export const shaOf = (seed: string): string => {
  let hash = 2166136261
  let out = ""
  for (let round = 0; out.length < 40; round++) {
    for (const char of `${seed}#${round}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
    out += (hash >>> 0).toString(16).padStart(8, "0")
  }
  return out.slice(0, 40)
}

const retrySource = (): ReadonlyArray<DesignCodeLine> => code(`import { backoff } from "../lib/backoff"
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

const mailSource = (): ReadonlyArray<DesignCodeLine> => code(`import { APP_URL } from "../config"
import { events } from "../events"
import { createResetToken } from "../auth/reset-token"
import type { User } from "../users"
import { mailer } from "./mailer"

export async function sendPasswordReset(user: User): Promise<void> {
  const token = await createResetToken(user.id)
  await mailer.send({
    to: user.email,
    template: "password-reset-v2",
    data: { name: user.firstName, link: \`\${APP_URL}/reset?token=\${token}\` }
  })
}

events.on("password.reset", ({ user }) => sendPasswordReset(user))`)

const checkoutTest = (): ReadonlyArray<DesignCodeLine> => code(`import { checkout } from "./checkout"
import { stripe } from "../test/stripe"

test("charges the saved card", async () => {
  const order = await makeOrder({ total: 4200 })
  const result = checkout(order)
  stripe.resolveIntent(order.intent)
  expect(result.status).toBe("paid")
  await result.settled
})`)

const flowSource = (): ReadonlyArray<DesignCodeLine> => code(`import { Flow } from "@smthrs/flow"
import { todo } from "@smthrs/flow/todo"

export default Flow.make("todo", {
  ...todo,
  body: todo.steps({
    order: ["plan", "implement", "verify", "review", "propose"],
    verify: ["pnpm typecheck", "pnpm test --changed"],
    review: ["pnpm lint"]
  })
})`)

const FAIL = ["$ pnpm test webhooks", " FAIL  src/webhooks/retry.test.ts", "   ✗ retries a 503 with backoff   5001 ms", "     Error: test timed out after 5000 ms"]

/** T9's two attempts (journeys/run.ts): attempt 1 interrupted, attempt 2 waiting on its question. */
const retryTraces = (): ReadonlyArray<DesignTrace> => [
  {
    id: "run-retry-1", title: "Retry failed webhooks with backoff", todo: "t-retry", attempt: 1, branch: "b-retry", state: "failed",
    phases: [
      { id: "p1-read", step: "plan", title: "Read 3 files", summary: "Found a fixed 30 s wait before each retry.", took: 35, tone: "ok",
        cells: [
          { id: "c1-preflight", kind: "context", explain: "Preflight chose retry.ts, lib/backoff.ts and the Webhook retries page.", took: "1 s", tokens: "3.1k" },
          { id: "c1-plan", kind: "think", explain: "Planned: backoff() for each retry, give up after 5 attempts.", took: "11 s", tokens: "1.3k" }
        ] },
      { id: "p1-backoff", step: "implement", title: "Edited 1 file", summary: "Interrupted: the machine restarted mid-edit.", took: 20, tone: "fail", indicator: "Interrupted",
        cells: [{ id: "c1-edit", kind: "edit", explain: "Began switching deliver() to backoff(attempt); the machine restarted mid-edit.", tone: "fail", took: "6 s", tokens: "1.2k" }] }
    ]
  },
  {
    id: "run-retry", title: "Retry failed webhooks with backoff", todo: "t-retry", attempt: 2, branch: "b-retry", state: "waiting",
    phases: [
      { id: "p-read", step: "plan", title: "Read 3 files", summary: "Found a fixed 30 s wait before each retry.", took: 40, tone: "ok",
        cells: [
          { id: "c-preflight", kind: "context", explain: "Preflight chose retry.ts, lib/backoff.ts, the Webhook retries page and attempt 1.", took: "1 s", tokens: "3.4k" },
          { id: "c-read-retry", kind: "read", explain: "Read retry.ts: deliver() waits a fixed 30 s before each retry.", code: "    await sleep(30_000)", took: "4 s", tokens: "2.1k" },
          { id: "c-read-backoff", kind: "read", explain: "Read lib/backoff.ts: backoff(attempt) exists and caps the delay at 60 s.", took: "3 s", tokens: "0.8k" },
          { id: "c-plan", kind: "think", explain: "Planned: backoff() for each retry, give up after 5 attempts.", took: "12 s", tokens: "1.4k" }
        ] },
      { id: "p-backoff", step: "implement", title: "Edited 1 file", summary: "Changed the wait in deliver().", took: 60, tone: "ok",
        cells: [{ id: "c-edit-deliver", kind: "edit", explain: "Replaced the fixed 30 s wait in deliver() with backoff(attempt).", code: "-    await sleep(30_000)\n+    await sleep(backoff(attempt))", took: "9 s", tokens: "1.9k" }] },
      { id: "p-tests", step: "implement", title: "Ran tests · 1 failed ×3", summary: "The retry test times out every time.", took: 240, tone: "thrash", indicator: "Thrashing: pnpm test failed 3×",
        cells: [
          { id: "c-run-1", kind: "run", explain: "Ran the webhook tests. The retry test timed out.", tone: "fail", output: FAIL, took: "41 s" },
          { id: "c-run-2", kind: "run", explain: "Ran the same tests again with nothing changed. Same timeout.", tone: "fail", output: FAIL, took: "44 s" },
          { id: "c-run-3", kind: "run", explain: "Ran them a third time, still unchanged. Same failure.", tone: "fail", output: FAIL, took: "43 s" }
        ] },
      { id: "p-ask", step: "verify", title: "Asked a person", summary: "Asked whether to change the delay or raise the timeout.", tone: "wait", indicator: "Waiting for a person since 10:42",
        cells: [{ id: "c-ask", kind: "ask", explain: "Asked: change the delay, or raise the test timeout?", tone: "wait", quote: RETRY_QUESTION }] }
    ]
  }
]

const prBody = (todo: DesignTodo): ReadonlyArray<string> => [todo.prompt]

/** The j1 world every journey after setup starts from, plus the rows other cards need (issues, wiki, PRs, secrets, runs). */
export const seedDesignWorld = (): DesignWorldRows => {
  const todos: ReadonlyArray<DesignTodo> = [
    { id: "t-stripe", ref: "T8", title: "Upgrade the Stripe SDK to v17", owner: MAYA, branch: "b-stripe", state: "in-review", pr: 88, attempts: 1,
      prompt: "Upgrade stripe to v17. Keep the webhook signature check working.", evidence: STRIPE_EVIDENCE },
    { id: "t-retry", ref: "T9", title: "Retry failed webhooks with backoff", owner: BEN, branch: "b-retry", state: "needs-you", needs: "question", issue: 212, fixes: true,
      step: "verify", attempts: 2, elapsed: "12m", flowVersion: "v1", steps: TODO_FLOW,
      prompt: "Failed webhook deliveries should retry up to 5 times with backoff, then mark the event failed. Fixes #212.",
      question: { text: RETRY_QUESTION } },
    { id: "t-checkout", ref: "T10", title: "Fix the flaky checkout test", owner: ALICE, branch: "b-checkout", state: "working", step: "implement", attempts: 1, elapsed: "6m",
      prompt: "checkout.test.ts fails about 1 run in 10 on CI. Find the race and fix it." },
    { id: "t-log", ref: "T11", title: "Log every webhook retry attempt", owner: MAYA, branch: "b-log", state: "queued", queue: 1,
      prompt: "Log each retry attempt with the event id, attempt number and delay." }
  ]
  return {
    repo: {
      id: "repo", repo: "acme/api", stack: todos.map(each => each.id), flow: TODO_FLOW, capacity: 3, parallel: 2,
      mergedSinceLook: 5, syncedAgo: 40, mainSha: shaOf("main#216"), mainHead: { text: "#216 merged" }, nextPr: 215,
      setup: {
        listen: "network", addresses: [INSTALL_ADDRESS], memory: "32 GB", github: "app-installed", appCreated: true, squash: true,
        repository: "acme/api", provider: "Anthropic", fastKey: "saved", codingKey: "saved", gatewayKey: "saved", obsidian: "~/Obsidian/acme-api",
        source: "ready", sourcePct: 100, machine: "ready", machinePct: 100
      }
    },
    members: [
      { id: MAYA, name: "Maya Chen", login: "mayachen", initials: "MC", lane: 2, role: "owner", permission: "admin" },
      { id: BEN, name: "Ben Ortiz", login: "benortiz", initials: "BO", lane: 0, role: "maintainer", permission: "maintain" },
      { id: ALICE, name: "Alice Park", login: "alicepark", initials: "AP", lane: 1, role: "member", permission: "write" }
    ],
    todos,
    branches: [
      { id: "b-stripe", name: "upgrade-stripe", item: "t-stripe", from: "main", machine: "asleep", presence: [], activity: [
        { id: "b-stripe-a1", who: STACK, kind: "step", text: "Opened PR #88", tone: "ok" }
      ], terminals: [] },
      { id: "b-retry", name: "retry-webhooks", item: "t-retry", from: "main", machine: "awake",
        presence: [{ who: ALICE, where: { kind: "file", path: RETRY_FILE } }, { who: agentOf("b-retry"), where: { kind: "step", step: "verify" } }],
        activity: [
          { id: "b-retry-a1", who: agentOf("b-retry"), kind: "context", text: "Context", items: ["wiki: Webhook retries", "#212", "T9 plan"] },
          { id: "b-retry-a2", who: agentOf("b-retry"), kind: "step", text: "Planned: retry with backoff, give up after 5 attempts", tone: "ok" },
          { id: "b-retry-a3", who: agentOf("b-retry"), kind: "step", text: "Edited src/webhooks/retry.ts", tone: "ok" },
          { id: "b-retry-a4", who: agentOf("b-retry"), kind: "step", text: "pnpm test webhooks · 1 failed", tone: "fail" },
          { id: "b-retry-a5", who: agentOf("b-retry"), kind: "question", text: RETRY_QUESTION }
        ],
        terminals: ["term-retry-1"] },
      { id: "b-checkout", name: "fix-checkout-race", item: "t-checkout", from: "main", machine: "awake",
        presence: [{ who: agentOf("b-checkout"), where: { kind: "step", step: "implement" } }],
        activity: [{ id: "b-checkout-a1", who: agentOf("b-checkout"), kind: "step", text: "Planned: await the cart save before checkout", tone: "ok" }],
        terminals: [] },
      { id: "b-log", name: "log-retries", item: "t-log", from: "main", machine: "waiting", waitPosition: 1, presence: [], activity: [], terminals: [] }
    ],
    terminals: [
      { id: "term-retry-1", branch: "b-retry", title: "terminal 1", owner: agentOf("b-retry"), watchers: [ALICE],
        lines: FAIL.map((text, index) => ({ text, tone: index === 0 ? "prompt" as const : index === 1 || index === 2 ? "fail" as const : "dim" as const })) }
    ],
    files: [
      { id: `b-retry:${RETRY_FILE}`, path: RETRY_FILE, branch: "b-retry", lines: retrySource() },
      { id: "main:src/mail/reset.ts", path: "src/mail/reset.ts", branch: "main", lines: mailSource() },
      { id: "b-checkout:src/checkout/checkout.test.ts", path: "src/checkout/checkout.test.ts", branch: "b-checkout", lines: checkoutTest() },
      { id: "main:flows/todo/flow.ts", path: "flows/todo/flow.ts", branch: "main", lines: flowSource() }
    ],
    issues: [
      { number: 212, title: "Failed webhooks are never retried", author: ALICE, age: "2 d ago", open: true, todo: "t-retry", fixes: true,
        body: "A 503 from a customer endpoint drops the event for good.", comments: [] },
      { number: 231, title: "Password reset emails arrive twice", author: ALICE, age: "2 h ago", open: true,
        body: "Since Friday's deploy every reset request sends two emails. Some people click the first link, which has already expired.",
        comments: [
          { who: BEN, text: "Both the legacy mailer and the v2 template handle password.reset.", age: "1 h ago" },
          { who: ALICE, text: "v2 has been live for everyone since Friday, so the legacy path can go.", age: "40 min ago" }
        ] },
      { number: 235, title: "Show the currency on invoice totals", author: BEN, age: "3 h ago", open: true, comments: [],
        body: "Invoice totals print as 42.00 with no currency, so customers outside the US can't tell what they owe. Show the invoice's currency, e.g. EUR 42.00." }
    ],
    drafts: [],
    runs: [
      { id: "r-learn", title: "Learning from #87", state: "done", detail: "2 lessons", lessons: ["webhook-retries"] },
      { id: "r-wiki", title: "Wiki refresh", state: "running" },
      { id: "r-release", title: "release-notes", state: "failed", detail: "GitHub API rate limited" }
    ],
    flowVersions: [
      { id: "v1", flow: "todo", label: "v1 · flows/todo/flow.ts", state: "active", steps: TODO_FLOW },
      { id: "v2", flow: "todo", label: "v2 · flows/todo/flow.ts · proposed", state: "proposed", by: BEN, steps: [
        ...TODO_FLOW.slice(0, 3),
        { id: "changelog", title: "Changelog", detail: "Add a line to CHANGELOG.md." },
        ...TODO_FLOW.slice(3)
      ] },
      { id: "v-failed", flow: "todo", label: "flows/todo/flow.ts · failed", state: "merged-failed",
        error: "flows/todo/flow.ts:12: Type error in check step", steps: TODO_FLOW },
      { id: "merge", flow: "merge", label: "Merge flow", state: "active", system: true, steps: [
        { id: "approval", title: "Check the approval", detail: "The person merging approved this revision." },
        { id: "github", title: "Merge on GitHub", detail: "Squash-merge the PR into main." },
        { id: "rebase", title: "Rebase the stack", detail: "Rebase later items onto the new main." },
        { id: "learn", title: "Learn", detail: "Write what the change taught to the wiki." }
      ] }
    ],
    traces: retryTraces(),
    wiki: [
      { id: "webhook-retries", title: "Webhook retries", rev: 1, authors: [STACK],
        lines: [
          { n: 1, text: "Retry failed deliveries with `backoff(attempt)`, at most 5 attempts." },
          { n: 2, text: "Why: a fixed 30 s wait timed out the retry test." },
          { n: 3, text: "Code: `deliver()` and `redeliver()` in `retry.ts`" }
        ],
        decision: { from: 1, to: 2, by: STACK, change: 87 } },
      { id: "payments-testing", title: "Payments testing", rev: 3, authors: [ALICE, BEN],
        lines: [
          { n: 1, text: "Stripe test mode settles payment intents asynchronously." },
          { n: 2, text: "Await `result.settled` before checking a status." }
        ] }
    ],
    prs: [
      { number: 88, todo: "t-stripe", title: "Upgrade the Stripe SDK to v17", base: "main", head: "smithers/upgrade-stripe", sha: shaOf("pr#88"),
        state: "open", requestedBy: MAYA, body: prBody(todos[0]!), approvals: [], required: 0 }
    ],
    secrets: [{ name: "STRIPE_TEST_KEY", scope: "all branches" }, { name: "SENTRY_DSN", scope: "main only" }],
    agents: ["plan", "implement", "review"].map(step => ({ id: step, steps: [step], instructions: `flows/todo/${step}.md`, model: "Fable 5.1" })),
    acts: [],
    reviews: [],
    proposals: [
      { id: "r-learn", title: "Use the shared backoff() for every retry", refs: [85, 87, 88],
        evidence: "Three TODOs this month hand-wrote retry delays. lib/backoff.ts already caps them." }
    ],
    forms: []
  }
}
