/*
 * The repository home: the one stack, read as the team's work (mvp.md §6.4).
 * main is pinned at the top and items descend in merge order, so the next to
 * merge sits directly under main. Counts filter the same list. Each row
 * carries at most one action (Answer, Resolve, Merge, Review, Retry, Resume)
 * plus a ⋯ menu for order. Background runs sit below the stack.
 */
import { Button } from "@smthrs/ui"
import { ArrowDown, ArrowUp, BookOpen, Check, CircleDashed, GitBranch, Loader, MoreHorizontal, Plus, RotateCw, Trash2, X } from "lucide-react"
import { actorName, Avatar, AvatarStack, BranchChip, Card, Ref, StateGlyph, StatePill } from "../parts"
import { useFrame } from "../frame"
import { canMerge, mergeReadiness, refOf, STACK, waitingOn, type BackgroundRun, type Todo, type TodoState, type World } from "../world"

const FILTERS: ReadonlyArray<{ state: TodoState; word: string }> = [
  { state: "needs-you", word: "Needs you" },
  { state: "working", word: "Working" },
  { state: "queued", word: "Queued" },
  { state: "in-review", word: "In review" }
]

/** A private confirmation is the asker's, but the wait is everyone's to see: "Needs Ben", like GitHub's "review requested". */
export const NeedsPerson = ({ world, todo }: { readonly world: World; readonly todo: Todo }) => {
  const who = waitingOn(world, todo.id)
  return who === undefined ? null : <span className="mvp-needs-person" data-mock={`needs-person-${todo.id}`}><Avatar world={world} who={who} size={16} />Needs {actorName(world, who)}</span>
}

/** A Needs you item's one action follows from why it needs a person. */
export const needsAction = (todo: Todo): string =>
  todo.needs === "moved_off" ? "Return"
  : todo.needs === "conflict" || todo.failure === "conflict" ? "Resolve"
  : todo.needs === "foreign_push" || todo.needs === "force_push" ? "Review"
  : todo.needs === "order" ? "Move" : "Answer"

/** The one action a row offers, by state; Merge only when the shared readiness rule says so. */
const rowAction = (world: World, todo: Todo, me: string): { label: string; solid?: boolean } | null => {
  switch (todo.state) {
    case "needs-you": return { label: needsAction(todo) }
    case "in-review": return mergeReadiness(world, todo).state === "ready" && canMerge(world, me) ? { label: "Merge", solid: true } : { label: "Review" }
    case "failed": return { label: "Retry" }
    case "paused": return { label: "Resume" }
    default: return null
  }
}

/** Fresh sync reads quiet; past twice the one-minute target it turns gold with Retry. */
const syncLabel = (seconds: number): { text: string; stale: boolean } => {
  const stale = seconds > 120
  const text = seconds < 60 ? `synced ${seconds} s ago` : `synced ${Math.round(seconds / 60)} min ago`
  return { text, stale }
}

const RowMenu = ({ todo, first, last }: { readonly todo: Todo; readonly first: boolean; readonly last: boolean }) => (
  <div className="mvp-menu" role="menu" aria-label={`${todo.title} order`} data-mock={`menu-${todo.id}`}>
    <button type="button" role="menuitem" disabled={first} data-mock={`move-up-${todo.id}`}><ArrowUp size={14} aria-hidden="true" />Move up<kbd className="mvp-kbd">⌥↑</kbd></button>
    <button type="button" role="menuitem" disabled={last} data-mock={`move-down-${todo.id}`}><ArrowDown size={14} aria-hidden="true" />Move down<kbd className="mvp-kbd">⌥↓</kbd></button>
    <button type="button" role="menuitem" className="mvp-menu-danger" data-mock={`drop-${todo.id}`}><Trash2 size={14} aria-hidden="true" />Drop</button>
  </div>
)

const Row = ({ world, todo, next, prior, first, last, menu }: {
  readonly world: World
  readonly todo: Todo
  readonly next: boolean
  readonly prior?: Todo
  readonly first: boolean
  readonly last: boolean
  readonly menu: boolean
}) => {
  const { state: { seq }, me } = useFrame()
  const branch = world.branches.find(each => each.id === todo.branch)
  const present = branch?.presence.map(each => each.who) ?? []
  const action = rowAction(world, todo, me)
  const amendments = todo.amendments?.length ?? 0
  const settled = todo.state === "merged" || todo.state === "dropped"
  return (
    <li className="mvp-stack-row" data-state={todo.state} data-mock={`row-${todo.id}`} data-fresh={todo.seq === seq || undefined}>
      <span className="mvp-stack-node"><StateGlyph state={todo.state} /></span>
      <div className="mvp-stack-main">
        <div className="mvp-stack-title">
          <Ref world={world} todo={todo} />
          <button type="button" className="mvp-link" data-mock={`open-${todo.id}`}>{todo.title}</button>
          {amendments > 0 ? <button type="button" className="mvp-count-chip" title="Amendments">+{amendments}</button> : null}
        </div>
        <div className="mvp-meta">
          <StatePill todo={todo} flow={todo.steps ?? world.flow} />
          <NeedsPerson world={world} todo={todo} />
          {branch?.machine === "waiting" && todo.state === "working" ? <span className="mvp-waiting">Waiting for a machine · #{branch.waitPosition ?? 1}</span> : null}
          {branch === undefined || todo.state === "queued" || settled ? null
            : <span className="mvp-where"><BranchChip branch={branch} onOpen={() => {}} /><AvatarStack world={world} who={present} /></span>}
          {todo.pr === undefined ? null : <span className="mvp-pr">#{todo.pr}</span>}
          {todo.state === "in-review" && !next && prior !== undefined ? <span>Merges after {refOf(world, prior)}</span> : null}
          {branch?.rebasePending === undefined ? null : <span className="mvp-warn-text">Rebase pending</span>}
          {todo.approvalCleared ? <span className="mvp-warn-text">approval cleared by rebase</span> : null}
          {todo.lessons === undefined ? null : <span className="mvp-count-chip"><BookOpen size={12} aria-hidden="true" />{todo.lessons} {todo.lessons === 1 ? "lesson" : "lessons"}</span>}
          {todo.elapsed === undefined || settled ? null : <span className="mvp-elapsed">{todo.elapsed}</span>}
        </div>
      </div>
      <span className="mvp-row-end">
        {action === null ? null : (
          <Button size="sm" variant={action.solid ? "solid" : "outline"} data-mock={`${action.label.toLowerCase()}-${todo.id}`}>{action.label}</Button>
        )}
        {settled ? null : <button type="button" className="mvp-icon-btn" aria-label={`Order ${todo.title}`} aria-expanded={menu}
          aria-haspopup="menu" data-mock={`more-${todo.id}`}><MoreHorizontal size={16} aria-hidden="true" /></button>}
        {menu ? <RowMenu todo={todo} first={first} last={last} /> : null}
      </span>
    </li>
  )
}

/** One slot per machine: who holds each, or empty. A running background run (learning) holds one too (M-06). */
const Machines = ({ world }: { readonly world: World }) => {
  const awake = world.branches.filter(each => each.machine === "awake" || each.machine === "waking")
  const runs = world.runs.filter(each => each.state === "running" && each.queue === undefined)
  const used = awake.length + runs.length
  const slots = Array.from({ length: world.capacity }, (_, index) => index)
  return (
    <div className="mvp-machines" aria-label={`${used} of ${world.capacity} machines in use`}>
      {slots.map(index => {
        const branch = awake[index]
        const run = branch === undefined ? runs[index - awake.length] : undefined
        return (
          <span key={branch?.id ?? run?.id ?? `empty-${index}`} className="mvp-machine" data-used={branch !== undefined || run !== undefined || undefined}
            title={branch?.name ?? run?.title ?? "Free"}>
            {run !== undefined ? <Avatar world={world} who={STACK} size={16} live />
              : branch === undefined ? null : branch.item === undefined
              ? <Avatar world={world} who={branch.presence.find(each => !each.who.startsWith("agent"))?.who ?? "agent"} size={16} />
              : <Avatar world={world} who={`agent:${branch.id}`} size={16} live={branch.machine === "awake"} />}
          </span>
        )
      })}
      <span className="mvp-machines-label">{used}/{world.capacity} machines</span>

    </div>
  )
}

const RunRow = ({ run }: { readonly run: BackgroundRun }) => {
  const { state: { seq } } = useFrame()
  return (
    <li className="mvp-run-row" data-state={run.state} data-fresh={run.seq === seq || undefined}>
      {run.queue !== undefined ? <CircleDashed size={14} className="mvp-run-icon" aria-hidden="true" />
        : run.state === "running" ? <Loader size={14} className="mvp-run-icon" aria-hidden="true" />
        : run.state === "done" ? <Check size={14} className="mvp-run-icon" aria-hidden="true" />
        : <X size={14} className="mvp-run-icon" aria-hidden="true" />}
      <button type="button" className="mvp-link" data-mock={`run-${run.id}`}>{run.title}</button>
      {run.queue !== undefined ? <span className="mvp-meta">Queued · #{run.queue}</span> : run.detail === undefined ? null : <span className="mvp-meta">{run.detail}</span>}
      {run.state === "failed" ? <span className="mvp-row-end">
        <Button size="sm" variant="outline"><RotateCw size={13} aria-hidden="true" />Retry</Button>
        <Button size="sm" variant="ghost">Dismiss</Button>
      </span> : null}
    </li>
  )
}

export const HomeCard = ({ id, view }: { readonly id: string; readonly view?: string }) => {
  const { state: { world, seq } } = useFrame()
  const all = world.stack.map(each => world.todos.find(todo => todo.id === each)!)
  /* The rail reads top-down as what reaches main next: merged work joins main's row, dropped work leaves. */
  const items = all.filter(todo => todo.state !== "merged" && todo.state !== "dropped")
  const merged = all.filter(todo => todo.state === "merged").length
  const counts = new Map(FILTERS.map(({ state }) => [state, items.filter(todo => todo.state === state || (state === "working" && todo.state === "starting")).length]))
  const open = items.filter(todo => todo.state !== "merged" && todo.state !== "dropped")
  const nextId = open[0]?.id
  const sync = syncLabel(world.syncedAgo)
  const health = world.mainHealth
  const filter = view?.startsWith("filter:") ? view.slice(7) as TodoState : undefined
  const shows = (todo: Todo) => filter === undefined || todo.state === filter || (filter === "working" && todo.state === "starting")
  return (
    <Card id={id} kind="home" title={world.repo}>
      <div className="mvp-filters" role="toolbar" aria-label="Filter by state">
        {FILTERS.map(({ state, word }) => (
          <button key={state} type="button" className="mvp-filter" data-state={state} disabled={counts.get(state) === 0}
            aria-pressed={filter === state} data-mock={`filter-${state}`}>
            <StateGlyph state={state} /><span>{word}</span><b>{counts.get(state)}</b>
          </button>
        ))}
      </div>
      <ol className="mvp-stack" aria-label="Stack">
        <li className="mvp-stack-main-row">
          <span className="mvp-stack-node"><GitBranch size={14} aria-hidden="true" /></span>
          <span className="mvp-stack-trunk">main
            {world.mergedSinceLook + merged > 0 ? <button type="button" className="mvp-merged-since" data-mock="merged-since">{world.mergedSinceLook + merged} merged since you looked</button> : null}
            {world.mainHead === undefined ? null : <span className="mvp-main-head" data-fresh={world.mainHead.seq === seq || undefined}>{world.mainHead.text}</span>}
          </span>
          {health === undefined ? (
            <span className="mvp-sync" data-stale={sync.stale || undefined}>
              {sync.text}{sync.stale ? <button type="button" className="mvp-inline-link">Retry</button> : null}
            </span>
          ) : (
            <span className="mvp-sync" data-stale data-health={health.state}>
              {health.cause}{health.retryAt === undefined ? null : ` · retries at ${health.retryAt}`}
              {health.state === "refused" ? <button type="button" className="mvp-inline-link">Fix</button> : null}
            </span>
          )}
        </li>
        {items.filter(shows).map(todo => (
          <Row key={todo.id} world={world} todo={todo} next={todo.id === nextId} prior={open[open.indexOf(todo) - 1]}
            first={open.indexOf(todo) === 0} last={open.indexOf(todo) === open.length - 1} menu={view === `menu:${todo.id}`} />
        ))}
      </ol>
      {world.runs.every(each => each.state === "done") ? null : (
        <ul className="mvp-runs" aria-label="Background runs">
          {world.runs.filter(each => each.state !== "done").map(each => <RunRow key={each.id} run={each} />)}
        </ul>
      )}
      <div className="mvp-actions">
        <Machines world={world} />
        <span className="mvp-actions-end">
          <Button size="sm" variant="ghost" data-mock="new-todo"><Plus size={14} aria-hidden="true" />New TODO</Button>
        </span>
      </div>
    </Card>
  )
}
