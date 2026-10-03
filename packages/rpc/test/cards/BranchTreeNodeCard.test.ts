/**
 * Behavioral projection contract checks for BranchTreeNode.
 * @since 1.0.0
 */

import { BranchTreeNodeCardSchema } from "../../src/BranchTreeNodeCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/BranchTreeNode.ts"

cardContract("BranchTreeNode", BranchTreeNodeCardSchema, fixtures)
