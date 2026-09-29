/**
 * The run's token meter, `↑34k ↓2.0k · 7.9%/128k · cache 94%`: a pure fold over
 * the run card's journal, the same numbers the terminal's footer meter shows.
 */
import { uniqueCallEvents } from "@smthrs/gateway/Diagnosis"
import { knownContextWindowTokens } from "@smthrs/model/ModelCatalog"
import type { JournalRecord } from "./RunTrace"

export interface RunMeter {
  /** Input tokens summed over every settled model call, cached reads included. */
  readonly input: number
  readonly output: number
  /** Cached input tokens summed over the calls; absent when no call reported any. */
  readonly cached: number | undefined
  /** The latest call's input tokens: what the context held when it was last sent. */
  readonly context: number
  /** The context window of the latest turn's seat; absent when no turn named one or the catalog does not know its model. */
  readonly window: number | undefined
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

// `provider:model` -> `model`, as `Seat.modelIdOf` in @smthrs/agent (not an app dependency).
const modelIdOf = (seat: string): string => {
  const separator = seat.indexOf(":")
  return separator < 0 ? seat : seat.slice(separator + 1)
}

/** Folds `control.agent.model-settled` usage; a journal with no usage has no meter. */
export const runMeterOf = (events: ReadonlyArray<JournalRecord>): RunMeter | undefined => {
  let input = 0, output = 0, cached: number | undefined, context: number | undefined
  let seat: string | undefined
  let calls = 0
  // Native step facts unwrap into the same `control.agent.*` records the trace folds.
  for (const event of uniqueCallEvents(events)) {
    const payload = record(event.payload)
    if (event.kind === "control.agent.turn-opened") {
      const named = payload?.seat
      if (typeof named === "string" && named !== "") seat = named
      continue
    }
    if (event.kind !== "control.agent.model-settled") continue
    const usage = record(payload?.usage)
    if (usage === undefined) continue
    const read = count(usage.inputTokens), wrote = count(usage.outputTokens), hit = count(usage.cachedInputTokens)
    if (read === undefined && wrote === undefined) continue
    calls += 1
    input += read ?? 0
    output += wrote ?? 0
    if (hit !== undefined) cached = (cached ?? 0) + hit
    if (read !== undefined) context = read
  }
  if (calls === 0) return undefined
  return { input, output, cached, context: context ?? 0, window: seat === undefined ? undefined : knownContextWindowTokens(modelIdOf(seat)) }
}

/** Token counts as the terminal writes them (apps/tui/src/editor.ts `tokens`). */
export const meterTokens = (value: number): string => {
  if (value < 1000) return String(value)
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** The share of the window the latest call filled, in percent. */
export const windowPercent = (meter: RunMeter): number | undefined =>
  meter.window === undefined || meter.window <= 0 ? undefined : (meter.context / meter.window) * 100

/** Cached reads over input across the run, in percent, the terminal's `R / ↑`. */
export const cachePercent = (meter: RunMeter): number | undefined =>
  meter.cached === undefined || meter.input <= 0 ? undefined : Math.min(100, (meter.cached / meter.input) * 100)

export interface RunMeterParts {
  readonly usage: string
  readonly window: string | undefined
  readonly cache: string | undefined
  /** Above 90% of the window. */
  readonly windowDanger: boolean
  /** Below half the input read from cache. */
  readonly cacheWarning: boolean
}

export const runMeterParts = (meter: RunMeter): RunMeterParts => {
  const filled = windowPercent(meter)
  const hit = cachePercent(meter)
  return {
    usage: `↑${meterTokens(meter.input)} ↓${meterTokens(meter.output)}`,
    window: filled === undefined ? undefined : `${filled.toFixed(1)}%/${meterTokens(meter.window!)}`,
    cache: hit === undefined ? undefined : `cache ${Math.round(hit)}%`,
    windowDanger: filled !== undefined && filled > 90,
    cacheWarning: hit !== undefined && hit < 50
  }
}

/** `↑34k ↓2.0k · 7.9%/128k · cache 94%`, omitting the parts the journal cannot say. */
export const runMeterText = (meter: RunMeter): string => {
  const parts = runMeterParts(meter)
  return [parts.usage, parts.window, parts.cache].filter((part) => part !== undefined).join(" · ")
}

/**
 * The meter spelled out for assistive technology, the arrows and the colour
 * levels in words: `34k tokens in, 2.0k out, 7.9% of 128k window, cache 94%`.
 */
export const runMeterLabel = (meter: RunMeter): string => {
  const parts = runMeterParts(meter)
  const filled = windowPercent(meter)
  const hit = cachePercent(meter)
  return [
    `${meterTokens(meter.input)} tokens in, ${meterTokens(meter.output)} out`,
    filled === undefined ? undefined : `${filled.toFixed(1)}% of ${meterTokens(meter.window!)} window${parts.windowDanger ? ", nearly full" : ""}`,
    hit === undefined ? undefined : `cache ${Math.round(hit)}%${parts.cacheWarning ? ", low" : ""}`
  ].filter((part) => part !== undefined).join(", ")
}
