import { ViewSkeleton } from "../ViewSkeleton"
import { flowAction, flowProps } from "../flows/FlowAction"
import { workflowLaunchOf } from "../state/WorkflowLaunch"
/*
 * The workflow cards: the embedded run card (run-trace) with its trace body
 * and steer row, the which-repository chooser (workflow-repo), and the
 * workspace's workflow listing (workflow-list). WorkflowRunCardBody and WorkflowListCardBody are
 * exported because the Flows pane and the runs tests mount them directly: one
 * list with two mounts, never a second implementation of the same listing.
 */
import { runSourceCommand } from "@smthrs/ui/run-command"
import { Button, Input, Markdown } from "@smthrs/ui"
import { useId, useState } from "react"
import type { KeyboardEvent } from "react"
import type { Card, FlowDurationsRow } from "../state/AppState"
import { timeLabel as clockLabel } from "../Timestamps"
import { rovingKeyDown } from "../RovingKeyDown"
import type { CardFamily, CardProjectionAuthority, RunCommand } from "./CardFamily"
import { defaultPill, settledPill } from "./CardFamily"
import { RunTraceBody, TERMINAL_RUN_PHASES } from "./RunTraceCard"
import { ChildRuns } from "../SubagentGrid"
import { flowArgs } from "../flows/FlowArgs"
import { runFailureOf } from "../state/RunFailure"

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
  childCards
}: {
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
}) => {
  const onRunCommand = runSourceCommand(card.id, sendRunCommand)
  const request = workflowLaunchOf(card)
  if (request && request.runId === undefined) return <div className="flow-run-card">
    <p className={request.error ? "sui-approval-error" : "smithers-card-note"} role={request.error ? "alert" : "status"}>
      {request.error?.message ?? "Requested"}
    </p>
    {request.error ? <Button size="sm" {...flowProps("flow.run.retry")} onClick={() => onRetryRun(card.id)}>Retry</Button> : null}
  </div>
  const { phase, error, observationError, runId, kind } = card.payload
  const failure = runFailureOf(card.payload)
  const facet = card.payload.facet ?? "steps"
  const facetRequest = card.payload.facetRequest
  const facetUnready = facetRequest !== undefined && facetRequest.state !== "complete" && facetRequest.facet === facet
  /* A tutorial plan card is the plan alone: no facets, no lifecycle acts, no steer. */
  const planOnly = kind === "change-plan"
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
      {/* The run as a trace (spec 06): the card's body for every run kind. Its rows dispatch runs.trace.*. */}
      <RunTraceBody
        card={card}
        onRunCommand={onRunCommand}
        workflowCatalogs={workflowCatalogs}
        flowDurations={flowDurations}
        fileCards={fileCards}
      />
      <ChildRuns card={card} collection={childCards} onRunCommand={onRunCommand} />
      {facetRequest?.state === "failed" ? <p className="sui-approval-error" role="alert">{facetRequest.error}</p> : null}
      {facet === "transcript" && !facetUnready ?
        card.payload.transcriptRows === undefined || card.payload.transcriptRows.length === 0 ?
          <p className="smithers-card-note">The transcript is empty so far.</p> :
          (
            <ol className="flow-run-transcript" aria-label="Transcript" data-testid={`flow-run-transcript-${runId}`}>
              {card.payload.transcriptRows.map((row) => (
                <li key={row.sequence}>
                  <span className="flow-run-transcript-meta">
                    {row.turn !== undefined ? `turn ${row.turn}` : ""}{row.at !== undefined ? ` · ${clockLabel(row.at)}` : ""}{row.kind !== undefined ? ` · ${row.kind}` : ""}
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
      {(phase === "completed" || phase === "failed" || phase === "cancelled" || phase === "no-capacity") && error !== undefined && !planOnly ?
        (
          <div>
            <p className="sui-approval-error" role="alert" data-refusal-fault={failure.fault}>{failure.message}</p>
            <details><summary>Technical details</summary><pre tabIndex={0}>{failure.detail}</pre></details>
          </div>
        ) :
        null}
      {observationError !== undefined ? <p className="sui-approval-error" role="alert">{observationError}</p> : null}
      {/* §3: the two acts a quiet run offers — both registered commands. */}
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
      {TERMINAL_RUN_PHASES.has(phase) && (error !== undefined || observationError !== undefined || card.payload.events?.some((event) => event.kind === "control.engine.projection-gap")) && !planOnly ? (
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
      {planOnly ? null : (
        <div className="flow-run-actions flow-run-footer">
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
        </div>
      )}
      {/* Spec 06 §3: a prototype is never steered; its header has no Steer, so its card has no steer row. */}
      {LIVE_RUN_PHASES.has(phase) && kind !== "prototype" ? <RunSteerRow runId={runId} onRunCommand={onRunCommand} /> : null}
    </div>
  )
}

/** The phases a run can still be steered, resumed, or stopped in. */
const LIVE_RUN_PHASES: ReadonlySet<string> = new Set(["launching", "running", "waiting-approval", "reconnecting"])
// "stopped" is the phase a REFUSED cancel leaves (workflow-pump stopWatchingRun): the run may still be live, so it is not terminal;
// TERMINAL_RUN_PHASES (RunTraceCard.tsx) is the set a Run again answers.

/** The thinking levels a steer may name — the wire's own vocabulary (@smthrs/notifications). */
const THINKING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const

/*
 * Lane runs §5 — the steer row: an operator message into the next turn, and
 * the mono strip of the other three steer kinds. Every submit is the flow
 * (runs.steer / runs.seat / runs.thinking / runs.tools); the text under the
 * pointer is presentation state, cleared the moment its flow takes it.
 */
const RunSteerRow = ({
  runId,
  onRunCommand
}: {
  readonly runId: string
  readonly onRunCommand: RunCommand
}) => {
  const [message, setMessage] = useState("")
  const [seat, setSeat] = useState("")
  const [tools, setTools] = useState("")
  const sendMessage = (): void => {
    const body = message.trim()
    if (body === "") return
    onRunCommand("runs.steer", flowArgs("runs.steer", { runId, body }))
    setMessage("")
  }
  const sendSeat = (): void => {
    const value = seat.trim()
    if (value === "") return
    onRunCommand("runs.seat", flowArgs("runs.seat", { runId, seat: value }))
    setSeat("")
  }
  const sendTools = (): void => {
    const value = tools.trim()
    if (value === "") return
    onRunCommand("runs.tools", flowArgs("runs.tools", { runId, toolNames: value }))
    setTools("")
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
      <div className="flow-run-actions flow-run-steer-strip">
        <Input
          className="flow-run-steer-input flow-run-steer-small"
          aria-label="Move the run to a seat"
          placeholder="seat — provider:model"
          value={seat}
          onInput={(event) => setSeat(event.currentTarget.value)}
          onKeyDown={onEnter(sendSeat)}
        />
        <select
          className="sui-input flow-run-steer-select"
          aria-label="Change the thinking level"
          data-testid={`flow-run-thinking-${runId}`}
          value=""
          onChange={(event) => {
            const level = event.currentTarget.value
            if (level !== "") onRunCommand("runs.thinking", flowArgs("runs.thinking", { runId, thinking: level }))
          }}
        >
          <option value="" disabled>
            thinking ▾
          </option>
          {THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        <Input
          className="flow-run-steer-input flow-run-steer-small"
          aria-label="Add tools to the run"
          placeholder="tools — comma-separated"
          value={tools}
          onInput={(event) => setTools(event.currentTarget.value)}
          onKeyDown={onEnter(sendTools)}
        />
      </div>
    </div>
  )
}

/*
 * Wave 12 §2 — which loaded repository. Embedded, keyboard-complete (arrows
 * move, Enter chooses), and one act: choosing IS the confirm, so the create
 * resumes immediately on the repo the human named.
 */
const WorkflowRepoCardBody = ({
  card,
  onChooseWorkflowRepo
}: {
  readonly card: Extract<Card, { kind: "workflow-repo" }>
  readonly onChooseWorkflowRepo: (fullName: string) => void
}) => {
  const optionId = useId()
  const { repos, chosen, description } = card.payload
  const [highlighted, setHighlighted] = useState(0)
  const index = Math.min(highlighted, Math.max(repos.length - 1, 0))
  if (chosen !== null) {
    return <p className="smithers-card-note">Creating it on {chosen}.</p>
  }
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const move = rovingKeyDown(event.key, { count: repos.length, current: index })
    if (move.kind === "move") {
      event.preventDefault()
      setHighlighted(move.index)
      return
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      const repo = repos[index]
      if (repo !== undefined) onChooseWorkflowRepo(repo)
    }
  }
  return (
    <div className="workflow-repo-chooser">
      <p className="smithers-card-note">{description}</p>
      <ul
        className="workflow-repo-list"
        role="listbox"
        aria-label="Your loaded repositories"
        aria-activedescendant={repos.length ? `${optionId}-${index}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {repos.map((repo, position) => (
          <li key={repo}>
            <button
              type="button"
              role="option"
              id={`${optionId}-${position}`}
              tabIndex={-1}
              aria-selected={position === index}
              data-highlighted={position === index}
              className="workflow-repo-row"
              {...flowProps("flow.repo.choose")}
              onMouseEnter={() => setHighlighted(position)}
              onClick={() => onChooseWorkflowRepo(repo)}
            >
              {repo}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}


/*
 * The workspace's workflows (flow.list) — each row's Run is a command binding.
 * Exported because the Flows pane (ask 5, App.tsx) renders THESE rows: one
 * list with two mounts, never a second implementation of the same listing.
 */
export const WorkflowListCardBody = ({
  card,
  onRunCommand: sendRunCommand
}: {
  readonly card: Extract<Card, { kind: "workflow-list" }>
  readonly onRunCommand: RunCommand
}) => {
  const onRunCommand = runSourceCommand(card.id, sendRunCommand)
  const { workflows, issueContext, research, repo } = card.payload
  if (card.loading) return <ViewSkeleton />
  if (card.payload.catalogRequest?.state === "failed") return <div role="alert"><p>{card.body}</p><Button size="sm" {...flowAction(onRunCommand, "flow.list")}>Retry</Button></div>
  return (
    <div>
      {issueContext ? <p className="smithers-card-note">Issue #{issueContext.number} · {issueContext.title}</p> : null}
      {workflows.length === 0 ? <p className="smithers-card-note">No flows on this workspace yet.</p> : null}
      <ul className="workflow-list">
        {workflows.map((workflow) => (
          <li key={workflow.key} className="workflow-list-row">
            <div className="workflow-list-text">
              <strong>{workflow.description ?? workflow.key.replace(/^issue\//, "issue.")}</strong>
              {workflow.description !== null ? <span>{workflow.key.replace(/^issue\//, "issue.")}</span> : null}
              {workflow.prompt ? <Markdown className="smithers-card-markdown" content={workflow.prompt} /> : null}
            </div>
            {issueContext && (workflow.key === "issue.repro" || workflow.key === "issue/repro") ?
              <Button size="sm" variant="outline" {...flowProps("issue.repro")} onClick={() => sendRunCommand("issue.repro", flowArgs("issue.repro", { number: issueContext.number, repo }))}>Run repro</Button> :
              <Button size="sm" variant="outline"  {...flowAction(onRunCommand, "flow.run", flowArgs("flow.run", { name: workflow.key, input: issueContext ? { args: JSON.stringify({ issue: issueContext }) } : undefined }))}>Run</Button>}
            <Button size="sm" variant="ghost" {...flowAction(onRunCommand, "flow.plan", flowArgs("flow.plan", { name: workflow.key }))}>Plan</Button>
          </li>
        ))}
      </ul>
      {research ? <Markdown className="smithers-card-markdown" content={research} /> : null}
      {issueContext ? <Button size="sm" variant="outline" {...flowProps("issue.add-flow")} onClick={() => sendRunCommand("issue.add-flow", flowArgs("issue.add-flow", { number: issueContext.number, repo }))}>Add flow</Button> : null}
    </div>
  )
}

export const workflowCardFamily: CardFamily<"run-trace" | "workflow-repo" | "workflow-list"> = {
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
      />
    ),
    pill: (card) => {
      /* A tutorial plan card wears the plan's state, not a run phase: pending until started, done once it is. */
      if (card.payload.kind === "change-plan") return card.status === "acted" ? "done" : "pending"
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
  "workflow-repo": {
    render: (card, actions) => <WorkflowRepoCardBody card={card} onChooseWorkflowRepo={actions.onChooseWorkflowRepo} />,
    pill: defaultPill
  },
  "workflow-list": {
    render: (card, actions) => <WorkflowListCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
