/*
 * A run, inside (Will, 2026-10-02). One TODO attempt is one durable run
 * (mvp.md B.4): Plan to Propose, then a wait for merge that a rebase loops
 * back to Verify. Embedded, the card draws the attempt as a graph in the step
 * strip's language, names the phase it is in and shows any indicator
 * (thrashing, waiting). Inspect maximizes the same card: every attempt's graph
 * on top; below, the run's own timeline on the left, its phases grouped under
 * their step and titled by a cheap model from what the agent was doing, every
 * cell with a plain explanation; the selected cell's detail (code, output,
 * time, tokens) on the right. Steer and Stop stay in reach.
 */
import { Button } from "@smthrs/ui"
import { BookOpen, Bot, Check, FilePen, Layers, MessageCircleQuestion, Maximize2, Repeat, Send, SquareTerminal, Undo2, X } from "lucide-react"
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react"
import { Avatar, Card, actorName } from "../parts"
import { typedOr, useFrame } from "../frame"
import type { Cell, FlowStep, Phase, Trace } from "../world"
import type { ExtraCardProps } from "./extra"

const CELL_ICON: Record<Cell["kind"], ReactNode> = {
  context: <Layers size={13} aria-hidden="true" />,
  read: <BookOpen size={13} aria-hidden="true" />,
  edit: <FilePen size={13} aria-hidden="true" />,
  run: <SquareTerminal size={13} aria-hidden="true" />,
  think: <Bot size={13} aria-hidden="true" />,
  ask: <MessageCircleQuestion size={13} aria-hidden="true" />,
  steer: <Send size={13} aria-hidden="true" />,
  subagent: <Bot size={13} aria-hidden="true" />,
  rebase: <Undo2 size={13} aria-hidden="true" />
}

const STATE_WORD: Record<Trace["state"], string> = {
  running: "Working",
  waiting: "Waiting for a person",
  held: "Waiting for merge",
  merged: "Merged",
  failed: "Failed"
}

/** Seconds as the run shows them: "40 s", "4 min". */
const duration = (seconds: number): string => seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`

const Indicator = ({ phase }: { readonly phase: Phase }) => phase.indicator === undefined ? null : (
  <span className="mvp-indicator" data-tone={phase.tone}>{phase.tone === "thrash" ? <Repeat size={12} aria-hidden="true" /> : null}{phase.indicator}</span>
)

/** What needs a look in the step the run is in (thrashing, a wait for a person): one line each, on the run's embedded card or its TODO's card. */
export const RunFlags = ({ trace }: { readonly trace: Trace }) => {
  const step = trace.phases.at(-1)?.step
  return <>{trace.phases.filter(phase => phase.step === step && phase.indicator !== undefined && (phase.tone === "thrash" || phase.tone === "wait"))
    .map(phase => <div key={phase.id} className="mvp-run-flag"><Indicator phase={phase} /></div>)}</>
}

/* ── The attempt graph ───────────────────────────────────── */

/** A node's look, in the step strip's terms (parts.tsx StepStrip, mock.css .mvp-steps). */
type Node = "done" | "current" | "waiting" | "failed" | "next" | "held"

const NODE_WORD: Record<Node, string> = { done: "done", current: "working", waiting: "waiting for a person", failed: "failed", next: "not reached", held: "waiting for merge" }

/** A step the run reached is done, unless the run is still in it: its latest phase is that step's. */
const nodeOf = (trace: Trace, step: string): Node => {
  if (!trace.phases.some(phase => phase.step === step)) return "next"
  if (trace.phases.at(-1)?.step !== step) return "done"
  return trace.state === "running" ? "current" : trace.state === "waiting" ? "waiting" : trace.state === "failed" ? "failed" : "done"
}

/** One node column in Inspect: earlier attempts and the rebase loop line up with the current graph. */
const NODE_W = 104

/** From the wait for merge back into Verify, under the graph. A rebase that just arrived draws it once, teal. */
const RebaseLoop = ({ from, to, fresh }: { readonly from: number; readonly to: number; readonly fresh: boolean }) => {
  const start = (from + 0.5) * NODE_W
  const end = (to + 0.5) * NODE_W
  return (
    <svg className="mvp-loop" data-fresh={fresh || undefined} width={(from + 1) * NODE_W} height={30} role="img" aria-label="A rebase goes back to Verify">
      <path className="mvp-loop-line" pathLength={1} d={`M${start} 2V12Q${start} 20 ${start - 8} 20H${end + 8}Q${end} 20 ${end} 12V3`} />
      <path className="mvp-loop-head" d={`M${end - 4} 7L${end} 2L${end + 4} 7`} />
      <text x={(start + end) / 2} y={20} dy="0.35em" textAnchor="middle">rebase</text>
    </svg>
  )
}

/*
 * One attempt as a graph: compact in the embedded card; full in Inspect, with
 * each step's time, the wait's "since" and the rebase loop; earlier attempts
 * dimmed above it, up to the node where they stopped and why.
 */
const Attempt = ({ trace, flow, size, label = false, selected, dim = false }: {
  readonly trace: Trace
  readonly flow: ReadonlyArray<FlowStep>
  readonly size: "compact" | "full" | "earlier"
  readonly label?: boolean
  /** The selected cell in Inspect: its step's node is marked. */
  readonly selected?: string
  readonly dim?: boolean
}) => {
  const { state: { seq } } = useFrame()
  const inspect = size !== "compact"
  const steps = size === "earlier" ? flow.filter(step => nodeOf(trace, step.id) !== "next") : flow
  const stopped = trace.state === "failed" ? trace.phases.at(-1) : undefined
  const selectedStep = trace.phases.find(phase => phase.cells.some(cell => cell.id === selected))?.step
  const wait: Node = trace.state === "held" ? "held" : trace.state === "merged" ? "done" : "next"
  const node = (id: string, title: string, state: Node, took: string | undefined, thrashed: boolean) => (
    <button type="button" className="mvp-node" data-selected={(inspect && id === selectedStep) || undefined}
      data-mock={inspect ? `node-${trace.attempt}-${id}` : undefined}
      aria-label={[title, NODE_WORD[state], took, thrashed ? "thrashed" : undefined].filter(Boolean).join(", ")}>
      <span className="mvp-step-mark" aria-hidden="true">
        {state === "done" ? <Check size={size === "full" ? 12 : 10} strokeWidth={3} /> : state === "failed" ? <X size={size === "full" ? 12 : 10} strokeWidth={3} /> : null}
      </span>
      {size === "earlier" ? null : <span className="mvp-node-name"><span className="mvp-step-name">{title}</span>{thrashed ? <Repeat size={11} className="mvp-node-thrash" aria-hidden="true" /> : null}</span>}
      {took === undefined ? null : <span className="mvp-node-took">{took}</span>}
    </button>
  )
  const graph = (
    <ol className="mvp-steps mvp-attempt" data-size={size} aria-label={`Attempt ${trace.attempt}`} style={{ "--node-w": `${NODE_W}px` } as CSSProperties}>
      {steps.map(step => {
        const state = nodeOf(trace, step.id)
        const phases = trace.phases.filter(phase => phase.step === step.id)
        const took = size === "full" && phases.some(phase => phase.took !== undefined) ? duration(phases.reduce((sum, phase) => sum + (phase.took ?? 0), 0)) : undefined
        return (
          <li key={step.id} data-phase={state} aria-current={state === "current" || state === "waiting" ? "step" : undefined}>
            {node(step.id, step.title, state, took, phases.some(phase => phase.tone === "thrash"))}
            {size === "earlier" && stopped?.step === step.id ? <span className="mvp-attempt-reason">{stopped.indicator}</span> : null}
          </li>
        )
      })}
      {size === "earlier" ? null : (
        <li data-phase={wait} data-wait aria-current={wait === "held" ? "step" : undefined}>
          {node("merge", "Merge", wait, size === "full" && trace.held !== undefined ? `since ${trace.held.since}` : undefined, false)}
        </li>
      )}
    </ol>
  )
  if (size === "compact") return graph
  const loop = flow.findIndex(step => step.id === "verify")
  return (
    <div className="mvp-attempt-row" data-size={size} data-dim={dim || undefined} data-mock={`attempt-${trace.attempt}`}>
      {label ? <span className="mvp-attempt-label">Attempt {trace.attempt}</span> : null}
      <div>
        {graph}
        {size === "full" && loop >= 0
          ? <RebaseLoop from={flow.length} to={loop} fresh={trace.phases.some(phase => phase.cells.some(cell => cell.kind === "rebase" && cell.seq === seq))} />
          : null}
      </div>
    </div>
  )
}

/* ── The card ────────────────────────────────────────────── */

export const RunCard = ({ id, target, view }: ExtraCardProps) => {
  const frame = useFrame()
  const timeline = useRef<HTMLElement>(null)
  const attempts = useRef<HTMLDivElement>(null)
  const followed = useRef<string | undefined>(undefined)
  /*
   * The timeline follows the selected cell, as the conversation follows its
   * newest entry, scrolling only itself, so a narrow screen keeps the graph in
   * view. It measures layout offsets, not screen boxes: the card may still be
   * growing in, and it follows again once the fonts settle the line wraps.
   */
  useLayoutEffect(() => {
    const list = timeline.current
    const cell = list?.querySelector<HTMLElement>("[aria-current]") ?? null
    if (list === null || cell === null || cell.dataset.mock === followed.current) return
    const first = followed.current === undefined
    followed.current = cell.dataset.mock
    const follow = (behavior: ScrollBehavior) => {
      /* 32 px clears the sticky step header. */
      const top = cell.offsetTop - 32
      const bottom = cell.offsetTop + cell.offsetHeight + 8 - list.clientHeight
      const to = Math.min(Math.max(list.scrollTop, bottom), top)
      if (to !== list.scrollTop) list.scrollTo({ top: to, behavior })
    }
    follow(first ? "auto" : "smooth")
    if (first) void document.fonts.ready.then(() => follow("auto"))
  })
  /* Wider than the card, the graph scrolls sideways to keep the node the run is at in view. */
  useLayoutEffect(() => {
    const strip = attempts.current
    const here = strip?.querySelector<HTMLElement>(".mvp-attempt-row:last-child li[aria-current]") ?? null
    if (strip === null || here === null) return
    const over = here.offsetLeft + here.offsetWidth + 16 - strip.clientWidth
    if (over > strip.scrollLeft) strip.scrollLeft = over
  })
  const { world, seq } = frame.state
  const trace = world.traces.find(each => each.id === target)
  if (trace === undefined) return null
  const flow = world.todos.find(each => each.id === trace.todo)?.steps ?? world.flow
  const stepTitle = (step: string): string => flow.find(each => each.id === step)?.title ?? step
  const status = (
    <span className="mvp-run-state" data-state={trace.state}>
      {trace.state === "running" ? <span className="mvp-dot" data-state="working" aria-hidden="true" /> : trace.state === "held" ? <span className="mvp-run-held" aria-hidden="true" /> : null}
      {STATE_WORD[trace.state]}
    </span>
  )
  if (view !== "max") {
    /* What needs a look now: the newest live or flagged phase, and the indicators of the step the run is in. */
    const now = trace.state === "held" || trace.state === "merged" ? undefined : trace.phases.filter(phase => phase.tone !== undefined && phase.tone !== "ok").at(-1)
    return (
      <Card id={id} kind="run" title={trace.title} status={status}>
        <div className="mvp-section"><Attempt trace={trace} flow={flow} size="compact" /></div>
        {now === undefined ? null : <p className="mvp-run-now">{now.title}</p>}
        <RunFlags trace={trace} />
        <div className="mvp-actions"><span className="mvp-actions-end">
          <Button size="sm" variant="outline" data-mock={`inspect-${trace.id}`}><Maximize2 size={13} aria-hidden="true" />Inspect</Button>
        </span></div>
      </Card>
    )
  }
  const all = trace.todo === undefined ? [trace] : world.traces.filter(each => each.todo === trace.todo).sort((a, b) => a.attempt - b.attempt)
  const earlier = all.filter(each => each.attempt < trace.attempt)
  const selectedId = frame.state.viewers[frame.me]?.selected ?? trace.phases.at(-1)?.cells.at(-1)?.id
  /* The timeline is the selected cell's attempt: a node of an earlier attempt opens that attempt's record. */
  const shown = all.find(each => each.phases.some(phase => phase.cells.some(cell => cell.id === selectedId))) ?? trace
  const selected = shown.phases.flatMap(phase => phase.cells).find(cell => cell.id === selectedId)
  const selectedPhase = shown.phases.find(phase => phase.cells.some(cell => cell.id === selectedId))
  /* A finished phase collapses to its title and summary; flagged, live and selected phases stay open. */
  const open = (phase: Phase) => phase.tone === "thrash" || phase.tone === "wait" || phase.tone === "live" || phase.tone === "fail" || phase.cells.some(cell => cell.id === selectedId)
  /* Phases sit under their step in run order; a step the run comes back to (a rebase) starts a new group. */
  const groups: Array<{ readonly step: string; readonly phases: Array<Phase> }> = []
  for (const phase of shown.phases) {
    const last = groups.at(-1)
    if (last?.step === phase.step) last.phases.push(phase)
    else groups.push({ step: phase.step, phases: [phase] })
  }
  return (
    <Card id={id} kind="run" title={trace.title} status={status}>
      <div className="mvp-run-attempts" ref={attempts}>
        {earlier.map(each => <Attempt key={each.id} trace={each} flow={flow} size="earlier" label selected={selectedId} dim={each !== shown} />)}
        <Attempt trace={trace} flow={flow} size="full" label={earlier.length > 0} selected={selectedId} />
      </div>
      <div className="mvp-run-max">
        <nav className="mvp-run-timeline" aria-label="Run timeline" ref={timeline}>
          <ol>
            {groups.map((group, index) => (
              <li key={index} className="mvp-run-step">
                <div className="mvp-run-step-head">{stepTitle(group.step)}</div>
                <ol className="mvp-run-phases">
                  {group.phases.map(phase => (
                    <li key={phase.id} className="mvp-run-phase" data-tone={phase.tone}>
                      <div className="mvp-run-phase-head">
                        <span className="mvp-run-phase-n">{shown.phases.indexOf(phase) + 1}</span>
                        <span className="mvp-run-phase-title"><b>{phase.title}</b><span>{phase.summary}</span></span>
                        {phase.took === undefined ? null : <span className="mvp-took">{duration(phase.took)}</span>}
                      </div>
                      <Indicator phase={phase} />
                      {open(phase) ? null : <button type="button" className="mvp-run-collapsed" data-mock={`phase-${phase.id}`}>{phase.cells.length} {phase.cells.length === 1 ? "step" : "steps"}</button>}
                      {!open(phase) ? null : <ol className="mvp-run-cells">
                        {phase.cells.map(cell => (
                          <li key={cell.id}>
                            <button type="button" className="mvp-run-cell" aria-current={cell.id === selectedId || undefined} data-tone={cell.tone}
                              data-fresh={cell.seq === seq || undefined} data-mock={`cell-${cell.id}`}>
                              <span className="mvp-run-cell-icon">{cell.who === undefined ? CELL_ICON[cell.kind] : <Avatar world={world} who={cell.who} size={16} />}</span>
                              <span className="mvp-run-cell-text">{cell.explain}</span>
                              {cell.tone === "fail" ? <X size={12} className="mvp-tl-failed" aria-hidden="true" /> : null}
                            </button>
                          </li>
                        ))}
                      </ol>}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        </nav>
        <section className="mvp-run-detail" aria-label="Selected cell">
          {selected === undefined ? null : (
            <>
              <div className="mvp-run-detail-head">
                <span className="mvp-run-cell-icon">{CELL_ICON[selected.kind]}</span>
                <span className="mvp-run-detail-phase">{selectedPhase === undefined ? null : `${stepTitle(selectedPhase.step)} · ${selectedPhase.title}`}</span>
                {selected.who === undefined ? null : <span className="mvp-meta"><Avatar world={world} who={selected.who} size={16} />{actorName(world, selected.who)}</span>}
                <span className="mvp-actions-end mvp-took">{[selected.took, selected.tokens].filter(Boolean).join(" · ")}</span>
              </div>
              <p className="mvp-run-explain">{selected.explain}</p>
              {selected.quote === undefined ? null : <blockquote className="mvp-run-quote" data-copy="data">{selected.quote}</blockquote>}
              {selected.kind === "subagent" ? <div><Button size="sm" variant="outline" data-mock={`inspect-sub-${selected.id}`}><Maximize2 size={13} aria-hidden="true" />Inspect this subagent</Button></div> : null}
              {selected.code === undefined ? null : <pre className="mvp-code mvp-run-code">{selected.code}</pre>}
              {selected.output === undefined ? null : (
                <div className="mvp-term mvp-run-output">{selected.output.map((line, index) => (
                  <div key={index} className="mvp-term-line" data-tone={line.startsWith("✗") || line.includes("FAIL") ? "fail" : line.startsWith("✓") || line.includes("PASS") ? "ok" : undefined}>{line}</div>
                ))}</div>
              )}
            </>
          )}
        </section>
      </div>
      {trace.state === "merged" || trace.state === "failed" ? null : (
        <form className="mvp-inline-input mvp-steer" onSubmit={event => event.preventDefault()}>
          <input aria-label="Steer the coding agent" placeholder="Steer the coding agent" readOnly value={typedOr(frame, `steer:${trace.branch}`, "")} data-mock={`run-steer-${trace.id}`} />
          <Button size="sm" variant="outline" data-mock={`run-steer-send-${trace.id}`}>Steer</Button>
          {trace.state === "held" ? null : <Button size="sm" variant="ghost">Stop</Button>}
        </form>
      )}
    </Card>
  )
}
