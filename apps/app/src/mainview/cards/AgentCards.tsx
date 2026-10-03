import { flowArgs } from "../flows/FlowArgs"
import { flowAction } from "../flows/FlowAction"
import { Button } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import { Monogram } from "../AgentMark"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import { describedFailure, FailureNotice } from "../FailureNotice"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"

type AgentsCard = Extract<Card, { kind: "agents" }>

/* The agents listing's last refusal: one sentence; the seam's words stay behind Details. */
const AGENTS_FAILED: UserFailureCopy = {
  fault: "infra",
  sentence: "Smithers could not update your agents. Not your fault.",
  actions: []
}

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
  if ("cloud" in card.payload) return null
  const { native, agents, error } = card.payload
  if (agents.length === 0) return <p className="smithers-card-note">Agents run on the native app's harnesses.</p>
  return (
    <div className="agents-card">
      <ul className="workflow-list" data-testid="agents-list">
        {agents.map((agent) => <ProfileRowView key={agent.id} agent={agent} native={native} onRunCommand={onRunCommand} />)}
      </ul>
      {error !== undefined ?
        <FailureNotice className="sui-approval-error" data-testid="agents-failure" failure={describedFailure("AgentsFailed", AGENTS_FAILED, error)} /> :
        null}
    </div>
  )
}

export const agentCardFamily: CardFamily<"agents"> = {
  /* Agents as data: the listings settle when they render. */
  agents: {
    render: (card, actions) => <AgentsCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  },

}
