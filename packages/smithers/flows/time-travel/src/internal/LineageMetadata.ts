/**
 * The lineage a journal entry's open metadata names.
 *
 * Replay, rewind validation, and the snapshot projector all read `lineageId`
 * off `entry.meta`; they decode it with this one schema.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * Admits the lineage identity carried in journal metadata.
 *
 * @since 0.1.0
 * @category schemas
 */
export const LineageMetadata = Schema.Struct({ lineageId: Schema.NonEmptyString })
