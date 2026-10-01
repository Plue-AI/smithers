import * as Evaluator from "@smthrs/model/Evaluator"
import { Schema } from "effect"

// Archived declaration immediately before 6206550ccc (#3161). The sole
// representation change was the addition of approval_unavailable. Current
// EvaluatorError fields are also pinned by the complete rc.115 preimage.
// This fixture retains the original declaration for durable replay; it does
// not install a second production error family or relax a current schema.
export class HarnessErrorBeforeApproval extends Schema.TaggedError<HarnessErrorBeforeApproval>()(
  "/harness/HarnessError",
  {
    code: Schema.Literals([
      "assembly_failed",
      "incompatible_journal",
      "render_failed",
      "model_failed",
      "engine_failed",
      "read_only_cap",
      "completion_unjudged",
      "completion_incomplete",
      "claim_unproven",
      "suspended"
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Union([Evaluator.EvaluatorError, Schema.Defect()]))
  }
) {}
