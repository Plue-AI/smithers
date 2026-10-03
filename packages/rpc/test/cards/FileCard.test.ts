/**
 * Behavioral projection contract checks for File.
 * @since 1.0.0
 */

import { FileCardSchema } from "../../src/FileCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/File.ts"

cardContract("File", FileCardSchema, fixtures)
