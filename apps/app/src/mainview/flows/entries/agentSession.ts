/*
 * The `agent.session` flows (apps/app/docs/UI-COVERAGE-GAPS.md "agents ·
 * Cloud agent sessions"): run a cloud agent session — Codex, Claude, or
 * Smithers, executed by Smithers Cloud inside a sandbox — on a repository,
 * watch its transcript live on the `agent` card's cloud variant, send it
 * follow-up messages, and stop it. The seam behind them is
 * state/seams/AgentSessionSeam.ts; the wire is plue's
 * /api/repos/{o}/{r}/agent/sessions family.
 *
 * Consequential acts follow the three-door law: starting a session launches
 * a sandbox agent (confirm, and the outbound launch capability), a follow-up
 * message dispatches the session's next run (confirm, like runs.steer), and
 * stopping one is consequential (confirm). The reads (list, view) are free.
 */
import { Schema } from "effect"
import { AGENT_PROVIDERS } from "../../state/seams/AgentSessionSeam"
import { line, text } from "@smthrs/ui/flow-form"
import { flow, RepoTarget } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The `agent.session.*` flows, registered with the agent flows in Flows.ts order. */
export const agentSessionFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "agent.session.new",
    form: {
      fields: {
        repo: { optionsFrom: "cloud-repos", kind: "text" },
        task: { label: "Request", kind: "textarea" }
      },
      args: (payload) => line(text(payload, "repo"), text(payload, "provider"), text(payload, "task"))
    },
    summary: "Start a cloud agent session (Codex, Claude, or Smithers) on a repository: Smithers Cloud runs it in a sandbox, and the session card streams its transcript",
    runtime: ["cloud"],
    confirm: (payload) => `start a ${String(payload.provider)} agent session on ${String(payload.repo)}`,
    args: "<owner/repo> <provider> <request…>",
    requires: ["signed-in"],
    input: Schema.Struct({
      repo: Schema.String,
      provider: Schema.Literals(AGENT_PROVIDERS),
      task: Schema.String
    }),
    handler: ({ repo, provider, task }) => actions.newAgentSession(repo, provider, task)
  }),
  flow({
    name: "agent.session.list",
    summary: "List a repository's cloud agent sessions",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.listAgentSessions(repo)
  }),
  flow({
    name: "agent.session.view",
    form: { args: (payload) => line(text(payload, "sessionId"), text(payload, "repo")) },
    summary: "Open one cloud agent session's card: its transcript, live while the session is active",
    runtime: ["cloud"],
    args: "<id> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ sessionId: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ sessionId, repo }) => actions.viewAgentSession(sessionId, repo)
  }),
  flow({
    name: "agent.session.say",
    form: {
      fields: { text: { label: "Message", kind: "textarea" } },
      args: (payload) => line(text(payload, "sessionId"), text(payload, "text"))
    },
    summary: "Send a follow-up message to a cloud agent session (dispatches its next run)",
    runtime: ["cloud"],
    confirm: ({ sessionId }) => `send the message to agent session ${String(sessionId)}`,
    args: "<id> <text…>",
    requires: ["signed-in"],
    input: Schema.Struct({ sessionId: Schema.String, text: Schema.String }),
    handler: ({ sessionId, text }) => actions.sayToAgentSession(sessionId, text)
  }),
  flow({
    name: "agent.session.stop",
    form: { args: (payload) => line(text(payload, "sessionId"), text(payload, "repo")) },
    summary: "Stop a cloud agent session (its run is cancelled and the session is deleted)",
    runtime: ["cloud"],
    confirm: ({ sessionId }) => `stop agent session ${String(sessionId)}`,
    args: "<id> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ sessionId: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ sessionId, repo }) => actions.stopAgentSession(sessionId, repo)
  })
]
