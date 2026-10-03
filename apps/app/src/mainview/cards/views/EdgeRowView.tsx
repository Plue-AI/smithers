import type { EdgeMapProps, ToastCard } from "@smthrs/rpc/ToastCard"
export function EdgeRow({ toast, onAction, onView }: { toast: ToastCard } & Pick<EdgeMapProps, "onAction" | "onView">) {
  const action = toast.action!
  const jump = () => onView({ jump_to: toast.entry_id })
  const press = () => onAction(action.tag, action.args ?? {})
  return <li data-tone={toast.tone}><button type="button" className="mvp-tl-row" onClick={jump}><span className="mvp-tl-node" aria-hidden="true">●</span><span className="mvp-tl-text"><b>{toast.title}</b>{toast.detail === undefined ? null : <span>{toast.detail}</span>}</span></button>
    {action ? <span className="mvp-tl-actions"><button type="button" data-flow={action.tag} disabled={Boolean(action.disabled)} onClick={press}>{action.label}</button>{action.disabled ? <span>{action.disabled.reason}</span> : null}</span> : null}
  </li>
}
