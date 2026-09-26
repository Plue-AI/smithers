/**
 * `organization/work-item`: one piece of work the intake picked.
 *
 * An issue is triaged by the triage role: taken (claimed for its owner role
 * and delivered through `organization/intake` under that role, its pull
 * request linked from the claim comment, the claim released when no pull
 * request comes of it or the delivery fails), skipped, or handed to the
 * owner as a request through the assistant. An accepted proposal is
 * delivered by its owner role: a code change through intake, a document
 * through `organization/assignment`. Keyed by the item's key, so a second
 * intake or a restarted host joins the one run.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import Assignment from "../assignment/flow.ts"
import {
  ClaimIssue,
  type Decision,
  DescribeWork,
  type WorkFailure,
  ItemReport,
  LinkPull,
  ReadTriage,
  RecordItem,
  ReleaseIssue,
  TriageTask,
  WorkItem,
  WriteRequest
} from "../autonomy.ts"
import { fieldTurn } from "../field-turn.ts"
import Intake from "../intake/flow.ts"
import type { Report, Request } from "../schema.ts"
import { TeamPost } from "../team-channel.ts"

const implementationVersion = "organization/work-item/v2"

type Item = typeof WorkItem.Type

const ended = (item: Item, fields: Readonly<Record<string, unknown>>): Node.Node<ItemReport> =>
  Node.succeed({ key: item.key, kind: item.kind, owner: "", paths: [], ...fields } as unknown as ItemReport)

const record = (item: Item, report: Node.Node<ItemReport, any, any>): Node.Node<ItemReport, any, any> =>
  report.pipe(Node.bindPlanned(Node.capture({ implementationVersion }, (outcome) => RecordItem.call({ item, report: outcome }))))

/** What a failure says, as a line. */
const described = (failure: unknown) => DescribeWork.call({ failure: failure as Planned.Planned<typeof WorkFailure.Type> })

/** A delivery through intake under `role`, and how it ended for the item. */
const delivered = (
  item: Item,
  role: Planned.Planned<string> | string,
  request: Node.Node<Request, any, any>
): Node.Node<ItemReport, any, any> =>
  request.pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (asked) => Intake.child({ request: asked }))),
    Node.bindPlanned(Node.capture({ implementationVersion }, (report: Planned.Planned<Report>) =>
      Node.succeed(report).pipe(Node.branch({
        if: Node.capture({ implementationVersion }, (seen) => seen.pull !== undefined),
        then: (seen) =>
          (item.kind === "issue"
            ? LinkPull.call({ item, role: role as string, pull: seen.pull as never }).pipe(Node.andThen(Node.succeed(seen)))
            : Node.succeed(seen)).pipe(
              Node.bindPlanned(Node.capture({ implementationVersion }, (pulled) =>
                ended(item, { status: "pull-request", summary: pulled.summary, owner: role, pull: pulled.pull, paths: [] })))
            ),
        else: (seen) =>
          (item.kind === "issue"
            ? ReleaseIssue.call({ item, role: role as string, reason: seen.summary }).pipe(Node.andThen(Node.succeed(seen)))
            : Node.succeed(seen)).pipe(
              Node.bindPlanned(Node.capture({ implementationVersion }, (answered) =>
                ended(item, { status: "answered", summary: answered.summary, owner: role, paths: [] })))
            )
      })))),
    Node.catch({
      onFailure: Node.capture({ implementationVersion }, (failure) =>
        described(failure).pipe(
          Node.bindPlanned(Node.capture({ implementationVersion }, (reason) =>
            (item.kind === "issue"
              ? ReleaseIssue.call({ item, role: role as string, reason }).pipe(Node.andThen(Node.succeed(reason)))
              : Node.succeed(reason)).pipe(
                Node.bindPlanned(Node.capture({ implementationVersion }, (why) =>
                  ended(item, { status: "failed", summary: why, owner: role })))
              )))
        ))
    })
  ) as Node.Node<ItemReport, any, any>

/** An issue: triage, then the decision. */
const issue = (item: Item) =>
  Actions.PinRoster.call({}).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (pin) =>
      TriageTask.call({ revision: pin.revision, item }).pipe(
        Node.bindPlanned(Node.capture({ implementationVersion }, (stage) =>
          fieldTurn(pin.revision, stage, ["decision", "reason"]).pipe(
            Node.bindPlanned(Node.capture({ implementationVersion }, (answer) =>
              ReadTriage.call({ revision: pin.revision, item, answer }).pipe(
                Node.bindPlanned(Node.capture({ implementationVersion }, (decision) => decide(item, stage.principal, decision)))
              )))
          )))
      ))),
    Node.catch({
      onFailure: Node.capture({ implementationVersion }, (failure) =>
        described(failure).pipe(
          Node.bindPlanned(Node.capture({ implementationVersion }, (reason) => ended(item, { status: "invalid", summary: reason })))
        ))
    })
  )

/** The request a taken issue is delivered as, under its owner. */
const requestOf = (item: Item, taken: Planned.Planned<Decision>): Node.Node<Request> =>
  Node.succeed(taken).pipe(Node.map(Node.capture({ implementationVersion, item }, function(accepted): Request {
    const it = this.item
    return {
      key: it.key,
      text: [
        `Issue #${it.issue?.number ?? 0} (${it.issue?.url ?? ""}): ${it.title}`,
        "",
        it.body.slice(0, 4_000),
        "",
        "Contract:",
        accepted.contract
      ].join("\n").slice(0, 8_000),
      source: "github",
      role: accepted.owner,
      repository: it.repository,
      ...(it.issue === undefined ? {} : { issue: it.issue })
    }
  }))) as Node.Node<Request>

/** A taken issue: claimed, handed to its owner in the team channel, delivered. */
const take = (item: Item, triage: Planned.Planned<string>, taken: Planned.Planned<Decision>): Node.Node<ItemReport, any, any> =>
  ClaimIssue.call({ item, role: taken.owner }).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (claim) =>
      Node.succeed(claim).pipe(Node.branch({
        if: Node.capture({ implementationVersion }, (seen) => seen.claimed),
        else: () => ended(item, { status: "held", summary: claim.reason, owner: taken.owner }),
        then: () =>
          Node.succeed(taken).pipe(
            Node.map(Node.capture({ implementationVersion }, (accepted) => `Handoff → ${accepted.owner}: ${accepted.reason}`)),
            Node.bindPlanned(Node.capture({ implementationVersion }, (text) =>
              TeamPost.call({
                thread: item.key,
                role: triage,
                text,
                ...(item.issue === undefined ? {} : { refs: [{ kind: "issue" as const, github: item.issue.github, number: item.issue.number }] })
              }))),
            Node.andThen(delivered(item, taken.owner, requestOf(item, taken)))
          )
      }))))
  ) as Node.Node<ItemReport, any, any>

const decide = (item: Item, triage: Planned.Planned<string>, decision: Planned.Planned<Decision>): Node.Node<ItemReport, any, any> =>
  Node.succeed(decision).pipe(Node.branch({
    if: Node.capture({ implementationVersion }, (seen) => seen.kind === "take"),
    then: (taken) => take(item, triage, taken),
    else: (other) =>
      Node.succeed(other).pipe(Node.branch({
        if: Node.capture({ implementationVersion }, (seen) => seen.kind === "needs-will"),
        then: (asked) =>
          WriteRequest.call({
            key: item.key,
            role: triage,
            title: `#${item.issue?.number ?? 0} ${item.title}`,
            need: asked.reason,
            why: item.issue?.url ?? ""
          }).pipe(
            Node.bindPlanned(Node.capture({ implementationVersion }, (written) =>
              ended(item, { status: "needs-will", summary: asked.reason, paths: [written.path] })))
          ),
        else: (seen) =>
          Node.succeed(seen).pipe(Node.branch({
            if: Node.capture({ implementationVersion }, (kind) => kind.kind === "skip"),
            then: (skipped) => ended(item, { status: "skipped", summary: skipped.reason }),
            else: (invalid) => ended(item, { status: "invalid", summary: invalid.reason })
          }))
      }))
  })) as Node.Node<ItemReport, any, any>

/** An accepted proposal: its owner delivers it. */
const proposal = (item: Item): Node.Node<ItemReport, any, any> => {
  const owner = item.owner ?? ""
  const text = `Accepted proposal ${item.path ?? ""}: ${item.title}\n\n${item.body}`.slice(0, 8_000)
  if (item.work === "code") {
    return delivered(item, owner, Node.succeed({ key: item.key, text, source: "proposal", role: owner, repository: item.repository } satisfies Request))
  }
  return Assignment.child({
    key: item.key,
    role: owner,
    kind: "report",
    title: item.title,
    task: text,
    repository: item.repository,
    context: ["proposals", "channel"],
    workspace: false,
    peers: []
  }).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (report) =>
      ended(item, { status: "answered", summary: report.summary, owner, paths: report.paths }))),
    Node.catch({
      onFailure: Node.capture({ implementationVersion }, (failure) =>
        described(failure).pipe(
          Node.bindPlanned(Node.capture({ implementationVersion }, (reason) => ended(item, { status: "failed", summary: reason, owner })))
        ))
    })
  ) as Node.Node<ItemReport, any, any>
}

/** Work one item. */
/** Named so the declaration has no top-level comma discovery's static reader would split on. */
type Body = Node.Node<ItemReport, Actions.ReceiptFailed, any>

export default Flow.make("organization/work-item", {
  description:
    "Work one item the organization's intake picked: triage an issue and deliver, skip, or escalate it, or deliver an accepted proposal.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  idempotencyKey: (payload) => payload.item.key,
  payload: { item: WorkItem },
  success: ItemReport,
  error: Actions.ReceiptFailed,
  body: ({ item }): Body =>
    record(item, item.kind === "issue" ? issue(item) : proposal(item)).pipe(
      Node.bindPlanned(Node.capture({ implementationVersion }, (outcome) =>
        Actions.WriteReceipt.call({ runId: item.key, name: "work-item", receipt: { item, report: outcome } as never }).pipe(
          Node.andThen(Node.succeed(outcome))
        )))
    ) as Body
})
