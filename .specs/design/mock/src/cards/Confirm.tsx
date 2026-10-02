/*
 * Review & merge (mvp.md §6.10, Appendix A): the person's own confirmation,
 * bound to the revision they reviewed. It shows the current revision and each
 * check's live state, and Merge waits until every check has passed on that
 * revision. An approval given for an earlier revision is shown as stale.
 * Agents can't approve or merge: asked to merge, they open this card.
 */
import { Button } from "@smthrs/ui"
import { Check, ExternalLink, Loader, X } from "lucide-react"
import { Card } from "../parts"
import { useFrame } from "../frame"
import { refOf, todo as todoOf } from "../world"
import type { ExtraCardProps } from "./extra"
import { placeOf } from "./Todo"

export const ConfirmCard = ({ id, target }: ExtraCardProps) => {
  const { state: { world }, me } = useFrame()
  const todo = todoOf(world, target)
  const evidence = todo.evidence
  const done = todo.state === "merged"
  const person = world.members.find(each => each.id === me)?.name.split(" ")[0]
  const checking = evidence !== undefined && (evidence.checks.some(check => check.state === "running") || evidence.github.passed < evidence.github.total)
  const stale = todo.approvedRev !== undefined && evidence?.rev !== undefined && todo.approvedRev !== evidence.rev
  return (
    <Card id={id} kind="confirm" title={done ? `Merged ${refOf(world, todo)}` : `Merge ${refOf(world, todo)} into main?`}>
      <div className="mvp-meta"><b className="mvp-confirm-title">{todo.title}</b>{done ? null : <span>{placeOf(world, todo)}</span>}</div>
      {evidence === undefined ? null : (
        <div className="mvp-confirm-facts">
          {todo.pr === undefined ? null : <a className="mvp-link" href="#">#{todo.pr}<ExternalLink size={11} aria-hidden="true" /></a>}
          {evidence.rev === undefined ? null : <span className="mvp-mono">rev {evidence.rev}</span>}
          {evidence.checks.map(check => (
            <span key={check.name} className="mvp-check" data-state={check.state}>
              {check.state === "passed" ? <Check size={13} aria-hidden="true" /> : check.state === "failed" ? <X size={13} aria-hidden="true" /> : <Loader size={13} aria-hidden="true" />}{check.name}
            </span>
          ))}
          <span className="mvp-check" data-state={evidence.github.passed === evidence.github.total ? "passed" : "running"}>
            {evidence.github.passed === evidence.github.total ? <Check size={13} aria-hidden="true" /> : <Loader size={13} aria-hidden="true" />}GitHub {evidence.github.passed}/{evidence.github.total}
          </span>
          <span>{evidence.review}</span>
        </div>
      )}
      {stale ? <p className="mvp-warn-text mvp-stale">You approved {todo.approvedRev}; it is now at {evidence?.rev}. Review the new revision.</p> : null}
      {done ? null : (
        <div className="mvp-actions">
          <span className="mvp-meta">Merges as {person}</span>
          <span className="mvp-actions-end">
            <Button size="sm" variant="ghost"><ExternalLink size={13} aria-hidden="true" />on GitHub</Button>
            <Button size="sm" variant="ghost">Cancel</Button>
            {checking ? <Button size="sm" variant="outline" disabled>Checks running</Button>
              : <Button size="sm" variant="solid" data-mock={`confirm-merge-${todo.id}`}>{stale ? "Review & merge" : "Merge"}</Button>}
          </span>
        </div>
      )}
    </Card>
  )
}
