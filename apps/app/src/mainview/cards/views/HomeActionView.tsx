import type { Action } from "@smthrs/rpc/CardAction"
import type { HomeViewProps } from "@smthrs/rpc/HomeCard"

/** Supplied actions preserve their order, arguments and disabled reason. */
export function HomeActionView({ action, onAction, menu }: { action: Action; onAction: HomeViewProps["onAction"]; menu?: boolean }) {
  return <span className="mvp-home-action"><button role={menu ? "menuitem" : undefined} type="button" data-flow={action.tag} disabled={!!action.disabled}
    onClick={() => onAction(action.tag, action.args ?? {})}>{action.label}</button>
    {action.disabled ? <span className="mvp-meta">{action.disabled.reason}</span> : null}</span>
}
