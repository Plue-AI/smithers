import { useCallback, useRef, useState } from "react"
import { Bell, Check, CircleAlert, LoaderCircle, X } from "lucide-react"
import type { ToastCard, ToastStackProps } from "@smthrs/rpc/ToastCard"

function Notice({ toast, onAction, onView, onReveal }: { toast: ToastCard; onReveal?: (node: HTMLDivElement | null) => void } & Pick<ToastStackProps, "onAction" | "onView">) {
  const action = toast.action
  const press = () => { if (action) onAction(action.tag, action.args ?? {}) }
  const hide = () => onView({ toast_hidden: toast.id })
  const icon = toast.kind === "allow_notifications" ? <Bell size={13} /> : toast.tone === "done" ? <Check size={13} />
    : toast.tone === "failed" ? <X size={13} /> : toast.tone === "live" ? <LoaderCircle size={13} /> : <CircleAlert size={13} />
  return <div ref={onReveal} className="notice" data-tone={toast.tone} data-notice={toast.id} role={toast.tone === "failed" ? "alert" : "status"}>
    <span className="notice-icon" aria-hidden="true">{icon}</span>
    <span className="notice-body"><b>{toast.title}</b>{toast.detail === undefined ? null : <span>{toast.detail}</span>}
      {action ? <span className="notice-actions"><button type="button" data-flow={action.tag} disabled={Boolean(action.disabled)} onClick={press}>{action.label}</button>
        {action.disabled ? <span>{action.disabled.reason}</span> : null}</span> : null}
    </span>
    <button type="button" className="notice-hide" aria-label={`Hide ${toast.title}`} onClick={hide}><X size={13} aria-hidden="true" /></button>
  </div>
}

/** Notifications: at most three, "+N more" discloses the rest (T-UI-08). */
export function ToastStack({ toasts, more, onAction, onView }: ToastStackProps) {
  const [expanded, setExpanded] = useState(false)
  const revealPending = useRef(false)
  const reveal = useCallback((node: HTMLDivElement | null) => {
    if (!node || !revealPending.current) return
    const control = node.querySelector<HTMLButtonElement>("button:not(:disabled)")
    if (control) { revealPending.current = false; control.focus() }
  }, [])
  const disclose = () => { revealPending.current = true; setExpanded(true) }
  if (toasts.length === 0) return null
  return <section className="notify" aria-label="Notifications">
    {(expanded ? toasts : toasts.slice(0, 3)).map((toast, index) => <Notice key={toast.id} toast={toast} onAction={onAction} onView={onView} onReveal={expanded && index >= 3 ? reveal : undefined} />)}
    {more > 0 && !expanded ? <button type="button" className="notice-more" aria-expanded={expanded} onClick={disclose}>+{more} more</button> : null}
  </section>
}
