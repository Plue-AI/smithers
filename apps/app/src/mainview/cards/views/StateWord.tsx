import { CircleDashed, GitMerge, GitPullRequest, Pause, X } from "lucide-react"
import type { TodoState } from "@smthrs/rpc/CardPrimitives"

export type StateWordProps = { state: TodoState; step?: string }
export const stateWords: Record<TodoState, string> = {
  queued: "Queued", starting: "Starting", working: "Working", needs_you: "Needs you",
  paused: "Paused", failed: "Failed", in_review: "In review", merged: "Merged", dropped: "Dropped"
}
const icons = { in_review: GitPullRequest, merged: GitMerge, failed: X, dropped: CircleDashed, paused: Pause }
export function StateWord({ state, step }: StateWordProps) {
  const Icon = state in icons ? icons[state as keyof typeof icons] : undefined
  const label = state === "queued" && step ? `Waiting for a machine · ${step}`
    : step ? `${stateWords[state]} · ${step}` : stateWords[state]
  return <span className="mvp-state" data-state={state}>
    {Icon ? <Icon className="mvp-glyph" size={13} aria-hidden="true" /> : <span className="mvp-dot" data-state={state} aria-hidden="true" />}
    {label}
  </span>
}
