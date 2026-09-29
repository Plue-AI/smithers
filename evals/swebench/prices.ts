/**
 * The committed price table the scorecard grades cost with.
 *
 * Prices are USD per million tokens, as published for the OpenAI API. They are
 * committed rather than fetched so that re-scoring an old run reproduces the
 * old number: a price change must be an edit here, with a date, not a silent
 * drift in someone's report.
 *
 * Verified 2026-08-19 against:
 *   - https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/
 *     (the GPT-5.6 launch post: Sol at $5 / $30 per 1M input / output)
 *   - https://www.orcarouter.ai/blog/gpt-5-6-sol-pricing (verified 2026-08-18:
 *     $5.00 input on a cache miss, $0.50 cached input, $30.00 output)
 *   - https://openrouter.ai/openai/gpt-5.6-sol (quotes the same base rates
 *     under a promotional 50% discount, cache read at half of $0.50)
 *
 * A seat the table does not name has undefined cost with an explicit
 * `unpriced` note, never silently at another model's rate.
 *
 * Jev is priced from the journal beside the seat, never folded into the
 * seat's number: `claim-demanded` and `supervisor-settled` carry the usage of
 * the two harness classifiers, and a `cell-call-settled` of the `jev` flow
 * carries the usage of an agent's own call. `decision-settled` carries the
 * same readings without usage and is never priced.
 *
 * @since 0.1.0
 */

/**
 * One model's USD price per million tokens.
 *
 * @category models
 * @since 0.1.0
 */
export interface Price {
  readonly input: number
  readonly cachedInput: number
  readonly cacheWrite: number
  readonly output: number
  readonly source: string
}

/**
 * The gateway id of Jev, as `Evaluator.defaultModel` names it. Every Jev
 * reading a journal records is priced under this row, whichever seat the
 * run's model turns were on.
 *
 * @category constants
 * @since 0.1.0
 */
export const jevModel = "typesafe-ai/jev"

/**
 * The table, keyed by both the bare model id and the seat spelling the flows
 * CLI uses, because a run's journal records the seat and a codex run records
 * the model.
 *
 * @category constants
 * @since 0.1.0
 */
import { modelPrices as table } from "../../packages/backend/modelprice/prices.generated.ts"

export const prices: Record<string, Price> = Object.fromEntries(
  Object.entries(table).map(([id, price]) => [id, {
    input: price.input,
    cachedInput: price.cacheRead,
    cacheWrite: price.cacheWrite,
    output: price.output,
    source: "modelprice Go rate card"
  }])
)
for (const [id, price] of Object.entries(table)) {
  if (price.provider === "openai") prices[`openai:${id}`] = prices[id]!
}
/**
 * Computes USD for one run's token counts.
 *
 * `inputTokens` is the provider's total prompt count and already contains
 * `cachedInputTokens`, so the cached share is billed at the cache-read rate and
 * only the remainder at the input rate. Reasoning tokens are part of the output
 * count and are not billed twice.
 *
 * @category constructors
 * @since 0.1.0
 */
export const usd = (
  model: string | undefined,
  tokens: {
    readonly inputTokens: number
    readonly cachedInputTokens: number
    readonly outputTokens: number
    readonly cacheWriteTokens?: number
  }
): { readonly usd: number | undefined; readonly source: string } => {
  const id = model?.replace(/^openai:/, "")
  const initial = id === undefined ? undefined : table[id]
  if (initial === undefined) {
    return { usd: undefined, source: `unpriced: no committed price for ${model ?? "an unrecorded model"}` }
  }
  const price = initial.next !== undefined && initial.nextFrom !== undefined
      && new Date() >= new Date(initial.nextFrom) ?
    initial.next :
    initial
  const write = tokens.cacheWriteTokens ?? 0
  const prompt = tokens.inputTokens + write
  const rates = price.longContext !== undefined && prompt >= (price.longContextFrom ?? Infinity)
    ? price.longContext :
    price
  const uncached = Math.max(0, tokens.inputTokens - tokens.cachedInputTokens)
  const total = price.flatPerCall ?? 0
  const metered = (uncached * rates.input + tokens.cachedInputTokens * rates.cacheRead
    + write * rates.cacheWrite + tokens.outputTokens * rates.output) / 1_000_000
  return { usd: Math.round((total + metered) * 10_000) / 10_000, source: "modelprice Go rate card" }
}
