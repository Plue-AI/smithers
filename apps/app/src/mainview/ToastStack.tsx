import { Alert, AlertDescription, AlertTitle, Button, Spinner } from "@smthrs/ui"
import { Check, Square, X } from "lucide-react"
import { ModalPopover } from "./ModalPopover"
import { workerToastActions } from "./WorkerToastActions"
import type { Card, Toast } from "./state/AppState"
import { bindToastShortcut, ToastActionButton, type ToastAction } from "./ToastAction"
import { flowProps } from "./flows/FlowAction"
import { frameMs } from "@smthrs/rpc/SubagentCard"
import { live } from "@smthrs/rpc/WorkerControls"
import { useClock } from "@smthrs/ui/clock"
import { subagentOf, toastOf } from "./state/Subagents"

/*
 * The one shared toast surface (the 300ms law): a corner stack over the chat,
 * driven entirely by the toasts collection — transitions dispatched like
 * everything else. Running work shows what is running; a resolved ok toast
 * dismisses itself; a failure toast stays honest until dismissed (the dismiss
 * affordance routes through the registered toast.dismiss command).
 */
export function ToastStack({
  toasts,
  onDismiss,
  onAction,
  cards = [],
  available = () => true
}: {
  readonly cards?: ReadonlyArray<Card>
  readonly available?: (action: ToastAction) => boolean
  readonly toasts: ReadonlyArray<Toast>
  readonly onDismiss: (id: string) => void
  readonly onAction: (action: ToastAction) => void
}) {
  // A worker's toast says what its subagent card says (#2162): glyph, title, clock.
  const workers = new Map(toasts.flatMap(toast => {
    const subagent = subagentOf(cards.find(card => card.id === toast.sourceCard))
    return subagent === undefined ? [] : [[toast.id, subagent] as const]
  }))
  const now = useClock([...workers.values()].some(subagent => live(subagent.status)), frameMs)
  if (toasts.length === 0) return null
  return (
    <ModalPopover className="toast-stack" label="Notifications" onMount={bindToastShortcut}>
      {[...toasts].sort((a, b) => b.createdAt - a.createdAt).map((toast) => {
        const worker = workers.get(toast.id)
        const line = worker === undefined ? undefined : toastOf(worker, now)
        return <Alert
          key={toast.id}
          className="toast"
          data-toast-status={toast.status}
          variant={toast.status === "failed" ? "destructive" : "default"}
          /*
           * B-6: role="alert" is an assertive error landmark — only a FAILED
           * toast is one. A running/ok toast is a calm status note; rendering
           * it as an alert made an ordinary notification (repositories ready
           * to choose) read as an error surface mid-correction.
           */
          role={toast.status === "failed" ? "alert" : "status"}
        >
          {line !== undefined ? <span className="toast-icon subagent-glyph" data-tone={line.tone} aria-hidden="true">{line.glyph}</span>
            : toast.status === "running" ? <Spinner size="sm" className="toast-icon" aria-label="Working" />
            : toast.status === "cancelled" ? <Square size={17} className="toast-icon" aria-hidden="true" />
            : toast.status === "ok" ? <Check size={17} className="toast-icon" aria-hidden="true" />
            : <X size={17} className="toast-icon" aria-hidden="true" />}
          <div className="toast-body">
            <AlertTitle className="toast-title">{line?.text ?? toast.title}</AlertTitle>
            {toast.detail === "" ? null
              /*
               * A failed toast's detail is whatever its producer caught — often
               * an error message or a server body — so the title stays the
               * line and the detail waits behind a collapsed native Details.
               * Running, done and cancelled details are the work's own progress
               * words and stay in view.
               */
              : toast.status === "failed" ? <details className="toast-detail"><summary>Details</summary><pre tabIndex={0}>{toast.detail}</pre></details>
              : <AlertDescription className="toast-detail">{toast.detail}</AlertDescription>}
            <ToastActionButton toast={toast} onAction={action => { if (toast.status !== "running") onDismiss(toast.id); onAction(action) }} />
            <div className="toast-worker-actions">
              {workerToastActions(cards.find(card => card.id === toast.sourceCard), cards).filter(available).map(action =>
                <ToastActionButton key={action.flow} toast={{ ...toast, action, answeredAction: undefined }} onAction={onAction} />)}
            </div>
          </div>
          {toast.status === "failed" ?
            (
              <Button
                variant="ghost"
                size="icon"
                className="toast-dismiss"
                {...flowProps("toast.dismiss")}
                aria-label={`Dismiss: ${toast.title}`}
                title="Dismiss"
                onClick={() => onDismiss(toast.id)}
              >
                <X size={12} />
              </Button>
            ) :
            null}
        </Alert>
      })}
    </ModalPopover>
  )
}
