/**
 * Behavioral projection contract checks for ContextLine.
 * @since 1.0.0
 */

import { ContextLineCardSchema } from "../../src/ContextLineCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/ContextLine.ts"

cardContract("ContextLine", ContextLineCardSchema, fixtures)
