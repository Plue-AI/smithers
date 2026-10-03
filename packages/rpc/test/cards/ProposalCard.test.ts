/**
 * Behavioral projection contract checks for Proposal.
 * @since 1.0.0
 */

import { ProposalCardSchema } from "../../src/ProposalCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Proposal.ts"

cardContract("Proposal", ProposalCardSchema, fixtures)
