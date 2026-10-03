/**
 * Behavioral projection contract checks for Terminal.
 * @since 1.0.0
 */

import { TerminalCardSchema } from "../../src/TerminalCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Terminal.ts"

cardContract("Terminal", TerminalCardSchema, fixtures)
