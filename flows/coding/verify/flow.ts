/** Required checks on one retained commit of the mythical stack. */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import { CodingError, type Receipt, type Revision } from "../schema.ts"
import { AdmitVerifySource, verifyImplementation, VerifyInput, VerifyResult, verifySummary } from "../verify-schema.ts"
import { RunCheck } from "../workflow.ts"

/**
 * The stack service runs this on a lane when it had to rebase a candidate
 * onto a newer tip: the lane's own checks measured the old commits, so the
 * rebased tree is checked again before it is proposed. Each receipt binds
 * the exact commit and tree, like every other coding check, and carries the
 * paths the candidate changed so an affected check selects their targets.
 */
export default Flow.make("coding/Verify", {
  description: "Run the project's required checks on one retained commit of the repository's mythical stack.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: VerifyInput,
  success: VerifyResult,
  error: CodingError,
  body: (input) => {
    // Admission refuses a check set that cannot verify anything before any check runs.
    return AdmitVerifySource.call({ source: input.source, checks: input.checks }).pipe(
      Node.bindPlanned((head) =>
        Node.all({
          head: Node.succeed(head),
          receipts: Node.all(
            Object.fromEntries(
              input.checks.map(
                (check) => [
                  check.id,
                  RunCheck.call({
                    implementation: {
                      change: "mythical-candidate",
                      parent: head,
                      atoms: [head],
                      head,
                      reads: [],
                      writes: input.writes
                    },
                    check
                  })
                ]
              )
            )
          )
        }).pipe(
          Node.map((
            { head, receipts }: { head: typeof Revision.Type; receipts: Readonly<Record<string, typeof Receipt.Type>> }
          ) => {
            const result = verifySummary(
              input.checks,
              verifyImplementation(head, input.writes),
              Object.values(receipts)
            )
            return result instanceof CodingError ? { outage: result, result: null } : { outage: null, result }
          }),
          Node.branch({
            if: (summary) => summary.outage !== null,
            then: (summary) => Node.fail(summary.outage as Planned.Planned<CodingError>),
            else: (summary) => Node.succeed(summary.result as Planned.Planned<typeof VerifyResult.Type>)
          })
        )
      )
    )
  }
})
