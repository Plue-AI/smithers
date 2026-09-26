/**
 * `organization/deliver`: one admitted request carried from the assistant to
 * a landed branch.
 *
 * The assistant routes the request (the host does, for a request that names
 * its role); the role it hands off to (the lead) writes a contract naming a
 * builder and an independent checker; the builder works in a microVM
 * workspace; the change is collected, checked in a fresh machine, and judged
 * by the checker, for at most `maxRounds` rounds; an approved change lands on
 * a branch of the host repository, never the checked-out one, and with the
 * repository's landing `pr` that branch is pushed and opened as a pull
 * request. Every handoff and verdict is posted to the team channel. Every
 * ending, including a failure, writes a receipt under the organization's
 * generated directory and, for a Slack request, ends its thread with one line
 * that links what it names, and turns the owner's 👀 into ✅ or ❌.
 *
 * A question is not a task: the assistant answers it (`fields.answer`), or
 * routes it to the role that knows (`fields.question`), which answers it in
 * one reply with no contract, workspace, or checks.
 *
 * Gates attach at two named boundaries, from the admission's policy:
 *
 * - `task` / `organization/deliver`, before the builder starts, about the
 *   request and the assignment;
 * - `external-write` / `organization/apply-change`, before the change lands,
 *   about the patch digest, the files, and the check result.
 *
 * An empty policy adds no node.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import { Schema } from "effect"
import * as Slack from "../../../packages/smithers/agent/integrations/src/slack/Actions.ts"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import * as Gates from "../../../packages/smithers/agent/organization/src/Gates.ts"
import type * as Profile from "../../../packages/smithers/agent/organization/src/Profile.ts"
import type * as Workspace from "../../../packages/smithers/agent/organization/src/Workspace.ts"
import {
  Admission,
  AgainTask,
  Answer,
  AnswerTask,
  Assign,
  type Assignment,
  BuildTask,
  CheckTask,
  Closing,
  CorrectTask,
  Decide,
  DeliveryFailed,
  Describe,
  LeadTask,
  RenderReply,
  Report,
  Request,
  RouteTask,
  Settle,
  type Stage,
  StepFailure,
  DisposeWorkspaces,
  hostFields,
  HostRoute,
  PublishChange,
  React,
  ReadAsk,
  WriteDocument
} from "../schema.ts"
import { fieldTurn } from "../field-turn.ts"
import type { Ref } from "../links.ts"
import Delegate from "../delegate/flow.ts"
import Hire from "../hire/flow.ts"
import MeetingsBook from "../meetings-book/flow.ts"
import { slackConnection } from "../slack-connection.ts"
import { TeamPost } from "../team-channel.ts"

const implementationVersion = "organization/deliver/v11"

/** Why a builder whose turn left no change is asked again. */
const noChangeAgain =
  "Your turn left no change in the workspace: the collected diff is empty. Make the change the criteria require, read the output of your commands, then answer. If the change cannot be made, answer blocked with the reason."

/** The check an empty change fails, as a report shows it. */
const noChangeCheck = {
  name: Actions.changeCheck,
  exitCode: 1,
  timedOut: false,
  durationMs: 0,
  tail: "no change: the collected diff is empty"
}

/** The boundary the builder's task crosses. */
export const taskGate: Gates.At = { boundary: "task", target: "organization/deliver" }
/** The boundary a landing crosses. */
export const landGate: Gates.At = { boundary: "external-write", target: "organization/apply-change" }

type Payload = { readonly request: typeof Request.Type; readonly admission: typeof Admission.Type }

type TurnWorkspace = {
  readonly key: Planned.Planned<string>
  readonly repository: string
  readonly commit: Planned.Planned<string>
}

/** One ask: compose, run under the principal's own host, check against its charter. */
const ask = (revision: Planned.Planned<string>, stage: Planned.Planned<Stage>, workspace?: TurnWorkspace) =>
  Actions.ComposeTask.call({
    revision,
    principal: stage.principal,
    task: stage.task,
    context: stage.context,
    // The key and commit are planned references the engine resolves inside the struct.
    ...(workspace === undefined
      ? {}
      : { workspace: workspace as unknown as { key: string; repository: string; commit: string } })
  }).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (payload) => Actions.RoleTask.call(payload))),
    Node.bindPlanned(Node.capture({ implementationVersion }, (result) =>
      Node.all({
        principal: Node.succeed(stage.principal),
        result: Node.succeed(result),
        // A host field (a hire, a meeting) is an ask of the host, not charter output.
        validation: Node.succeed(result).pipe(
          Node.map(Node.capture({ implementationVersion, hostFields }, function(answer): Profile.RoleResult {
            const fields = { ...answer.fields }
            for (const name of this.hostFields) delete fields[name]
            return { ...answer, fields }
          })),
          Node.bindPlanned(Node.capture({ implementationVersion }, (charterOnly) =>
            Actions.ValidateResult.call({ revision, principal: stage.principal, result: charterOnly })))
        )
      })))
  )

/**
 * One principal's turn. A result that breaks the charter (a missing field
 * on `done`, a field the charter does not declare on any status) is asked
 * again once, with the violations in its context; the second answer stands.
 */
export const turn = (revision: Planned.Planned<string>, stage: Planned.Planned<Stage>, workspace?: TurnWorkspace) =>
  ask(revision, stage, workspace).pipe(
    Node.branch({
      if: Node.capture({ implementationVersion }, (seen) => !seen.validation.valid),
      then: (seen) =>
        CorrectTask.call({ stage, result: seen.result, validation: seen.validation }).pipe(
          Node.bindPlanned(Node.capture({ implementationVersion }, (corrected) => ask(revision, corrected, workspace)))
        ),
      else: (seen) => Node.succeed(seen)
    }),
    Node.map(Node.capture({ implementationVersion }, (seen): Answer => ({
      principal: seen.principal,
      result: seen.result,
      valid: seen.validation.valid,
      violations: seen.validation.violations.map((violation) => violation.message)
    })))
  )

type Failure = typeof StepFailure.Type

/**
 * A report node. `fields` may hold planned references, which the engine
 * resolves wherever they sit; the declared type cannot say so.
 */
const report = (payload: Payload, fields: Readonly<Record<string, unknown>>): Node.Node<Report> =>
  Node.succeed({ key: payload.request.key, ...fields } as unknown as Report)

/** Every workspace machine a delivery has prepared so far: the builder's, then each round's checker's. */
type Machines = ReadonlyArray<Planned.Planned<Workspace.Prepared> | Planned.Planned<Workspace.Prepared | null>>

/**
 * One build-collect-check-judge round, and the next one while the checker
 * asks for changes. Every machine the delivery prepared stays until it ends
 * (a run parked at a gate resumes into them after a restart), and every
 * ending removes them all.
 */
const round = (
  payload: Payload,
  revision: Planned.Planned<string>,
  assignment: Planned.Planned<Assignment>,
  prepared: Planned.Planned<Workspace.Prepared>,
  n: number,
  findings: Planned.Planned<ReadonlyArray<string>> | ReadonlyArray<string>,
  machines: Machines
): Node.Node<Report, Failure, any> => {
  const { admission, request } = payload
  const principals = {
    assistant: admission.assistant,
    lead: assignment.lead,
    builder: assignment.builder,
    checker: assignment.checker
  }
  const disposeAll = (all: Machines) => DisposeWorkspaces.call({ workspaces: all as never })
  const workspace = { key: prepared.key, repository: admission.repository, commit: prepared.commit }
  // The diff is read only after the builder's turn has finished: a step
  // that does not consume a reference may otherwise start beside it.
  const collected = (build: Planned.Planned<Answer>) =>
    Node.andThen(Node.succeed(build), Actions.CollectDiff.call({ workspace: prepared }))
  // A turn that left no change is asked once more; a second empty change
  // blocks the delivery, and nothing is checked or landed.
  return BuildTask.call({ request, assignment, workdir: prepared.workdir, round: n, findings }).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (stage) =>
      turn(revision, stage, workspace).pipe(
        Node.bindPlanned(Node.capture({ implementationVersion }, (build) =>
          collected(build).pipe(
            Node.branch({
              if: Node.capture({ implementationVersion }, (diff) => diff.patch === ""),
              then: () =>
                AgainTask.call({ stage, reason: noChangeAgain }).pipe(
                  Node.bindPlanned(Node.capture({ implementationVersion }, (again) => turn(revision, again, workspace))),
                  Node.bindPlanned(Node.capture({ implementationVersion }, (rebuilt) =>
                    collected(rebuilt).pipe(
                      Node.branch({
                        if: Node.capture({ implementationVersion }, (diff) => diff.patch === ""),
                        then: () =>
                          disposeAll(machines).pipe(
                            Node.andThen(Node.succeed(rebuilt)),
                            Node.map(Node.capture({ implementationVersion }, (answer) =>
                              `no change: ${answer.principal} left no change in the workspace (${answer.result.status}: ${answer.result.summary})`)),
                            Node.bindPlanned(Node.capture({ implementationVersion }, (summary) =>
                              report(payload, {
                                status: "blocked",
                                summary,
                                principals,
                                rounds: n,
                                checks: [noChangeCheck]
                              })))
                          ),
                        else: (diff) => judged(rebuilt, diff)
                      })
                    )))
                ),
              else: (diff) => judged(build, diff)
            })
          )))
      )))
  ) as Node.Node<Report, Failure, any>

  function judged(build: Planned.Planned<Answer>, diff: Planned.Planned<Workspace.Diff>): Node.Node<Report, Failure, any> {
    return Actions.RunChecks.call({
            repository: admission.repository,
            commit: prepared.commit,
            patch: diff.patch,
            checks: admission.checks
          }).pipe(
            Node.bindPlanned(Node.capture({ implementationVersion }, (checks) =>
              CheckTask.call({ request, assignment, workdir: prepared.workdir, round: n, build, diff, checks }).pipe(
                // A checker that holds a workspace in the repository reproduces
                // the change in a machine of its own, seeded from the same
                // commit with the collected change applied; any other judges
                // the diff and the receipts.
                Node.branch({
                  if: Node.capture({ implementationVersion }, (stage) => stage.workspace === true),
                  then: (stage) =>
                    Actions.PrepareWorkspace.call({
                      repository: admission.repository,
                      commit: prepared.commit,
                      slug: `check-${n}`,
                      patch: diff.patch
                    }).pipe(
                      Node.bindPlanned(Node.capture({ implementationVersion }, (checking) =>
                        Node.all({
                          check: turn(revision, stage, {
                            key: checking.key,
                            repository: admission.repository,
                            commit: checking.commit
                          }).pipe(
                            Node.catch({
                              onFailure: Node.capture({ implementationVersion }, (failure) =>
                                disposeAll([...machines, checking]).pipe(
                                  Node.andThen(Node.fail(failure as Planned.Planned<Failure>))
                                ))
                            })
                          ),
                          checking: Node.succeed(checking)
                        })))
                    ),
                  else: (stage) => Node.all({ check: turn(revision, stage), checking: Node.succeed(null) })
                }),
                Node.bindPlanned(Node.capture({ implementationVersion }, (checked) => {
                  const check = checked.check
                  const all: Machines = [...machines, checked.checking]
                  return Decide.call({ build, check, checks, diff }).pipe(
                    Node.bindPlanned(Node.capture({ implementationVersion, n }, function(verdict) {
                      return say(payload, assignment.checker, Node.succeed(verdict).pipe(
                        Node.map(Node.capture({ implementationVersion, n: this.n }, function(seen) {
                          return seen.approved ? `Round ${this.n}: approved` : `Round ${this.n}: changes requested: ${(seen.findings[0] ?? "").slice(0, 160)}`
                        }))
                      )).pipe(Node.andThen(Node.succeed(verdict)))
                    })),
                    Node.branch({
                      if: Node.capture({ implementationVersion }, (verdict) => verdict.approved),
                      then: (verdict) =>
                        Gates.before(
                          admission.gates,
                          landGate,
                          {
                            repository: admission.repository,
                            branch: admission.branch,
                            parent: prepared.commit,
                            patchDigest: diff.digest,
                            files: diff.files,
                            checksPassed: checks.passed,
                            approvedBy: assignment.checker
                          },
                          Actions.ApplyChange.call({
                            repository: admission.repository,
                            branch: admission.branch,
                            parent: prepared.commit,
                            patch: diff.patch,
                            message: assignment.message,
                            principal: assignment.builder,
                            at: admission.at
                          })
                        ).pipe(
                          Node.bindPlanned(Node.capture({ implementationVersion }, (applied) =>
                            Node.andThen(Node.succeed(applied), disposeAll(all)).pipe(
                              Node.andThen(published(payload, assignment, applied, verdict.checks, {
                                status: "landed",
                                summary: check.result.summary,
                                principals,
                                rounds: n,
                                applied,
                                checks: verdict.checks
                              }))
                            )))
                        ),
                      else: (verdict) =>
                        n >= admission.maxRounds
                          ? disposeAll(all).pipe(
                            Node.andThen(report(payload, {
                              status: "changes-requested",
                              summary: check.result.summary,
                              principals,
                              rounds: n,
                              findings: verdict.findings,
                              checks: verdict.checks
                            }))
                          )
                          : round(payload, revision, assignment, prepared, n + 1, verdict.findings, all)
                    }),
                    // A failure after the checker's turn (a declined gate, a
                    // landing refused) removes this round's machines too.
                    Node.catch({
                      onFailure: Node.capture({ implementationVersion }, (failure) =>
                        disposeAll(all).pipe(Node.andThen(Node.fail(failure as Planned.Planned<Failure>))))
                    })
                  )
                }))
              )))
          ) as Node.Node<Report, Failure, any>
  }
}

/**
 * A landed change's report. With the repository's landing `pr` the branch is
 * pushed and opened as a pull request first, and the report names it; a
 * push or pull request that fails fails the delivery, and the branch stays.
 */
const published = (
  payload: Payload,
  assignment: Planned.Planned<Assignment>,
  applied: Planned.Planned<Workspace.Applied>,
  checks: Planned.Planned<ReadonlyArray<unknown>>,
  fields: Readonly<Record<string, unknown>>
): Node.Node<Report, Failure, any> => {
  const pull = payload.admission.pull
  if (pull === undefined) return report(payload, fields)
  return PublishChange.call({
    key: payload.request.key,
    repository: payload.admission.repository,
    remote: pull.remote,
    github: pull.github,
    applied,
    title: assignment.message,
    lead: assignment.lead,
    ...(payload.request.issue === undefined ? {} : { issue: payload.request.issue }),
    checks: checks as never
  }).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (opened) => report(payload, { ...fields, pull: opened })))
  ) as Node.Node<Report, Failure, any>
}

/** A post to the team channel in the request's thread, under `role`'s name. */
const say = (payload: Payload, role: Planned.Planned<string> | string, text: Node.Node<string, any, any>): Node.Node<unknown, Failure, any> =>
  text.pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (line) =>
      TeamPost.call({ thread: payload.request.key, role: role as string, text: line })))
  ) as Node.Node<unknown, Failure, any>

/** The assistant's route, or the host's when the request names its role. */
const routed = (payload: Payload, revision: Planned.Planned<string>): Node.Node<Answer, Failure, any> =>
  (payload.request.role === undefined
    ? RouteTask.call({ revision, assistant: payload.admission.assistant, request: payload.request }).pipe(
      Node.bindPlanned(Node.capture({ implementationVersion }, (stage) => turn(revision, stage)))
    )
    : HostRoute.call({ revision, assistant: payload.admission.assistant, request: payload.request })) as Node.Node<Answer, Failure, any>

/** Routing, the contract, the gated build, and every early ending, as one report. */
const work = (payload: Payload) => {
  const { admission, request } = payload
  return Actions.PinRoster.call({}).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (pin) =>
      routed(payload, pin.revision).pipe(
        Node.bindPlanned(Node.capture({ implementationVersion }, (routed) =>
          withAsk(payload, routed, () =>
          questioned(payload, pin.revision, routed, () =>
          say(payload, admission.assistant, Node.succeed(routed).pipe(
            Node.map(Node.capture({ implementationVersion }, (seen) => {
              const handoff = seen.result.handoffs[0]
              return handoff === undefined ? `Answered: ${seen.result.summary.slice(0, 200)}` : `Handoff → ${handoff.to}`
            }))
          )).pipe(Node.andThen(
          LeadTask.call({ revision: pin.revision, request, repository: admission.repository, routed }))).pipe(
            Node.branch({
              if: Node.capture({ implementationVersion }, (stage) => stage.proceed),
              else: (stage) =>
                report(payload, {
                  status: stage.outcome,
                  summary: stage.reason,
                  principals: { assistant: admission.assistant },
                  rounds: 0
                }),
              then: (stage) =>
                turn(pin.revision, stage).pipe(
                  Node.bindPlanned(Node.capture({ implementationVersion }, (answered) =>
                  withAsk(payload, answered, () => Node.succeed(answered).pipe(
                  Node.branch({
                    // A valid `done` with no handoffs is the role's own answer: a document, not a change.
                    if: Node.capture({ implementationVersion }, (contract) =>
                      contract.valid && contract.result.status === "done" && contract.result.handoffs.length === 0),
                    then: (contract) => documented(payload, pin.revision, contract),
                    else: (contract) =>
                    Assign.call({ revision: pin.revision, key: request.key, repository: admission.repository, contract }).pipe(
                      Node.branch({
                        if: Node.capture({ implementationVersion }, (assignment) => assignment.proceed),
                        else: (assignment) =>
                          report(payload, {
                            status: "blocked",
                            summary: assignment.reason,
                            principals: { assistant: admission.assistant, lead: contract.principal },
                            rounds: 0
                          }),
                        then: (assignment) =>
                          Node.succeed(assignment).pipe(Node.branch({
                            if: Node.capture({ implementationVersion }, (planned) => planned.delegate !== null),
                            then: (planned) =>
                              child(payload, "organization/delegate", contract.principal, Delegate.child(planned.delegate as never)),
                            else: () =>
                          say(payload, contract.principal, Node.succeed(assignment).pipe(
                            Node.map(Node.capture({ implementationVersion }, (planned) =>
                              `Handoff → ${planned.builder} builds, ${planned.checker} checks: ${planned.objective.slice(0, 160)}`))
                          )).pipe(
                            Node.andThen(Gates.before(
                              admission.gates,
                              taskGate,
                              { request: request.text, assignment },
                              based(payload).pipe(
                                Node.branch({
                                  if: Node.capture({ implementationVersion }, (base) => base.commit !== null),
                                  else: (base) =>
                                    report(payload, {
                                      status: "blocked",
                                      summary: base.reason,
                                      principals: { assistant: admission.assistant, lead: contract.principal },
                                      rounds: 0
                                    }),
                                  then: (base) =>
                              Actions.PrepareWorkspace.call({
                                repository: admission.repository,
                                commit: base.commit as Planned.Planned<string>,
                                slug: "build"
                              }).pipe(
                                Node.bindPlanned(Node.capture({ implementationVersion }, (prepared) =>
                                  round(payload, pin.revision, assignment, prepared, 1, [], [prepared]).pipe(
                                    // Every ending removes the workspace machine: a failed
                                    // round disposes it before it is reported.
                                    Node.catch({
                                      onFailure: Node.capture({ implementationVersion }, (failure) =>
                                        Actions.DisposeWorkspace.call({ workspace: prepared }).pipe(
                                          Node.andThen(failed(payload, failure))
                                        ))
                                    })
                                  )))
                              )
                                })
                              )
                            ))
                          )
                          }))
                      })
                    )
                  })
                ))))
                )
            })
          )))))
      )))
  )
}

/**
 * A question's delivery: the assistant's own answer, or the answer of the one
 * role it routed the question to (`fields.question`), as the report whose
 * thread ends with it. Anything else is not a question and goes on.
 */
const questioned = (
  payload: Payload,
  revision: Planned.Planned<string>,
  routed: Planned.Planned<Answer>,
  otherwise: () => Node.Node<Report, Failure, any>
): Node.Node<Report, Failure, any> => {
  const answeredBy = (answer: Node.Node<Answer, any, any>) =>
    answer.pipe(Node.map(Node.capture({ implementationVersion, key: payload.request.key, assistant: payload.admission.assistant }, function(seen): Report {
      // The answer a valid `done` result carries in `fields.answer`; empty when none.
      const field = seen.result.fields["answer"]
      const text = seen.valid && seen.result.status === "done" && typeof field === "string" ? field.trim() : ""
      const principals = { assistant: this.assistant, lead: seen.principal }
      return text === ""
        ? { key: this.key, status: "blocked", summary: seen.result.summary, principals, rounds: 0 }
        : { key: this.key, status: "answered", summary: text.slice(0, 2_000), principals, rounds: 0, answer: { principal: seen.principal, text } }
    }))) as Node.Node<Report, Failure, any>
  return Node.succeed(routed).pipe(Node.branch({
    if: Node.capture({ implementationVersion }, (seen) =>
      seen.valid && seen.result.status === "done" && seen.result.handoffs.length === 0 &&
      typeof seen.result.fields["answer"] === "string" && seen.result.fields["answer"].trim() !== ""),
    then: () => answeredBy(Node.succeed(routed)),
    else: () =>
      Node.succeed(routed).pipe(Node.branch({
        if: Node.capture({ implementationVersion }, (seen) =>
          seen.valid && seen.result.status === "done" && seen.result.fields["question"] === true && seen.result.handoffs.length === 1),
        then: () =>
          AnswerTask.call({ revision, request: payload.request, routed }).pipe(
            Node.bindPlanned(Node.capture({ implementationVersion }, (stage) => answeredBy(fieldTurn(revision, stage, ["answer"]))))
          ),
        else: () => otherwise()
      }))
  })) as Node.Node<Report, Failure, any>
}

/**
 * The commit the task starts from, or why there is none: a base that could
 * not be fetched blocks the delivery before any machine boots.
 */
const based = (payload: Payload) =>
  Actions.ResolveBase.call({ repository: payload.admission.repository, commit: payload.admission.commit }).pipe(
    Node.map(Node.capture({ implementationVersion }, (resolved): { commit: string | null; reason: string } => ({
      commit: resolved.commit,
      reason: ""
    }))),
    Node.catch({
      onFailure: Node.capture({ implementationVersion }, (failure) =>
        Node.succeed(failure as Planned.Planned<{ readonly message: string }>).pipe(
          Node.map(Node.capture({ implementationVersion }, (refused): { commit: string | null; reason: string } => ({
            commit: null,
            reason: `the base could not be resolved: ${refused.message}`
          })))
        ))
    })
  )

/**
 * A child flow's ending as the delivery's: its summary answers the request,
 * and a child that did not finish its work blocks it with its reason.
 */
const child = (
  payload: Payload,
  flow: string,
  principal: Planned.Planned<string>,
  run: Node.Node<{ readonly status: string; readonly summary: string; readonly paths: ReadonlyArray<string> }, any, any>
): Node.Node<Report, Failure, any> =>
  run.pipe(
    Node.bindPlanned(Node.capture({ implementationVersion, flow }, function(ended) {
      return report(payload, {
        status: "answered",
        summary: ended.summary,
        principals: { assistant: payload.admission.assistant, lead: principal },
        rounds: 0,
        child: { flow: this.flow, status: ended.status, summary: ended.summary, paths: ended.paths }
      })
    })),
    Node.catch({
      onFailure: Node.capture({ implementationVersion }, (failure) =>
        report(payload, {
          status: "blocked",
          summary: (failure as Planned.Planned<{ readonly message: string }>).message,
          principals: { assistant: payload.admission.assistant, lead: principal },
          rounds: 0
        }))
    })
  ) as Node.Node<Report, Failure, any>

/**
 * An answer's asks of the host: a hire runs `organization/hire`, a meeting
 * `organization/meetings-book`, each as a child whose ending ends the
 * delivery; a malformed ask blocks it; with none, `otherwise` goes on.
 */
const withAsk = (
  payload: Payload,
  answer: Planned.Planned<Answer>,
  otherwise: () => Node.Node<Report, Failure, any>
): Node.Node<Report, Failure, any> =>
  ReadAsk.call({ key: payload.request.key, answer }).pipe(
    Node.branch({
      if: Node.capture({ implementationVersion }, (ask) => ask.kind === "none"),
      then: () => otherwise(),
      else: (ask) =>
        Node.succeed(ask).pipe(Node.branch({
          if: Node.capture({ implementationVersion }, (asked) => asked.kind === "hire"),
          then: (asked) => child(payload, "organization/hire", answer.principal, Hire.child(asked.hire as never)),
          else: (asked) =>
            Node.succeed(asked).pipe(Node.branch({
              if: Node.capture({ implementationVersion }, (booking) => booking.kind === "meeting"),
              then: (booking) =>
                child(payload, "organization/meetings-book", answer.principal, MeetingsBook.child(booking.meeting as never)),
              else: (refused) =>
                report(payload, {
                  status: "blocked",
                  summary: refused.reason,
                  principals: { assistant: payload.admission.assistant, lead: answer.principal },
                  rounds: 0
                })
            }))
        }))
    })
  ) as Node.Node<Report, Failure, any>

/** A role's own answer written to the wiki as a document, or why it could not be. */
const documented = (payload: Payload, revision: Planned.Planned<string>, contract: Planned.Planned<Answer>) =>
  WriteDocument.call({ revision, key: payload.request.key, answer: contract }).pipe(
    Node.branch({
      if: Node.capture({ implementationVersion }, (document) => document.written),
      then: (document) =>
        report(payload, {
          status: "answered",
          summary: contract.result.summary,
          principals: { assistant: payload.admission.assistant, lead: contract.principal },
          rounds: 0,
          document: document.path
        }),
      else: (document) =>
        report(payload, {
          status: "blocked",
          summary: document.reason,
          principals: { assistant: payload.admission.assistant, lead: contract.principal },
          rounds: 0
        })
    })
  )

/** A progress post in the request's thread, or nothing for a request with no thread. */
const progress = (
  payload: Payload,
  speaker: Planned.Planned<string> | string,
  text: Planned.Planned<string> | string,
  step: string,
  refs?: Planned.Planned<ReadonlyArray<Ref>>
): Node.Node<unknown, Failure, any> => {
  const conversation = payload.request.conversation
  if (conversation === undefined) return Node.succeed(undefined)
  return RenderReply.call({ speaker, text, ...(refs === undefined ? {} : { refs: refs as unknown as ReadonlyArray<Ref> }) }).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (reply) =>
      Slack.PostMessage.call({
        connectionId: slackConnection,
        channel: conversation.channel,
        threadTs: conversation.thread,
        text: reply.text,
        key: `${payload.request.key}/${step}`,
        persona: reply.persona
      })))
  )
}

/** The report of a delivery a step failure ended. */
const failed = (payload: Payload, failure: unknown): Node.Node<Report, Failure, any> =>
  Describe.call({ failure: failure as Planned.Planned<typeof StepFailure.Type> }).pipe(
    Node.map(Node.capture({ implementationVersion, key: payload.request.key }, function(described): Report {
      return {
        key: this.key,
        status: "failed",
        summary: `${described.code}: ${described.message}`,
        principals: {},
        rounds: 0
      }
    }))
  )

/** The owner's message's reactions: `remove`, then `add`; nothing for a request with no thread. */
const reacted = (payload: Payload, remove: ReadonlyArray<string>, add: Planned.Planned<string>): Node.Node<unknown, Failure, any> => {
  const conversation = payload.request.conversation
  if (conversation === undefined) return Node.succeed(null)
  return React.call({
    channel: conversation.channel,
    ts: conversation.message ?? conversation.thread,
    remove,
    add: [add as unknown as string]
  }) as Node.Node<unknown, Failure, any>
}

/** Receipt, reply, and the run's own ending, for any report. */
const finish = (payload: Payload, outcome: Planned.Planned<Report>) =>
  Actions.WriteReceipt.call({
    runId: payload.request.key,
    name: "deliver",
    receipt: { request: payload.request, admission: payload.admission, report: outcome }
  }).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (written) =>
      // The owner's thread and the team channel get one line, with its
      // links; the contract and the checker's verdict are in the receipt.
      Closing.call({
        report: outcome,
        receipt: written.path,
        assistant: payload.admission.assistant,
        repository: payload.admission.repository
      }).pipe(
        Node.bindPlanned(Node.capture({ implementationVersion }, (closing) =>
          TeamPost.call({ thread: payload.request.key, role: closing.speaker, text: closing.text, refs: closing.refs }).pipe(
            Node.andThen(progress(payload, closing.speaker, closing.text, "result", closing.refs)),
            Node.andThen(reacted(payload, ["eyes", "double_vertical_bar"], closing.reaction))
          ))),
        Node.andThen(Settle.call({ report: outcome, receipt: written.path }))
      )))
  )

/** Deliver one admitted request. */
export default Flow.make("organization/deliver", {
  description:
    "Deliver one admitted owner request through the organization: the assistant routes it, a lead writes the contract, a builder changes the repository in a microVM workspace, the change is checked in a fresh microVM and judged by an independent checker, and an approved change lands on a branch with a receipt.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  idempotencyKey: (payload) => payload.request.key,
  payload: { request: Request, admission: Admission },
  success: Report,
  error: Schema.Union([DeliveryFailed, StepFailure]),
  body: (payload) =>
    work(payload).pipe(
      Node.catch({ onFailure: Node.capture({ implementationVersion }, (failure) => failed(payload, failure)) }),
      Node.bindPlanned(Node.capture({ implementationVersion }, (outcome) => finish(payload, outcome as Planned.Planned<Report>)))
    )
})
