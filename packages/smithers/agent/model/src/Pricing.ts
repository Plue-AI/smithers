/**
 * USD prices for model calls.
 *
 * The rates are the backend's rate card, `packages/backend/modelprice`,
 * generated into `internal/prices.generated.ts`; a Go check fails when the two
 * drift, so there is one price table in the tree. A caller that pays other
 * rates passes its own rows over {@link table}.
 *
 * A normalized {@link ModelEvent.Usage} counts cache reads and cache writes
 * inside `inputTokens`, so each class is taken out of the input count and
 * charged at its own rate.
 *
 * @since 1.0.0-rc.1
 */

import { Schema } from "effect"
import { type ModelPrice, modelPrices } from "./internal/prices.generated.ts"
import type * as ModelEvent from "./ModelEvent.ts"

/**
 * USD per million tokens for each token class a provider reports.
 *
 * @category schemas
 * @since 1.0.0-rc.1
 */
export const Rates = Schema.Struct({
  input: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  cacheRead: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  cacheWrite: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  output: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
})

/**
 * The decoded form of {@link Rates}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Rates = typeof Rates.Type

/**
 * One model's rate card: standard rates, an optional long-context card that
 * prices the whole call from `longContextFrom` prompt tokens, and an optional
 * dated successor.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Price = ModelPrice

/**
 * Rate cards keyed by model id or seat (`provider:model`). An override row may
 * be plain {@link Rates}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Table = Readonly<Record<string, Rates | Price>>

/**
 * The backend rate card.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const table: Readonly<Record<string, Price>> = modelPrices

/**
 * Where a cost came from: the provider's own charge, or usage priced here.
 *
 * @category schemas
 * @since 1.0.0-rc.1
 */
export const CostSource = Schema.Literals(["reported", "estimated"])

/**
 * The decoded form of {@link CostSource}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type CostSource = typeof CostSource.Type

/**
 * One call's USD cost and its source.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Cost {
  readonly costUsd: number
  readonly costSource: CostSource
}

/**
 * Options for {@link lookup} and {@link cost}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Options {
  /** Rate cards to use; defaults to {@link table}. Spread {@link table} to override single rows. */
  readonly table?: Table | undefined
  /** The instant whose price applies, in epoch milliseconds; defaults to now. */
  readonly at?: number | undefined
}

const snapshot = /-\d{8}$/

const candidates = (modelId: string): ReadonlyArray<string> => {
  const id = modelId.trim()
  const bare = id.slice(Math.max(id.lastIndexOf("/"), id.lastIndexOf(":")) + 1)
  return [id, bare, bare.replace(snapshot, "")]
}

/**
 * The rate card in effect for a model id at an instant, or `undefined` for a
 * model the table does not price.
 *
 * An exact row wins. Otherwise a seat (`openai:gpt-5.6-sol`) or gateway id
 * (`anthropic/claude-sonnet-5`) resolves to its bare model, and a dated
 * snapshot (`claude-haiku-4-5-20251001`) to its family. A row's dated
 * successor applies from its `nextFrom`.
 *
 * @category resolvers
 * @since 1.0.0-rc.1
 */
export const lookup = (modelId: string, options: Options = {}): Rates | Price | undefined => {
  const rows = options.table ?? table
  const key = candidates(modelId).find((candidate) => Object.hasOwn(rows, candidate))
  if (key === undefined) return undefined
  const at = options.at ?? Date.now()
  // A Rates row has no successor; an undated successor never starts.
  let price = rows[key] as Price
  while (price.next !== undefined && at >= Date.parse(String(price.nextFrom))) price = price.next
  return price
}

/**
 * The rate-weighted token sum of one call: each token class times its rate.
 * With rates in USD per million tokens this is micro-dollars.
 *
 * Input and output counts are required, and every supplied counter must be
 * finite and non-negative, with cache reads and writes inside the input
 * count; anything else is `NaN`, so malformed usage is never priced low.
 *
 * @category accounting
 * @since 1.0.0-rc.1
 */
export const weigh = (usage: ModelEvent.Usage, rates: Rates): number => {
  const counters = [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.cacheWriteTokens]
  if (counters.some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))) return Number.NaN
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return Number.NaN
  const read = usage.cachedInputTokens ?? 0
  const write = usage.cacheWriteTokens ?? 0
  const uncached = usage.inputTokens - read - write
  if (uncached < 0) return Number.NaN
  return uncached * rates.input + read * rates.cacheRead + write * rates.cacheWrite + usage.outputTokens * rates.output
}

/**
 * The USD cost of one call under a rate card, `NaN` for malformed usage (see
 * {@link weigh}). A long-context card prices the whole call once the prompt
 * reaches its threshold.
 *
 * @category accounting
 * @since 1.0.0-rc.1
 */
export const costUsd = (usage: ModelEvent.Usage, price: Rates | Price): number => {
  const card = price as Price
  const rates = card.longContext !== undefined && (usage.inputTokens ?? 0) >= Number(card.longContextFrom) ?
    card.longContext :
    card
  return Math.round(weigh(usage, rates) / 1_000_000 * 1e9) / 1e9
}

/**
 * The cost of one call: the provider's reported charge when there is a valid
 * one, otherwise its usage priced under the model's rate card. `undefined`
 * when neither is available, for an unpriced model or malformed usage.
 *
 * @category accounting
 * @since 1.0.0-rc.1
 */
export const cost = (usage: ModelEvent.Usage, modelId: string | undefined, options: Options = {}): Cost | undefined => {
  if (usage.costUsd !== undefined && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) {
    return { costUsd: usage.costUsd, costSource: "reported" }
  }
  const price = modelId === undefined ? undefined : lookup(modelId, options)
  if (price === undefined) return undefined
  const usd = costUsd(usage, price)
  return Number.isNaN(usd) ? undefined : { costUsd: usd, costSource: "estimated" }
}
