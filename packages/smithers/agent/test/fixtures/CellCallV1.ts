import { Schema } from "effect"

// Archived wire declaration from 580c67600b^:packages/smithers/agent/harness/src/Cell.ts.
// Keep this independent of the current Cell module: it writes the pre-A2 fixture.
// flow_withheld added when CallFailureCode gained it (#1929).
const CallFailureCode = Schema.Literals([
  "unknown_flow",
  "capability_refused",
  "truncated_write",
  "declaration_changed",
  "invalid_input",
  "unimplemented",
  "timeout",
  "run_completed",
  "checkpoint_unavailable",
  "checkpoint_exhausted",
  "checkpoint_readonly",
  "checkpoint_unsupported",
  "flow_failed",
  "flow_withheld"
])

export class CallResult extends Schema.Class<CallResult>("flows/harness/Cell/CallResult")({
  outcome: Schema.Literals(["success", "failure"]),
  value: Schema.Json,
  message: Schema.optional(Schema.String),
  code: Schema.optional(CallFailureCode)
}) {}

// Historical rc.112 material remains pinned independently. Effect rc.115
// omits the default Union mode in SchemaRepresentation, changing sealed keys.
// Current main also folds boundary and declaration digests into the preimage;
// the rc.115 fixture pins that complete representation independently.
export const key = "key1_8ab2962732794ee8d8b3bf550657b41d475fd082ec9c8c7073b1d24a8d77d4b9"

// Moved again when `HarnessErrorCode` gained `completion_unjudged`, and once
// more when it gained `claim_unproven`: the wire declaration folded into the
// preimage carries the whole error union, so a new member is a new declaration
// digest and a new sealed key. That is what the digest is for. In-flight runs
// finish under the declaration they started on; a new run is keyed under this
// one. Moved when CallFailureCode gained flow_withheld (#1929), and when
// `HarnessError.cause` gained the typed `EvaluatorError` member (#2807), and
// when that member carried what a failed reading paid (#3010).
export const effect115Key = "key1_a839b582877e4aed09963b2cc3aa15af094379d286e83018dd67dd3efb06d4c8"

// Independent JSON oracle. This fixture contains only JSON values, no schema
// classes, undefined, non-finite numbers or other normalization cases.
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([name, child]) => `${JSON.stringify(name)}:${canonical(child)}`).join(",")
    }}`
  }
  return JSON.stringify(value)
}
