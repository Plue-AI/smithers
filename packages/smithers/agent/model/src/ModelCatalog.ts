/**
 * Static facts about known provider models.
 *
 * A model id is the only thing a caller has before it reaches a provider, and
 * some decisions have to be made from it alone. This module is where those
 * facts live, beside the protocols that produce the ids, so a consumer that is
 * deliberately provider-neutral never has to carry a provider table of its own.
 *
 * @since 1.0.0-rc.0
 */

/** The default window for a model this catalog has not met. */
const unknownModelTokens = 128_000

const contextWindows: ReadonlyArray<readonly [RegExp, number]> = [
  [/claude.*haiku/i, 200_000],
  // Native 1M windows; older Claude and cloud-prefixed ids stay conservative.
  // https://platform.claude.com/docs/en/build-with-claude/context-windows
  // A numeric minor version (claude-opus-5-5) keeps its family's window.
  [/^claude-(?:(?:opus|sonnet)-5(?:-[0-9]{1,2})?|opus-4-[678]|sonnet-4-6)$/i, 1_000_000],
  [/^claude-(?:fable|mythos)-5(?:-[0-9]+)*$/i, 1_000_000],
  [/claude/i, 200_000],
  // https://developers.openai.com/api/docs/models/gpt-6.1-sol
  [/^gpt-6\.1-sol$/i, 1_050_000],
  // Codex's own model catalog lists gpt-6-* and gpt-5.6-* with one window.
  [/gpt-[56]/i, 400_000],
  [/gpt-4\.1/i, 1_000_000],
  [/gpt-4o/i, 128_000],
  [/^o[134]/i, 200_000],
  // Cerebras serves qwen-3.8-27b at 128K on paid tiers and 64K on the free
  // trial; the paid window is what a keyed seat resolves.
  // https://inference-docs.cerebras.ai/models/qwen-3.8-27b
  [/^qwen-3\.8/i, 128_000]
]

/**
 * The context window, in tokens, of a model id this catalog has met, or
 * `undefined` when no row matches. A display that must not invent a window
 * (a usage meter) reads this; a budget that needs a number reads
 * `contextWindowTokensFor`.
 *
 * @category resolvers
 * @since 1.0.0-rc.1
 */
export const knownContextWindowTokens = (modelId: string): number | undefined => {
  for (const [pattern, tokens] of contextWindows) {
    if (pattern.test(modelId)) return tokens
  }
  return undefined
}

/**
 * The context window, in tokens, of a known model id, with a conservative
 * floor for models the catalog has not met. Never zero: a consumer that reads
 * zero as "compaction disabled" must not have it disabled by a resolver that
 * did resolve a window.
 *
 * @category resolvers
 * @since 1.0.0-rc.0
 */
export const contextWindowTokensFor = (modelId: string): number =>
  knownContextWindowTokens(modelId) ?? unknownModelTokens

// Claude models whose documented output ceiling is 128K tokens.
// https://platform.claude.com/docs/en/about-claude/models/overview
const outputCeilings: ReadonlyArray<readonly [RegExp, number]> = [
  [
    /^claude-(?:(?:opus|sonnet)-5(?:-[0-9]{1,2})?|(?:fable|mythos)-5(?:-[0-9]+)*|opus-4-[678]|sonnet-4-6)$/i,
    128_000
  ]
]

/**
 * The largest output budget, in tokens, a known model accepts, or `undefined`
 * for a model the catalog has not met. A protocol that must state a budget
 * (Anthropic Messages) sends this instead of a guess, so a turn is not cut off
 * below what the model can write.
 *
 * @category resolvers
 * @since 1.0.0-rc.1
 */
export const maxOutputTokensFor = (modelId: string): number | undefined => {
  for (const [pattern, tokens] of outputCeilings) {
    if (pattern.test(modelId)) return tokens
  }
  return undefined
}
