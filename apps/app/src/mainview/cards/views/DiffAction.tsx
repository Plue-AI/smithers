import { Button } from "@smthrs/ui/button"
import type { Action } from "@smthrs/rpc/CardAction"
import type { DiffViewProps } from "@smthrs/rpc/DiffCard"
export function DiffAction({ action, onAction }: { action: Action; onAction: DiffViewProps["onAction"] }) {
  const press = () => onAction(action.tag, action.args ?? {})
  return <span><Button size="sm" variant="outline" data-flow={action.tag} data-primary={action.primary || undefined} disabled={!!action.disabled} onClick={press}>{action.label}</Button>{action.disabled ? <span className="code-action-reason">{action.disabled.reason}</span> : null}</span>
}
