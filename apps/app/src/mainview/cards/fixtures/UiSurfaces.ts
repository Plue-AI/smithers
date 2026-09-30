/*
 * Fixture cards for the surfaces smithers-ui-DESIGN.md extends: a threads
 * list with chat and task rows, one chat issue as a conversation, the agent
 * profiles, a run in its Steps view parked on a timer, the inbox, and the
 * connect card's integration rows. Invented values over the
 * real payload shapes, for tests and screenshots only; nothing here reaches a
 * production path.
 */
import { AGENT_ROLES } from "@smthrs/rpc/AgentRoles"
import type * as SubagentCard from "@smthrs/rpc/SubagentCard"
import type { SubagentItem } from "../../SubagentGrid"
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

/** A run whose journal shows a model turn, a read, a failing test and a timer park. */
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
  stamp(13, "run.parked", 65_000, { reason: "timer" })
]

export const fixtureCards = (): ReadonlyArray<Card> => [
  {
    id: `issues-${REPO}`, kind: "issue-list", title: `Issues · ${REPO}`, status: "active", createdAt: T0, ordinal: 1,
    payload: {
      repo: REPO, filter: "open", kind: "all",
      issues: [
        {
          number: 2104, title: "#team", state: "open", author: "owner", comments: 12, updatedAt: iso(-2), source: "smithers-cloud",
          kind: "chat"
        },
        {
          number: 2101, title: "Fix wiki staleness banner", state: "fixed", author: "owner", comments: 5, updatedAt: iso(-45), source: "smithers-cloud",
          kind: "chat", task: { owner: ENGINEER, due: iso(24 * 60), priority: 1, parent: { number: 2088 }, fixedBy: ENGINEER }
        },
        {
          number: 2103, title: "Owner ↔ Assistant", state: "open", author: "owner", comments: 3, updatedAt: iso(-90), source: "smithers-cloud",
          kind: "chat"
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
        { id: 9002, author: "smithers-bot", persona: { username: "engineer" }, commentBody: "On it. Plan: reproduce, then fix `wiki/search.ts`.", createdAt: iso(-60 * 24 + 14), reactions: [] },
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
      // The rows the Agents card renders with no repository loaded: the
      // built-in roles. Since e2738feeb7 an open card is rewritten to exactly
      // these after any transition, so invented rows would not survive a command.
      agents: AGENT_ROLES.map((role) => ({
        id: role.id, label: role.label, purpose: role.purpose, harness: role.harness, harnessName: role.harness, model: role.model, builtin: role.builtin,
        ...(role.kind === undefined ? {} : { kind: role.kind }),
        available: false, reason: "", account: ""
      }))
    }
  },
  {
    id: "run-daily-audit", kind: "run-trace", title: "Daily audit", status: "active", createdAt: T0, ordinal: 4,
    payload: { repo: REPO, workspaceId: "00000000-0000-4000-8000-00000000da11", runId: "run-daily-audit", workflow: "coding/request", phase: "running", steps: [], result: null, lastSeq: 13, events: runEvents(), traceView: "steps", liveTail: true }
  },
  {
    id: `approvals-inbox-${REPO}`, kind: "approvals-inbox", title: "Inbox", status: "active", createdAt: T0, ordinal: 5,
    payload: {
      repo: REPO,
      approvals: [
        { runId: "run-post-digest", requestId: "gate-1", title: "slack.post #team", approval: { _tag: "ApprovalTarget.Node", node: "call-3" }, requestedAt: T0 - 12 * 60_000 },
        { runId: "run-eval-suite", requestId: "gate-2", title: "Which suite owns the flaky test?", approval: {}, requestedAt: T0 - 60 * 60_000, question: { kind: "ask", prompt: "Which suite owns the flaky test?" } }
      ]
    }
  },
  {
    id: "connect-embedded", kind: "connect", title: "Connect work to Smithers", status: "active", createdAt: T0, ordinal: 6,
    payload: {
      provider: "github", github: { connected: true, login: "owner" }, nativeAvailable: false,
      integrations: { repo: REPO, rows: [
        { id: "slack", state: "connected", detail: "#team" },
        { id: "linear", state: "connected", detail: "ENG", lastSyncAt: iso(-4) }
      ] }
    }
  }
]

const tool = (name: string, target: string, state: "pending" | "done" | "error" = "done", extra: { readonly added?: number; readonly removed?: number; readonly verb?: SubagentCard.Verb } = {}): SubagentCard.Entry =>
  ({ kind: "tool", tool: name, target, state, ...extra })

/** The approved mock's three subagents (#2162): running with changed files, waiting on a child, and done. */
export const fixtureSubagents = (now: number): ReadonlyArray<SubagentItem> => [
  {
    id: "auth-audit", color: 1, open: { flow: "tab.select", args: "tab-auth-audit" }, stop: { flow: "tab.close", args: "tab-auth-audit" },
    subagent: { title: "auth-audit: rate-limit login", status: "running", model: "sol", startedAt: now - 42_000, entries: [
      ...["auth/session.ts", "auth/tokens.ts", "auth/limits.ts", "auth/index.ts", "auth/errors.ts", "auth/store.ts", "auth/types.ts"].map(path => tool("read", path)),
      tool("read", "auth/login.ts"), tool("grep", "\"attempts\""), tool("edit", "login.ts", "done", { added: 18, removed: 4 }),
      tool("bash", "bun test auth", "error"), tool("edit", "login.ts", "pending")
    ], files: [{ path: "auth/login.ts", added: 18, removed: 4 }, { path: "auth/login.test.ts", added: 13, removed: 2 }] }
  },
  {
    id: "db-migrate", color: 2, open: { flow: "runs.open", args: "run-db-migrate example/app" }, stop: { flow: "flow.run.stop", args: "flow-run-db-migrate" },
    subagent: { title: "db-migrate: sessions → v2", status: "waiting", model: "sol", startedAt: now - 38_000, entries: [
      tool("read", "db/schema.ts"), tool("read", "db/sessions.ts"), tool("grep", "session_v1"),
      tool("write", "migrations/0042.sql"), tool("bash", "bun test db"), tool("agent.delegate", "backfill"),
      tool("wait", "backfill", "pending", { verb: { pending: "Waiting on", done: "Waited on" } })
    ], files: [{ path: "migrations/0042.sql", added: 44, removed: 0 }] }
  },
  {
    id: "docs", color: 3, open: { flow: "tab.card", args: "agent-session-docs" },
    subagent: { title: "docs: update login guide", status: "done", model: "luna", startedAt: now - 120_000, endedAt: now - 56_000, entries: [
      tool("read", "docs/auth.md"), tool("edit", "docs/auth.md", "done", { added: 12, removed: 2 })
    ], files: [{ path: "docs/auth.md", added: 12, removed: 2 }] }
  }
]

/** A successful agent/spawn of `child` at the absolute time `at`. */
const spawn = (sequence: number, child: string, flow: string, at: number) => [
  { sequence, kind: "control.agent.cell-call-started", occurredAt: at, payload: { flowName: "agent/spawn", input: { flow }, at } },
  { sequence: sequence + 1, kind: "control.agent.cell-call-settled", occurredAt: at + 1, payload: { flowName: "agent/spawn", outcome: "success", value: { child }, at: at + 1 } }
]

/** The ctrl+s overview's workers (#2190): a local agent, and a run with two child runs, one of them opened. */
export const fixtureOverviewCards = (now: number): ReadonlyArray<Card> => [
  {
    id: "agent-auth-audit", kind: "agent", title: "auth-audit", status: "active", createdAt: now - 42_000, ordinal: 1,
    payload: { harnessId: "claude", displayName: "auth-audit: rate-limit login", tabId: "tab-auth-audit", sessionId: "tab-auth-audit", cwd: "/repo", phase: "running", exitCode: null }
  },
  {
    id: "flow-run-run-release", kind: "run-trace", title: "release", status: "active", createdAt: now - 40_000, ordinal: 2,
    payload: { repo: REPO, runId: "run-release", workflow: "release", phase: "running", steps: [], result: null, lastSeq: 4,
      events: [...spawn(1, "run-db-migrate", "db-migrate", now - 38_000), ...spawn(3, "run-docs", "docs", now - 30_000)] }
  },
  {
    id: "flow-run-run-db-migrate", kind: "run-trace", title: "db-migrate", status: "active", createdAt: now - 38_000, ordinal: 3,
    payload: { repo: REPO, runId: "run-db-migrate", workflow: "db-migrate", phase: "completed", steps: [], result: null, lastSeq: 0 }
  }
]
