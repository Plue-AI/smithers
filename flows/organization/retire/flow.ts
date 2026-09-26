/**
 * `organization/retire`: retires a hired principal and everything it hired.
 *
 * Retirement is terminal: every grant is revoked, `retiredAt` is recorded,
 * and the memory namespace is kept so the principal's history stays
 * attributable. Each retired profile is rewritten in
 * `<rosterDir>/Specialists/` with compare-and-set, the roster is pinned with
 * them, and from then on every dispatch to one of them, or to anything they
 * hired, is refused. A core role is retired by editing its page, not here.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import * as Profile from "../../../packages/smithers/agent/organization/src/Profile.ts"
import { finish } from "../delegate/flow.ts"
import { RequestKey } from "../schema.ts"
import { Retire, StaffFailed, type StaffReport, StaffReport as Report } from "../staff.ts"

const implementationVersion = "organization/retire/v1"

/** Retire one hire and its hires. */
export default Flow.make("organization/retire", {
  description:
    "Retire a hired principal and everything it hired: grants revoked, retirement recorded in the roster with a receipt, and every later dispatch refused.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  idempotencyKey: (payload) => payload.key,
  payload: { key: RequestKey, principal: Profile.PrincipalId },
  success: Report,
  error: Schema.Union([StaffFailed, Actions.ReceiptFailed]),
  body: (payload) =>
    Retire.call({ key: payload.key, principal: payload.principal }).pipe(
      Node.map(Node.capture({ implementationVersion, key: payload.key, principal: payload.principal }, function(outcome) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- tsc needs it for inference
        return {
          key: this.key,
          status: outcome.retired.length === 0 ? "refused" : "retired",
          summary: outcome.reason,
          principal: this.principal,
          paths: outcome.paths
        } as StaffReport
      })),
      Node.bindPlanned(Node.capture({ implementationVersion }, (outcome) =>
        finish(payload.key, "retire", payload, outcome)))
    )
})
