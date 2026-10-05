import { flowArgs } from "../flows/FlowArgs"
import { flowAction } from "../flows/FlowAction"
/*
 * The Steps view of a run: `time · type · description · duration · tokens`,
 * one row per recorded span, each a door to its own recorded details.
 *
 * The rows are `traceSteps` (RunTraceSteps.ts) off the trace model the card
 * already folds; selection is the card's persisted `selection`, so opening a
 * step is the same `runs.trace.select` the tree and the frame lines dispatch,
 * and a reload reopens the same step. The details under an open step are the
 * existing SpanPane: input, output, printed text, failure and journal fields,
 * and nothing the journal did not record.
 */
import type { ReactNode } from "react"
import { timeLabel } from "../Timestamps"
import type { RunCommand } from "./CardFamily"
import { durationWords, type TraceModel } from "./RunTrace"
import { tokenWords, totalTokens, traceSteps, type TraceStep } from "./TraceSteps"

/** The mono facts line a run's steps add up to: `12 steps · 3 min · 12.4k tok`. */
export const stepFacts = (steps: ReadonlyArray<TraceStep>, wallMs: number): ReadonlyArray<string> => {
  const tokens = totalTokens(steps)
  return [
    `${steps.filter(step => step.type !== "engine").length} ${steps.filter(step => step.type !== "engine").length === 1 ? "step" : "steps"}`,
    wallMs > 0 ? durationWords(wallMs) : undefined,
    tokens === undefined ? undefined : `${tokenWords(tokens)} tok`
  ].filter((fact): fact is string => fact !== undefined)
}

export const StepList = ({ model, runId, selected, detail, onRunCommand, cardId = runId, dense = false }: {
  readonly model: TraceModel
  readonly runId: string
  /** The open step's span id, from the card's persisted selection. */
  readonly selected?: string | undefined
  /** The details rendered under the open step (the card's SpanPane). */
  readonly detail?: ReactNode
  readonly onRunCommand: RunCommand
  readonly cardId?: string
  /** A timeline nests the list under a run row; it drops the wrapper's own padding. */
  readonly dense?: boolean
}) => {
  const steps = traceSteps(model)
  if (steps.length === 0) return null
  return (
    <ol className="run-steps" aria-label="Steps" data-dense={dense || undefined}>
      {steps.map((step) => {
        const open = selected === step.id
        const detailId = `${cardId}-step-${step.id}`
        return (
          <li key={step.id} data-step-open={open} data-status={step.status}>
            <button
              type="button"
              className="run-step"
              data-step={step.id}
              data-type={step.type}
              aria-expanded={open}
              aria-controls={open ? detailId : undefined}
              {...flowAction(onRunCommand, "runs.trace.select", flowArgs("runs.trace.select", { runId, nodeId: open ? model.root.id : step.id }))}
            >
              <span className="run-step-time">{step.at > 0 ? timeLabel(step.at) : ""}</span>
              <span className="run-step-type" data-type={step.type}>{step.type}</span>
              <span className="run-step-text">
                <span className="run-trace-dot" data-status={step.status} aria-hidden />
                {step.description}
              </span>
              <span className="run-step-duration">{step.durationMs === undefined ? "" : durationWords(step.durationMs)}</span>
              <span className="run-step-tokens">{step.tokens === undefined ? "" : tokenWords(step.tokens)}</span>
            </button>
            {open && detail !== undefined ? <div id={detailId} className="run-turn-detail">
              {step.engine === undefined ? null : <ul aria-label="Engine records">{step.engine.map(span => <li key={span.id}>{span.label}</li>)}</ul>}
              {detail}
            </div> : null}
          </li>
        )
      })}
    </ol>
  )
}
