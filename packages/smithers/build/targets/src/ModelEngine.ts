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
 * `claude` spawns a non-persistent, tool-free safe-mode print session and
 * reads its JSON envelope. `codex` spawns an ephemeral read-only exec session
 * with user configuration and targets disabled and reads the last
 * `agent_message` item of its JSONL event stream. Both prompts travel over
 * stdin, never argv.
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
