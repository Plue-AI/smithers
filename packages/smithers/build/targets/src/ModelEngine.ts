/**
 * The model CLI vocabulary every target that makes a model call shares.
 *
 * The engine names live in their own module rather than in the review rule
 * that first needed them, so the rule that spawns a CLI and the rule that
 * validates an author's `engine` option read one list. Borrowing the
 * vocabulary from a neighboring rule is how the two drift: the manifest rule
 * used to refuse an unknown engine with a message naming an engine this
 * schema has never admitted.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * The model CLI a target runs a prompt through.
 *
 * Reviews use tool-free provider requests: `claude` selects Anthropic Messages
 * and `codex` selects OpenAI Responses. The generic `promptEngine` utility
 * and explicit trusted-host executable overrides use the corresponding CLI.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Engine = Schema.Literals(["claude", "codex"])

/**
 * The model CLI a target runs a prompt through.
 *
 * @category models
 * @since 0.1.0
 */
export type Engine = typeof Engine.Type
