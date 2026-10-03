/**
 * Behavioral projection contract checks for Secrets.
 * @since 1.0.0
 */

import { SecretsCardSchema } from "../../src/SecretsCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Secrets.ts"

cardContract("Secrets", SecretsCardSchema, fixtures)
