/**
 * What a worker tab says about itself, in one place for the tab strip, the
 * worker list and the worker view: its status glyph and color, its model,
 * its clock, and the actions its status allows.
 */
import type * as FailureCopy from "@smthrs/model/FailureCopy"
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import * as WorkerControls from "@smthrs/rpc/WorkerControls"
import * as Budget from "./budget.ts"
import * as Keys from "./keys.ts"
import { color } from "./theme.ts"
import type { Tab } from "./workspace.ts"

/** `queued` waits for a free seat. */
export type Status = Tab["status"]

/** Semantic palette keys used by the terminal views. */
const tones = {
  running: "info",
  waiting: "warning",
  done: "success",
  failed: "danger",
  stopped: "faint"
} as const satisfies Record<SubagentCard.Tone, keyof typeof color>

/** A shared tone in this palette. */
export const toneColor = (tone: SubagentCard.Tone): string => color[tones[tone]]

/** The shared subagent glyph at `now`, in this palette's colors, so every running glyph turns together. */
export const style = (status: Status, now: number): { readonly glyph: string; readonly tone: string } => {
  const { glyph, tone } = SubagentCard.glyph(status, now)
  return { glyph, tone: toneColor(tone) }
}

/**
 * A run's outcome in the words every surface uses: `working`, `done`,
 * `done · unchecked`, `failed: <cause>` or `stopped`. Whose fault it was and
 * how to set up a model stay out of it.
 */
export const outcome = (tab: Pick<Tab, "status" | "failure" | "unchecked">): string => {
  const word = SubagentCard.outcome(tab.status)
  if (word === "failed") return `failed: ${tab.failure?.headline ?? "Worker stopped unexpectedly"}`
  return word === "done" && tab.unchecked === true ? "done · unchecked" : word
}

/** A worker's glyph: `⇄` in the needs color while the person drives it, else its status glyph. */
export const styleOf = (
  tab: Pick<Tab, "status" | "driver">,
  now: number
): { readonly glyph: string; readonly tone: string } =>
  tab.driver === undefined || (tab.status !== "running" && tab.status !== "waiting")
    ? style(tab.status, now)
    // Waiting for the person to send its next message, or working under them.
    : { glyph: "⇄", tone: tab.status === "waiting" ? color.needs : color.info }

export const live = WorkerControls.live

/** From the request until settlement; a settled tab's clock stops. */
export const elapsed = (tab: Pick<Tab, "startedAt" | "endedAt">, now: number): number =>
  Math.max(0, (tab.endedAt ?? now) - tab.startedAt)

export type ActionId = "stop" | "retry" | "model" | "wait" | "steer" | "takeover" | "raise"

/** What an action's availability reads: the status, and a failure's own offers. */
type Worker = Pick<Tab, "status" | "failure" | "driver" | "harness">

/** Each worker action is a button in the worker view and a registry key (`panel` context). */
const registered: ReadonlyArray<
  {
    readonly id: ActionId
    readonly binding: string
    /** The button's words when the binding's own label is too general. */
    readonly label?: string
    readonly when: (tab: Worker) => boolean
  }
> = [
  // A worker stopped at its run cap: `a` opens the form that resumes it with a chosen allowance. First, so
  // its chip fits on a narrow card before Resume and Switch model.
  {
    id: "raise",
    binding: "approve-form",
    label: "Raise cap",
    when: (tab) => tab.status === "failed" && Budget.capped(tab.failure)
  },
  { id: "stop", binding: "stop", when: (tab) => WorkerControls.allowed("stop", tab) },
  { id: "retry", binding: "retry", when: (tab) => WorkerControls.allowed("retry", tab) },
  { id: "model", binding: "worker-model", when: (tab) => WorkerControls.allowed("model", tab) },
  { id: "wait", binding: "worker-wait", when: (tab) => WorkerControls.allowed("wait", tab) },
  {
    id: "steer",
    binding: "steer-worker",
    // A wrapped harness reads no steering queue; it is taken over instead.
    when: (tab) => WorkerControls.allowed("steer", tab) && tab.driver === undefined && tab.harness === undefined
  },
  // A running worker only: a take-over parks it at its next frame boundary.
  { id: "takeover", binding: "take-over", when: (tab) => tab.status === "running" && tab.driver === undefined }
]

export const bindings = registered.map(({ id, binding, label, when }) => {
  const found = Keys.registry.find((each) => each.id === binding && each.context === "panel")
  if (found === undefined) throw new Error(`Worker action ${id} has no panel key binding ${binding}`)
  return { id, binding, keys: found.keys, label: label ?? found.label, when }
})

export type Action = (typeof bindings)[number]

/** The failure offer each recovery action answers. */
const offers: Partial<Record<ActionId, FailureCopy.Action>> = { retry: "resume", model: "switch-model", wait: "wait" }

/** What a worker's state allows; the recovery actions a failure offers come in its order. */
export const actions = (tab: Worker): ReadonlyArray<Action> => {
  const allowed = bindings.filter((binding) => binding.when(tab))
  const offered = tab.failure?.actions ?? []
  const rank = (action: Action) => {
    const offer = offers[action.id]
    return offer === undefined ? -1 : offered.indexOf(offer)
  }
  // Offered actions trade places among themselves; every other action keeps its own.
  const ordered = allowed.filter((action) => rank(action) >= 0).toSorted((a, b) => rank(a) - rank(b))
  let next = 0
  return allowed.map((action) => rank(action) < 0 ? action : ordered[next++]!)
}

/** The action a registry binding runs on this worker, if its state allows it. */
export const actionFor = (binding: string, tab: Worker) => actions(tab).find((each) => each.binding === binding)
