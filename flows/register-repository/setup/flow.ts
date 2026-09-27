/** Setup after an approved registration: prove this workspace runs the repository's own checks. */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Checks, Clone, or, RegisterError, Repo, SetupReceipt } from "../schema.ts"
import { VerifyStep } from "../workflow.ts"

export default Flow.make("register-repository/setup", {
  description:
    "Set Smithers up for an approved repository: run its detected checks once in this workspace and record the result.",
  capabilities: ["fs:read:**", "proc:spawn:*"],
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: { repo: Repo, commit: Clone.fields.commit, checks: or(Checks) },
  success: SetupReceipt,
  error: RegisterError,
  body: ({ repo, commit, checks }) =>
    VerifyStep.call({ repo, commit, checks }).pipe(Node.map((runs) => ({ repo, commit, runs })))
})
