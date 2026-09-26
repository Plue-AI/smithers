/**
 * `organization/routine`: one occurrence of a routine from the routines page.
 *
 * A cron routine's occurrence is keyed by its date in its zone
 * (`routine-<id>-<date>`); a once or onboarding routine is keyed by its id and
 * never runs again after it finished (`autonomy.json`). A task routine is one
 * `organization/assignment` for its role (after the organization's
 * qualification, for `run: qualify`). An onboarding routine runs every listed
 * role's first week, one assignment at a time so it stays inside the host's
 * concurrency and each role's budget: each role writes its onboarding page and
 * proposals; then each reviews two others' pages or proposals and files its
 * requests; then the triage role writes the priorities, which turn accepted
 * proposals into work. Every assignment is keyed, so a restarted host or a
 * second run joins the ones already done.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import { Schema } from "effect"
import * as Config from "../../../packages/smithers/agent/organization/src/Config.ts"
import * as Profile from "../../../packages/smithers/agent/organization/src/Profile.ts"
import Assignment from "../assignment/flow.ts"
import { type Assignment as AssignmentPayload, type AssignmentReport, FinishRoutine, RoutineOccurrence, RunQualification } from "../autonomy.ts"

const implementationVersion = "organization/routine/v1"

/** How a routine's occurrence ended. */
export const RoutineReport = Schema.Struct({
  key: Schema.String,
  status: Schema.Literals(["done", "skipped"]),
  summary: Schema.String,
  assignments: Schema.Array(Schema.Struct({ key: Schema.String, status: Schema.String, summary: Schema.String }))
})
export type RoutineReport = typeof RoutineReport.Type

type Payload = {
  readonly routine: Config.Routine
  readonly roles: ReadonlyArray<string>
  readonly triage: string
}

type Ended = { readonly key: string; readonly status: string; readonly summary: string }

/** One assignment; a failure is its report, so the next one still runs. */
const assign = (payload: Omit<AssignmentPayload, "after">, after: Planned.Planned<string> | undefined): Node.Node<Ended> =>
  Assignment.child({ ...payload, ...(after === undefined ? {} : { after }) } as unknown as AssignmentPayload).pipe(
    Node.map(Node.capture({ implementationVersion }, (report: AssignmentReport): Ended => ({ key: report.key, status: report.status, summary: report.summary }))),
    Node.catch({
      onFailure: Node.capture({ implementationVersion }, (failure): Node.Node<Ended> =>
        Node.all({
          key: Node.succeed(payload.key),
          summary: Node.succeed((failure as Planned.Planned<{ readonly message: string }>).message)
        }).pipe(Node.map(Node.capture({ implementationVersion }, ({ key, summary }): Ended => ({ key, status: "blocked", summary })))))
    })
  ) as Node.Node<Ended>

/** Runs `steps` one after another: each starts once the one before it ended. */
const sequence = (steps: ReadonlyArray<Omit<AssignmentPayload, "after">>): Node.Node<ReadonlyArray<Ended>> => {
  let chain: Node.Node<ReadonlyArray<Ended>> = Node.succeed([])
  steps.forEach((step, index) => {
    chain = chain.pipe(
      Node.bindPlanned(Node.capture({ implementationVersion }, (done) =>
        Node.all({
          done: Node.succeed(done),
          // `after` names the previous result, so this assignment waits for it.
          next: assign(
            step,
            index === 0 ? undefined : (done as unknown as Record<string, { readonly key: Planned.Planned<string> }>)[String(index - 1)]!.key
          )
        }))),
      Node.map(Node.capture({ implementationVersion }, ({ done, next }): ReadonlyArray<Ended> => [...done, next]))
    ) as Node.Node<ReadonlyArray<Ended>>
  })
  return chain
}

/** The onboarding sequence: every role's page and proposals, then every role's review, then the priorities. */
export const onboarding = (id: string, roles: ReadonlyArray<string>, triage: string, repository?: string) => {
  const base = (role: string, kind: AssignmentPayload["kind"], title: string, peers: ReadonlyArray<string>) => ({
    key: `onboarding-${id}-${role}-${kind}`.slice(0, 128),
    role,
    kind,
    title,
    task: "",
    ...(repository === undefined ? {} : { repository }),
    context: [],
    workspace: false,
    routine: id,
    peers
  })
  const peersOf = (index: number) =>
    roles.length < 2 ? [] : [roles[(index + 1) % roles.length]!, ...(roles.length > 2 ? [roles[(index + 2) % roles.length]!] : [])]
  return [
    ...roles.map((role) => base(role, "onboard", "Onboarding", [])),
    ...roles.map((role, index) => base(role, "review", "Onboarding review", peersOf(index))),
    base(triage, "priorities", "Priorities", [])
  ]
}

/** Run one routine occurrence. */
export default Flow.make("organization/routine", {
  description:
    "Run one occurrence of a routine from the routines page: a role's standing task, the qualification and its report, or the one-time onboarding of the listed roles.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: {
    routine: Config.Routine,
    /** The roles an onboarding routine onboards, in order. */
    roles: Schema.Array(Profile.PrincipalId),
    /** The role that writes the onboarding's priorities. */
    triage: Profile.PrincipalId
  },
  success: RoutineReport,
  body: (payload: Payload) =>
    RoutineOccurrence.call({ routine: payload.routine }).pipe(
      Node.bindPlanned(Node.capture({ implementationVersion }, (occurrence) =>
        Node.succeed(occurrence).pipe(Node.branch({
          if: Node.capture({ implementationVersion }, (seen) => seen.run),
          else: () =>
            Node.succeed({ key: occurrence.key, status: "skipped", summary: occurrence.reason, assignments: [] } as unknown as RoutineReport),
          then: () => {
            const routine = payload.routine
            const work: Node.Node<ReadonlyArray<Ended>> = routine.onboarding === true
              ? sequence(onboarding(routine.id, payload.roles, payload.triage, routine.repository))
              : routine.run === "qualify"
              ? RunQualification.call({ key: occurrence.key }).pipe(
                Node.bindPlanned(Node.capture({ implementationVersion }, (qualified) =>
                  assign(taskOf(routine, occurrence.key, qualified.scorecard), undefined))),
                Node.map(Node.capture({ implementationVersion }, (ended): ReadonlyArray<Ended> => [ended]))
              ) as Node.Node<ReadonlyArray<Ended>>
              : assign(taskOf(routine, occurrence.key), undefined).pipe(
                Node.map(Node.capture({ implementationVersion }, (ended): ReadonlyArray<Ended> => [ended]))
              ) as Node.Node<ReadonlyArray<Ended>>
            return work.pipe(
              Node.bindPlanned(Node.capture({ implementationVersion }, (assignments) =>
                FinishRoutine.call({ routine, key: occurrence.key, summary: routine.id }).pipe(
                  Node.andThen(Node.all({ key: Node.succeed(occurrence.key), ended: Node.succeed(assignments) })),
                  Node.map(Node.capture({ implementationVersion }, ({ ended, key }): RoutineReport => ({
                    key,
                    status: "done",
                    summary: `${ended.filter((entry) => entry.status === "done").length}/${ended.length} done`,
                    assignments: ended
                  })))
                )))
            )
          }
        }))))
    )
})

/** A task routine's assignment. */
const taskOf = (routine: Config.Routine, key: Planned.Planned<string>, scorecard?: Planned.Planned<string>): Omit<AssignmentPayload, "after"> => ({
  key: key as unknown as string,
  role: routine.role!,
  kind: "report",
  title: routine.id,
  task: routine.task!,
  ...(routine.repository === undefined ? {} : { repository: routine.repository }),
  context: routine.context ?? [],
  workspace: routine.workspace ?? false,
  ...(routine.output === undefined ? {} : { output: routine.output }),
  routine: routine.id,
  peers: [],
  ...(scorecard === undefined ? {} : { scorecard: scorecard as unknown as string })
})
