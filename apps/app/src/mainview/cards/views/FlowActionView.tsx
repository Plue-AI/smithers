import type { Action } from "@smthrs/rpc/CardAction"
import type { FlowViewProps } from "@smthrs/rpc/FlowCard"
export function FlowActionView({ action, onAction }: { action: Action; onAction: FlowViewProps["onAction"] }) {
  const press = () => onAction(action.tag, { ...action.args })
  return <span className="flow-control"><button type="button" data-flow={action.tag} data-primary={action.primary || undefined} disabled={action.disabled !== undefined} onClick={press}>{action.label}</button>{action.disabled ? <span className="flow-disabled">{action.disabled.reason}</span> : null}</span>
}
