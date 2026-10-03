/**
 * Behavioral projection contract checks for ActorChip.
 * @since 1.0.0
 */

import { ActorChipCardSchema } from "../../src/ActorChipCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/ActorChip.ts"

cardContract("ActorChip", ActorChipCardSchema, fixtures)
