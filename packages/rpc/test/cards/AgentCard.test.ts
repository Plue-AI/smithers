/**
 * Behavioral projection contract checks for Agent.
 * @since 1.0.0
 */

import { AgentCardSchema } from "../../src/AgentCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Agent.ts"

cardContract("Agent", AgentCardSchema, fixtures)
