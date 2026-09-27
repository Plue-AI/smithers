/**
 * Defect recorded when a trampoline lineage runs past its declared round budget.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * A lineage asked for one more round than its flow's `maxRounds` allows.
 *
 * `docs/concepts/trampoline-rounds.md` chooses a budget over loop
 * detection: identical consecutive rounds are legal (a poller is exactly
 * that), so the only honest stop condition is a declared bound on how many
 * rounds one lineage may open. Exceeding it is terminal for the lineage — the
 * round that asked for the handoff is settled with this defect rather than
 * handed off — because a lineage that has run out of budget has nowhere left
 * to continue, and letting it keep going would make the bound advisory.
 *
 * `roundOrdinal` is the zero-based ordinal of the round that was refused, so
 * it always equals `maxRounds` when the refusal is raised.
 *
 * @category errors
 * @since 0.1.0
 */
export class MaxRoundsExceeded extends Schema.TaggedError<MaxRoundsExceeded>()(
  "@smthrs/flow/MaxRoundsExceeded",
  {
    code: Schema.Literal("max_rounds_exceeded").pipe(
      Schema.withConstructorDefault(Effect.succeed("max_rounds_exceeded"))
    ),
    flowName: Schema.String,
    lineageId: Schema.String,
    maxRounds: Schema.Number,
    roundOrdinal: Schema.Number,
    message: Schema.String
  }
) {}
