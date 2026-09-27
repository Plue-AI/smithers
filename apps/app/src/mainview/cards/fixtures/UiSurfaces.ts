/*
 * Fixture cards for the surfaces smithers-ui-DESIGN.md extends: a threads
 * list with chat and task rows, one chat issue as a conversation, the agent
 * profiles, a run in its Steps view under a runaway guard, the inbox with an
 * incident, and the connect card's integration rows. Invented values over the
 * real payload shapes, for tests and screenshots only; nothing here reaches a
 * production path.
 */
import type { Card } from "../../state/AppState"

const REPO = "example/app"
const T0 = Date.UTC(2026, 8, 26, 9, 0, 0)
const iso = (offsetMinutes: number) => new Date(T0 + offsetMinutes * 60_000).toISOString()

export const PA = { id: "assistant", name: "Assistant", agentId: "assistant" }
export const ENGINEER = { id: "engineer", name: "Engineer", agentId: "engineer" }
export const QA = { id: "reviewer", name: "Reviewer", agentId: "reviewer" }

const stamp = (sequence: number, kind: string, at: number, payload: Record<string, unknown> = {}) => ({
  sequence, kind: `control.${kind}`, occurredAt: T0 + at, payload: { ...payload, at: T0 + at }
})

/** A run whose journal shows a model turn, a read, a failing test and a budget guard park. */
export const runEvents = () => [
  stamp(1, "agent.turn-opened", 0, { seat: "openai:model-a" }),
  stamp(2, "agent.model-settled", 8_000, { text: "Reading the vault page first.", usage: { inputTokens: 2_100, outputTokens: 340 } }),
  stamp(3, "agent.cell-produced", 8_100, { source: "await ctx.call('read', { path: 'docs/Assistant.md' })" }),
  stamp(4, "agent.cell-call-started", 8_200, { callId: "c1", flowName: "read", input: { path: "docs/Assistant.md" } }),
  stamp(5, "agent.cell-call-settled", 8_600, { callId: "c1", flowName: "read", outcome: "success", value: "# Assistant\n…" }),
  stamp(6, "agent.turn-closed", 8_700),
  stamp(7, "agent.turn-opened", 9_000, { seat: "openai:model-a" }),
  stamp(8, "agent.model-settled", 21_000, { text: "Running the checks.", usage: { inputTokens: 4_400, outputTokens: 610 } }),
  stamp(9, "agent.cell-call-started", 21_200, { callId: "c2", flowName: "bash", input: { command: "bun test src/wiki" } }),
  stamp(10, "agent.cell-call-settled", 63_000, { callId: "c2", flowName: "bash", outcome: "failure", error: "1 failed" }),
  stamp(11, "agent.cell-call-started", 63_500, { callId: "c3", flowName: "write", input: { path: "apps/app/src/mainview/wiki/search.ts", content: "…" } }),
  stamp(12, "agent.cell-call-settled", 64_200, { callId: "c3", flowName: "write", outcome: "success" }),
  stamp(13, "run.parked", 65_000, { reason: "budget" })
]

export const fixtureCards = (): ReadonlyArray<Card> => [
  {
    id: `issues-${REPO}`, kind: "issue-list", title: `Issues · ${REPO}`, status: "active", createdAt: T0, ordinal: 1,
    payload: {
      repo: REPO, filter: "open", kind: "all",
      issues: [
        {
          number: 2104, title: "#team", state: "open", author: "owner", comments: 12, updatedAt: iso(-2), source: "smithers-cloud",
          kind: "chat", synced: true, last: { persona: ENGINEER, text: "Opened PR #2101 for the wiki fix.", at: iso(-2) }
        },
        {
          number: 2101, title: "Fix wiki staleness banner", state: "fixed", author: "owner", comments: 5, updatedAt: iso(-45), source: "smithers-cloud",
          kind: "chat", task: { owner: ENGINEER, due: iso(24 * 60), priority: 1, parent: { number: 2088 }, fixedBy: ENGINEER },
          last: { persona: ENGINEER, text: "Tests pass.", at: iso(-45) }
        },
        {
          number: 2103, title: "Owner ↔ Assistant", state: "open", author: "owner", comments: 3, updatedAt: iso(-90), source: "smithers-cloud",
          kind: "chat", last: { persona: PA, text: "Tomorrow's 1:1s are booked 9:00–14:00.", at: iso(-90) }
        },
        {
          number: 2095, title: "Flaky CI on shard 3", state: "closed", author: "owner", comments: 1, updatedAt: iso(-24 * 60), source: "github",
          htmlUrl: "https://github.com/example/app/issues/2095", labels: ["bug"], labelColors: { bug: "d73a4a" }
        }
      ]
    }
  },
  {
    id: `issue-${REPO}-2101`, kind: "issue", title: "Fix wiki staleness banner", status: "active", createdAt: T0, ordinal: 2,
    payload: {
      repo: REPO, number: 2101, title: "Fix wiki staleness banner", state: "fixed", author: "owner", issueBody: "The wiki banner still says stale after a refresh.",
      labels: [], kind: "chat", source: "smithers-cloud",
      task: { owner: ENGINEER, due: iso(24 * 60), priority: 1, parent: { number: 2088, title: "Wiki freshness" }, fixedBy: ENGINEER },
      visibility: "private",
      sync: { provider: "slack", connectionId: "slack", scopeId: "T0000000000", conversationId: "C0000000000", threadId: "1700000000.000100", state: "synced" },
      comments: [
        { id: 9001, author: "smithers-bot", persona: { username: "assistant" }, commentBody: "The owner asked for the staleness banner fix. Taking it.", createdAt: iso(-60 * 24 + 12), reactions: [] },
        { id: 9002, author: "smithers-bot", persona: { username: "engineer" }, commentBody: "On it. Plan: reproduce, then fix `wiki/search.ts`.", createdAt: iso(-60 * 24 + 14), origin: "slack", reactions: [] },
        { id: 9003, author: "smithers-bot", persona: { username: "engineer" }, commentBody: "Tests pass. PR [#2101](https://github.com/example/app/pull/2101).", createdAt: iso(-60 * 24 + 16), reactions: [{ name: "👀", actor: "owner", active: true }, { name: "✅", actor: "U0000000000", active: true }] },
        { id: 9004, author: "owner", commentBody: "Ship it.", createdAt: iso(-40), reactions: [] }
      ],
      pendingComments: [{ id: "req-1", text: "And add the test to the wiki suite.", actor: "user", owner: "owner", status: "failed", error: "Posting the message failed (503)" }]
    }
  },
  {
    id: "agents", kind: "agents", title: "Agents", status: "active", createdAt: T0, ordinal: 3,
    payload: {
      native: false,
      agents: [
        { id: "assistant", label: "Assistant", purpose: "Schedules, digests and the one door to the owner.", harness: "codex", harnessName: "Codex", model: { provider: "openai", id: "model-a", label: "Model A" }, builtin: false, kind: "core", available: false, reason: "", account: "" },
        { id: "product-lead", label: "Product Lead", purpose: "Turns accepted work into issues that run.", harness: "codex", harnessName: "Codex", model: { provider: "openai", id: "model-a", label: "Model A" }, builtin: false, kind: "core", reportsTo: "assistant", available: false, reason: "", account: "" },
        { id: "researcher", label: "Researcher", purpose: "Watches competing products.", harness: "codex", harnessName: "Codex", model: { provider: "openai", id: "model-a", label: "Model A" }, builtin: false, kind: "specialist", reportsTo: "product-lead", available: false, reason: "", account: "" },
        { id: "engineer", label: "Engineer", purpose: "Implements non-trivial changes end to end, with tests.", harness: "codex", harnessName: "Codex", model: { provider: "openai", id: "model-b", label: "Model B" }, builtin: false, kind: "core", reportsTo: "assistant", available: false, reason: "", account: "" },
        { id: "reviewer", label: "Reviewer", purpose: "Verifies fixes and keeps the evals honest.", harness: "codex", harnessName: "Codex", model: { provider: "openai", id: "model-a", label: "Model A" }, builtin: false, kind: "core", reportsTo: "assistant", available: false, reason: "", account: "" }
      ]
    }
  },
  {
    id: "run-daily-audit", kind: "run-trace", title: "Daily audit", status: "active", createdAt: T0, ordinal: 4,
    payload: { repo: REPO, runId: "run-daily-audit", workflow: "coding/request", phase: "running", steps: [], result: null, lastSeq: 13, events: runEvents(), traceView: "steps", liveTail: true }
  },
  {
    id: `approvals-inbox-${REPO}`, kind: "approvals-inbox", title: "Inbox", status: "active", createdAt: T0, ordinal: 5,
    payload: {
      repo: REPO,
      approvals: [
        { runId: "run-post-digest", requestId: "gate-1", title: "slack.post #team", approval: { _tag: "ApprovalTarget.Node", node: "call-3" }, requestedAt: T0 - 12 * 60_000, agent: PA, thread: `${REPO}#2104` },
        { runId: "run-eval-suite", requestId: "gate-2", title: "Which suite owns the flaky test?", approval: {}, requestedAt: T0 - 60 * 60_000, agent: QA, question: { kind: "ask", prompt: "Which suite owns the flaky test?" } }
      ],
      incidents: [{ runId: "run-daily-audit", title: "Daily audit", guard: "budget", detail: "2.1% of the week", parkedAt: T0 - 4 * 60_000, agent: ENGINEER, thread: `${REPO}#2101` }]
    }
  },
  {
    id: "connect-embedded", kind: "connect", title: "Connect work to Smithers", status: "active", createdAt: T0, ordinal: 6,
    payload: {
      provider: "github", github: { connected: true, login: "owner" }, nativeAvailable: false,
      integrations: { repo: REPO, rows: [
        { id: "slack", state: "connected", detail: "#team" },
        { id: "linear", state: "connected", detail: "ENG", lastSyncAt: iso(-4) },
        { id: "notion", state: "coming-soon" }
      ] }
    }
  }
]
