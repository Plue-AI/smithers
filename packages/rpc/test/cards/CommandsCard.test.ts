/**
 * Behavioral projection contract checks for Commands.
 * @since 1.0.0
 */

import { CommandsCardSchema } from "../../src/CommandsCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Commands.ts"

cardContract("Commands", CommandsCardSchema, fixtures)
