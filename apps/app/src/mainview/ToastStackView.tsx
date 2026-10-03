import { useState } from "react"
import { Notice } from "./cards/views/ToastNoticeView"
import type { ToastStackProps } from "@smthrs/rpc/ToastCard"


export function ToastStack({ toasts, more, onAction, onView }: ToastStackProps) {
  const [expanded, setExpanded] = useState(false)
  const disclose = () => setExpanded(true)
  return <section className="mvp-notify" aria-label="Notifications">
    {(expanded ? toasts : toasts.slice(0, 3)).map(toast => <Notice key={toast.id} toast={toast} onAction={onAction} onView={onView} />)}
    {more > 0 ? <button type="button" className="mvp-notice-more" aria-expanded={expanded} onClick={disclose}>+{more} more</button> : null}
  </section>
}
