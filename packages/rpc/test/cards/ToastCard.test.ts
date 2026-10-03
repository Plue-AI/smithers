/**
 * Behavioral projection contract checks for Toast.
 * @since 1.0.0
 */

import { ToastCardSchema } from "../../src/ToastCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Toast.ts"

cardContract("Toast", ToastCardSchema, fixtures)
