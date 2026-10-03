/*
 * The review flow's card (/review, mvp.md Appendix A): a verdict and findings,
 * each pointing at a line. ⌘K "review retry-webhooks" and /review open the
 * same card. Each finding has its own acts: Please fix sends it to the coding
 * agent as a steer; Not useful dismisses it (mvp.md B.2). Like the PR card, it
 * reviews only the item's own change, the diff from the previous item's
 * candidate (spec §12.5.1), and names the head it read.
 */
import { Button } from "@smthrs/ui"
import { CircleAlert, CircleDot, Info } from "lucide-react"
import { Avatar, BranchChip, Card, actorName } from "../parts"
import { useFrame } from "../frame"
import { branch as branchOf, refOf } from "../world"
import type { ExtraCardProps } from "./extra"

const SEVERITY = {
  blocker: { word: "Blocker", Icon: CircleAlert },
  fix: { word: "Fix", Icon: CircleDot },
  note: { word: "Note", Icon: Info }
} as const

export const ReviewCard = ({ id, target }: ExtraCardProps) => {
  const { state: { world } } = useFrame()
  const review = world.reviews.find(each => each.id === target)
  if (review === undefined) return null
  const branch = branchOf(world, review.branch)
  const item = branch.item === undefined ? undefined : world.todos.find(each => each.id === branch.item)
  /* The head it read: the review's own record once world.ts keeps one, else its item's current revision. */
  const head = review.rev ?? item?.evidence?.rev
  return (
    <Card id={id} kind="review" title="Review"
      status={<span className="mvp-verdict" data-verdict={review.verdict}>{review.verdict === "clean" ? "No findings" : `${review.findings.length} findings`}</span>}
      end={<span className="mvp-edited-by"><Avatar world={world} who={review.by} size={18} />{actorName(world, review.by)}</span>}>
      <div className="mvp-meta"><BranchChip branch={branch} onOpen={() => {}} />
        <span>{item === undefined ? "Changes since the fork" : `${refOf(world, item)}'s own change`}</span>
        {head === undefined ? null : <span className="mvp-mono mvp-muted" data-mock={`review-head-${review.id}`}>{head}</span>}</div>
      <ul className="mvp-findings">
        {review.findings.map((finding, index) => {
          const { word, Icon } = SEVERITY[finding.severity]
          return (
            <li key={index} data-severity={finding.severity}>
              <span className="mvp-finding-kind"><Icon size={13} aria-hidden="true" />{word}</span>
              <button type="button" className="mvp-ws-where">{finding.path.split("/").at(-1)}:{finding.line}</button>
              <span className="mvp-finding-text" data-copy="data">{finding.text}</span>
              {finding.acted === undefined ? (
                <span className="mvp-finding-acts">
                  <Button size="sm" variant="outline" data-mock={`finding-fix-${review.id}-${index}`}>Please fix</Button>
                  <Button size="sm" variant="ghost" data-mock={`finding-not-useful-${review.id}-${index}`}>Not useful</Button>
                </span>
              ) : <span className="mvp-meta">{finding.acted === "fix" ? "Sent as a steer" : "Dismissed"}</span>}
            </li>
          )
        })}
      </ul>
      <div className="mvp-actions"><span className="mvp-actions-end"><Button size="sm" variant="ghost">Diff</Button></span></div>
    </Card>
  )
}
