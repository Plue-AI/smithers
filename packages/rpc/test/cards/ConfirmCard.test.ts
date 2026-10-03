/**
 * Behavioral projection contract checks for Confirm.
 * @since 1.0.0
 */

import { ConfirmCardSchema } from "../../src/ConfirmCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Confirm.ts"

cardContract("Confirm", ConfirmCardSchema, fixtures)
