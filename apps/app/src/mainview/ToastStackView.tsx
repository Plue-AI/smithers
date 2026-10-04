import { useState } from "react"
import { Bell, Check, CircleAlert, LoaderCircle, X } from "lucide-react"
import type { ToastCard, ToastStackProps } from "@smthrs/rpc/ToastCard"

function Notice({ toast, onAction, onView }: { toast: ToastCard } & Pick<ToastStackProps, "onAction" | "onView">) {
  const action = toast.action
  const press = () => { if (action) onAction(action.tag, action.args ?? {}) }
  const hide = () => onView({ toast_hidden: toast.id })
  const icon = toast.kind === "allow_notifications" ? <Bell size={13} /> : toast.tone === "done" ? <Check size={13} />
    : toast.tone === "failed" ? <X size={13} /> : toast.tone === "live" ? <LoaderCircle size={13} /> : <CircleAlert size={13} />
  return <div className="mvp-notice" data-tone={toast.tone} data-notice={toast.id} role={toast.tone === "failed" ? "alert" : "status"}>
    <span className="mvp-notice-icon" aria-hidden="true">{icon}</span>
    <span className="mvp-notice-body"><b>{toast.title}</b>{toast.detail === undefined ? null : <span>{toast.detail}</span>}
      {action ? <span className="mvp-notice-actions"><button type="button" data-flow={action.tag} disabled={Boolean(action.disabled)} onClick={press}>{action.label}</button>
        {action.disabled ? <span>{action.disabled.reason}</span> : null}</span> : null}
    </span>
    <button type="button" className="mvp-notice-hide" aria-label={`Hide ${toast.title}`} onClick={hide}><X size={13} aria-hidden="true" /></button>
  </div>
}

/** Notifications: at most three, "+N more" discloses the rest (T-UI-08). */
export function ToastStack({ toasts, more, onAction, onView }: ToastStackProps) {
  const [expanded, setExpanded] = useState(false)
  const disclose = () => setExpanded(true)
  if (toasts.length === 0) return null
  return <section className="mvp-notify" aria-label="Notifications">
    {(expanded ? toasts : toasts.slice(0, 3)).map(toast => <Notice key={toast.id} toast={toast} onAction={onAction} onView={onView} />)}
    {more > 0 && !expanded ? <button type="button" className="mvp-notice-more" aria-expanded={expanded} onClick={disclose}>+{more} more</button> : null}
  </section>
}
