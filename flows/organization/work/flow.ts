/**
 * `organization/work`: the organization's intake, on a schedule.
 *
 * Synchronizes the configured repositories' issues and picks at most `max`
 * items (issues to triage, then accepted proposals), each worked by its own
 * `organization/work-item`, at once. The schedule skips an occurrence while
 * the previous intake still runs, so at most `max` autonomous deliveries run
 * at a time.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import { Schema } from "effect"
import { type ItemReport, Scan, type Scanned, type WorkItem } from "../autonomy.ts"
import WorkItemFlow from "../work-item/flow.ts"

const implementationVersion = "organization/work/v1"

/** What one intake did. */
export const WorkReport = Schema.Struct({
  items: Schema.Array(Schema.Struct({ key: Schema.String, status: Schema.String, summary: Schema.String })),
  synced: Schema.Int,
  problems: Schema.Array(Schema.String)
})
export type WorkReport = typeof WorkReport.Type

type Ended = { readonly key: string; readonly status: string; readonly summary: string } | null

/** The `index`th item's work, or nothing when the intake found fewer. */
const slot = (scanned: Planned.Planned<Scanned>, index: number): Node.Node<Ended> =>
  Node.succeed(scanned).pipe(Node.branch({
    if: Node.capture({ implementationVersion, index }, function(seen) {
      return seen.items.length > this.index
    }),
    then: (seen) =>
      WorkItemFlow.child({ item: (seen.items as unknown as Record<string, Planned.Planned<WorkItem>>)[String(index)] as never }).pipe(
        Node.map(Node.capture({ implementationVersion }, (report: ItemReport): Ended => ({ key: report.key, status: report.status, summary: report.summary }))),
        Node.catch({
          onFailure: Node.capture({ implementationVersion }, (failure) =>
            Node.succeed({ key: "", status: "failed", summary: (failure as Planned.Planned<{ readonly message: string }>).message } as unknown as Ended))
        })
      ),
    else: () => Node.succeed(null)
  }))

/** Take in the organization's work. */
export default Flow.make("organization/work", {
  description:
    "Synchronize the configured repositories' issues and work at most `max` items: triage and deliver issues, and deliver accepted proposals.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: { max: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })) },
  success: WorkReport,
  body: ({ max }) =>
    Scan.call({ max }).pipe(
      Node.bindPlanned(Node.capture({ implementationVersion }, (scanned) =>
        Node.all(Object.fromEntries(Array.from({ length: max }, (_, index) => [`item${index}`, slot(scanned, index)]))).pipe(
          Node.map(Node.capture({ implementationVersion }, (slots: Readonly<Record<string, Ended>>) =>
            Object.values(slots).filter((entry): entry is NonNullable<Ended> => entry !== null))),
          Node.bindPlanned(Node.capture({ implementationVersion }, (items) =>
            Node.succeed({ items, synced: scanned.synced, problems: scanned.problems } as unknown as WorkReport)))
        )))
    )
})
