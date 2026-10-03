/**
 * Behavioral projection contract checks for Members.
 * @since 1.0.0
 */

import { MembersCardSchema } from "../../src/MembersCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Members.ts"

cardContract("Members", MembersCardSchema, fixtures)
