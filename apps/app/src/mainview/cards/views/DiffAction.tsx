import type { Action } from "@smthrs/rpc/CardAction"
import type { DiffViewProps } from "@smthrs/rpc/DiffCard"
export function DiffAction({ action, onAction }: { action: Action; onAction: DiffViewProps["onAction"] }) {
  const press = () => onAction(action.tag, action.args ?? {})
  return <span><button type="button" data-flow={action.tag} disabled={!!action.disabled} onClick={press}>{action.label}</button>{action.disabled ? <span>{action.disabled.reason}</span> : null}</span>
}
