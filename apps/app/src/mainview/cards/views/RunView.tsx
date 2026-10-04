/*
 * The Run card (T-FLW-07): one attempt as a graph in the step strip's
 * language. Embedded: the graph, the phase the run is in, its flags and the
 * presses it was given. Maximized it is the monitor: every attempt's graph
 * (earlier ones dimmed), the run's timeline under step headers on the left,
 * the selected cell's or step's detail on the right, the journal tab when the
 * container loaded one, the trailing wait for merge and the rebase loop back
 * to Verify. Props only; the container binds the actions and renders them in
 * the order it gives them.
 */
import { useState, type CSSProperties, type ReactNode } from "react"
import { BookOpen, Bot, Check, FilePen, Layers, Maximize2, MessageCircleQuestion, Repeat, ScanSearch, Send, Sparkles, SquareTerminal, Undo2, X } from "lucide-react"
import type { Action } from "@smthrs/rpc/CardAction"
import type { RunViewProps } from "@smthrs/rpc/MonitorCard"
import { ActorChip } from "./ActorChip"

type Model = RunViewProps["model"]
type Attempt = Model["attempts"][number]
type Phase = Attempt["phases"][number]
type Cell = Phase["cells"][number]
type View = RunViewProps["view"]

const CELL_ICON: Record<Cell["kind"], ReactNode> = {
  context: <Layers size={13} aria-hidden="true" />, read: <BookOpen size={13} aria-hidden="true" />,
  edit: <FilePen size={13} aria-hidden="true" />, run: <SquareTerminal size={13} aria-hidden="true" />,
  think: <Bot size={13} aria-hidden="true" />, ask: <MessageCircleQuestion size={13} aria-hidden="true" />,
  answer: <MessageCircleQuestion size={13} aria-hidden="true" />, steer: <Send size={13} aria-hidden="true" />,
  reviewer: <ScanSearch size={13} aria-hidden="true" />, rebase: <Undo2 size={13} aria-hidden="true" />
}

const STATE_WORD: Record<Model["state"], string> = {
  running: "Working", waiting: "Waiting for a person", held: "Waiting for merge", failed: "Failed", done: "Merged", interrupted: "Interrupted"
}

const NODE_WORD: Record<Attempt["graph"][number]["state"], string> = {
  done: "done", current: "working", waiting: "waiting for a person", failed: "failed", next: "not reached", held: "waiting for merge"
}

/** One node column in the monitor: earlier attempts and the rebase loop line up with the current graph. */
const NODE_W = 104

const duration = (seconds: number): string => seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`
const tokenLabel = (count: number): string => `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
const finished = (state: Model["state"]): boolean => state === "done" || state === "failed" || state === "interrupted"

/** A phase names its step instance ("verify#2" after a rebase); the graph names the step. */
const stepIdOf = (attempt: Attempt, key: string): string => attempt.steps.find(step => step.key === key)?.id ?? key.replace(/#\d+$/, "")
const stepLabel = (attempt: Attempt, key: string): string => {
  const id = stepIdOf(attempt, key)
  return attempt.graph.find(node => node.id === id)?.label ?? attempt.steps.find(step => step.key === key)?.label ?? id
}
const phasesOfStep = (attempt: Attempt, id: string): ReadonlyArray<Phase> => attempt.phases.filter(phase => stepIdOf(attempt, phase.step) === id)

const costOf = (phases: ReadonlyArray<Phase>): { readonly took?: string; readonly tokens?: string } => {
  const used = phases.flatMap(phase => phase.cells).reduce((sum, cell) => sum + (cell.tokens ?? 0), 0)
  const time = phases.reduce((sum, phase) => sum + phase.took_s, 0)
  return { ...(time === 0 ? {} : { took: duration(time) }), ...(used === 0 ? {} : { tokens: tokenLabel(used) }) }
}

/** What the fast model wrote carries a sparkle; a person's words and plain facts do not. */
const Written = () => <Sparkles size={11} className="mvp-written" aria-hidden="true" />
const Explain = ({ cell }: { readonly cell: Cell }) => <>{cell.actor === undefined && cell.explain !== undefined ? <Written /> : null}{cell.explain ?? cell.label}</>

const Indicator = ({ phase, past, step }: { readonly phase: Phase; readonly past: boolean; readonly step: string }) => {
  if (phase.indicator === undefined) return null
  const was = past && phase.tone !== "fail"
  const text = !was ? phase.indicator
    : phase.tone === "thrash" ? `Thrashed at ${step} · ${phase.cells.filter(cell => cell.kind === "run").length} runs`
    : phase.tone === "wait" ? "Waited for a person" : phase.indicator
  return <span className="mvp-indicator" data-tone={was ? "past" : phase.tone}>{phase.tone === "thrash" ? <Repeat size={12} aria-hidden="true" /> : null}{text}</span>
}

const RebaseLoop = ({ from, to }: { readonly from: number; readonly to: number }) => {
  const start = (from + 0.5) * NODE_W
  const end = (to + 0.5) * NODE_W
  return <svg className="mvp-loop" width={(from + 1) * NODE_W} height={30} role="img" aria-label="A rebase goes back to Verify">
    <path d={`M${start} 2V12Q${start} 20 ${start - 8} 20H${end + 8}Q${end} 20 ${end} 12V3`} />
    <path d={`M${end - 4} 7L${end} 2L${end + 4} 7`} />
    <text x={(start + end) / 2} y={20} dy="0.35em" textAnchor="middle">rebase</text>
  </svg>
}

/*
 * One attempt as a graph: compact in the embedded card; full in the monitor
 * with each step's time and tokens and the rebase loop; earlier attempts
 * dimmed above it, up to the node where they stopped and why. A node press
 * selects that step of that attempt.
 */
function AttemptGraph({ attempt, size, selected, onView, label, dim }: {
  readonly attempt: Attempt
  readonly size: "compact" | "full" | "earlier"
  readonly selected?: string | undefined
  readonly onView?: RunViewProps["onView"]
  readonly label?: boolean
  readonly dim?: boolean
}) {
  const nodes = size === "earlier" ? attempt.graph.filter(node => node.state !== "next" && node.id !== "merge") : attempt.graph
  const stopped = attempt.state === "interrupted" || attempt.state === "failed" ? attempt.phases.at(-1) : undefined
  const graph = <ol className="mvp-attempt" data-size={size} data-past={finished(attempt.state) || undefined} aria-label={`Attempt ${attempt.n}`}
    style={{ "--node-w": `${NODE_W}px` } as CSSProperties}>
    {nodes.map(node => {
      const phases = phasesOfStep(attempt, node.id)
      const cost = size !== "full" ? {} : costOf(phases)
      const thrashed = phases.some(phase => phase.tone === "thrash")
      const body = <>
        <span className="mvp-attempt-mark" aria-hidden="true">
          {node.state === "done" ? <Check size={size === "full" ? 12 : 10} strokeWidth={3} /> : node.state === "failed" ? <X size={size === "full" ? 12 : 10} strokeWidth={3} /> : null}
        </span>
        {size === "earlier" ? null : <span className="mvp-node-name"><span>{node.label}</span>{thrashed ? <Repeat size={11} className="mvp-node-thrash" aria-hidden="true" /> : null}</span>}
        {cost.took === undefined ? null : <span className="mvp-node-took">{cost.took}</span>}
        {cost.tokens === undefined ? null : <span className="mvp-node-took">{cost.tokens} tokens</span>}
      </>
      const name = [node.label, NODE_WORD[node.state], cost.took, cost.tokens === undefined ? undefined : `${cost.tokens} tokens`, thrashed ? "thrashed" : undefined].filter(Boolean).join(", ")
      return <li key={node.id} data-phase={node.state} data-wait={node.id === "merge" || undefined}
        aria-current={node.state === "current" || node.state === "waiting" || node.state === "held" ? "step" : undefined}>
        {onView === undefined || node.id === "merge"
          ? <span className="mvp-node" role="img" aria-label={name}>{body}</span>
          : <button type="button" className="mvp-node" aria-label={name} data-node={`${attempt.run_id}:${node.id}`} data-selected={node.id === selected || undefined}
            onClick={() => onView({ selected: `step:${attempt.run_id}:${node.id}` })}>{body}</button>}
        {size === "earlier" && stopped?.step !== undefined && stepIdOf(attempt, stopped.step) === node.id && stopped.indicator !== undefined
          ? <span className="mvp-attempt-reason">{stopped.indicator}</span> : null}
      </li>
    })}
  </ol>
  if (size === "compact") return graph
  const loop = attempt.graph.findIndex(node => node.id === "verify")
  const merge = attempt.graph.findIndex(node => node.id === "merge")
  return <div className="mvp-attempt-row" data-size={size} data-dim={dim || undefined}>
    {label === true ? <span className="mvp-attempt-label">Attempt {attempt.n}</span> : null}
    <div>{graph}{size === "full" && loop >= 0 && merge > loop ? <RebaseLoop from={merge} to={loop} /> : null}</div>
  </div>
}

/** A text box and its one press: the press sends the action's own args plus what was typed. */
function InlineAction({ action, onAction }: { readonly action: Action; readonly onAction: RunViewProps["onAction"] }) {
  const [text, setText] = useState("")
  const field = action.input?.[0]
  const name = field?.name ?? "text"
  const label = field?.label ?? action.label
  const value = text.trim()
  return <form className="mvp-inline-input" data-flow={action.tag} onSubmit={event => { event.preventDefault(); onAction(action.tag, { ...action.args, ...(value ? { [name]: value } : {}) }) }}>
    <input aria-label={label} placeholder={label} value={text} disabled={action.disabled !== undefined} onChange={event => setText(event.target.value)} />
    <button type="button" className="mvp-run-button" data-flow={action.tag} data-primary={action.primary || undefined} disabled={action.disabled !== undefined}
      title={action.disabled?.reason} onClick={() => onAction(action.tag, { ...action.args, ...(value ? { [name]: value } : {}) })}>{action.label}</button>
  </form>
}

function ActionButton({ action, onAction, children }: { readonly action: Action; readonly onAction: RunViewProps["onAction"]; readonly children?: ReactNode }) {
  return <button type="button" className="mvp-run-button" data-flow={action.tag} data-primary={action.primary || undefined}
    disabled={action.disabled !== undefined} title={action.disabled?.reason} onClick={() => onAction(action.tag, { ...action.args })}>{children}{action.label}</button>
}

/** The presses, in the order the container gave them: a press with an input is a text box. */
function Footer({ actions, onAction }: { readonly actions: ReadonlyArray<Action>; readonly onAction: RunViewProps["onAction"] }) {
  if (actions.length === 0) return null
  return <div className="mvp-run-foot">
    {actions.map(action => action.input !== undefined && action.input.length > 0
      ? <InlineAction key={`${action.tag} ${action.label}`} action={action} onAction={onAction} />
      : <ActionButton key={`${action.tag} ${action.label}`} action={action} onAction={onAction}>{action.tag === "run.inspect" ? <Maximize2 size={13} aria-hidden="true" /> : null}</ActionButton>)}
    {actions.some(action => action.disabled !== undefined) ? <span className="mvp-run-disabled">{actions.flatMap(action => action.disabled === undefined ? [] : [action.disabled.reason]).join(" · ")}</span> : null}
  </div>
}

/** The journal the container loaded for `view.tab === "journal"`, and the scrubber when the run is being replayed. */
function JournalPane({ model, view, onView }: { readonly model: Model; readonly view: View; readonly onView: RunViewProps["onView"] }) {
  const replay = model.replay
  const at = view.at ?? replay?.at
  return <div className="mvp-run-journal">
    {replay === undefined || at === undefined ? null : <label className="mvp-run-scrub">
      <span>{at} / {replay.last}</span>
      <input type="range" aria-label="Run position" min={0} max={replay.last} value={at} onChange={event => onView({ at: event.currentTarget.valueAsNumber })} />
    </label>}
    <ol>{(model.journal ?? []).map(entry => <li key={entry.seq} data-after={at !== undefined && entry.seq > at || undefined}>
      <span className="mvp-run-journal-seq">{entry.seq}</span><span className="mvp-run-journal-type">{entry.type}</span><span>{entry.text}</span>
    </li>)}</ol>
  </div>
}

export function RunView({ model, actions, onAction, view, onView }: RunViewProps) {
  const latest = model.attempts.at(-1)
  const status = <span className="mvp-run-state" data-state={model.state}>
    {model.state === "running" ? <span className="mvp-run-live" aria-hidden="true" /> : model.state === "held" ? <span className="mvp-run-held" aria-hidden="true" /> : null}
    {STATE_WORD[model.state]}{model.state === "held" && model.held !== undefined ? ` · since ${model.held.since}` : null}
  </span>
  const header = <header className="smithers-card-header">
    <h2 className="smithers-card-title">{model.todo === undefined ? null : <span className="mvp-run-ref">T{model.todo}</span>}{model.title}</h2>
    {status}
  </header>
  /* What needs a look: the flags of the step the run is in, and every wait nobody has settled. */
  const step = latest?.phases.at(-1)?.step
  const flagged = latest === undefined || step === undefined ? []
    : latest.phases.filter(phase => phase.step === step && phase.indicator !== undefined && (phase.tone === "thrash" || phase.tone === "wait"))
  const open = model.waits.filter(wait => wait.settled === undefined)
  const flags = flagged.length + open.length === 0 ? null : <div className="mvp-run-flags">
    {flagged.map(phase => <div key={phase.id} className="mvp-run-flag"><Indicator phase={phase} past={finished(model.state)} step={stepLabel(latest!, phase.step)} /></div>)}
    {open.map(wait => <div key={wait.id} className="mvp-run-flag"><span className="mvp-indicator" data-tone="wait">{wait.label}</span></div>)}
  </div>
  if (!view.maximized) {
    const now = latest === undefined || model.state === "held" || model.state === "done" ? undefined : latest.phases.filter(phase => phase.tone !== "ok").at(-1)
    return <section className="smithers-card mvp-run" data-kind="run" data-keyboard-pane="Run" aria-label={`Run ${model.title}`}>
      {header}
      <div className="smithers-card-body">
        {latest === undefined ? null : <AttemptGraph attempt={latest} size="compact" />}
        {now === undefined ? null : <p className="mvp-run-now">{now.title}</p>}
        {flags}
        <Footer actions={actions} onAction={onAction} />
      </div>
    </section>
  }
  /* The selection: a cell id, or a whole step "step:<run>:<step>". */
  const pick = /^step:(.+):([^:]+)$/.exec(view.selected ?? "")
  const pickedRun = pick === null ? undefined : model.attempts.find(each => each.run_id === pick[1])
  const cellRun = model.attempts.find(each => each.phases.some(phase => phase.cells.some(cell => cell.id === view.selected)))
  const shown = pickedRun ?? cellRun ?? latest
  const selectedStep = pickedRun === undefined ? undefined : pick?.[2]
  const selectedId = pickedRun !== undefined ? undefined : cellRun !== undefined ? view.selected : latest?.phases.at(-1)?.cells.at(-1)?.id
  const selected = shown?.phases.flatMap(phase => phase.cells).find(cell => cell.id === selectedId)
  const selectedPhase = shown?.phases.find(phase => phase.cells.some(cell => cell.id === selectedId))
  const marked = selectedStep ?? (shown === undefined || selectedPhase === undefined ? undefined : stepIdOf(shown, selectedPhase.step))
  const groups: Array<{ readonly step: string; readonly phases: Array<Phase> }> = []
  for (const phase of shown?.phases ?? []) {
    const last = groups.at(-1)
    if (last?.step === phase.step) last.phases.push(phase)
    else groups.push({ step: phase.step, phases: [phase] })
  }
  const stepRows = shown === undefined || selectedStep === undefined ? [] : shown.steps.filter(each => each.id === selectedStep)
  const stepPhases = shown === undefined || selectedStep === undefined ? [] : phasesOfStep(shown, selectedStep)
  const stepCost = costOf(stepPhases)
  const tabs = model.journal !== undefined || view.tab === "journal"
  const journal = view.tab === "journal"
  const cellButton = (cell: Cell, attribute: "data-cell" | "data-transcript-cell") =>
    <button type="button" className="mvp-run-cell" aria-current={cell.id === selectedId || undefined} data-tone={cell.tone}
      data-cell={attribute === "data-cell" ? cell.id : undefined} data-transcript-cell={attribute === "data-transcript-cell" ? cell.id : undefined}
      onClick={() => onView({ selected: cell.id })}>
      <span className="mvp-run-cell-icon">{cell.actor === undefined ? CELL_ICON[cell.kind] : <ActorChip actor={cell.actor} size="s" />}</span>
      <span className="mvp-run-cell-text"><Explain cell={cell} /></span>
      {cell.tone === "fail" ? <X size={12} className="mvp-run-failed" aria-hidden="true" /> : null}
    </button>
  return <section className="smithers-card mvp-run" data-kind="run" data-maximized="" data-keyboard-pane="Run" aria-label={`Run ${model.title}`}>
    {header}
    <div className="smithers-card-body">
      {model.attempts.length === 0 ? null : <div className="mvp-run-attempts">
        {model.attempts.slice(0, -1).map(each => <AttemptGraph key={each.run_id} attempt={each} size="earlier" label dim={each !== shown}
          selected={each === shown ? marked : undefined} onView={onView} />)}
        <AttemptGraph attempt={latest!} size="full" label={model.attempts.length > 1} selected={latest === shown ? marked : undefined} onView={onView} />
      </div>}
      {flags}
      {tabs ? <div className="mvp-run-tabs" role="tablist" aria-label="Run views">
        <button type="button" role="tab" className="mvp-run-tab" data-tab="run" aria-selected={!journal} onClick={() => onView({ tab: "run" })}>Run</button>
        <button type="button" role="tab" className="mvp-run-tab" data-tab="journal" aria-selected={journal} onClick={() => onView({ tab: "journal" })}>Journal</button>
      </div> : null}
      {journal ? <JournalPane model={model} view={view} onView={onView} /> : shown === undefined ? null : <div className="mvp-run-max">
        <nav className="mvp-run-timeline" aria-label="Run timeline" data-past={finished(shown.state) || undefined}>
          <ol>{groups.map((group, index) => <li key={index} className="mvp-run-step" aria-current={stepIdOf(shown, group.step) === selectedStep ? "step" : undefined}>
            <div className="mvp-run-step-head">{stepLabel(shown, group.step)}</div>
            <ol className="mvp-run-phases">{group.phases.map(phase => <li key={phase.id} className="mvp-run-phase" data-tone={phase.tone}>
              <div className="mvp-run-phase-head">
                <span className="mvp-run-phase-n">{shown.phases.indexOf(phase) + 1}</span>
                <span className="mvp-run-phase-title"><b>{phase.title}</b>{phase.summary === undefined ? null : <span><Written />{phase.summary}</span>}</span>
                {phase.took_s === 0 ? null : <span className="mvp-run-took">{duration(phase.took_s)}</span>}
              </div>
              <Indicator phase={phase} past={finished(shown.state)} step={stepLabel(shown, phase.step)} />
              {phase.cells.length === 0 ? null : <ol className="mvp-run-cells">{phase.cells.map(cell => <li key={cell.id}>{cellButton(cell, "data-cell")}</li>)}</ol>}
            </li>)}</ol>
          </li>)}</ol>
        </nav>
        <section className="mvp-run-detail" aria-label={selectedStep === undefined ? "Selected cell" : "Selected step"}>
          {selectedStep !== undefined ? <>
            <div className="mvp-run-detail-head">
              <span className="mvp-run-detail-phase">{shown.graph.find(node => node.id === selectedStep)?.label ?? selectedStep}</span>
              <span className="mvp-run-detail-end">{[stepCost.took, stepCost.tokens === undefined ? undefined : `${stepCost.tokens} tokens`].filter(Boolean).join(" · ")}</span>
            </div>
            {stepRows.filter(row => row.input !== undefined || row.output !== undefined).map(row => <div key={row.key} className="mvp-run-step-io">
              {stepRows.length > 1 ? <span className="mvp-run-detail-phase">{row.label} · {row.k}</span> : null}
              {row.input === undefined ? null : <pre className="mvp-run-code" data-copy="data">{JSON.stringify(row.input, null, 2)}</pre>}
              {row.output === undefined ? null : <pre className="mvp-run-code" data-copy="data">{JSON.stringify(row.output, null, 2)}</pre>}
            </div>)}
            {stepPhases.length === 0 ? null : <ol className="mvp-run-transcript">{stepPhases.flatMap(phase => phase.cells).map(cell => <li key={cell.id}>{cellButton(cell, "data-transcript-cell")}</li>)}</ol>}
          </> : selected === undefined ? null : <>
            <div className="mvp-run-detail-head">
              <span className="mvp-run-cell-icon">{CELL_ICON[selected.kind]}</span>
              <span className="mvp-run-detail-phase">{selectedPhase === undefined ? null : `${stepLabel(shown, selectedPhase.step)} · ${selectedPhase.title}`}</span>
              {selected.actor === undefined ? null : <ActorChip actor={selected.actor} size="s" />}
              <span className="mvp-run-detail-end">{[selected.took_s === undefined ? undefined : duration(selected.took_s), selected.tokens === undefined ? undefined : `${tokenLabel(selected.tokens)} tokens`].filter(Boolean).join(" · ")}</span>
            </div>
            <p className="mvp-run-explain"><Explain cell={selected} /></p>
            {selected.quote === undefined ? null : <blockquote className="mvp-run-quote" data-copy="data">{selected.quote}</blockquote>}
            {selected.code === undefined ? null : <pre className="mvp-run-code" data-copy="data">{selected.code}</pre>}
            {selected.output === undefined ? null : <div className="mvp-run-output" data-copy="data">{selected.output.split("\n").map((line, index) =>
              <div key={index} data-tone={line.includes("✗") || line.includes("FAIL") ? "fail" : line.includes("✓") || line.includes("PASS") ? "ok" : undefined}>{line}</div>)}</div>}
          </>}
        </section>
      </div>}
      <Footer actions={actions} onAction={onAction} />
    </div>
  </section>
}
