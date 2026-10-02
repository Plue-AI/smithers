/*
 * The Issue card: GitHub discussion, read in the app (mvp.md §3: issues are
 * where discussion happens). One primary action, Make TODO. Once a TODO
 * exists, the card says "Committed as T12 ↗" instead.
 */
import { Button } from "@smthrs/ui"
import { CircleDot, ExternalLink, GitCommitHorizontal } from "lucide-react"
import { Avatar, Card, StatePill, actorName } from "../parts"
import { useFrame } from "../frame"
import { issue as issueOf, refOf } from "../world"
import type { ExtraCardProps } from "./extra"

export const IssueCard = ({ id, target }: ExtraCardProps) => {
  const { state: { world, seq } } = useFrame()
  const issue = issueOf(world, Number(target))
  const made = issue.todo === undefined ? undefined : world.todos.find(each => each.id === issue.todo)
  return (
    <Card id={id} kind="issue" title={<><span className="mvp-issue-number">#{issue.number}</span> {issue.title}</>}
      status={<span className="mvp-issue-state" data-open={issue.open || undefined}><CircleDot size={13} aria-hidden="true" />{issue.open ? "Open" : "Closed"}</span>}>
      <div className="mvp-thread">
        <article className="mvp-comment">
          <Avatar world={world} who={issue.author} size={22} />
          <div><header><b>{actorName(world, issue.author)}</b><span>{issue.age}</span></header><p>{issue.body}</p></div>
        </article>
        {issue.comments.map((comment, index) => (
          <article key={index} className="mvp-comment">
            <Avatar world={world} who={comment.who} size={22} />
            <div><header><b>{actorName(world, comment.who)}</b><span>{comment.age}</span></header><p>{comment.text}</p></div>
          </article>
        ))}
      </div>
      <div className="mvp-actions">
        {made === undefined
          ? <Button variant="solid" size="sm" data-mock={`make-todo-${issue.number}`}>Make TODO</Button>
          : <span className="mvp-made" data-fresh={made.seq === seq || undefined}><GitCommitHorizontal size={14} aria-hidden="true" />Committed as
              <button type="button" className="mvp-link" data-mock={`made-${made.id}`}>{refOf(world, made)} ↗</button><StatePill todo={made} flow={world.flow} /></span>}
        <span className="mvp-actions-end"><Button size="sm" variant="ghost"><ExternalLink size={13} aria-hidden="true" />GitHub</Button></span>
      </div>
    </Card>
  )
}
