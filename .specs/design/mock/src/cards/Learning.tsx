/*
 * A learning run's proposal (mvp.md §6.12, J5): an improvement to a flow,
 * backed by evidence from the team's own runs. It never applies itself: a
 * member turns it into a TODO, which merges like any other, or dismisses it.
 */
import { Button } from "@smthrs/ui"
import { Lightbulb } from "lucide-react"
import { Card } from "../parts"
import { useFrame } from "../frame"
import type { ExtraCardProps } from "./extra"

export const ProposalCard = ({ id, target }: ExtraCardProps) => {
  const { state: { world } } = useFrame()
  const proposal = world.proposals.find(each => each.id === target)
  if (proposal === undefined) return null
  const made = proposal.todo === undefined ? undefined : world.todos.find(each => each.id === proposal.todo)
  return (
    <Card id={id} kind="proposal" title={proposal.title} status={<span className="mvp-proposal-tag"><Lightbulb size={13} aria-hidden="true" />Suggested</span>}>
      <p className="mvp-proposal-why">{proposal.evidence}</p>
      <div className="mvp-proposal-refs">
        {proposal.refs.map(ref => <a key={ref} className="mvp-ref" href="#">#{ref}</a>)}
      </div>
      <div className="mvp-actions">
        {made === undefined ? <>
          <Button size="sm" variant="solid" data-mock={`proposal-todo-${proposal.id}`}>Make TODO</Button>
          <span className="mvp-actions-end"><Button size="sm" variant="ghost">Dismiss</Button></span>
        </> : <span className="mvp-meta">TODO <b>{made.title}</b></span>}
      </div>
    </Card>
  )
}
