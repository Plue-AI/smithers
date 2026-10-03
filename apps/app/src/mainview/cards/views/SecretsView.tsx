import type { SecretsViewProps } from "@smthrs/rpc/SecretsCard"
import type { Action } from "@smthrs/rpc/CardAction"
import { KeyRound } from "lucide-react"
import { SetupAction } from "./SetupAction"

const scopeWords = { all_branches: "all branches", main_only: "main only" }

export function SecretsView({ model, actions, onAction }: SecretsViewProps) {
  const control = (action: Action, index: number, replace = false) => {
    const form = <SetupAction key={JSON.stringify(action)} action={action} onAction={onAction} inline placeholders choiceLabels={scopeWords} />
    return replace && action.input?.length
      ? <details key={index}><summary>{action.label}</summary>{form}</details>
      : <div key={index}>{form}</div>
  }
  return <section className="secrets-view" data-kind="secrets" data-keyboard-pane="Secrets" aria-label="Secrets">
    <h2>Secrets</h2>
    <ul className="secrets-list">
      {model.secrets.map(secret => <li key={secret.name}>
        <div className="secret-row"><KeyRound size={14} aria-hidden="true" /><code>{secret.name}</code><span className="secret-scope">{scopeWords[secret.scope]}</span></div>
        <div className="secret-actions">{secret.actions.map((action, index) => control(action, index, true))}</div>
      </li>)}
    </ul>
    <div className="secret-add">{actions.map((action, index) => control(action, index))}</div>
  </section>
}
