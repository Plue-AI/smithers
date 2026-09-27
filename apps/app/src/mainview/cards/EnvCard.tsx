/* Environment variables and their registered edit and secrets actions. */
import { Button } from "@smthrs/ui"
import { flowAction } from "../flows/FlowAction"
import { Terminal } from "lucide-react"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

export const EnvCardBody = ({
  card, onRunCommand
}: {
  readonly card: Extract<Card, { kind: "env" }>
  readonly onRunCommand: RunCommand
}) => (
  <div className="world-card-list">
    <p className="world-card-path">{card.payload.repo}</p>
    {card.payload.reconnect === true ?
      <Button size="sm" {...flowAction(onRunCommand, "env.remove-token", card.payload.repo)}>Remove token</Button> :
      null}
    {card.payload.vars.length === 0 ?
      <Button size="sm" {...flowAction(onRunCommand, "env.set")}>Add variable</Button> :
      (
        <ul className="world-card-list">
          {card.payload.vars.map((entry) => (
            <li key={entry.name} className="world-card-row">
              <span className="world-card-title">{entry.name}</span>
              <span className="world-card-path">{entry.value}</span>
            </li>
          ))}
        </ul>
      )}
    {card.payload.setupScript !== null ?
      (
        <div className="connect-store-row">
          <span className="connect-store-icon">
            <Terminal size={16} aria-hidden="true" />
          </span>
          <span className="connect-store-text">
            <strong>Setup script</strong>
          </span>
        </div>
      ) :
      null}
    {card.payload.setupScript !== null ? <pre className="world-card-path">{card.payload.setupScript}</pre> : null}
    <Button size="sm" {...flowAction(onRunCommand, "secrets.list", card.payload.repo)}>Secrets</Button>
  </div>
)

export const envCardFamily: CardFamily<"env"> = {
  env: { render: (card, actions) => <EnvCardBody card={card} onRunCommand={actions.onRunCommand} />, pill: settledPill }
}
