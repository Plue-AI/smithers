import type { Card } from "./state/AppState"
import type { RunCommand } from "./cards/CardFamily"
import { wholeTraceOf, TERMINAL_RUN_PHASES } from "./cards/RunTraceCard"
import { PhaseStrip } from "./cards/RunTracePhaseStrip"
import { RunTraceSummary } from "./cards/RunTraceSummary"
import { durationWords } from "./cards/RunTrace"
import { flowAction } from "./flows/FlowAction"
import { runSourceCommand } from "@smthrs/ui/run-command"

type RunCard = Extract<Card, { kind: "run-trace" }>

/** The caller supplies only the visible conversation's cards. A running job
 * stays in reach even after a newer, shorter job has finished. */
export const monitoredRun = (cards: ReadonlyArray<Card>): RunCard | undefined => {
  const runs = cards.filter((card): card is RunCard => card.kind === "run-trace" &&
    card.payload.kind !== "change-plan" && (card.payload.events?.length ?? 0) > 0).filter(card => {
      const trace = wholeTraceOf(card)
      return trace.bands.length > 0 || trace.milestones.length > 0
    })
  const newest = (rows: ReadonlyArray<RunCard>) => rows.reduce<RunCard | undefined>((found, card) =>
    found === undefined || card.ordinal > found.ordinal ? card : found, undefined)
  return newest(runs.filter(card => !TERMINAL_RUN_PHASES.has(card.payload.phase))) ?? newest(runs)
}

/** The same persisted cursor, journal, and commands as the embedded run. */
export function ChatRunTimeline({ cards, onRunCommand: dispatch }: {
  readonly cards: ReadonlyArray<Card>
  readonly onRunCommand: RunCommand
}) {
  const card = monitoredRun(cards)
  if (card === undefined) return null
  const model = wholeTraceOf(card)
  if (model.bands.length === 0 && model.milestones.length === 0) return null
  const onRunCommand = runSourceCommand(card.id, dispatch)
  const inspect: RunCommand = (name, args) => {
    onRunCommand(name, args)
    // Selection changes the embedded card. Reveal its evidence without moving
    // keyboard focus out of the scrubber or taking over the conversation.
    if (name === "runs.trace.select") requestAnimationFrame(() => {
      document.querySelector(`[data-testid="card-${CSS.escape(card.id)}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "instant" })
    })
  }
  return <aside className="chat-run-timeline" aria-label="Run timeline" data-testid="chat-run-timeline">
    <div className="chat-run-timeline-heading">
      <span className="chat-run-timeline-title">{card.title}</span>
      <RunTraceSummary card={card} model={model} facts={[durationWords(model.extent.end - model.extent.start)]} onRunCommand={onRunCommand} />
      {card.payload.liveTail === false ? <button type="button" className="run-trace-filter"
        {...flowAction(onRunCommand, "runs.trace.live", card.payload.runId)}>Latest</button> : null}
    </div>
    <PhaseStrip model={model} records={card.payload.events ?? []} runId={card.payload.runId}
      cursorSeq={card.payload.cursorSeq} onRunCommand={inspect} />
  </aside>
}
