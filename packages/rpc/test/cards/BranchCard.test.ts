/**
 * Behavioral projection contract checks for Branch.
 * @since 1.0.0
 */

import { BranchCardSchema } from "../../src/BranchCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Branch.ts"

cardContract("Branch", BranchCardSchema, fixtures)
