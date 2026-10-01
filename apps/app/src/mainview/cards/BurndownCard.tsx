/*
 * The issue-sweep burndown board: the body of an `issue-sweep` run card.
 *
 * Summary first (the run's status with its controls, the count of every
 * state, one meter band for capacity, the machine and the accounts), then the
 * board grouped by state, the open issue's detail directly under its row. The
 * card's own title names the flow and the repository, and its status pill
 * stands down for this body (ChatCards.tsx), so each is said once.
 * Every value is read from the run journal (Burndown.ts); the state filter
 * and the open issue live on the card payload and change through
 * `runs.burndown.filter` / `runs.burndown.select`, so a reload keeps them.
 * The keyboard highlight, an open confirmation, a group shown past its
 * embedded cap and the last reading's moves are local chrome.
 *
 * Keyboard: the count strip and the board are one tab stop each. Arrows rove
 * inside (Up/Down through every row and "more" control, Left/Right to the
 * neighbouring group, Home/End to the ends); Enter or Space opens a row's
 * detail, Tab walks into it, and Escape closes it and puts focus back on the
 * row. A confirmation takes focus on its safe choice and gives it back to the
 * control that asked.
 *
 * A run that is starting, or whose journal is unread, draws the same layout
 * as placeholders, so nothing jumps when the journal arrives. The watch's own
 * state (reconnecting, quiet, stopped) sits beside the run's status and never
 * replaces it. A control that does not apply is absent.
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { Box, Circle, CircleArrowDown, CircleArrowUp, CircleCheck, CircleDashed, CircleDot, CirclePause, CircleSlash, CircleX, Cloud, Laptop, type LucideIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle, Button, DiffHunks, EmptyState, parseUnifiedFile, Progress, RelativeTime, Skeleton, Spinner, StatusPill } from "@smthrs/ui"
import { runSourceCommand } from "@smthrs/ui/run-command"
import { flowArgs } from "../flows/FlowArgs"
import { flowAction, flowProps } from "../flows/FlowAction"
import { rovingKeyDown } from "../RovingKeyDown"
import type { Card } from "../state/AppState"
import {
  BURNDOWN_STATES, burndownAgent, burndownControls, burndownMoves, burndownObserver, burndownOf, burndownStage, PLACEMENT_WORDS,
  type BurndownItem, type BurndownState, type BurndownView
} from "./Burndown"
import type { RunCommand } from "./CardFamily"
import { durationWords } from "./RunTrace"
import { RUN_PHASE_WORDS } from "./RunTraceSummary"

type RunTraceCard = Extract<Card, { kind: "run-trace" }>

/** The operator signal a sweep parked on exhausted accounts waits for (flows/issue-sweep/flow.ts `accountsReset`). */
export const ACCOUNTS_RESET = "issue-sweep/accounts-reset"

export const STATE_WORDS: Readonly<Record<BurndownState, string>> = {
  skip: "Skip", ours: "Ours", claimed: "Claimed", working: "Working", adopting: "Adopting",
  landing: "Landing", landed: "Landed", held: "Held", failed: "Failed"
}

/* The app's run words (RUN_PHASE_WORDS) without their sentence stop, as a pill says them; only a park, which no other run has, has its own. */
const runWord = (phase: string, fallback: string) => (RUN_PHASE_WORDS[phase] ?? fallback).replace(/\.$/, "")
const STATUS: Readonly<Record<BurndownView["status"], { readonly status: string; readonly label: string }>> = {
  running: { status: "running", label: runWord("running", "Running") },
  parked: { status: "waiting", label: "Parked" },
  cancelled: { status: "cancelled", label: runWord("cancelled", "Cancelled") },
  completed: { status: "completed", label: runWord("completed", "Finished") },
  failed: { status: "failed", label: runWord("failed", "Failed") }
}

/*
 * The strip's emphasis: the states with work moving are the loud ones, the
 * finished ones next, the rest quiet. A zero is quiet whatever its state.
 */
const WEIGHT: Readonly<Record<BurndownState, "live" | "done" | "quiet">> = {
  skip: "quiet", ours: "quiet", claimed: "quiet", working: "live", adopting: "live",
  landing: "live", landed: "done", held: "quiet", failed: "done"
}

/* Each state has its own mark, so a row, a count and a group say the state without the hue; its tone comes from the element it sits in. */
const MARKS: Readonly<Record<BurndownState, LucideIcon>> = {
  skip: CircleSlash, ours: Circle, claimed: CircleDashed, working: CircleDot, adopting: CircleArrowDown,
  landing: CircleArrowUp, landed: CircleCheck, held: CirclePause, failed: CircleX
}

const StateMark = ({ state }: { readonly state: BurndownState }) => {
  const Mark = MARKS[state]
  return <Mark className="burndown-mark" aria-hidden focusable={false} />
}

/* Where an issue is worked, as a mark and the flow's word: a column of rows reads Cloud from VM without a hue. */
const PLACES: Readonly<Record<NonNullable<BurndownItem["placement"]>, LucideIcon>> = { local: Laptop, vm: Box, cloud: Cloud }

const Placement = ({ placement }: { readonly placement: NonNullable<BurndownItem["placement"]> }) => {
  const Mark = PLACES[placement]
  return (
    <span className="burndown-place" data-placement={placement}>
      <Mark className="burndown-place-mark" aria-hidden focusable={false} />{PLACEMENT_WORDS[placement]}
    </span>
  )
}

/* A row says where and who from claimed onward: a queued issue's last attempt does not say where its next one runs. */
const rowPlacement = (item: BurndownItem) => item.state === "ours" || item.state === "skip" ? undefined : item.placement
const rowAgent = (item: BurndownItem) => item.state === "ours" || item.state === "skip" ? undefined : burndownAgent(item)

/**
 * What a new reading of the run changed, said once: the run's status when it
 * changed, then each issue that moved (past three, the count per state).
 */
export const burndownAnnouncement = (previous: BurndownView, next: BurndownView): string => {
  const moves = burndownMoves(previous, next)
  const moved = moves.length <= 3
    ? moves.map((move) => `#${move.number} ${STATE_WORDS[move.to].toLowerCase()}`)
    : BURNDOWN_STATES.flatMap((state) => {
      const count = moves.filter((move) => move.to === state).length
      return count === 0 ? [] : [`${count} ${STATE_WORDS[state].toLowerCase()}`]
    })
  return [...(previous.status === next.status ? [] : [STATUS[next.status].label]), ...moved].join(", ")
}

/** Rows a group shows in the embedded card before its "more" control; maximized shows every row. */
export const GROUP_CAP = 5

const views = new WeakMap<RunTraceCard["payload"], BurndownView>()
/** The board a payload projects; a payload never changes, so its projection is computed once. */
export const burndownOfCard = (card: RunTraceCard): BurndownView => {
  const held = views.get(card.payload)
  if (held !== undefined) return held
  const view = burndownOf(card.payload.events ?? [], { phase: card.payload.phase, error: card.payload.error, input: card.payload.input })
  views.set(card.payload, view)
  return view
}

const elapsed = (item: BurndownItem, now: number): string | undefined =>
  item.startedAt === undefined ? undefined : durationWords(Math.max((item.finishedAt ?? now) - item.startedAt, 0))

const DiffStatText = ({ item }: { readonly item: BurndownItem }) => item.diff === undefined ? null : (
  <span className="burndown-diff" aria-label={`${item.diff.files} files, ${item.diff.insertions} added, ${item.diff.deletions} removed`}>
    <span data-sign="add">+{item.diff.insertions}</span> <span data-sign="del">−{item.diff.deletions}</span>
  </span>
)

/** The sweep's own input, for a restart that reattaches to the same attempt's children. */
const restartArgs = (card: RunTraceCard, view: BurndownView): string => {
  const input = view.input ?? {}
  return flowArgs("issue-sweep", {
    ...(typeof input.maxAgents === "number" ? { maxAgents: input.maxAgents } : {}),
    ...(input.placement === "local" || input.placement === "vm" ? { placement: input.placement } : {}),
    ...(typeof input.attempt === "number" ? { attempt: input.attempt } : {}),
    ...(typeof input.landers === "number" ? { landers: input.landers } : {}),
    ...(typeof input.cloudAgents === "number" ? { cloudAgents: input.cloudAgents } : {}),
    repo: card.payload.repo
  })
}

/*
 * One consequential act, asked once more in place: the safe choice takes focus
 * once, when the question opens (a later reading of the run never moves it),
 * and Escape backs out. @smthrs/ui's Confirmation is a modal; this is inline.
 */
const Confirm = ({ id, title, act, onKeep, run }: {
  readonly id: string
  readonly title: string
  readonly act: string
  readonly onKeep: () => void
  readonly run: { readonly "data-flow": string; readonly "data-flow-args": string | undefined; readonly onClick: () => void }
}) => (
  <div className="burndown-confirm" role="alertdialog" aria-labelledby={id} data-testid="burndown-confirm"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onKeep() } }}>
    <span className="burndown-confirm-title" id={id}>{title}</span>
    <Button type="button" variant="destructive" size="sm" {...run}>{act}</Button>
    <Button type="button" variant="ghost" size="sm" autoFocus onClick={onKeep}>Not yet</Button>
  </div>
)

/** The last reading this body drew, what moved since the one before it, and the words for that. */
interface Seen {
  readonly view: BurndownView
  readonly moved: ReadonlySet<number>
  readonly ticked: ReadonlySet<BurndownState>
  readonly said: string
}

/** One issue's detail, the disclosure its row controls: drawn directly under the row, so the two are read together. */
const Detail = ({ item, id, now }: { readonly item: BurndownItem; readonly id: string; readonly now: number }) => (
  <section className="burndown-detail" id={id} aria-label={`Issue #${item.number}`} data-testid="burndown-detail" data-state={item.state}>
    <h5 className="burndown-detail-head">
      <span className="burndown-row-number">#{item.number}</span> {item.title ?? ""}
    </h5>
    <dl className="run-trace-kv burndown-kv">
      {item.placement === undefined ? null : <><dt>Placement</dt><dd><Placement placement={item.placement} /></dd></>}
      {burndownAgent(item) === undefined ? null : <><dt>Agent</dt><dd><code>{burndownAgent(item)}</code></dd></>}
      {elapsed(item, now) === undefined ? null : <><dt>Elapsed</dt><dd className="burndown-meter-value">{elapsed(item, now)}</dd></>}
      {item.diff === undefined ? null : <><dt>Changes</dt><dd><DiffStatText item={item} /> <span className="burndown-meter-value">{item.diff.files} files</span></dd></>}
      {item.commit === undefined ? null : <><dt>Commit</dt><dd><code>{item.commit}</code></dd></>}
      {item.pr === undefined ? null : <><dt>Pull request</dt><dd><a href={item.pr} target="_blank" rel="noreferrer">{item.pr.replace(/^https:\/\/github\.com\//, "")}</a></dd></>}
    </dl>
    {/* The reason in full: it wraps, nothing is cut, and it can be selected and copied. */}
    {item.reason === undefined ? null : <pre className="run-trace-code burndown-reason" tabIndex={0} aria-label="Reason" data-testid="burndown-reason">{item.reason}</pre>}
    {item.patch === undefined ? null : item.patch.split(/^(?=diff --git )/m).filter((part) => part.trim() !== "").map((part, index) => (
      <DiffHunks key={index} file={parseUnifiedFile(part)} />
    ))}
  </section>
)

/** The board's layout as placeholders: a group of {@link GROUP_CAP} rows at the height real rows take. */
const BoardSkeleton = () => (
  <div className="burndown-board" data-skeleton="true" aria-hidden data-testid="burndown-board-skeleton">
    <section className="burndown-group">
      <h5 className="burndown-group-head"><Skeleton className="burndown-skeleton" data-part="head" /></h5>
      <ul className="burndown-rows">
        {Array.from({ length: GROUP_CAP }, (_, index) => (
          <li key={index}>
            <div className="burndown-row" data-skeleton="true">
              <Skeleton className="burndown-skeleton burndown-mark" data-part="mark" />
              <Skeleton className="burndown-skeleton" data-part="number" />
              <Skeleton className="burndown-skeleton" data-part="title" />
              <span className="burndown-row-meta"><Skeleton className="burndown-skeleton" data-part="meta" /></span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  </div>
)

export const BurndownBody = ({ card, onRunCommand: send, now = Date.now(), presentation = "embedded", notices }: {
  readonly card: RunTraceCard
  readonly onRunCommand: RunCommand
  /** The render's clock, for elapsed times. */
  readonly now?: number
  /** Embedded caps each group at {@link GROUP_CAP} rows; maximized shows them all. */
  readonly presentation?: "embedded" | "maximized" | undefined
  /** The run card's own failure notices (WorkflowCards.tsx), drawn under the header where the status is read. */
  readonly notices?: ReactNode
}) => {
  const view = burndownOfCard(card)
  const onRunCommand = runSourceCommand(card.id, send)
  const { runId } = card.payload
  const filter = card.payload.burndown?.filter
  const open = card.payload.burndown?.item
  const [asking, setAsking] = useState<"stop" | "resume" | undefined>(undefined)
  const [stopSent, setStopSent] = useState(false)
  const [stripFocus, setStripFocus] = useState<number>(() => Math.max(BURNDOWN_STATES.indexOf(filter ?? "skip"), 0))
  const [stopFocus, setStopFocus] = useState<string | undefined>(undefined)
  const [uncapped, setUncapped] = useState<ReadonlySet<BurndownState>>(new Set())
  const [seen, setSeen] = useState<Seen>({ view, moved: new Set(), ticked: new Set(), said: "" })
  const opener = useRef<HTMLButtonElement | null>(null)
  const board = useRef<HTMLDivElement | null>(null)

  // A new reading: what it moved is drawn and said once, until the next reading replaces it.
  if (seen.view !== view) {
    setSeen({
      view,
      moved: new Set(burndownMoves(seen.view, view).map((move) => move.number)),
      ticked: new Set(BURNDOWN_STATES.filter((state) => seen.view.counts[state] !== view.counts[state])),
      said: burndownAnnouncement(seen.view, view)
    })
  }

  const stage = burndownStage(card.payload)
  const observer = burndownObserver(card.payload.phase)
  const controls = burndownControls(view, stage, observer)
  const live = view.status === "running" || view.status === "parked"
  const exhausted = view.parked.kind === "exhausted" && live ? view.parked : undefined
  const until = view.parked.kind === "wait-until" && view.status === "parked" ? view.parked.at : undefined
  const restart = controls.resume === "restart" ? restartArgs(card, view) : undefined
  const signalArgs = flowArgs("runs.signal", { runId, name: ACCOUNTS_RESET })
  // The reset signal this card sent: waiting on the workspace, refused, or accepted while the same park still stands.
  const signal = card.payload.signalRequest?.name === ACCOUNTS_RESET ? card.payload.signalRequest : undefined
  const resuming = exhausted !== undefined && signal !== undefined &&
    (signal.state === "pending" || (signal.state === "sent" && exhausted.since <= signal.afterSeq))
  const refused = exhausted !== undefined && signal?.state === "failed" ? signal.error ?? "" : undefined
  const stopping = controls.stop && (view.stopping || stopSent)
  const vmRow = view.input?.placement === "vm"
  const vmMax = view.machine.maxAgents ?? view.capacity.slots
  // An observation that is no longer fresh says so in place of the health it can no longer vouch for.
  const health = view.machine.freshness === "stale" ? <StatusPill status="stale" label="Stale" />
    : view.machine.health === undefined ? undefined : (
      <StatusPill status={view.machine.health === "healthy" ? "ok" : view.machine.health === "stalled" ? "waiting" : view.machine.health}
        label={view.machine.health === "healthy" ? "Healthy" : view.machine.health === "stalled" ? "Stalled" : view.machine.health} />
    )
  const shown = filter === undefined ? view.items : view.items.filter((item) => item.state === filter)
  // A filtered board is the one group asked for; the open issue's group never hides it.
  const capped = presentation !== "maximized" && filter === undefined
  const groups = BURNDOWN_STATES.flatMap((state) => {
    const all = shown.filter((item) => item.state === state)
    if (all.length === 0) return []
    const hidesOpen = all.slice(GROUP_CAP).some((item) => item.number === open)
    const whole = !capped || uncapped.has(state) || all.length <= GROUP_CAP + 1 || hidesOpen
    // The "more" control: a capped group longer than its cap, unless the open issue already keeps it whole.
    const more = capped && all.length > GROUP_CAP + 1 && !hidesOpen
    // A meta line is reserved only where some row has one to show, so rows in a group match and a group with none stays one line a row.
    const meta = all.some((item) => rowPlacement(item) !== undefined || rowAgent(item) !== undefined || item.startedAt !== undefined || item.diff !== undefined)
    return [{ state, all, more, meta, items: whole ? all : all.slice(0, GROUP_CAP) }]
  })
  // The board's keyboard stops, in reading order: each group's rows, then its "more" control.
  const stopsOf = (group: (typeof groups)[number]) => [...group.items.map((item) => `${item.number}`), ...(group.more ? [`more:${group.state}`] : [])]
  const stops = groups.flatMap(stopsOf)
  const focused = stops.find((stop) => stop === stopFocus) ?? stops.find((stop) => stop === `${open}`) ?? stops[0]
  const flat = groups.flatMap((group) => group.items)
  const detailId = `${card.id}-burndown-detail`
  // The journal is read and the run is going, but no round has listed the issues yet: the board is unknown, not empty.
  // A run parked before its first listing, or one nobody is watching, has nothing on the way, so it draws no placeholder.
  const discovering = stage === "ready" && view.status === "running" && observer === "connected" && !view.discovered && view.items.length === 0
  // A confirmation closes either way and hands focus back to the control that opened it.
  const keep = () => {
    setAsking(undefined)
    opener.current?.focus()
  }

  const onStripKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = event.key === "ArrowRight" ? "ArrowDown" : event.key === "ArrowLeft" ? "ArrowUp" : event.key
    const move = rovingKeyDown(key, { count: BURNDOWN_STATES.length, current: stripFocus, ends: true })
    if (move.kind !== "move") return
    event.preventDefault()
    setStripFocus(move.index)
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[move.index]?.focus()
  }

  const focusStop = (stop: string) => {
    setStopFocus(stop)
    board.current?.querySelector<HTMLElement>(`[data-stop="${stop}"]`)?.focus()
  }

  const onBoardKey = (event: KeyboardEvent<HTMLDivElement>) => {
    // Escape anywhere in the board closes the open detail and returns to its row.
    if (event.key === "Escape" && open !== undefined) {
      event.preventDefault()
      onRunCommand("runs.burndown.select", flowArgs("runs.burndown.select", { runId, item: open }))
      focusStop(`${open}`)
      return
    }
    // Arrows belong to the stops; inside a detail they scroll and select as usual.
    if (!(event.target instanceof HTMLElement) || event.target.dataset.stop === undefined) return
    const index = Math.max(stops.indexOf(focused ?? ""), 0)
    let target: string | undefined
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const group = groups.findIndex((each) => stopsOf(each).includes(focused ?? ""))
      const next = groups[group + (event.key === "ArrowRight" ? 1 : -1)]
      target = next === undefined ? undefined : stopsOf(next)[0]
    } else {
      const move = rovingKeyDown(event.key, { count: stops.length, current: index, ends: true, loop: false })
      if (move.kind === "move") target = stops[move.index]
    }
    if (target === undefined) return
    event.preventDefault()
    focusStop(target)
  }

  return (
    <section className="burndown" aria-label="Issue burndown" data-testid={`burndown-${runId}`} data-status={view.status}
      data-stage={stage} data-observer={observer} data-presentation={presentation} aria-busy={stage !== "ready" || discovering}>
      <header className="burndown-head">
        <div className="burndown-identity">
          {stage === "launching"
            ? <StatusPill status="launching" label={RUN_PHASE_WORDS.launching} data-testid="burndown-status" />
            : <StatusPill status={STATUS[view.status].status} label={STATUS[view.status].label} data-testid="burndown-status" />}
          {until === undefined ? null : (
            <span className="burndown-until" data-testid="burndown-until">until <RelativeTime ts={until} relativeUntilMs={Number.NEGATIVE_INFINITY} /></span>
          )}
          {observer === "connected" || stage === "launching" ? null
            : <StatusPill status={observer} label={RUN_PHASE_WORDS[observer]} data-testid="burndown-observer" />}
        </div>
        {controls.stop || controls.resume !== undefined || controls.retry ? (
          <div className="burndown-controls">
            {controls.retry ? (
              <button type="button" className="run-trace-filter" data-testid="burndown-retry"
                {...flowProps("flow.run.retry", card.id)} onClick={() => { setStopSent(false); onRunCommand("flow.run.retry", card.id) }}>
                Check again
              </button>
            ) : null}
            {controls.stop ? (
              <button type="button" className="run-trace-filter" data-testid="burndown-stop" aria-expanded={stopping ? undefined : asking === "stop"}
                aria-busy={stopping} aria-disabled={stopping} data-busy={stopping ? "true" : undefined}
                {...flowProps("flow.run.stop", card.id)}
                onClick={(event) => { if (stopping) return; opener.current = event.currentTarget; setAsking("stop") }}>
                {stopping ? <Spinner size="sm" role="presentation" aria-hidden /> : null}Stop for now
              </button>
            ) : null}
            {controls.resume !== undefined ? (
              <button type="button" className="run-trace-filter" data-testid="burndown-resume" aria-expanded={resuming ? undefined : asking === "resume"}
                aria-busy={resuming} aria-disabled={resuming} data-busy={resuming ? "true" : undefined}
                {...(controls.resume === "signal" ? flowProps("runs.signal", signalArgs) : flowProps("issue-sweep", restart))}
                onClick={(event) => { if (resuming) return; opener.current = event.currentTarget; setAsking("resume") }}>
                {resuming ? <Spinner size="sm" role="presentation" aria-hidden /> : null}Resume
              </button>
            ) : null}
          </div>
        ) : null}
      </header>
      {asking === "stop" && controls.stop && !stopping ? (
        <Confirm id={`${card.id}-burndown-confirm`} title="Stop for now?" act="Stop for now" onKeep={keep}
          run={{ ...flowAction(onRunCommand, "flow.run.stop", card.id), onClick: () => { keep(); setStopSent(true); onRunCommand("flow.run.stop", card.id) } }} />
      ) : null}
      {asking === "resume" && controls.resume !== undefined && !resuming ? (
        <Confirm title={controls.resume === "signal" ? "Accounts reset?" : "Resume the sweep?"} id={`${card.id}-burndown-confirm`} act="Resume" onKeep={keep}
          run={controls.resume === "signal"
            ? { ...flowAction(onRunCommand, "runs.signal", signalArgs), onClick: () => { keep(); onRunCommand("runs.signal", signalArgs) } }
            : { ...flowAction(onRunCommand, "issue-sweep", restart), onClick: () => { keep(); onRunCommand("issue-sweep", restart) } }} />
      ) : null}
      {refused === undefined ? null : (
        <Alert variant="destructive" className="burndown-refused" data-testid="burndown-refused">
          <AlertDescription>{refused}</AlertDescription>
        </Alert>
      )}
      {notices}
      {exhausted !== undefined ? (
        <Alert variant="warning" className="burndown-reset" data-testid="burndown-reset">
          <AlertTitle>Reset accounts</AlertTitle>
          <ul className="burndown-reset-list">
            {exhausted.accounts.map((account) => (
              <li key={account.label}><code>{account.label}</code> <span>{account.state}</span></li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {stage === "ready" ? (
        <div className="burndown-strip" role="toolbar" aria-label="States" onKeyDown={onStripKey} data-testid="burndown-strip">
          {BURNDOWN_STATES.map((state, index) => (
            <button key={state} type="button" className="burndown-count" data-state={state} aria-pressed={filter === state}
              data-weight={view.counts[state] === 0 ? "zero" : WEIGHT[state]}
              tabIndex={index === stripFocus ? 0 : -1} onFocus={() => setStripFocus(index)} aria-label={`${view.counts[state]} ${STATE_WORDS[state]}`}
              {...flowAction(onRunCommand, "runs.burndown.filter", flowArgs("runs.burndown.filter", { runId, filter: state }))}>
              <StateMark state={state} />
              {/* Keyed by its value: a count that changed is a new element, so its tick plays once. */}
              <span key={view.counts[state]} className="burndown-count-n" data-ticked={seen.ticked.has(state) ? "true" : undefined}>{view.counts[state]}</span>
              <span className="burndown-count-word">{STATE_WORDS[state]}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="burndown-strip" aria-hidden data-testid="burndown-strip-skeleton">
          {BURNDOWN_STATES.map((state) => (
            <span key={state} className="burndown-count" data-state={state} data-weight="zero">
              <StateMark state={state} />
              <Skeleton className="burndown-skeleton" data-part="count" />
              <span className="burndown-count-word">{STATE_WORDS[state]}</span>
            </span>
          ))}
        </div>
      )}

      {stage === "ready" ? (
        <div className="burndown-meters">
          {view.capacity.slots === undefined ? null : (
            <div className="burndown-meter" data-testid="burndown-capacity">
              <span className="burndown-meter-label" id={`${card.id}-slots`}>Slots</span>
              <Progress value={view.capacity.active} max={view.capacity.slots} aria-labelledby={`${card.id}-slots`}
                aria-valuetext={`${view.capacity.active} of ${view.capacity.slots}`} className="burndown-progress" />
              <span className="burndown-meter-value">{view.capacity.active}/{view.capacity.slots}</span>
              {vmRow ? null : <span className="burndown-meter-status" data-testid="burndown-machine">{health}</span>}
            </div>
          )}
          {vmRow ? (
            <div className="burndown-meter" data-testid="burndown-machine">
              <span className="burndown-meter-label" id={`${card.id}-vms`}>VMs</span>
              {vmMax === undefined ? <span className="burndown-progress" /> : (
                <Progress value={view.machine.vms} max={vmMax} aria-labelledby={`${card.id}-vms`}
                  aria-valuetext={`${view.machine.vms} of ${vmMax}`} className="burndown-progress" />
              )}
              <span className="burndown-meter-value">{view.machine.vms}/{vmMax ?? "–"}</span>
              <span className="burndown-meter-status">{health}</span>
            </div>
          ) : view.capacity.slots === undefined && health !== undefined ? (
            <div className="burndown-meter" data-testid="burndown-machine"><span className="burndown-meter-status">{health}</span></div>
          ) : null}
          {view.machine.cloud === undefined ? null : (
            <div className="burndown-meter" data-testid="burndown-cloud">
              <span className="burndown-meter-label" id={`${card.id}-cloud`}>Cloud</span>
              <Progress value={view.machine.cloud.active} max={view.machine.cloud.agents} aria-labelledby={`${card.id}-cloud`}
                aria-valuetext={`${view.machine.cloud.active} of ${view.machine.cloud.agents}`} className="burndown-progress" />
              <span className="burndown-meter-value">{view.machine.cloud.active}/{view.machine.cloud.agents}</span>
            </div>
          )}
          {view.accounts.length === 0 ? null : (
            <ul className="burndown-accounts" aria-label="Accounts" data-testid="burndown-accounts">
              {view.accounts.map((account) => (
                <li key={account.label} className="burndown-account" data-reset={account.needsReset ? "true" : undefined}
                  title={`${account.items} issues · ${account.active} active · ${account.landed} landed · ${account.failed} failed`}>
                  <span className="burndown-account-mark" aria-hidden />
                  <code className="burndown-account-label">{account.label}</code>
                  <span className="burndown-meter-value burndown-account-n" aria-hidden>{account.items}</span>
                  {/* A list item's own name is not read out reliably; the breakdown is text for the reader, the title for the pointer. */}
                  <span className="ghc-visually-hidden">{`: ${account.items} issues, ${account.active} active, ${account.landed} landed, ${account.failed} failed${account.needsReset ? ", needs a reset" : ""}`}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="burndown-meters" aria-hidden data-testid="burndown-meters-skeleton">
          <div className="burndown-meter">
            <span className="burndown-meter-label">Slots</span>
            <Skeleton className="burndown-progress burndown-skeleton" data-part="bar" />
            <Skeleton className="burndown-skeleton" data-part="value" />
          </div>
        </div>
      )}

      {stage !== "ready" || discovering ? <BoardSkeleton />
        : view.items.length === 0 && !view.discovered ? null
        : flat.length === 0 ? <EmptyState className="burndown-empty" title="No issues" data-testid="burndown-empty" /> : (
          <div className="burndown-board" role="group" aria-label="Issues" ref={board} onKeyDown={onBoardKey} data-testid="burndown-board">
            {groups.map((group) => (
              <section key={group.state} className="burndown-group" data-state={group.state} aria-label={STATE_WORDS[group.state]}>
                <h5 className="burndown-group-head"><StateMark state={group.state} />{STATE_WORDS[group.state]} <span className="burndown-meter-value">{group.all.length}</span></h5>
                <ul className="burndown-rows">
                  {group.items.map((item) => (
                    <li key={item.number} className="burndown-item">
                      <button type="button" className="burndown-row" data-issue={item.number} data-state={item.state} data-stop={item.number}
                        data-moved={seen.moved.has(item.number) ? "true" : undefined}
                        tabIndex={`${item.number}` === focused ? 0 : -1} onFocus={() => setStopFocus(`${item.number}`)}
                        aria-expanded={item.number === open} aria-controls={item.number === open ? detailId : undefined}
                        aria-label={[`#${item.number}${item.title === undefined ? "" : ` ${item.title}`}`, STATE_WORDS[item.state],
                          ...[rowPlacement(item)].flatMap((placement) => placement === undefined ? [] : [PLACEMENT_WORDS[placement]]),
                          ...[rowAgent(item)].flatMap((agent) => agent === undefined ? [] : [agent])].join(", ")}
                        title={item.title}
                        {...flowAction(onRunCommand, "runs.burndown.select", flowArgs("runs.burndown.select", { runId, item: item.number }))}>
                        <StateMark state={item.state} />
                        <span className="burndown-row-number">#{item.number}</span>
                        <span className="burndown-row-title">{item.title ?? ""}</span>
                        {group.meta ? (
                          <span className="burndown-row-meta">
                            {[rowPlacement(item)].map((placement) => placement === undefined ? null : <Placement key="place" placement={placement} />)}
                            {rowAgent(item) === undefined ? null : <code className="burndown-row-agent">{rowAgent(item)}</code>}
                            {elapsed(item, now) === undefined ? null : <span className="burndown-row-elapsed">{elapsed(item, now)}</span>}
                            <DiffStatText item={item} />
                          </span>
                        ) : null}
                      </button>
                      {item.number === open ? <Detail item={item} id={detailId} now={now} /> : null}
                    </li>
                  ))}
                </ul>
                {group.more ? (
                  <button type="button" className="burndown-more" data-testid={`burndown-more-${group.state}`} data-stop={`more:${group.state}`}
                    aria-expanded={group.items.length === group.all.length}
                    tabIndex={`more:${group.state}` === focused ? 0 : -1} onFocus={() => setStopFocus(`more:${group.state}`)}
                    onClick={() => setUncapped((held) => {
                      const next = new Set(held)
                      if (next.has(group.state)) next.delete(group.state)
                      else next.add(group.state)
                      return next
                    })}>
                    {group.items.length === group.all.length ? "Fewer" : `${group.all.length - group.items.length} more`}
                  </button>
                ) : null}
              </section>
            ))}
          </div>
        )}

      <span className="ghc-visually-hidden" role="status" data-testid="burndown-announce">{seen.said}</span>
    </section>
  )
}
