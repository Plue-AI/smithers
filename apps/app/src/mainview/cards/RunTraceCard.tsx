import { flowArgs } from "../flows/FlowArgs"
import { flowAction } from "../flows/FlowAction"
/**
 * The run reads as current status, goals and journal rows. A persisted row
 * selection opens its code and evidence. The timeline view adds the debugger.
 * Every view choice enters an existing runs.trace flow; this card owns no state.
 */
import { runSourceCommand } from "@smthrs/ui/run-command"
import { Markdown, StatusPill } from "@smthrs/ui"
import { PhaseStrip } from "./RunTracePhaseStrip"
export { phasePins } from "./RunTracePhaseStrip"
import { codingEvidenceOf } from "./CodingPlan"
import { FlowRunGraph, runGraphOfCard } from "./FlowRunGraph"
import { CodingPlanBody } from "./CodingPlanCard"
import { RunTraceSummary } from "./RunTraceSummary"
import { launchSourceOf } from "../state/WorkflowLaunch"
import { StepList, stepFacts } from "./RunTraceSteps"
import { traceSteps } from "./TraceSteps"
import { CodingPocBody } from "./CodingPocCard"
import { CodingVibeBody } from "./CodingVibeCard"
import type { Card, FlowDurationsRow } from "../state/AppState"
import { timeLabel } from "../Timestamps"
import type { RunCommand } from "./CardFamily"
import {
  durationWords,
  spanMatches,
  spanPath,
  type TraceFilter,
  type TraceFold,
  traceFiltersFor,
  traceFoldModel,
  traceFoldSync,
  traceFromJournal,
  type TraceModel,
  type TraceNote,
  type TraceSpan,
  turnNarratives,
  waterfallGeometry
} from "./RunTrace"

/** The banner every prototype run wears (spec 06 §3, mock #s6). */
export const PROTOTYPE_BANNER = "Prototypes are evidence for /implement, then reaped. No review, no gates, no landing."

/** The phases a run has settled in. */
export const TERMINAL_RUN_PHASES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "no-capacity"])

type RunTraceCard = Extract<Card, { kind: "run-trace" }>

const durationOf = (span: TraceSpan, model: TraceModel): string | undefined => {
  const end = span.endedAt ?? (span.status === "running" || span.status === "waiting" ? model.extent.end : undefined)
  if (end === undefined) return undefined
  return durationWords(Math.max(end - span.startedAt, 0))
}

const json = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

const sequenceOf = (record: Record<string, unknown>): number =>
  typeof record.sequence === "number" ? record.sequence : 0

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * The check targets the plan declared. Activity comes from calls independently
 * of these coverage requirements.
 *
 * Read off the WHOLE journal: what the plan declared is a fact about the run,
 * not about where the reader parked the cursor, and the strip below shows the
 * run's phases past the cursor. A card at the live tail is the same object
 * `CodingPlanBody` reads, so the two share one walk of the journal.
 */
const checkTargetsOf = (card: RunTraceCard): ReadonlyArray<string> => {
  const { cursorSeq: _parked, ...whole } = card.payload
  const declared = codingEvidenceOf(card.payload.cursorSeq === undefined ? card : { ...card, payload: whole })
  return declared.plan?.changes.flatMap((change) => change.checks.map((check) => check.target)) ?? []
}

/**
 * The two folds of one payload: the whole journal the card holds, and the
 * journal up to the scrub cursor.
 *
 * A payload is immutable, so the traces derived from it cannot change. Without
 * this cache every render of every run card walks the journal again — through
 * `codingEvidenceOf`, which decodes candidate plans and canonical-digests them
 * — and the strip's second fold would double that. A derivation keyed by the
 * payload object is not card state: it lives exactly as long as the payload it
 * came from, and the card still holds nothing of its own.
 */
const folds = new WeakMap<RunTraceCard["payload"], { readonly model: TraceModel; readonly whole: TraceModel }>()

/**
 * The live fold of each journal, keyed by its first record. A payload that
 * appends to the journal the last one held steps only the new records.
 */
const journalFolds = new WeakMap<object, TraceFold>()

const foldsOf = (card: RunTraceCard): { readonly model: TraceModel; readonly whole: TraceModel } => {
  const held = folds.get(card.payload)
  if (held !== undefined) return held
  const { runId, workflow, phase, kind, events, cursorSeq } = card.payload
  const journal = events ?? []
  const targets = checkTargetsOf(card)
  const options = targets.length === 0 ? undefined : { checkTargets: targets }
  const run = (status: string) => ({ runId, flowId: workflow, status, ...(kind === undefined ? {} : { kind }) })
  const first = journal[0]
  const live = traceFoldSync(first === undefined ? undefined : journalFolds.get(first), run(phase), journal)
  if (first !== undefined) journalFolds.set(first, live)
  const whole = traceFoldModel(live, phase)
  const latest = journal.reduce((max, record) => Math.max(max, sequenceOf(record)), 0)
  const scrubbed = cursorSeq !== undefined && cursorSeq < latest
  const fold = {
    whole,
    // At a cursor before the journal's end the run had not settled, so the root
    // wears `running` unless a `control.run.*` record within the cursor says otherwise.
    model: scrubbed
      ? traceFromJournal(run("running"), journal.filter((record) => sequenceOf(record) <= cursorSeq), options)
      : whole
  }
  folds.set(card.payload, fold)
  return fold
}

/**
 * The trace the card's log shows: the journal up to the scrub cursor (§2, the
 * scrubber lands on a record and every region re-renders at that seq from the
 * fold the client already holds), or the whole journal when nothing is parked.
 *
 * @param card the run card
 */
export const traceOf = (card: RunTraceCard): TraceModel => foldsOf(card).model

/**
 * The trace of the whole journal the card holds, whatever the cursor says.
 *
 * The strip is a scrubber: the bands and pins past the cursor are the places
 * it can still be scrubbed TO, so they are rendered as not-yet-reached rather
 * than dropped. The outcome line reads this fold too, because its phase word
 * is the run's own verdict and counts beside a verdict describe the same run.
 *
 * @param card the run card
 */
export const wholeTraceOf = (card: RunTraceCard): TraceModel => foldsOf(card).whole

/**
 * The selected node: the payload's selection when it names a row still in the
 * fold, else the newest frame while live tail holds (§2: live tail follows the
 * newest frame), else the run itself.
 *
 * @param card the run card
 * @param model its trace
 */
export const selectedSpan = (card: RunTraceCard, model: TraceModel): TraceSpan => {
  const { selection, liveTail } = card.payload
  const named = selection === undefined ? undefined : model.rows.find((span) => span.id === selection)
  if (named !== undefined) return named
  if (liveTail !== false) {
    const frames = model.rows.filter((span) => span.kind === "frame")
    const newest = frames.at(-1)
    if (newest !== undefined) return newest
  }
  return model.root
}

export const RunTraceBody = ({
  card,
  onRunCommand: sendRunCommand,
  workflowCatalogs,
  flowDurations,
  fileCards,
  admin = false
}: {
  readonly card: RunTraceCard
  /** A Smithers admin decides admin-decided waits; nobody else is offered them. */
  readonly admin?: boolean
  readonly workflowCatalogs?: ReadonlyArray<Extract<Card, { kind: "workflow-list" }>>
  readonly onRunCommand: RunCommand
  /** Every measured row the session holds, for the graph's own predictions. */
  readonly flowDurations?: ReadonlyArray<FlowDurationsRow>
  /** The files already read into this conversation; the graph's Code tab renders the declared one. */
  readonly fileCards?: ReadonlyArray<Extract<Card, { kind: "file" }>>
}) => {
  const onRunCommand = runSourceCommand(card.id, sendRunCommand)
  const { runId, phase, kind, steps, result } = card.payload
  /* A tutorial plan card is a plan, not a run: it has no outcome, no progress and no journal to show. */
  const planOnly = kind === "change-plan"
  /* A repository setup or job run answers with structured data, not prose, and does its work in child executions. */
  const repositoryRun = card.payload.workflow === "repository/setup" || card.payload.workflow.startsWith("repository-jobs/")
  const model = traceOf(card)
  const whole = wholeTraceOf(card)
  const view = card.payload.traceView ?? "turns"
  const runGraph = runGraphOfCard(card)
  const filters = traceFiltersFor(kind)
  const filter: TraceFilter = filters.some(([id]) => id === card.payload.filter) ? card.payload.filter ?? "all" : "all"
  const selected = selectedSpan(card, model)
  const path = spanPath(model, selected.id)
  const frame = path.find((span) => span.kind === "frame" || span.kind === "execution")
  const frameIndex = frame === undefined ? -1 : model.rows.findIndex((span) => span.id === frame.id)
  const scopeEnd = frame === undefined
    ? -1
    : model.rows.findIndex((span, index) => index > frameIndex && span.depth <= frame.depth)
  const scope = frameIndex < 0 ? model.rows : model.rows.slice(frameIndex, scopeEnd < 0 ? undefined : scopeEnd)
  const rows = (view === "timeline" ? model.rows : scope).filter((span) =>
    span.kind === "run" || spanMatches(span, filter)
  )
  const turns = turnNarratives(model)
  const native = model.root.children.filter((span) =>
    span.kind === "execution" || span.id.startsWith("engine-gap:") || span.id.startsWith("engine-invalid:")
  )
  // Following a run is cheap. The debugger appears only after an explicit selection or timeline request.
  const inspecting = card.payload.selection !== undefined
  const wall = model.extent.end - model.extent.start
  const settled = TERMINAL_RUN_PHASES.has(phase)
  /*
   * The phase word is the RUN's verdict, so the counts beside it are the run's
   * too: a cursor moves the log below it, never what the run finished doing.
   * Where the reader is parked is the bar's own "At #n", not a shrunk fact.
   */
  const ran = {
    turns: whole === model ? turns.length : turnNarratives(whole).length,
    calls: whole.rows.filter((span) => span.kind === "call").length,
    wall: whole.extent.end - whole.extent.start
  }
  const facts = [
    ran.turns > 0 ? count(ran.turns, "turn") : undefined,
    ran.calls > 0 ? count(ran.calls, "call") : undefined,
    whole.counts.spans > 0 ? durationWords(ran.wall) : undefined
  ].filter((fact) => fact !== undefined)
  /* What started the run, as the launch recorded it: a pushed ref's name, else the flow the input named. Never inferred. */
  const launchSource = launchSourceOf(card)
  const trigger = launchSource !== undefined ? `from ${launchSource} · ${card.payload.workflow}` : undefined
  const scrub = card.payload.liveTail === false ? (
    <span className="run-trace-scrub">
      {card.payload.cursorSeq !== undefined ? <span className="run-trace-cursor">At #{card.payload.cursorSeq}</span> : null}
      <button type="button" className="run-trace-filter"  {...flowAction(onRunCommand, "runs.trace.live", runId)}>
        Latest
      </button>
    </span>
  ) : null
  const detail = (
    <TurnDetail card={card} model={model} selected={selected} scope={scope} frame={frame} />
  )
  return (
    <div className="run-trace" data-testid={`run-trace-${runId}`} data-kind={kind} data-view={planOnly ? "plan" : view}>
      {kind === "prototype" ?
        (
          <p className="run-trace-banner" data-testid={`run-trace-banner-${runId}`}>
            <span className="run-trace-kind">kind: prototype · never promoted</span> {PROTOTYPE_BANNER}
          </p>
        ) :
        null}
      {planOnly ? null : (
        <RunTraceSummary card={card} model={whole} facts={facts} onRunCommand={onRunCommand} admin={admin} />
      )}
      {!planOnly && result !== null ? repositoryRun ? (
        <details className="run-progress-fold">
          <summary>Technical details</summary>
          <pre className="run-trace-code" tabIndex={0} aria-label="Run output">{result}</pre>
        </details>
      ) : <Markdown className="smithers-card-markdown run-result" content={result} /> : null}
      <CodingPlanBody model={whole} card={card} onRunCommand={onRunCommand} workflowCatalogs={workflowCatalogs} />
      <CodingPocBody card={card} onRunCommand={onRunCommand} />
      <CodingVibeBody card={card} onRunCommand={onRunCommand} />
      {/* The run's progress words (payload.steps, a short tail the pump and replays write), newest last. */}
      {planOnly || steps.length === 0 ? null : settled ? (
        <details className="run-progress-fold">
          <summary><span className="run-fold-title">Progress</span><span className="run-fold-meta">{count(steps.length, "update")}</span></summary>
          <ol className="run-progress" aria-label="Progress" data-run-steps="">
            {steps.map((step, index) => <li key={`${index}:${step}`}>{step}</li>)}
          </ol>
        </details>
      ) : model.lines.length > 0 ? null : (
        <ol className="run-progress" aria-label="Progress" data-run-steps="">
          {steps.map((step, index) => <li key={`${index}:${step}`}>{step}</li>)}
        </ol>
      )}
      {planOnly ? null : view === "steps" ? (
        <>
          <div className="run-trace-bar" data-view="steps" role="group" aria-label="Trace presentation">
            <button
              type="button"
              className="run-trace-filter run-trace-view"
              aria-pressed={false}
              {...flowAction(onRunCommand, "runs.trace.view", flowArgs("runs.trace.view", { runId, view: "turns" }))}
            >
              Timeline
            </button>
            <span className="run-trace-bar-title">Steps</span>
            <span className="run-trace-clock" data-testid={`run-trace-steps-facts-${runId}`}>{stepFacts(traceSteps(model), wall).join(" · ")}</span>
            {scrub}
          </div>
          <PhaseStrip model={whole} records={card.payload.events ?? []} runId={runId} cursorSeq={card.payload.cursorSeq} onRunCommand={onRunCommand} />
          {/* The trigger as its own row (DESIGN §3.4): only what the launch recorded — its source ref, the flow it ran. */}
          {trigger === undefined ? null : (
            <div className="run-trigger" data-testid={`run-trigger-${runId}`}>
              <span className="agent-trigger-glyph" aria-hidden>⚡</span>
              <span className="run-step-time">{model.extent.start > 0 ? timeLabel(model.extent.start) : ""}</span>
              <span className="run-step-type">trigger</span>
              <span className="run-trigger-text">{trigger}</span>
            </div>
          )}
          <StepList model={model} runId={runId} selected={card.payload.selection} cardId={card.id} onRunCommand={onRunCommand}
            detail={<SpanPane span={selected} model={model} runId={runId} />} />
          {model.counts.spans === 0 ? (
            <p className="run-trace-empty" data-testid={`run-trace-empty-${runId}`}>
              {settled ? "No steps were recorded." : "No steps yet."}
            </p>
          ) : null}
        </>
      ) : view === "graph" && runGraph !== undefined ? (
        <FlowRunGraph
          card={card}
          view={runGraph}
          onRunCommand={onRunCommand}
          flowDurations={flowDurations}
          fileCards={fileCards}
        />
      ) : view === "turns" || view === "graph" ? (
        <>
          {turns.length > 0 || native.length > 0 || scrub !== null || runGraph !== undefined ? (
            <div className="run-trace-bar" data-view="turns" role="group" aria-label="Trace presentation">
              <span className="run-trace-bar-title">Timeline</span>
              {scrub}
              <button
                type="button"
                className="run-trace-filter run-trace-view"
                aria-pressed={false}
                {...flowAction(onRunCommand, "runs.trace.view", flowArgs("runs.trace.view", { runId, view: "timeline" }))}
              >
                Details
              </button>
              <button
                type="button"
                className="run-trace-filter run-trace-view"
                aria-pressed={false}
                {...flowAction(onRunCommand, "runs.trace.view", flowArgs("runs.trace.view", { runId, view: "steps" }))}
              >
                Steps
              </button>
              {runGraph === undefined ? null : (
                <button
                  type="button"
                  className="run-trace-filter run-trace-view"
                  aria-pressed={false}
                  {...flowAction(onRunCommand, "runs.trace.view", flowArgs("runs.trace.view", { runId, view: "graph" }))}
                >
                  Graph
                </button>
              )}
            </div>
          ) : null}
          <PhaseStrip model={whole} records={card.payload.events ?? []} runId={runId} cursorSeq={card.payload.cursorSeq} onRunCommand={onRunCommand} />
          <FrameLines model={model} selected={selected} runId={runId} onRunCommand={onRunCommand}
            openFrame={inspecting ? frame?.id : undefined} detail={detail} cardId={card.id} />
          {native.length > 0 ? (
            <ol className="run-turns run-engine" aria-label="Recorded engine work">
              {native.map((span) => {
                const open = inspecting && frame?.id === span.id
                const detailId = `${card.id}-engine-${span.id}`
                return (
                  <li key={span.id} data-turn-open={open}>
                    <button
                      type="button"
                      className="run-turn"
                      data-engine-span={span.id}
                      aria-pressed={open}
                      aria-expanded={open}
                      aria-controls={open ? detailId : undefined}
                      {...flowAction(onRunCommand, "runs.trace.select", flowArgs("runs.trace.select", { runId, nodeId: span.id }))}
                    >
                      <span className="run-turn-number"><span className="run-trace-dot" data-status={span.status} aria-hidden /></span>
                      <span className="run-turn-body">
                        <span className="run-turn-text">{span.label} · {span.status}</span>
                      </span>
                      <span className="run-trace-duration">{durationOf(span, model) ?? ""}</span>
                    </button>
                    {open ? <div id={detailId} className="run-turn-detail">{detail}</div> : null}
                  </li>
                )
              })}
            </ol>
          ) : null}
          {model.counts.spans === 0 && !inspecting && !repositoryRun ? (
            <p className="run-trace-empty" data-testid={`run-trace-empty-${runId}`}>
              {settled ? "No turns were recorded." : "No turns yet."}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <div className="run-trace-bar" data-view="timeline" role="group" aria-label="Trace filters">
            <button
              type="button"
              className="run-trace-filter run-trace-view"
              aria-pressed={false}
              {...flowAction(onRunCommand, "runs.trace.view", flowArgs("runs.trace.view", { runId, view: "turns" }))}
            >
              Timeline
            </button>
            <span className="run-trace-bar-title">Details</span>
            {filters.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="run-trace-filter"
                data-filter={id}
                data-on={filter === id}
                aria-pressed={filter === id}
                {...flowAction(onRunCommand, "runs.trace.filter", flowArgs("runs.trace.filter", { runId, filter: id }))}
              >
                {label}
              </button>
            ))}
            <span className="run-trace-clock" data-testid={`run-trace-clock-${runId}`}>
              {model.counts.spans === 0
                ? "no journal yet"
                : `${count(model.counts.spans, "span")}${
                  model.counts.running > 0 ? ` · ${model.counts.running} running` : ""
                }${model.counts.failed > 0 ? ` · ${model.counts.failed} failed` : ""} · t = ${durationWords(wall)}`}
            </span>
            {scrub}
          </div>
          <PhaseStrip model={whole} records={card.payload.events ?? []} runId={runId} cursorSeq={card.payload.cursorSeq} onRunCommand={onRunCommand} />
          <FrameLines model={model} selected={selected} runId={runId} onRunCommand={onRunCommand} />
          <nav className="run-trace-path" aria-label="Recorded call path">
            <PathCrumbs path={path} selected={selected} runId={runId} onRunCommand={onRunCommand} />
          </nav>
          <div className="run-trace-body">
            <CallTree rows={rows} selected={selected} model={model} runId={runId} onRunCommand={onRunCommand} />
            <div className="run-trace-detail">
              {model.counts.spans === 0 ?
                (
                  <p className="run-trace-empty" data-testid={`run-trace-empty-${runId}`}>
                    {settled ? "No spans were recorded." : "No spans yet."}
                  </p>
                ) :
                (
                  <ol className="run-trace-waterfall" aria-label="Waterfall">
                    {rows.filter((span) => span.kind !== "run").map((span) => {
                      const bar = waterfallGeometry(span, model.extent)
                      const instant = span.endedAt !== undefined && span.endedAt <= span.startedAt
                      const summary = `${span.label} · ${span.status}${
                        durationOf(span, model) === undefined ? "" : ` · ${durationOf(span, model)}`
                      }`
                      return (
                        <li
                          key={span.id}
                          className="run-trace-water-row"
                          data-trace-bar={span.id}
                          data-status={span.status}
                        >
                          <span className="run-trace-water-label">{span.label}</span>
                          <span className="run-trace-track">
                            <button
                              type="button"
                              className="run-trace-water-bar"
                              data-instant={instant}
                              data-open={span.endedAt === undefined}
                              aria-label={summary}
                              aria-pressed={selected.id === span.id}
                              title={summary}
                              style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                              {...flowAction(onRunCommand, "runs.trace.select", flowArgs("runs.trace.select", { runId, nodeId: span.id }))}
                            />
                          </span>
                        </li>
                      )
                    })}
                  </ol>
                )}
              {frame !== undefined ? <TurnSource scope={scope} /> : null}
              <SpanPane span={selected} model={model} runId={runId} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** The recorded ancestry of the selection, each a door back up. */
const PathCrumbs = ({ path, selected, runId, onRunCommand }: {
  readonly path: ReadonlyArray<TraceSpan>
  readonly selected: TraceSpan
  readonly runId: string
  readonly onRunCommand: RunCommand
}) => (
  <>
    {path.map((ancestor, index) => (
      <span key={ancestor.id}>
        {index > 0 ? <span aria-hidden>{" / "}</span> : null}
        <button
          type="button"
          aria-current={ancestor.id === selected.id ? "location" : undefined}
          {...flowAction(onRunCommand, "runs.trace.select", flowArgs("runs.trace.select", { runId, nodeId: ancestor.id }))}
        >
          {ancestor.label}
        </button>
      </span>
    ))}
  </>
)

/** One discipline event, under the frame it happened in. */
const Note = ({ note }: { readonly note: TraceNote }) => (
  <div className="run-note" data-note={note.seq} data-tone={note.tone}>
    <span className="run-note-title">{note.title}</span>
    <span className="run-note-body">{note.body}</span>
    {note.evidence === undefined || note.evidence.length === 0 ? null : (
      <ul className="run-note-evidence">
        {note.evidence.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}
      </ul>
    )}
  </div>
)

/**
 * What each frame did, in the words its calls earned, with the discipline
 * events under the frame they happened in. A note whose frame is not in the
 * fold still renders, at the end: a dropped note would read as a run with
 * nothing to say about it.
 */
const FrameLines = ({ model, selected, runId, onRunCommand, openFrame, detail, cardId = runId }: {
  readonly model: TraceModel
  readonly selected: TraceSpan
  readonly runId: string
  readonly onRunCommand: RunCommand
  readonly openFrame?: string
  readonly detail?: React.ReactNode
  readonly cardId?: string
}) => {
  const { lines, notes } = model
  if (lines.length === 0 && notes.length === 0) return null
  const placed = new Set(lines.map((line) => line.spanId))
  return (
    <ol className="run-lines" aria-label="What each frame did">
      {lines.map((line) => (
        <li key={line.spanId} data-turn-open={openFrame === line.spanId}>
          <button
            type="button"
            className="run-line"
            data-frame-line={line.spanId}
            data-failed={line.failed}
            data-wrote={line.wrote}
            aria-pressed={selected.id === line.spanId}
            aria-expanded={openFrame === line.spanId}
            aria-controls={openFrame === line.spanId ? `${cardId}-${line.spanId}` : undefined}
            {...flowAction(onRunCommand, "runs.trace.select", flowArgs("runs.trace.select", { runId, nodeId: openFrame === line.spanId ? model.root.id : line.spanId }))}
          >
            <span className="run-line-number">{line.frame}</span>
            <span className="run-line-body">
              <span className="run-line-verb">{line.verb}</span>
              {/* A flow the verb table has never heard of, whose input names
                  nothing the fold reads as a subject, is its own name and
                  nothing else: no empty element, no space left dangling. */}
              {line.subject === "" ? null : <>{" "}<span className="run-line-subject">{line.subject}</span></>}
            </span>
            <span className="run-line-result">{line.result}</span>
            {line.repeatOf === undefined ? null : <span className="run-line-repeat">same as {line.repeatOf}</span>}
          </button>
          {openFrame === line.spanId ? <div id={`${cardId}-${line.spanId}`} className="run-turn-detail">{detail}</div> : null}
          {(detail === undefined || openFrame === line.spanId) ? notes.filter((note) => note.spanId === line.spanId).map((note) => <Note key={note.seq} note={note} />) : null}
        </li>
      ))}
      {notes.filter((note) => !placed.has(note.spanId)).map((note) => (
        <li key={note.seq}><Note note={note} /></li>
      ))}
    </ol>
  )
}

/** The spans in scope as rows: a row is a button that selects its span. */
const CallTree = ({ rows, selected, model, runId, onRunCommand }: {
  readonly rows: ReadonlyArray<TraceSpan>
  readonly selected: TraceSpan
  readonly model: TraceModel
  readonly runId: string
  readonly onRunCommand: RunCommand
}) => (
  <ol className="run-trace-tree" aria-label="Call tree">
    {rows.map((span) => (
      <li key={span.id}>
        <button
          type="button"
          className="run-trace-node"
          data-trace-span={span.id}
          data-kind={span.kind}
          data-status={span.status}
          data-depth={span.depth}
          aria-pressed={selected.id === span.id}
          style={{ paddingLeft: `${0.5 + span.depth * 0.875}rem` }}
          {...flowAction(onRunCommand, "runs.trace.select", flowArgs("runs.trace.select", { runId, nodeId: span.id }))}
        >
          <span className="run-trace-dot" data-status={span.status} aria-hidden />
          <span className="run-trace-label">{span.label}</span>
          {/* The dot already says completed; only another status earns its word. */}
          <span className="run-trace-status">{span.status === "completed" ? "" : span.status}</span>
          <span className="run-trace-duration">{durationOf(span, model) ?? ""}</span>
        </button>
      </li>
    ))}
  </ol>
)

/** The script the turn ran, as the journal recorded it. */
const TurnSource = ({ scope }: { readonly scope: ReadonlyArray<TraceSpan> }) => {
  const cells = scope.filter((span) => span.detail.source !== undefined)
  if (cells.length === 0) return null
  return (
    <section className="run-turn-source" aria-label="Recorded turn source">
      {cells.length > 0
        ? cells.map((span) => <Block key={span.id} title="Script" text={span.detail.source!} />)
        : null}
    </section>
  )
}

/** A selected row opens its recorded code, model response and call evidence in place. */
const TurnDetail = ({ card, model, selected, scope, frame }: {
  readonly card: RunTraceCard
  readonly model: TraceModel
  readonly selected: TraceSpan
  readonly scope: ReadonlyArray<TraceSpan>
  readonly frame: TraceSpan | undefined
}) => {
  const { runId } = card.payload
  return (
    <>
      {frame !== undefined && frame.kind === "frame" ? <TurnSource scope={scope} /> : null}
      {scope.filter(span => span.detail.printed !== undefined || span.kind === "call" || span.kind === "model").map(span => (
        <div key={span.id} className="run-row-evidence" data-evidence-span={span.id}>
          {span.kind === "call" ? <strong>{span.label}</strong> : null}
          {span.detail.printed === undefined ? null : <Block title="Printed" text={span.detail.printed} />}
          {span.detail.input === undefined ? null : <Block title="Input" text={json(span.detail.input)} />}
          {span.detail.output === undefined ? null : <Block title={span.kind === "model" ? "Model" : "Output"} text={span.detail.output} />}
          {span.detail.message === undefined ? null : <Block title="Failure" text={span.detail.message} alert />}
        </div>
      ))}
      {selected.kind === "execution" || selected.kind === "event" || selected.kind === "run" ? <SpanPane span={selected} model={model} runId={runId} /> : null}
    </>
  )
}

/** The selected span's facts, and nothing the journal did not record. */
export const SpanPane = (
  { span, model, runId }: { readonly span: TraceSpan; readonly model: TraceModel; readonly runId: string }
) => {
  const { detail } = span
  const duration = durationOf(span, model)
  return (
    <div className="run-trace-pane" data-testid={`run-trace-pane-${runId}`} data-span={span.id}>
      <h5 className="run-trace-pane-title">
        <span className="run-trace-pane-kind">{span.kind}</span> · {span.label} <StatusPill status={span.status} />
      </h5>
      <dl className="run-trace-kv">
        {span.startedAt > 0 ?
          (
            <>
              <dt>started</dt>
              <dd>{timeLabel(span.startedAt)}</dd>
            </>
          ) :
          null}
        {duration !== undefined ?
          (
            <>
              <dt>duration</dt>
              <dd>{duration}{span.endedAt === undefined ? " · open" : ""}</dd>
            </>
          ) :
          null}
        {detail.seat !== undefined ?
          (
            <>
              <dt>seat</dt>
              <dd>{detail.seat}</dd>
            </>
          ) :
          null}
        {detail.usage !== undefined &&
            (detail.usage.inputTokens !== undefined || detail.usage.outputTokens !== undefined) ?
          (
            <>
              <dt>tokens</dt>
              <dd>{detail.usage.inputTokens ?? 0} in / {detail.usage.outputTokens ?? 0} out</dd>
            </>
          ) :
          null}
        {detail.event !== undefined ?
          (
            <>
              <dt>journal</dt>
              <dd>{detail.event}{detail.sequence !== undefined ? ` · #${detail.sequence}` : ""}</dd>
            </>
          ) :
          null}
      </dl>
      {detail.source !== undefined ? <Block title="Script" text={detail.source} /> : null}
      {detail.printed !== undefined ? <Block title="Printed" text={detail.printed} /> : null}
      {detail.input !== undefined ? <Block title="Input" text={json(detail.input)} /> : null}
      {detail.output !== undefined ? <Block title="Output" text={detail.output} /> : null}
      {detail.message !== undefined ? <Block title="Failure" text={detail.message} alert /> : null}
      {detail.fields !== undefined ?
        (
          <Block
            title="Journal fields"
            text={Object.entries(detail.fields).map(([key, value]) => `${key.padEnd(12)}${json(value)}`).join("\n")}
          />
        ) :
        null}
    </div>
  )
}

const Block = (
  { title, text, alert = false }: { readonly title: string; readonly text: string; readonly alert?: boolean }
) => (
  <div className="run-trace-block">
    <h5>{title}</h5>
    <pre className="run-trace-code" tabIndex={0} aria-label={title} {...(alert ? { role: "alert" } : {})}>{text}</pre>
  </div>
)
