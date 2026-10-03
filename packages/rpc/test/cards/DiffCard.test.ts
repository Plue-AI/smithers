/**
 * Behavioral projection contract checks for Diff.
 * @since 1.0.0
 */

import { DiffCardSchema } from "../../src/DiffCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Diff.ts"

cardContract("Diff", DiffCardSchema, fixtures)
