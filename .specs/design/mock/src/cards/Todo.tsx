/*
 * The TODO card: the work. Its prompt, where it is worked and its place in the
 * stack, how far the flow has come, the one question waiting on a person, and
 * once a PR opens, the evidence a reviewer needs before Merge (mvp.md §6.6).
 * Any member can answer, steer, stop, resume, retry or drop.
 */
import { Button } from "@smthrs/ui"
import { BookOpen, Check, ExternalLink, History, Loader, RotateCw, X } from "lucide-react"
import { Avatar, AvatarStack, BranchChip, Card, Ref, StatePill, StepStrip, actorName } from "../parts"
import { typedOr, useFrame } from "../frame"
import { mergeReadiness, openItems, refOf, todo as todoOf, type Todo, type World } from "../world"
import { RunFlags } from "./Run"

const ordinal = (n: number): string => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`

/** "next to merge" or "3rd in stack": where the item sits in the repository's one stack. */
export const placeOf = (world: World, todo: Todo): string => {
  const open = world.stack.filter(id => {
    const each = world.todos.find(candidate => candidate.id === id)
    return each !== undefined && each.state !== "merged" && each.state !== "dropped"
  })
  const index = open.indexOf(todo.id)
  return index === 0 ? "next to merge" : index > 0 ? `${ordinal(index + 1)} in stack` : ""
}

/* Reasons a person resolves somewhere else: the card names it and offers the one action, never an answer field. */
const ELSEWHERE: Partial<Record<NonNullable<Todo["needs"]>, string>> = { conflict: "Resolve", moved_off: "Resolve", force_push: "Review", order: "Move" }

const Question = ({ todo }: { readonly todo: Todo }) => {
  const frame = useFrame()
  const { world } = frame.state
  if (todo.question === undefined) return null
  const answered = todo.question.answer
  const late = todo.question.late?.by === frame.me ? todo.question.late : undefined
  const elsewhere = todo.needs === undefined ? undefined : ELSEWHERE[todo.needs]
  return (
    <div className="mvp-ask" data-answered={answered !== undefined || undefined} data-mock={`ask-${todo.id}`}>
      <div className="mvp-ask-line">
        <Avatar world={world} who={`agent:${todo.branch}`} size={20} />
        <span>{todo.question.text}</span>
      </div>
      {answered !== undefined ? (
        <>
          <div className="mvp-ask-line mvp-ask-answer">
            <Avatar world={world} who={answered.by} size={20} />
            <span><b>{actorName(world, answered.by)} answered</b> {answered.text}</span>
          </div>
          {late === undefined ? null : (
            <div className="mvp-inline-input mvp-late">
              <input aria-label="Your draft" readOnly value={late.text} />
              <Button size="sm" variant="outline" data-mock={`send-as-steer-${todo.id}`}>Send as steer</Button>
            </div>
          )}
        </>
      ) : todo.needs === "foreign_push" ? (
        /* A person's commit is never overwritten: bring it in (the branch rebases onto it at a checkpoint) or discard it on purpose. */
        <div className="mvp-actions mvp-ask-elsewhere">
          <Button size="sm" variant="solid" data-mock={`bring-in-${todo.id}`}>Bring in {actorName(world, todo.pushedBy ?? "")}'s commit</Button>
          <Button size="sm" variant="ghost" data-mock={`discard-push-${todo.id}`}>Discard</Button>
        </div>
      ) : elsewhere !== undefined ? (
        <div className="mvp-actions mvp-ask-elsewhere">
          <Button size="sm" variant="solid" data-mock={`${elsewhere.toLowerCase()}-card-${todo.id}`}>{elsewhere}</Button>
        </div>
      ) : (
        <form className="mvp-inline-input" onSubmit={event => event.preventDefault()}>
          <input aria-label="Answer" placeholder="Answer" value={typedOr(frame, `answer:${todo.id}`, "")} readOnly data-mock={`answer-input-${todo.id}`} />
          <Button size="sm" variant="solid" data-mock={`answer-send-${todo.id}`}>Answer</Button>
        </form>
      )}
    </div>
  )
}

const Failure = ({ todo }: { readonly todo: Todo }) => {
  const frame = useFrame()
  const { world } = frame.state
  const step = world.flow.find(each => each.id === todo.step)?.title ?? "A step"
  /* An attempt keeps the flow version it started on; once the active version differs, a retry can take it instead (B.4). */
  const older = todo.steps !== undefined && todo.steps.map(each => `${each.id}:${each.detail ?? ""}`).join() !== world.flow.map(each => `${each.id}:${each.detail ?? ""}`).join()
  return (
    <div className="mvp-failure" data-mock={`failure-${todo.id}`}>
      <div className="mvp-failure-line"><X size={14} aria-hidden="true" /><b>{step} failed</b><span>{todo.failure}</span></div>
      <form className="mvp-inline-input" onSubmit={event => event.preventDefault()}>
        <input aria-label="Steer the retry" placeholder="Steer the retry (optional)" readOnly
          value={typedOr(frame, `retry:${todo.id}`, "")} data-mock={`retry-input-${todo.id}`} />
        <Button size="sm" variant="solid" data-mock={`retry-${todo.id}`}><RotateCw size={13} aria-hidden="true" />Retry</Button>
        {older ? <Button size="sm" variant="ghost" data-mock={`retry-current-flow-${todo.id}`}>Retry with the current flow</Button> : null}
      </form>
    </div>
  )
}

const Evidence = ({ todo }: { readonly todo: Todo }) => {
  const { state: { world }, me } = useFrame()
  const evidence = todo.evidence
  if (evidence === undefined) return null
  const prior = openItems(world)[openItems(world).indexOf(todo) - 1]
  const readiness = mergeReadiness(world, todo, me)
  return (
    <div className="mvp-evidence" data-mock={`evidence-${todo.id}`}>
      <div className="mvp-evidence-row">
        <span className="mvp-evidence-key">PR</span>
        <span className="mvp-pr-line"><a className="mvp-link" href="#" data-mock={`pr-${todo.id}`}>#{todo.pr} on GitHub<ExternalLink size={12} aria-hidden="true" /></a>
          <span className="mvp-meta">into main{prior === undefined ? "" : ` · includes ${refOf(world, prior)}`}</span>
          {evidence.rev === undefined ? null : <span className="mvp-mono mvp-muted">{evidence.rev}</span>}
          <span className="mvp-diffstat"><b className="mvp-add">+{evidence.added}</b> <b className="mvp-del">−{evidence.removed}</b> · {evidence.files} {evidence.files === 1 ? "file" : "files"}</span></span>
      </div>
      <div className="mvp-evidence-row">
        <span className="mvp-evidence-key">Checks</span>
        <span className="mvp-checks">
          {evidence.checks.map(check => (
            <span key={check.name} className="mvp-check" data-state={check.state}>
              {check.state === "passed" ? <Check size={13} aria-hidden="true" /> : check.state === "failed" ? <X size={13} aria-hidden="true" /> : <Loader size={13} aria-hidden="true" />}
              {check.name}{check.took === undefined ? null : <span className="mvp-took">{check.took}</span>}
            </span>
          ))}
          {evidence.github.failing === undefined ? (
            <span className="mvp-check" data-state={evidence.github.passed === evidence.github.total ? "passed" : "running"}>
              {evidence.github.passed === evidence.github.total ? <Check size={13} aria-hidden="true" /> : <Loader size={13} aria-hidden="true" />}
              GitHub {evidence.github.passed}/{evidence.github.total}
            </span>
          ) : (
            <a className="mvp-check mvp-check-link" data-state="failed" href="#"><X size={13} aria-hidden="true" />GitHub: {evidence.github.failing} failed<ExternalLink size={11} aria-hidden="true" /></a>
          )}
        </span>
      </div>
      <div className="mvp-evidence-row">
        <span className="mvp-evidence-key">Review</span>
        <span className="mvp-review-line">
          {evidence.reviewing === true
            ? <span className="mvp-check" data-state="running"><Loader size={13} aria-hidden="true" />Running on {evidence.rev}</span>
            : <span data-copy="data">{evidence.review}</span>}
          {evidence.reviewing === true && evidence.previous !== undefined
            ? <span className="mvp-previous"><span className="mvp-mono">{evidence.previous.rev}</span> <span data-copy="data">{evidence.previous.review}</span></span> : null}
        </span>
      </div>
      {todo.approvalCleared ? <div className="mvp-evidence-row"><span className="mvp-evidence-key" /><span className="mvp-warn-text">Approval cleared by rebase · checks rerun</span></div> : null}
      {todo.state === "in-review" ? (
        <div className="mvp-actions">
          <Button size="sm" variant="ghost" data-mock={`diff-${todo.id}`}>Diff</Button>
          <span className="mvp-actions-end">
            {/* One rule for every merge surface (world.ts mergeReadiness): the reason is text, never a disabled button. */}
            {readiness.state === "ready" ? <Button variant="solid" data-mock={`merge-${todo.id}`}>Merge</Button>
              : readiness.state === "done" ? null
              : <span className="mvp-merge-reason" data-state={readiness.state} data-mock={`merge-reason-${todo.id}`}>{readiness.reason}
                  {readiness.github === true ? <a className="mvp-link" href="#">on GitHub<ExternalLink size={11} aria-hidden="true" /></a> : null}</span>}
          </span>
        </div>
      ) : null}
    </div>
  )
}

const Amendments = ({ todo }: { readonly todo: Todo }) => {
  const { state: { world } } = useFrame()
  if (todo.amendments === undefined || todo.amendments.length === 0) return null
  return (
    <details className="mvp-amendments">
      <summary><History size={13} aria-hidden="true" />{todo.amendments.length} amendment{todo.amendments.length === 1 ? "" : "s"}</summary>
      <ol>{todo.amendments.map((each, index) => <li key={index}><Avatar world={world} who={each.by} size={16} /><span data-copy="data">{each.text}</span></li>)}</ol>
    </details>
  )
}

export const TodoCard = ({ id, target }: { readonly id: string; readonly target: string }) => {
  const { state: { world, seq } } = useFrame()
  const todo = todoOf(world, target)
  const flow = todo.steps ?? world.flow
  const branch = world.branches.find(each => each.id === todo.branch)
  const place = placeOf(world, todo)
  const settled = todo.state === "merged" || todo.state === "dropped"
  const live = todo.state === "working" || todo.state === "starting" || todo.state === "needs-you"
  /* The TODO's latest attempt: its flags ride on this card, and Inspect opens its monitor (one card per thing). */
  const run = world.traces.filter(each => each.todo === todo.id).sort((a, b) => b.attempt - a.attempt)[0]
  return (
    <Card id={id} kind="todo" title={<><Ref world={world} todo={todo} /> {todo.title}</>} status={<StatePill todo={todo} flow={flow} />}
      end={<Avatar world={world} who={todo.owner} />}>
      <div className="mvp-meta">
        {branch === undefined || todo.state === "queued" || settled ? null : <span className="mvp-where"><BranchChip branch={branch} onOpen={() => {}} />
          <AvatarStack world={world} who={branch.presence.map(each => each.who)} /></span>}
        {branch?.machine === "waiting" && todo.state === "working" ? <span className="mvp-waiting">Waiting for a machine · #{branch.waitPosition ?? 1}</span> : null}
        {place === "" ? null : <span>{place}</span>}
        {(todo.attempts ?? 1) > 1 ? <button type="button" className="mvp-count-chip">Attempt {todo.attempts}</button> : null}
        {todo.issue === undefined ? null : <span>{todo.state === "merged" ? "closed" : "from"} #{todo.issue}</span>}
        <span>{actorName(world, todo.owner)}</span>
      </div>
      {todo.state === "queued" || todo.state === "starting" || todo.state === "dropped" ? (
        <p className="mvp-prompt">{todo.prompt}</p>
      ) : settled ? null : (
        <div className="mvp-section"><StepStrip flow={flow} todo={todo} seq={seq} /></div>
      )}
      {run === undefined || settled ? null : <RunFlags trace={run} />}
      <Amendments todo={todo} />
      <Question todo={todo} />
      {todo.state === "failed" ? <Failure todo={todo} /> : null}
      <Evidence todo={todo} />
      {todo.state === "merged" ? (
        <div className="mvp-actions">
          <span className="mvp-receipt"><Check size={14} aria-hidden="true" />Merged into main{todo.mergedVia !== undefined
            ? ` · in ${refOf(world, todoOf(world, todo.mergedVia))}'s commit` : todo.pr === undefined ? "" : ` · #${todo.pr}`}</span>
          {todo.mergedVia !== undefined ? null : todo.lessons === undefined ? <span className="mvp-meta"><Loader size={13} className="mvp-run-icon" aria-hidden="true" />Learning</span> : (
            <button type="button" className="mvp-count-chip mvp-lessons" data-mock={`lessons-${todo.id}`}>
              <BookOpen size={13} aria-hidden="true" />{todo.lessons} {todo.lessons === 1 ? "lesson" : "lessons"}
            </button>
          )}
          {run === undefined ? null : <span className="mvp-actions-end"><Button size="sm" variant="ghost" data-mock={`inspect-todo-${todo.id}`}>Inspect</Button></span>}
        </div>
      ) : null}
      {live || todo.state === "paused" ? (
        <div className="mvp-actions">
          <Button size="sm" variant="ghost" data-mock={`branch-${todo.id}`}>Open branch</Button>
          <Button size="sm" variant="ghost" data-mock={`inspect-todo-${todo.id}`}>Inspect</Button>
          <span className="mvp-actions-end">
            {todo.state === "paused" ? <Button size="sm" variant="outline" data-mock={`resume-${todo.id}`}>Resume</Button>
              : <Button size="sm" variant="ghost">Stop</Button>}
            <Button size="sm" variant="ghost">Drop</Button>
          </span>
        </div>
      ) : null}
    </Card>
  )
}
