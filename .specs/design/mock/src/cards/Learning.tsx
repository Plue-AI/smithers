/*
 * A learning run's receipt (mvp.md §4.1, §6.12, B.4, B.5). Learning is its
 * own background run after a merge: it queues for a machine, works, then
 * leaves the wiki pages it wrote and at most one flow change it suggests,
 * backed by the team's own runs. The card is the run's, so nothing shows
 * before the run exists. A suggestion never applies itself: a member makes it
 * a TODO, which merges like any other, or dismisses it. Once it is a TODO,
 * the card links that TODO and its state, and the evidence folds away.
 */
import { Button } from "@smthrs/ui"
import { ArrowUpRight, BookOpen, Check, GitCommitHorizontal, Lightbulb, RotateCw, X } from "lucide-react"
import { Card, Ref, StatePill } from "../parts"
import { useFrame } from "../frame"
import type { BackgroundRun } from "../world"
import type { ExtraCardProps } from "./extra"

const RunState = ({ run }: { readonly run: BackgroundRun }) =>
  run.queue !== undefined ? <span className="mvp-state" data-state="queued"><span className="mvp-dot" data-state="queued" aria-hidden="true" />Queued · #{run.queue}</span>
  : run.state === "running" ? <span className="mvp-state" data-state="working"><span className="mvp-dot" data-state="working" aria-hidden="true" />Working</span>
  : run.state === "failed" ? <span className="mvp-state" data-state="failed"><X size={13} aria-hidden="true" />Failed</span>
  : <span className="mvp-state" data-state="done"><Check size={13} aria-hidden="true" />Done</span>

/* The target is the run's id. A run suggests at most one change, so its suggestion shares the id. */
export const ProposalCard = ({ id, target }: ExtraCardProps) => {
  const { state: { world } } = useFrame()
  const run = world.runs.find(each => each.id === target)
  if (run === undefined) return null
  const proposal = run.state === "done" ? world.proposals.find(each => each.id === run.id) : undefined
  const made = proposal?.todo === undefined ? undefined : world.todos.find(each => each.id === proposal.todo)
  const pages = world.wiki.filter(page => run.lessons?.includes(page.id) === true)
  return (
    <Card id={id} kind="proposal" title={run.title} status={<RunState run={run} />}>
      {run.state === "failed" ? <>
        <p className="mvp-failure-line"><X size={14} aria-hidden="true" /><b>Failed</b><span>{run.detail}</span></p>
        <div className="mvp-actions">
          <Button size="sm" variant="outline" data-mock={`learning-retry-${run.id}`}><RotateCw size={13} aria-hidden="true" />Retry</Button>
          <Button size="sm" variant="ghost">Dismiss</Button>
        </div>
      </> : null}
      {pages.length === 0 ? null : (
        <div className="mvp-learning-lessons">
          <BookOpen size={13} aria-hidden="true" />{pages.length} {pages.length === 1 ? "lesson" : "lessons"}
          {pages.map(page => <button key={page.id} type="button" className="mvp-file-link" data-mock={`lesson-${page.id}`}>{page.title}</button>)}
        </div>
      )}
      {proposal === undefined ? null : (
        <div className="mvp-learning-suggestion">
          <div className="mvp-learning-title">
            <Lightbulb size={14} aria-hidden="true" /><b>{proposal.title}</b>
            {made === undefined ? <span className="mvp-proposal-tag">Suggested</span> : null}
          </div>
          <details className="mvp-learning-evidence" open={made === undefined}>
            <summary data-mock={`proposal-evidence-${run.id}`}>Evidence</summary>
            <p data-copy="data">{proposal.evidence}</p>
            <div className="mvp-proposal-refs">{proposal.refs.map(ref => <a key={ref} className="mvp-ref" href="#">#{ref}</a>)}</div>
          </details>
          <div className="mvp-actions">
            {made === undefined ? <>
              <Button size="sm" variant="solid" data-mock={`proposal-todo-${run.id}`}>Make TODO</Button>
              <span className="mvp-actions-end"><Button size="sm" variant="ghost" data-mock={`proposal-dismiss-${run.id}`}>Dismiss</Button></span>
            </> : <>
              <button type="button" className="mvp-learning-made" data-mock={`proposal-made-${run.id}`}>
                <GitCommitHorizontal size={14} aria-hidden="true" />Committed as <Ref world={world} todo={made} /><ArrowUpRight size={13} aria-hidden="true" />
              </button>
              <StatePill todo={made} flow={made.steps ?? world.flow} />
            </>}
          </div>
        </div>
      )}
    </Card>
  )
}
