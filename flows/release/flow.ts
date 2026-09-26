/** The release flow's graph: the file discovery reads, and the value a host runs. */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow, HumanTask } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { Collect } from "../release-content/workflow.ts"
import { ReleaseError, ReleaseInput, ReleaseResult } from "../release-support/schema.ts"
import {
  AuditDocs, Build, Checks, Outcome, Pack, PreparePlan, Publish, Smoke, Validate,
  VerifyCandidate, WritePreparation
} from "./workflow.ts"

type Requirements = Action.Requirement<(
  typeof AuditDocs | typeof PreparePlan | typeof WritePreparation | typeof Validate |
  typeof Checks | typeof Build | typeof Pack | typeof Smoke | typeof VerifyCandidate |
  typeof Publish | typeof Outcome
)["name"]>

export default Flow.make("smithers/Release", {
  description: "Prepare a Smithers release or validate, build, smoke-test and publish its exact npm tarballs with durable human approval.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: ReleaseInput,
  success: ReleaseResult,
  error: Schema.Union([ReleaseError, AgentAction.AgentFailure, HumanTask.HumanTaskFailed]),
  body: (input) => Node.bindPlanned(Collect.call({ version: input.version, from: input.from }), (evidence): Node.Node<ReleaseResult, ReleaseError | AgentAction.AgentFailure | HumanTask.HumanTaskFailed, Requirements> => {
    if (input.phase === "prepare") {
      return Node.bindPlanned(AuditDocs.call({ input, evidence }), (audit) =>
        Node.bindPlanned(PreparePlan.call({ input, evidence, audit }), (plan) => {
          if (input.dryRun) return Outcome.call({ status: "preview" as const, version: input.version, artifact: plan.directory, published: [] })
          return Node.branch(HumanTask.action.call({
            name: "release-preparation", kind: "confirm", prompt: plan.approvalPrompt, maxAttempts: 3
          }), {
            if: (answer) => answer === true,
            then: () => WritePreparation.call({ input, evidence, directory: plan.directory }),
            else: () => Outcome.call({ status: "declined" as const, version: input.version, artifact: plan.directory, published: [] })
          })
        }))
    }
    return Node.bindPlanned(AuditDocs.call({ input, evidence }), (audit) =>
      Node.bindPlanned(Validate.call({ input, evidence, audit }), (validated) =>
      Node.bindPlanned(Checks.call({ evidence: validated }), (checked) =>
        Node.bindPlanned(Build.call({ evidence: checked }), (built) =>
          Node.bindPlanned(Pack.call({ evidence: built }), (candidate) =>
            Node.bindPlanned(Smoke.call({ candidate, runtime: "26.4.0" }), (smoked) =>
                Node.bindPlanned(VerifyCandidate.call({ input, candidate: smoked }), (verified) => {
                  if (input.dryRun) return Outcome.call({ status: "preview" as const, version: input.version, artifact: verified.directory, published: [] })
                  return Node.branch(HumanTask.action.call({
                    name: "npm-publication", kind: "confirm", prompt: verified.approvalPrompt, maxAttempts: 3
                  }), {
                    if: (answer) => answer === true,
                    then: () => Publish.call({ input, candidate: verified }),
                    else: () => Outcome.call({ status: "declined" as const, version: input.version, artifact: verified.directory, published: [] })
                  })
                })))))))
  })
})
