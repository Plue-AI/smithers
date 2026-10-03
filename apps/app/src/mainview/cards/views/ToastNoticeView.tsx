import { Bell, Check, CircleAlert, X } from "lucide-react"
import type { ToastCard, ToastStackProps } from "@smthrs/rpc/ToastCard"
export function Notice({ toast, onAction, onView }: { toast: ToastCard } & Pick<ToastStackProps, "onAction" | "onView">) {
  const action = toast.action!
  const press = () => onAction(action.tag, action.args ?? {})
  const hide = () => onView({ toast_hidden: toast.id })
  return <div className="mvp-notice" data-tone={toast.tone} data-notice={toast.id} role={toast.tone === "failed" ? "alert" : "status"}>
    <span className="mvp-notice-icon" aria-hidden="true">{toast.kind === "allow_notifications" ? <Bell size={13} /> : toast.tone === "done" ? <Check size={13} /> : toast.tone === "failed" ? <X size={13} /> : <CircleAlert size={13} />}</span>
    <span className="mvp-notice-body"><b>{toast.title}</b>{toast.detail === undefined ? null : <span>{toast.detail}</span>}
      {action ? <span className="mvp-notice-actions"><button type="button" data-flow={action.tag} disabled={Boolean(action.disabled)} onClick={press}>{action.label}</button>{action.disabled ? <span>{action.disabled.reason}</span> : null}</span> : null}
    </span>
    <button type="button" className="mvp-notice-hide" aria-label={`Hide ${toast.title}`} onClick={hide}><X size={13} aria-hidden="true" /></button>
  </div>
}

