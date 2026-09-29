import { Button } from "@smthrs/ui"
import type { UserFailure, UserFailureAction, UserFailureCopy } from "@smthrs/rpc/UserFailure"
import type { ReactNode } from "react"

/*
 * How a card or panel shows one failure: the presenter's sentence, a button
 * for each action the failure offers AND the surface can perform, and the raw
 * detail behind a collapsed native Details (keyboard operable as is). The raw
 * text never becomes the sentence; build `failure` with `presentUserFailure`.
 */

/** The props one action's button spreads: a click handler, usually `flowAction(...)`. */
export interface FailureActionProps {
  readonly onClick: () => void
  /** Overrides the action's default label when the surface can name it better, e.g. "Reload app". */
  readonly label?: string
  readonly disabled?: boolean
  readonly "data-flow"?: string
  readonly "data-flow-args"?: string | undefined
}

/**
 * A failure whose type survived only as a surface-level tag (a stored act, a
 * payload flag) with its raw text beside it: the tag's copy, the text as detail.
 */
export const describedFailure = <Tag extends string>(tag: Tag, copy: UserFailureCopy, detail: string): UserFailure =>
  ({ tag, fault: copy.fault, sentence: copy.sentence, actions: copy.actions, detail })

const LABELS: Readonly<Record<UserFailureAction, string>> = {
  retry: "Retry",
  "sign-in": "Sign in",
  "use-here": "Use Smithers here",
  "download-recovery": "Download recovery file",
  "reset-local-data": "Reset local data"
}

export interface FailureNoticeProps {
  readonly failure: UserFailure
  /** The actions this surface can perform. An offered action with no entry is not drawn. */
  readonly actions?: Partial<Readonly<Record<UserFailureAction, FailureActionProps>>>
  /** `status` for a failure that is not the reason the surface exists. */
  readonly role?: "alert" | "status"
  readonly className?: string
  /** Surface hooks such as `data-testid` or `data-act`, forwarded to the notice. */
  readonly [data: `data-${string}`]: string | undefined
  /** Surface-specific doors after the actions, such as an upgrade. */
  readonly children?: ReactNode
}

export function FailureNotice({ failure, actions = {}, role = "alert", className, children, ...rest }: FailureNoticeProps) {
  const offered = failure.actions.flatMap(action => {
    const props = actions[action]
    return props === undefined ? [] : [[action, props] as const]
  })
  const detail = failure.detail.trim()
  return (
    <div role={role} className={className ?? "failure-notice"} data-fault={failure.fault}
      data-failure={failure.tag ?? undefined} {...rest}>
      <p>{failure.sentence}</p>
      {offered.map(([action, { label, ...props }]) => (
        <Button key={action} type="button" size="sm" variant="outline" {...props}>{label ?? LABELS[action]}</Button>
      ))}
      {children}
      {detail === "" || detail === failure.sentence ? null : (
        <details><summary>Details</summary><pre tabIndex={0}>{failure.detail}</pre></details>
      )}
    </div>
  )
}
