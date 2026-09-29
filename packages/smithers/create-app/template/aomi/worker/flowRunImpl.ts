/**
 * One pipeline flow run, projected onto a single `flow-run` card.
 *
 * `POST /api/flows/run` answers with an execution id and nothing else, so this
 * is where the run's progress becomes visible. The run is `runFlow` from
 * `@smthrs/create-app/worker` on the host `./host.ts` builds; each card the
 * flow paints is persisted as it streams, and the run's own card is replaced
 * once it settles. `AppSession` persists each version under the card's id, so
 * `GET /api/session?id=` always returns the latest one.
 *
 * The card id is the execution id. A run therefore owns exactly one card for
 * its whole life, which is what makes `card.update` the right frame: the shell
 * replaces a card it already has rather than growing the transcript per step.
 */
import type { FlowRunCard } from "@smthrs/create-app/ui"
import { runFlow } from "@smthrs/create-app/worker"
import type { FlowRunRequest, TurnFrame } from "../src/api.ts"
import type { Env } from "./env.ts"
import { type HostSeams, hostFor, type SessionFlows } from "./host.ts"

/** How a run ended, which is what the session's row in the Recent column reports. */
export type Phase = FlowRunCard["phase"]

/** One row of the card's step list. */
export type Step = FlowRunCard["steps"][number]

export interface FlowRunOptions {
  readonly env: Env
  /** Where `flows/write-flow` saves, as it does for a turn. */
  readonly session: SessionFlows
  readonly request: FlowRunRequest
  /** The card id as well as the run id; see the module comment. */
  readonly executionId: string
  /** Aborted by `POST /api/agent/turn/cancel`. */
  readonly signal: AbortSignal
  readonly emit: (frame: TurnFrame) => void
  /** Test seams; the Worker passes none. See `HostSeams`. */
  readonly seams?: HostSeams | undefined
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * The one card a run writes, and the only thing that writes it. The frame
 * carries the whole step list: `card.update` replaces a card, it does not
 * patch one.
 */
class RunCard {
  private steps: ReadonlyArray<Step> = []

  constructor(
    private readonly flowId: string,
    private readonly executionId: string,
    private readonly emit: (frame: TurnFrame) => void
  ) {}

  /** Ends the run without changing the stages the flow actually reported. */
  settle(
    phase: Phase,
    extra: { readonly result?: unknown; readonly error?: string; readonly steps?: ReadonlyArray<Step> } = {}
  ): Phase {
    this.steps = extra.steps ?? this.steps
    this.update(phase, extra)
    return phase
  }

  /** Replaces the whole card. `steps` is copied so a later mutation cannot reach it. */
  private update(phase: Phase, extra: { readonly result?: unknown; readonly error?: string } = {}): void {
    this.emit({
      type: "card.update",
      card: {
        kind: "flow-run",
        id: this.executionId,
        flowId: this.flowId,
        executionId: this.executionId,
        phase,
        steps: [...this.steps],
        ...(extra.result === undefined ? {} : { result: extra.result }),
        ...(extra.error === undefined ? {} : { error: extra.error })
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * The steps a flow reports in its output, when it reports any.
 *
 * A flow spec declares no stage list. The build pipeline returns its stages
 * in `BuildPlan.steps`, so a completed run reads them from there; a flow that
 * returns none leaves the card with an empty list.
 */
const stepsOf = (output: unknown): ReadonlyArray<Step> | undefined => {
  if (typeof output !== "object" || output === null || !("steps" in output) || !Array.isArray(output.steps)) {
    return undefined
  }
  const statuses: ReadonlyArray<Step["status"]> = ["pending", "running", "done", "failed", "cached"]
  const steps = output.steps.filter((step: unknown): step is Step =>
    typeof step === "object" && step !== null && "name" in step && typeof step.name === "string"
    && "status" in step && statuses.includes(step.status as Step["status"])
  )
  return steps.map((step) => ({ name: step.name, status: step.status }))
}

/**
 * Runs one pipeline flow and returns the phase it ended on.
 *
 * The caller (`AppSession.driveFlow`) turns that phase into the session's
 * status. A throw from here is the caller's to render, and it writes its own
 * failed card for it; every path this function handles itself settles the card
 * before returning. A host that cannot run the flow (unrouted, a chat flow, a
 * missing key or fork endpoint) settles the card `failed` with the refusal.
 */
export const runFlowRun = async (options: FlowRunOptions): Promise<Phase> => {
  const { emit, request, signal } = options
  const card = new RunCard(request.flowId, options.executionId, emit)
  let end: Extract<TurnFrame, { type: "done" | "error" }> | undefined
  const host = await hostFor(options.env, options.session, {
    card: (painted) => emit({ type: "card", card: painted }),
    delta: () => undefined,
    end: (frame) => {
      end = frame
    }
  }, options.seams)
  if ("error" in host) return card.settle("failed", { error: host.message })
  const stream = await runFlow(host, { flow: request.flowId, payload: request.payload }, signal)
  if (!(stream instanceof ReadableStream)) return card.settle("failed", { error: stream.message })
  // Nothing reads a flow run's frames; draining the stream is waiting for it.
  await stream.pipeTo(new WritableStream())
  if (end?.type === "done") {
    const steps = stepsOf(end.output)
    return card.settle("completed", { result: end.output, ...(steps === undefined ? {} : { steps }) })
  }
  return card.settle(signal.aborted ? "cancelled" : "failed", { error: end?.message ?? "The run ended without a result." })
}
