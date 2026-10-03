/**
 * Behavioral projection contract checks for TimelineEntry.
 * @since 1.0.0
 */

import { TimelineEntryCardSchema } from "../../src/TimelineEntryCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/TimelineEntry.ts"

cardContract("TimelineEntry", TimelineEntryCardSchema, fixtures)
