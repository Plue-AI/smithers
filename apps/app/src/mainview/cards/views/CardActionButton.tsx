import type { Action } from "@smthrs/rpc/CardAction"
import type { CardProps } from "@smthrs/rpc/CardAction"
export function CardActionButton({ action, onAction }: { action: Action; onAction: CardProps<unknown>["onAction"] }) {
  const press = () => onAction(action.tag, action.args ?? {})
  return <span><button type="button" data-flow={action.tag} data-primary={action.primary || undefined} disabled={!!action.disabled} onClick={press}>{action.label}</button>{action.disabled ? <span>{action.disabled.reason}</span> : null}</span>
}
