import { flowArgs } from "../flows/FlowArgs"
import { flowAction } from "../flows/FlowAction"
import { Button, Markdown } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import { findAgentRole } from "@smthrs/rpc/AgentRoles"
import { Monogram } from "../AgentMark"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

type AgentsCard = Extract<Card, { kind: "agents" }>

const CloudAgentsCardBody = ({ card, onRunCommand }: { readonly card: AgentsCard & { readonly payload: Extract<AgentsCard["payload"], { cloud: true }> }; readonly onRunCommand: RunCommand }) => (
  <ul className="workflow-list" data-testid="agent-sessions-list">
    {card.payload.sessions.map(session => (
      <li key={session.id} className="workflow-list-row" data-session={session.id}>
        <span className="workflow-list-text">
          <strong>{session.title || session.id}</strong>
          <span>{session.status}</span>
        </span>
        <Button variant="ghost" size="sm" {...flowAction(onRunCommand, "agent.session.view", flowArgs("agent.session.view", { sessionId: session.id, repo: card.payload.repo }))}>Open</Button>
        {session.status === "active" ? <Button variant="ghost" size="sm" {...flowAction(onRunCommand, "agent.session.stop", flowArgs("agent.session.stop", { sessionId: session.id, repo: card.payload.repo }))}>Stop</Button> : null}
      </li>
    ))}
  </ul>
)

type ProfileRow = Extract<AgentsCard["payload"], { native: boolean }>["agents"][number]

/*
 * One configured agent profile (smithers-ui-DESIGN.md §3.3): its mark, label,
 * model, its kind when the profile carries one, availability
 * where a harness answers for it, and the door to its recorded work: a
 * profile is a role flow, so its runs are the run list filtered by that flow
 * (runs.list flow=<id>).
 */
const ProfileRowView = ({ agent, native, onRunCommand }: { readonly agent: ProfileRow; readonly native: boolean; readonly onRunCommand: RunCommand }) => (
  <li key={agent.id} className="workflow-list-row agent-row" data-agent={agent.id} data-available={agent.available} data-kind={agent.kind}>
    <Monogram persona={{ id: agent.id, name: agent.label, agentId: agent.id }} />
    <span className="workflow-list-text">
      <strong>{agent.label}</strong>
      <span title={agent.purpose}>
        {[
          agent.kind === undefined || agent.kind === "core" ? undefined : agent.kind,
          agent.model.label,
          native ? (agent.available ? `● ${agent.account === "" ? "signed in" : agent.account}` : `○ ${agent.reason}`) : undefined
        ].filter((fact) => fact !== undefined && fact !== "").join(" · ")}
      </span>
    </span>
    <Button variant="ghost" size="sm" data-testid={`agent-runs-${agent.id}`} {...flowAction(onRunCommand, "runs.list", flowArgs("runs.list", { flow: agent.id }))}>Runs</Button>
  </li>
)

export const AgentsCardBody = ({ card, onRunCommand }: { readonly card: AgentsCard; readonly onRunCommand: RunCommand }) => {
  if ("cloud" in card.payload) return <CloudAgentsCardBody card={{ ...card, payload: card.payload }} onRunCommand={onRunCommand} />
  const { native, agents, error } = card.payload
  if (agents.length === 0) return <p className="smithers-card-note">Agents run on the native app's harnesses.</p>
  return (
    <div className="agents-card">
      <ul className="workflow-list" data-testid="agents-list">
        {agents.map((agent) => <ProfileRowView key={agent.id} agent={agent} native={native} onRunCommand={onRunCommand} />)}
      </ul>
      {error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {error}
          </p>
        ) :
        null}
    </div>
  )
}

/*
 * In the conversation an agent card draws as its subagent card
 * (SubagentGrid.tsx); these bodies are the agent's own tab (tab.card).
 *
 * The cloud variant (UI-COVERAGE-GAPS.md "agents · Cloud agent sessions"): a
 * cloud agent session that Smithers Cloud runs in a sandbox — the header
 * carries session · repository · provider · state, the transcript rows append
 * off the session's SSE stream (the seam owns the stream; the card projects
 * its payload), and the footer's Stop is agent.session.stop (the flow
 * confirms for the agent door). There is no composer in the card: a
 * follow-up is the app's own /agent.session.say.
 */
type AgentCard = Extract<Card, { kind: "agent" }>
type AgentCloudCard = Omit<AgentCard, "payload"> & {
  readonly payload: Extract<AgentCard["payload"], { readonly cloud: true }>
}

const CloudAgentCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: AgentCloudCard
  readonly onRunCommand: RunCommand
}) => {
  const { displayName, sessionId, repo, provider, state, task, transcript, error } = card.payload
  const live = state === "active"
  return (
    <div className="agent-card" data-phase={state} data-cloud="true">
      <p className="smithers-card-note" data-testid="agent-session-header">
        session {sessionId} · {repo}{provider === null ? "" : ` · ${provider}`} · {state}
      </p>
      {task !== undefined && task !== displayName ? <p className="smithers-card-note agent-card-task">Request: {task}</p> : null}
      {transcript.length === 0 ? null : (
        <ol className="world-card-list" data-testid="agent-session-transcript">
          {transcript.map((row) => (
            <li key={row.id} className="world-card-row" data-role={row.role}>
              <span className="world-card-path">{row.role}</span>
              <span className="workflow-list-text">
                {row.parts.map((part, index) =>
                  part.type === "text"
                    ? <Markdown key={index} className="smithers-card-markdown" content={part.text} />
                    : <span key={index} className="world-card-path">{part.type}: {part.text}</span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      {error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {error}
          </p>
        ) :
        null}
      {live ?
        (
          <div className="flow-run-actions">
            <Button
              size="sm"
              variant="outline"
              data-testid={`agent-session-stop-${sessionId}`}
              {...flowAction(onRunCommand, "agent.session.stop", sessionId)}
            >
              Stop
            </Button>
          </div>
        ) :
        null}
    </div>
  )
}

/*
 * A subagent launched from the `+` menu (docs/LOCAL-APP.md "Tabs"): which
 * harness, where it runs, whether it is still running, and the way back to
 * its tab — a registered flow (tab.select), so the card never owns the tab.
 */
const AgentCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "agent" }>
  readonly onRunCommand: RunCommand
}) => {
  if ("cloud" in card.payload) return <CloudAgentCardBody card={{ ...card, payload: card.payload }} onRunCommand={onRunCommand} />
  const { displayName, cwd, phase, exitCode, tabId, roleId, task } = card.payload
  // The purpose rode the card at launch (a custom agent's is in no table); older cards fall back to the built-in row.
  const purpose = card.payload.purpose ?? (roleId === undefined ? undefined : findAgentRole(roleId)?.purpose)
  const state = phase === "running"
    ? `${displayName} is running in ${cwd}.`
    : exitCode === null
    ? `${displayName} stopped.`
    : `${displayName} exited (${exitCode}).`
  return (
    <div className="agent-card" data-phase={phase} data-role={roleId}>
      {purpose !== undefined ? <p className="smithers-card-note agent-card-role">{purpose}</p> : null}
      {task !== undefined ? <p className="smithers-card-note agent-card-task">Request: {task}</p> : null}
      <p className="smithers-card-note">{state}</p>
      {phase === "running" ?
        (
          <div className="flow-run-actions">
            <Button
              size="sm"
              variant="outline"
              data-testid={`agent-open-tab-${tabId}`}
              {...flowAction(onRunCommand, "tab.select", tabId)}
            >
              Open tab
            </Button>
          </div>
        ) :
        null}
    </div>
  )
}

/* The explainer's answer (AgentRoles.ts): streams in place; says who was asked, never who answered. */
const ExplainCardBody = ({ card }: { readonly card: Extract<Card, { kind: "explain" }> }) => {
  const { question, answer, phase, answeredBy, error } = card.payload
  return (
    <div className="explain-card" data-phase={phase}>
      <p className="smithers-card-note explain-card-question">{question}</p>
      {answer !== "" ? <Markdown className="smithers-card-markdown" content={answer} /> : null}
      {phase === "asking" ? <p className="sui-approval-pending">Explaining…</p> : null}
      {phase === "failed" && error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {error}
          </p>
        ) :
        null}
      <p className="smithers-card-note explain-card-by">{answeredBy}</p>
    </div>
  )
}


export const agentCardFamily: CardFamily<"agent" | "explain" | "agents"> = {
  agent: {
    render: (card, actions) => <AgentCardBody card={card} onRunCommand={actions.onRunCommand} />,
    /*
     * A subagent's pill is its process: running, done on a clean exit, failed
     * otherwise. A null exit code is the unknown outcome (Cards.ts: "null when
     * unknown (the tab was closed)"), so it wears the neutral "stopped" the
     * body already reads out — never a green Done nobody can vouch for.
     * The cloud variant's pill is plue's session status in the same words.
     */
    pill: (card) => {
      if ("cloud" in card.payload) {
        const state = card.payload.state
        if (state === "active") return "running"
        if (state === "completed") return "done"
        if (state === "failed") return "failed"
        if (state === "cancelled") return "stopped"
        return state
      }
      if (card.payload.phase === "running") return "running"
      if (card.payload.exitCode === null) return "stopped"
      return card.payload.exitCode === 0 ? "done" : "failed"
    }
  },
  explain: {
    render: (card) => <ExplainCardBody card={card} />,
    pill: (card) => {
      if (card.payload.phase === "asking") return "running"
      return card.payload.phase === "answered" ? "done" : "failed"
    }
  },
  /* Agents as data: the listings settle when they render. */
  agents: {
    render: (card, actions) => <AgentsCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  },

}
