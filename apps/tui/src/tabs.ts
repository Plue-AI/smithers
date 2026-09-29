/**
 * What a worker tab says about itself, in one place for the tab strip, the
 * worker list and the worker view: its status glyph and color, its model,
 * its clock, and the actions its status allows.
 */
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import * as WorkerControls from "@smthrs/rpc/WorkerControls"
import * as Budget from "./budget.ts"
import * as Keys from "./keys.ts"
import { aliases as seatAliases, delegateModels } from "./models.ts"
import type { Model } from "./models.ts"
import { color } from "./theme.ts"
import type { Tab } from "./workspace.ts"

/** `queued` waits for a free seat. */
export type Status = Tab["status"]

/** Palette keys, read at draw time so a theme change reaches them. */
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

/** Whose fault a failure is, in the words every surface uses: `not your fault · provider`. */
export const faultWords = (fault: NonNullable<Tab["failure"]>["fault"]): string => faultLabel[fault]

/** Whose problem a failure is, in product words; the internal class never reaches the screen. */
const faultLabel = {
  user: "needs you",
  wait: "not your fault · waiting",
  infra: "not your fault · infra",
  dependency: "not your fault · provider",
  factory: "not your fault",
  policy: "cap reached",
  bug: "not your fault · bug"
} as const satisfies Record<NonNullable<Tab["failure"]>["fault"], string>

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

// A delegate alias wins where both tables name a seat (`cerebras`, not `qwen`).
const aliases = new Map<string, string>(
  [...Object.entries(seatAliases), ...Object.entries(delegateModels)].map(([alias, seat]) => [seat, alias])
)

/** The shortest name that tells seats apart: its seat alias (`opus`, `sol`), else the picker's label, else the model id. */
export const model = (seat: string, models: ReadonlyArray<Model>): string => {
  // Claude Code runs an alias or a full seat: `claude-code:opus` is `opus`.
  const bare = seat.startsWith("claude-code:") ? seat.slice("claude-code:".length) : seat
  return aliases.get(bare) ?? (Object.hasOwn(seatAliases, bare) ? bare : undefined) ??
    models.find((each) => each.seat === seat)?.label ??
    (seat.startsWith("replay:") ? "replay" : seat.slice(seat.indexOf(":") + 1))
}

/** Who runs a worker: its wrapped harness (`claude`, `codex`), else its model's short name. */
export const seatName = (tab: Pick<Tab, "seat" | "activeSeat" | "harness">, models: ReadonlyArray<Model>): string =>
  tab.harness?.vendor ?? model(tab.activeSeat ?? tab.seat, models)

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

export const actions = (tab: Worker): ReadonlyArray<Action> => bindings.filter((binding) => binding.when(tab))

/** The action a registry binding runs on this worker, if its state allows it. */
export const actionFor = (binding: string, tab: Worker) => actions(tab).find((each) => each.binding === binding)

/** Columns an overflow arrow takes: `‹ 12 `. */
export const arrow = 5

/**
 * The widest run of whole tabs around `active` that fits `width`, with room
 * for an arrow on each side that hides tabs. Never cuts a tab short.
 */
export const fit = (widths: ReadonlyArray<number>, active: number, width: number): { first: number; last: number } => {
  const at = Math.max(0, Math.min(active, widths.length - 1))
  let first = at
  let last = Math.min(widths.length, at + 1)
  const used = (from: number, to: number) =>
    widths.slice(from, to).reduce((sum, each) => sum + each, 0) + (from > 0 ? arrow : 0) +
    (to < widths.length ? arrow : 0)
  for (let grew = true; grew;) {
    grew = false
    if (last < widths.length && used(first, last + 1) <= width) {
      last++
      grew = true
    }
    if (first > 0 && used(first - 1, last) <= width) {
      first--
      grew = true
    }
  }
  return { first, last }
}
