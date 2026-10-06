import { Check, Loader, X } from "lucide-react"
import type { ConfirmViewProps } from "@smthrs/rpc/ConfirmCard"
import type { Merge } from "@smthrs/rpc/CardPrimitives"

import { ActorChip, actorName } from "./ActorChip"

// Read the shared result; never recompute readiness or authorization here.
const reasons: Record<NonNullable<Merge["reason"]>, string> = {
  state: "In review", order: "Waiting for stack order", attention: "Stack needs attention",
  merging: "Merging", rechecking: "Checks running", pending_work: "Changes pending",
  stale_head: "Review the current revision", checks: "Checks required", review_required: "Review required", github: "Waiting for GitHub"
}

export function ConfirmView({ model, actions, onAction }: ConfirmViewProps) {
  const { review, receipt } = model
  const evidence = review?.evidence
  const revision = model.subject.revision ?? evidence?.revision
  const stale = review?.approved_revision !== undefined && review.approved_revision !== revision
  const receiptText = receipt && (receipt.result === "done" ? receipt.text ?? "Done" : receipt.result === "cancelled" ? "Cancelled" : "Expired")
  const title = receiptText ?? (model.kind === "review_merge" ? `Merge ${model.subject.ref} into main?` : `${model.summary}?`)
  if (receipt) return <section className="smithers-card confirm-view" data-kind="confirm" data-keyboard-pane="Confirmation" aria-label={title}>
    <p className="confirm-receipt">{receipt.result === "done" ? <Check size={14} aria-hidden="true" /> : null}{receiptText}{receipt.result === "done" ? ` · ${receipt.by.name.split(" ")[0]}` : ""}</p>
  </section>
  return <section className="smithers-card confirm-view" data-kind="confirm" data-keyboard-pane="Confirmation" aria-label={title}>
    <header className="smithers-card-header"><h2 className="smithers-card-title">{title}</h2></header>
    <div className="smithers-card-body">
      <>
        {model.kind === "one_click" ? <p className="confirm-asker"><ActorChip actor={model.asked_by} size="s" /><span>{actorName(model.asked_by)}</span></p> : null}
        {model.kind === "review_merge" && review && evidence ? <>
          <div className="confirm-meta"><b>{review.title}</b><span>#{review.place} in stack</span></div>
          <div className="confirm-facts">
            <a href={review.pr.url} target="_blank" rel="noreferrer">#{review.pr.number} ↗</a>
            <span className="confirm-mono">rev {revision}</span>
            {evidence.items.map((item, i) => item.kind === "check" || item.kind === "github_check" ? <span key={i} className="confirm-check" data-state={item.state}>
              {item.state === "passed" ? <Check size={13} aria-hidden="true" /> : item.state === "failed" ? <X size={13} aria-hidden="true" /> : <Loader size={13} aria-hidden="true" />}{item.name}<span className="confirm-check-state">{item.state}</span>
            </span> : item.kind === "review" && !evidence.reviewing && !evidence.previous ? <span key={i}>{item.summary}</span> : null)}
            {evidence.reviewing ? <span>Review running on <span className="confirm-mono">{evidence.revision}</span></span> : evidence.previous ? <span className="confirm-previous">Reviewed <span className="confirm-mono">{evidence.previous.revision}</span> · same change</span> : null}
          </div>
          {stale ? <p className="confirm-stale">Approved {review.approved_revision} · Review {revision}</p> : null}
          {review.merge.state !== "ready" ? <p className="confirm-merge-reason" data-state={review.merge.state}>{review.merge.reason === "order" && review.merge.detail ? `Merges after ${review.merge.detail}` : review.merge.detail ?? (review.merge.reason ? reasons[review.merge.reason] : review.merge.state === "done" ? "Merged into main" : "Merging")}</p> : null}
        </> : null}
      </>
      {model.text === undefined ? null : <p className="confirm-text">{model.text}</p>}
      <div className="confirm-actions">{actions.map((action, i) => <span className="confirm-control" key={i}>
        <button type="button" data-flow={action.tag} data-primary={action.primary || undefined} disabled={action.disabled !== undefined} onClick={() => onAction(action.tag, { ...action.args })}>
          {action.label}{model.kind === "one_click" && action.primary ? <kbd aria-hidden="true">⏎</kbd> : null}
        </button>{action.disabled ? <span className="confirm-disabled">{action.disabled.reason}</span> : null}
      </span>)}</div>
    </div>
  </section>
}
