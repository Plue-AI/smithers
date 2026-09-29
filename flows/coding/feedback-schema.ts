/** Pure private control outcome shared with the run projection. */
import * as Fault from "@smthrs/flow/Fault"
import { Schema } from "effect"
import { Result } from "./schema.ts"

/** Every implementation exists; pending check receipts are deliberately absent. */
export class EarlyFeedback extends Schema.TaggedError<EarlyFeedback>()("coding/EarlyFeedback", { result: Result }) {}
// A check failed before the slow ones finished: the plan's to fix.
Fault.register("coding/EarlyFeedback", "factory")
