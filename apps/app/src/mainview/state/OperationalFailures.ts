import type { PlueFault } from "@smthrs/rpc/Refusal"
import { lostActFault, lostActFaultClass, type LostActFault } from "./BrowserWriteFailure"
import { diagnosticText, type ClientErrorReporter } from "./ClientErrors"

export type OperationalSeam = "journal.compaction" | "http.turn.driver" | "approval.forward" | "approval.reconcile" |
  "run.pump" | "run.cancel" | "setup.schedule" | "setup.guidance" | "setup.open-run" | "form.file-list" |
  "recommend.outcome" | "archive.notice" | "turn.cancel" | "turn.sign-in" | "turn.select" | "explain.cancel" | "explain.retire" | "explain.disconnect" |
  "account.revoke" | "wiki.index.listener" | "command.boundary" | "toast.work" | "prompt.queue" |
  "seam.failure" | "explain.launch"

export interface OperationalFailure {
  readonly seam: OperationalSeam
  readonly lost: LostActFault
  readonly fault: PlueFault
  readonly message: string
  readonly subject?: string
  readonly at: number
  readonly count: number
}
export interface OperationalFailureReporter {
  report(seam: OperationalSeam, error: unknown, subject?: string): void
  recent(): ReadonlyArray<OperationalFailure>
  reset(): void
}

/** Bounded controller-local evidence; reporting cannot interrupt the work it observes. */
export const createOperationalFailureReporter = (options: {
  clientErrors?: ClientErrorReporter; now?: () => number; dedupeWindowMs?: number; ringSize?: number
} = {}): OperationalFailureReporter => {
  const ring: Array<{ key: string; record: OperationalFailure }> = []
  const now = options.now ?? Date.now
  const size = Math.max(1, options.ringSize ?? 100)
  return {
    report: (seam, error, subject) => {
      try {
        const at = now(), lost = lostActFault(error)
        const key = JSON.stringify([seam, lost, subject])
        const previous = [...ring].reverse().find(entry => entry.key === key)
        if (previous && at - previous.record.at < (options.dedupeWindowMs ?? 60_000)) {
          previous.record = { ...previous.record, count: previous.record.count + 1 }
          return
        }
        const record: OperationalFailure = { seam, lost, fault: lostActFaultClass(error),
          message: diagnosticText(error).slice(0, 1024), subject, at, count: 1 }
        ring.push({ key, record })
        if (ring.length > size) ring.shift()
        options.clientErrors?.report("operational", JSON.stringify(record))
      } catch { /* The diagnostic sink must never become a second failure. */ }
    },
    recent: () => ring.map(entry => ({ ...entry.record })),
    reset: () => { ring.length = 0 }
  }
}
