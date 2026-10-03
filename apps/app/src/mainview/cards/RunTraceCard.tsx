import { workflowLaunchOf, type WorkflowLaunch } from "../state/WorkflowLaunch"
import { runFailureOf } from "../state/RunFailure"
import { isFlowNotFound } from "../state/controller/gateway"
import { flowProps } from "../flows/FlowAction"
import type { UserFailure } from "@smthrs/rpc/UserFailure"
import type { CardFamily } from "./CardFamily"
import { RunResult } from "./RunResult.tsx"
import { useState, type KeyboardEvent, type ReactNode } from "react"
import { flowArgs } from "../flows/FlowArgs"
import { flowAction } from "../flows/FlowAction"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure, FailureNotice } from "../FailureNotice"
/**
 * The run reads as current status, goals and journal rows. A persisted row
 * selection opens its code and evidence. The timeline view adds the debugger.
 * Every view choice enters an existing runs.trace flow; this card owns no state.
 */
import { runSourceCommand } from "@smthrs/ui/run-command"
import { Button, Input, StatusPill } from "@smthrs/ui"
import { PhaseStrip } from "./RunTracePhaseStrip"
export { phasePins } from "./RunTracePhaseStrip"
import { codingEvidenceOf } from "./CodingPlan"
import { FlowRunGraph, runGraphOfCard } from "./FlowRunGraph"
import { CodingPlanBody } from "./CodingPlanCard"
import { RunTraceSummary } from "./RunTraceSummary"
import { runTriggersOf, runTriggerWords } from "./RunTrigger"
import { AgentMark } from "../AgentMark"
import { StepList, stepFacts } from "./RunTraceSteps"
import { DevToolsPane } from "./RunDevTools"
import { traceSteps } from "./TraceSteps"
import { CodingPocBody } from "./CodingPocCard"
import { CodingVibeBody } from "./CodingVibeCard"
import type { Card, FlowDurationsRow } from "../state/AppState"
import { timeLabel } from "../Timestamps"
import type { CardProjectionAuthority, RunCommand } from "./CardFamily"
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
  childCards,
  admin = false,
}: {
  readonly card: RunTraceCard
  /** The shell's failure notices, for a summary that draws them under its own status (the burndown board). */
  readonly notices?: ReactNode
  /** Which frame the body is mounted in; the burndown caps long groups when embedded. */
  readonly presentation?: "embedded" | "maximized" | undefined
  /** The open cards, so the graph's forest states parent and child runs. */
  readonly childCards?: CardProjectionAuthority["collections"]["cards"] | undefined
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
  const latestSeq = (card.payload.events ?? []).reduce((max, record) => Math.max(max, sequenceOf(record)), 0)
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
  /* What started the run, as it was recorded (RunTrigger.ts): the message, the pinned pushed ref, the schedule, each approval decision. Never inferred. */
  const triggers = runTriggersOf(card)
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
    <div className="run-trace" data-testid={`run-trace-${runId}`} data-kind={kind} data-view={view}>
      {kind === "prototype" ?
        (
          <p className="run-trace-banner" data-testid={`run-trace-banner-${runId}`}>
            <span className="run-trace-kind">kind: prototype · never promoted</span> {PROTOTYPE_BANNER}
          </p>
        ) :
        null}
      {<RunTraceSummary card={card} model={whole} facts={facts} onRunCommand={onRunCommand} admin={admin} />}
      {result !== null ? <RunResult result={result} technical={repositoryRun} /> : null}
      <CodingPlanBody model={whole} card={card} onRunCommand={onRunCommand} workflowCatalogs={workflowCatalogs} />
      <CodingPocBody card={card} onRunCommand={onRunCommand} />
      <CodingVibeBody card={card} onRunCommand={onRunCommand} />
      {/* The run's progress words (payload.steps, a short tail the pump and replays write), newest last. */}
      {steps.length === 0 ? null : settled ? (
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
      {view === "steps" ? (
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
          {/* The triggers as their own rows (DESIGN §3.4, #2115): one per recorded source — the message with who posted it and its conversation, the pushed ref, the schedule, each approval decision with who made it. */}
          {triggers.map((trigger, index) => {
            const at = trigger.kind === "approval" && trigger.at !== undefined ? trigger.at : model.extent.start
            return (
              <div key={index} className="run-trigger" data-testid={`run-trigger-${runId}-${trigger.kind}`} data-trigger={trigger.kind}>
                <span className="agent-trigger-glyph" aria-hidden>⚡</span>
                <span className="run-step-time">{at > 0 ? timeLabel(at) : ""}</span>
                <span className="run-step-type">trigger</span>
                <span className="run-trigger-text">
                  {trigger.kind === "message" ? (
                    <>
                      <AgentMark persona={{ id: trigger.author, name: trigger.author }} size={16} onRunCommand={onRunCommand} />{" "}
                      <q className="run-trigger-quote" data-testid={`run-trigger-quote-${runId}`}>{trigger.text}</q>{" "}
                      
                    </>
                  ) : runTriggerWords(trigger, card.payload.workflow)}
                  {trigger.kind === "approval" && trigger.principal !== undefined
                    ? <> <AgentMark persona={{ id: trigger.principal, name: trigger.principal }} size={16} onRunCommand={onRunCommand} /></>
                    : null}
                </span>
              </div>
            )
          })}
          <StepList model={model} runId={runId} selected={card.payload.selection} cardId={card.id} onRunCommand={onRunCommand}
            detail={<SpanPane span={selected} model={model} runId={runId} />} />
          {model.counts.spans === 0 ? (
            <p className="run-trace-empty" data-testid={`run-trace-empty-${runId}`}>
              {settled ? "No steps were recorded." : "No steps yet."}
            </p>
          ) : null}
        </>
      ) : view === "devtools" ? (
        <>
          <div className="run-trace-bar" data-view="devtools" role="group" aria-label="Trace presentation">
            <button
              type="button"
              className="run-trace-filter run-trace-view"
              aria-pressed={false}
              {...flowAction(onRunCommand, "runs.trace.view", flowArgs("runs.trace.view", { runId, view: "turns" }))}
            >
              Timeline
            </button>
            <span className="run-trace-bar-title">DevTools</span>
            <span className="run-trace-clock" data-testid={`run-trace-devtools-facts-${runId}`}>
              {whole.counts.spans === 0
                ? "no journal yet"
                : `${count(whole.counts.spans, "span")}${
                  whole.counts.running > 0 ? ` · ${whole.counts.running} running` : ""
                }${whole.counts.failed > 0 ? ` · ${whole.counts.failed} failed` : ""} · t = ${durationWords(ran.wall)}`}
            </span>
          </div>
          {/* DevTools follows the live run: the whole journal, whatever the cursor of the other views says. */}
          <DevToolsPane model={whole} selected={selectedSpan(card, whole)} runId={runId} latestSeq={latestSeq} onRunCommand={onRunCommand} />
        </>
      ) : view === "graph" && runGraph !== undefined ? (
        <FlowRunGraph
          card={card}
          view={runGraph}
          onRunCommand={onRunCommand}
          flowDurations={flowDurations}
          fileCards={fileCards}
          childCards={childCards}
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
              <button
                type="button"
                className="run-trace-filter run-trace-view"
                aria-pressed={false}
                {...flowAction(onRunCommand, "runs.trace.view", flowArgs("runs.trace.view", { runId, view: "devtools" }))}
              >
                DevTools
              </button>
            </div>
          ) : null}
          <PhaseStrip model={whole} records={card.payload.events ?? []} runId={runId} cursorSeq={card.payload.cursorSeq} onRunCommand={onRunCommand} />
          {(
            <FrameLines model={model} selected={selected} runId={runId} onRunCommand={onRunCommand}
              openFrame={inspecting ? frame?.id : undefined} detail={detail} cardId={card.id} />
          )}
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
          {span.detail.message === undefined ? null : <CallFailure message={span.detail.message} />}
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
      {detail.message !== undefined ? <CallFailure message={detail.message} /> : null}
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

const Block = ({ title, text }: { readonly title: string; readonly text: string }) => (
  <div className="run-trace-block">
    <h5>{title}</h5>
    <pre className="run-trace-code" tabIndex={0} aria-label={title}>{text}</pre>
  </div>
)

/* A call's recorded failure: one sentence, and the journal's own words behind Details. */
export const CALL_FAILED: UserFailureCopy = { fault: "factory", sentence: "This call failed. Not your fault.", actions: [] }

const CallFailure = ({ message }: { readonly message: string }) => (
  <FailureNotice className="run-trace-block run-trace-failure" data-testid="run-trace-failure"
    failure={describedFailure("run.trace.call", CALL_FAILED, message)} />
)

type LaunchStage = NonNullable<WorkflowLaunch["error"]>["stage"]
type RunPhase = Extract<Card, { kind: "run-trace" }>["payload"]["phase"]
type RunFacet = NonNullable<Extract<Card, { kind: "run-trace" }>["payload"]["facetRequest"]>["facet"]

/* A request that never became a run: its stage picks the sentence; the gateway's words stay behind Details. */
export const LAUNCH_FAILURES: Readonly<Record<LaunchStage, UserFailureCopy>> = {
  preparation: { fault: "infra", sentence: "Smithers could not get the box ready for this run. Not your fault.", actions: ["retry"] },
  launch: { fault: "infra", sentence: "Smithers could not start this run. Not your fault.", actions: ["retry"] },
  persistence: { fault: "bug", sentence: "This browser could not save this run request. Not your fault.", actions: ["retry"] }
}

/* The one launch refusal the person can fix: the repository has no flow by that name. */
export const LAUNCH_FLOW_MISSING: UserFailureCopy = {
  fault: "user", sentence: "This repository has no flow by that name.", actions: []
}

/** A launch that failed before a run existed: its stage (or a missing flow) picks the copy; code and words are the detail. */
const launchFailure = (launch: NonNullable<WorkflowLaunch["error"]>): UserFailure => {
  const detail = `${launch.code} — ${launch.message}`
  return isFlowNotFound(launch.code)
    ? describedFailure("run.launch.flow-missing", LAUNCH_FLOW_MISSING, detail)
    : describedFailure(`run.launch.${launch.stage}`, LAUNCH_FAILURES[launch.stage], detail)
}

/* A facet read that failed: which view could not load. */
export const FACET_FAILURES: Readonly<Record<RunFacet, UserFailureCopy>> = {
  transcript: { fault: "infra", sentence: "Smithers could not load this run's transcript. Not your fault.", actions: [] },
  events: { fault: "infra", sentence: "Smithers could not load this run's events. Not your fault.", actions: [] }
}

const LIVE_UNWATCHED: UserFailureCopy = { fault: "infra", sentence: "Smithers lost track of this run. Not your fault.", actions: [] }
const SETTLED_UNREAD: UserFailureCopy = { fault: "infra", sentence: "This run finished, but Smithers could not read all of its record. Not your fault.", actions: [] }

/* Why the card cannot vouch for the run, by the phase it was left in. */
export const OBSERVATION_FAILURES: Readonly<Record<RunPhase, UserFailureCopy>> = {
  launching: LIVE_UNWATCHED,
  running: LIVE_UNWATCHED,
  "waiting-approval": LIVE_UNWATCHED,
  reconnecting: LIVE_UNWATCHED,
  quiet: LIVE_UNWATCHED,
  stopped: { fault: "infra", sentence: "Smithers stopped watching this run. Not your fault.", actions: [] },
  completed: SETTLED_UNREAD,
  failed: SETTLED_UNREAD,
  cancelled: SETTLED_UNREAD,
  "no-capacity": SETTLED_UNREAD
}

/*
 * Wave 11 — the embedded run card. RunTraceBody carries the run's outcome,
 * result, plan, progress and turns (RunTraceCard.tsx); this shell adds what
 * is about the card's relationship to the live run: why it is not moving, the
 * secondary facets (transcript, raw events), the observation errors, and the
 * lifecycle acts (stop, resume, run again, steer). Stream loss is routine and
 * stated honestly ("reconnecting"), never a silent stall.
 */
export const WorkflowRunCardBody = ({
  card,
  onStopRun,
  onRetryRun,
  onRunCommand: sendRunCommand,
  debugVerbose = false,
  workflowCatalogs,
  flowDurations,
  fileCards,
  childCards,
  admin = false,
  presentation
}: {
  readonly admin?: boolean
  readonly card: Extract<Card, { kind: "run-trace" }>
  readonly onStopRun: (cardId: string) => void
  readonly onRetryRun: (cardId: string) => void
  readonly onRunCommand: RunCommand
  readonly debugVerbose?: boolean
  readonly workflowCatalogs?: ReadonlyArray<Extract<Card, { kind: "workflow-list" }>>
  /** Every measured row the session holds, for the graph's own predictions. */
  readonly flowDurations?: ReadonlyArray<FlowDurationsRow>
  /** The files already read into this conversation; the graph's Code tab renders the declared one. */
  readonly fileCards?: ReadonlyArray<Extract<Card, { kind: "file" }>>
  /** The cards the child runs' own run cards are read from; absent in static previews. */
  readonly childCards?: CardProjectionAuthority["collections"]["cards"]
  /** Which frame the body is mounted in (CardActions.presentation). */
  readonly presentation?: "embedded" | "maximized" | undefined
}) => {
  const onRunCommand = runSourceCommand(card.id, sendRunCommand)
  const request = workflowLaunchOf(card)
  if (request && request.runId === undefined) return <div className="flow-run-card">
    {request.error === undefined ? <p className="smithers-card-note" role="status">Requested</p> : (
      <FailureNotice className="sui-approval-error" data-testid="flow-run-launch-failure" data-stage={request.error.stage}
        failure={launchFailure(request.error)}
        actions={{ retry: { ...flowProps("flow.run.retry"), onClick: () => onRetryRun(card.id) } }} />
    )}
  </div>
  const { phase, error, observationError, runId, kind } = card.payload
  const { fault, message: sentence, detail } = runFailureOf(card.payload)
  const facet = card.payload.facet ?? "steps"
  const facetRequest = card.payload.facetRequest
  const facetUnready = facetRequest !== undefined && facetRequest.state !== "complete" && facetRequest.facet === facet
  const notices = (
    <>
      {(phase === "completed" || phase === "failed" || phase === "cancelled" || phase === "no-capacity") && error !== undefined ?
        (
          <FailureNotice className="sui-approval-error run-failure" data-testid={`flow-run-failure-${runId}`}
            failure={{ tag: null, fault, sentence, actions: [], detail }} />
        ) :
        null}
      {observationError !== undefined ?
        <FailureNotice className="sui-approval-error" data-testid={`flow-run-observation-failure-${runId}`}
          failure={describedFailure(`run.observe.${phase}`, OBSERVATION_FAILURES[phase], observationError)} /> :
        null}
    </>
  )
  return (
    <div className="flow-run-card" data-run-kind={kind}>
      {/* Lane runs: why a live run is not moving, in the control plane's word. */}
      {card.payload.waiting !== undefined ?
        (
          <p className="smithers-card-note" data-testid={`flow-run-waiting-${runId}`}>
            {card.payload.waiting === "executor"
              ? "Accepted — waiting for an executor."
              : `Waiting on ${card.payload.waiting}.`}
          </p>
        ) :
        null}
      {card.payload.steeringPending === true && !TERMINAL_RUN_PHASES.has(phase) ?
        <p className="smithers-card-note">steering pending · delivered at the next turn</p> :
        null}
      {card.payload.deadlineAt !== undefined && !TERMINAL_RUN_PHASES.has(phase) ?
        <p className="smithers-card-note" data-testid={`flow-run-deadline-${runId}`}>Deadline {timeLabel(card.payload.deadlineAt)}</p> :
        null}
      {/* The run as a trace (spec 06): the card's body for every run kind. Its rows dispatch runs.trace.*. */}
      <RunTraceBody
        admin={admin}
        card={card}
        onRunCommand={onRunCommand}
        workflowCatalogs={workflowCatalogs}
        flowDurations={flowDurations}
        fileCards={fileCards}
        childCards={childCards}
        presentation={presentation}
        notices={notices}
      />
      {facetRequest?.state === "failed" ?
        <FailureNotice className="sui-approval-error" data-testid={`flow-run-facet-failure-${runId}`}
          failure={describedFailure(`run.facet.${facetRequest.facet}`, FACET_FAILURES[facetRequest.facet], facetRequest.error ?? "")} /> :
        null}
      {facet === "transcript" && !facetUnready ?
        card.payload.transcriptRows === undefined || card.payload.transcriptRows.length === 0 ?
          <p className="smithers-card-note">The transcript is empty so far.</p> :
          (
            <ol className="flow-run-transcript" aria-label="Transcript" data-testid={`flow-run-transcript-${runId}`}>
              {card.payload.transcriptRows.map((row) => (
                <li key={row.sequence}>
                  <span className="flow-run-transcript-meta">
                    {row.turn !== undefined ? `turn ${row.turn}` : ""}{row.at !== undefined ? ` · ${timeLabel(row.at)}` : ""}{row.kind !== undefined ? ` · ${row.kind}` : ""}
                  </span>
                  <span className="flow-run-transcript-text">{row.text}</span>
                </li>
              ))}
            </ol>
          ) :
        null}
      {facet === "events" && debugVerbose && !facetUnready ?
        card.payload.events === undefined || card.payload.events.length === 0 ?
          <p className="smithers-card-note">No events recorded yet.</p> :
          (
            <ul className="flow-run-steps flow-run-events" data-testid={`flow-run-events-${runId}`}>
              {card.payload.events.map((event, index) => (
                <li key={index}><code>{JSON.stringify(event)}</code></li>
              ))}
            </ul>
          ) :
        null}
      {notices}
      {phase === "quiet" ?
        (
          <div className="flow-run-actions">
            <Button size="sm" {...flowProps("flow.run.retry")} onClick={() => onRetryRun(card.id)}>
              Check again
            </Button>
            <Button
              size="sm"
              variant="outline"
              {...flowProps("flow.run.stop")}
              onClick={() => onStopRun(card.id)}
            >
              Stop watching
            </Button>
          </div>
        ) :
        null}
      {TERMINAL_RUN_PHASES.has(phase) && (error !== undefined || observationError !== undefined || card.payload.events?.some((event) => event.kind === "control.engine.projection-gap")) ? (
        <Button size="sm" {...flowProps("flow.run.retry")} onClick={() => onRetryRun(card.id)}>
          Check again
        </Button>
      ) : null}
      {/*
       * One row of acts. The facets (lane runs): the trace by default, the
       * transcript on demand (runs.logs), the raw journal only where verbose
       * is on (runs.events); each tab is a registered flow, never local
       * state. Then the lifecycle acts: Stop on every non-terminal phase (the
       * flow confirms); Resume for a wait the control plane named (anything
       * but an approval, which the approval card answers); Run again for a
       * settled run, with the same input, refusing honestly when this client
       * never recorded one.
       */}
      {<div className="flow-run-actions flow-run-footer">
        <div className="flow-run-tabs" role="tablist" aria-label="Run views">
          <Button
            size="sm"
            variant={facet === "steps" ? "default" : "outline"}
            role="tab"
            aria-selected={facet === "steps"}
            data-testid={`flow-run-facet-steps-${runId}`}
            {...flowAction(onRunCommand, "runs.steps", runId)}
          >
            Trace
          </Button>
          <Button
            size="sm"
            variant={facet === "transcript" ? "default" : "outline"}
            role="tab"
            aria-selected={facet === "transcript"}
            data-testid={`flow-run-facet-transcript-${runId}`}
            {...flowAction(onRunCommand, "runs.logs", runId)}
          >
            Transcript
          </Button>
          {debugVerbose ?
            (
              <Button
                size="sm"
                variant={facet === "events" ? "default" : "outline"}
                role="tab"
                aria-selected={facet === "events"}
                data-testid={`flow-run-facet-events-${runId}`}
                {...flowAction(onRunCommand, "runs.events", runId)}
              >
                Events
              </Button>
            ) :
            null}
        </div>
        {LIVE_RUN_PHASES.has(phase) ?
          (
            <div className="flow-run-lifecycle">
              <Button
                size="sm"
                variant="outline"
                {...flowProps("flow.run.stop")}
                data-testid={`flow-run-stop-${runId}`}
                onClick={() => onStopRun(card.id)}
              >
                Stop
              </Button>
            </div>
          ) :
          null}
        {TERMINAL_RUN_PHASES.has(phase) ?
          (
            <div className="flow-run-lifecycle">
              <Button
                size="sm"
                variant="outline"
                data-testid={`flow-run-rerun-${runId}`}
                {...flowAction(onRunCommand, "runs.rerun", runId)}
              >
                Run again
              </Button>
            </div>
          ) :
          null}
      </div>}
      {/* Spec 06 §3: a prototype is never steered; its header has no Steer, so its card has no steer row. */}
      {LIVE_RUN_PHASES.has(phase) && kind !== "prototype" ? <RunSteerRow runId={runId} onRunCommand={onRunCommand} /> : null}
    </div>
  )
}

/** The phases a run can still be steered, resumed, or stopped in. */
const LIVE_RUN_PHASES: ReadonlySet<string> = new Set(["launching", "running", "waiting-approval", "reconnecting"])
// "stopped" is the phase a REFUSED cancel leaves (workflow-pump stopWatchingRun): the run may still be live, so it is not terminal;
// TERMINAL_RUN_PHASES (RunTraceCard.tsx) is the set a Run again answers.

const RunSteerRow = ({
  runId,
  onRunCommand
}: {
  readonly runId: string
  readonly onRunCommand: RunCommand
}) => {
  const [message, setMessage] = useState("")
  const sendMessage = (): void => {
    const body = message.trim()
    if (body === "") return
    onRunCommand("runs.steer", flowArgs("runs.steer", { runId, body }))
    setMessage("")
  }
  const onEnter = (submit: () => void) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      submit()
    }
  }
  return (
    <div className="flow-run-steer" data-testid={`flow-run-steer-${runId}`}>
      <div className="flow-run-actions">
        <Input
          className="flow-run-steer-input"
          aria-label="Steer this run"
          placeholder="Steer this run — a message for the next turn"
          value={message}
          data-testid={`flow-run-steer-input-${runId}`}
          onInput={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={onEnter(sendMessage)}
        />
        <Button
          variant="outline"
          {...flowProps("runs.steer")}
          disabled={message.trim() === ""}
          onClick={() => {
            if (message.trim() === "") return
            onRunCommand("runs.steer", flowArgs("runs.steer", { runId, body: message.trim() }))
            setMessage("")
          }}
        >
          Steer
        </Button>
      </div>
    </div>
  )
}


export const runTraceCardFamily: CardFamily<"run-trace"> = {
  "run-trace": {
    render: (card, actions) => (
      <WorkflowRunCardBody
        card={card}
        onStopRun={actions.onStopRun}
        onRetryRun={actions.onRetryRun}
        onRunCommand={actions.onRunCommand}
        debugVerbose={actions.debugVerbose}
        workflowCatalogs={actions.workflowCatalogs}
        flowDurations={actions.flowDurations}
        fileCards={actions.fileCards}
        childCards={actions.projectionStore?.collections.cards}
        presentation={actions.presentation}
      />
    ),
    pill: (card) => {
      if (card.payload.phase === "completed") return "done"
      if (card.payload.phase === "cancelled") return "stopped"
      if (
        card.payload.phase === "failed" || card.payload.phase === "no-capacity"
      ) {
        return "failed"
      }
      if (card.payload.phase === "waiting-approval") return "waiting-approval"
      /*
       * Wave 12 §3: a card whose body says the run has gone quiet, or that
       * nobody is watching it any more, may not wear a Running pill. The pill
       * is the most glanceable claim on the card, and "Running" is precisely
       * the thing neither of these states can vouch for — they read Quiet and
       * Stopped, muted, through the shared status vocabulary.
       */
      if (card.payload.phase === "quiet" || card.payload.phase === "stopped") return card.payload.phase
      return "running"
    }
  },
}
