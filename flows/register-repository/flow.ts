/**
 * Register a repository: analyze it from one link, wait for Smithers admin review, then set it up.
 * Every step answers one question itself and journals a typed result; docs/mvp/REGISTRATION.md.
 */
import { Flow, HumanTask } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { Input, Outcome, RegisterError } from "./schema.ts"
import Setup from "./setup/flow.ts"
import {
  AgentShareStep,
  ChecksStep,
  CiStep,
  CleanupStep,
  CloneStep,
  CommitsStep,
  ContributorsStep,
  IntakeStep,
  LanguagesStep,
  LicenseStep,
  ReadinessStep,
  ThemeStep,
  WorkflowsStep
} from "./workflow.ts"

export const REVIEW = "register-repository/review"
export const DECLINE_NOTE = "register-repository/decline-note"
export const APPROVE = "Approve"
export const DECLINE = "Decline"

export default Flow.make("register-repository", {
  description:
    "Register a GitHub repository with Smithers: analyze it from its link (theme, license, checks, agent readiness, cleanup opportunities, commits, contributors, contribution intake, workflows to build, CI estimate), wait for Smithers admin review, then set it up.",
  capabilities: ["fs:read:**", "proc:spawn:*", "net:post:*", "model:call:*"],
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Input,
  success: Outcome,
  error: Schema.Union([RegisterError, HumanTask.HumanTaskFailed]),
  body: ({ link }) =>
    CloneStep.call({ link }).pipe(
      Node.bindPlanned((clone) =>
        ChecksStep.call({ clone }).pipe(
          Node.bindPlanned((checks) =>
            Node.all({
              clone: Node.succeed(clone),
              checks: Node.succeed(checks),
              readiness: ReadinessStep.call({ clone, checks }),
              theme: ThemeStep.call({ clone }),
              license: LicenseStep.call({ clone }),
              cleanup: CleanupStep.call({ clone }),
              agentShare: AgentShareStep.call({ clone }),
              commits: CommitsStep.call({ clone }),
              contributors: ContributorsStep.call({ clone }),
              intake: IntakeStep.call({ clone }),
              workflows: WorkflowsStep.call({ clone }),
              ci: CiStep.call({ clone }),
              languages: LanguagesStep.call({ clone })
            })
          )
        )
      ),
      Node.map((found) => ({ repo: found.clone.repo, ...found })),
      Node.bindPlanned((report) =>
        Node.succeed(report).pipe(
          Node.map((value) => `Register ${value.repo}?`),
          Node.bindPlanned((prompt) =>
            HumanTask.action.call({ name: REVIEW, kind: "select", prompt, options: [APPROVE, DECLINE] })
          ),
          Node.branch({
            if: (answer) => answer === APPROVE,
            then: () =>
              Node.succeed(report).pipe(
                Node.map((value) => ({ repo: value.repo, commit: value.clone.commit, checks: value.checks })),
                Node.bindPlanned((input) => Node.all({ report: Node.succeed(report), setup: Setup.child(input) })),
                Node.map(({ report, setup }) => ({ report, review: { decision: "approve" as const, note: "" }, setup }))
              ),
            else: () =>
              Node.succeed(report).pipe(
                Node.map((value) => `Why decline ${value.repo}?`),
                Node.bindPlanned((prompt) => HumanTask.action.call({ name: DECLINE_NOTE, kind: "ask", prompt })),
                Node.bindPlanned((note) => Node.all({ report: Node.succeed(report), note: Node.succeed(note) })),
                Node.map(({ report, note }) => ({
                  report,
                  review: { decision: "decline" as const, note: typeof note === "string" ? note.slice(0, 2000) : "" },
                  setup: null
                }))
              )
          })
        )
      )
    )
})
