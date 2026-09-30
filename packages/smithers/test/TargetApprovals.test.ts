/**
 * Build target approvals over a real project control database: the planner's
 * question, the operator's grant, and the refusals in between.
 */
import { Control, SystemFlows } from "@smthrs/control"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as TargetApprovals from "../src/cli/TargetApprovals.ts"
import * as NodeControl from "../src/NodeControl.ts"

const roots: Array<string> = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const project = () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-target-approvals-"))
  roots.push(root)
  return root
}

const request = (root: string, digest = "a".repeat(64)) => ({ root, label: "//images:push", digest })

const withControl = <A, E>(
  root: string,
  effect: Effect.Effect<A, E, Control.Control>,
  principal?: { readonly id: string; readonly kind: string }
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        NodeControl.layerControl({ root, startsRuns: false, ...(principal === undefined ? {} : { principal }) })
      ),
      Effect.scoped
    )
  )

describe("build target approvals", { timeout: 60_000 }, () => {
  it("plans against a reserved, plannable system flow", () => {
    expect(SystemFlows.plannable.map((entry) => entry.flowId)).toContain(TargetApprovals.flowId)
  })

  it("answers false and leaves a pending approval until the operator grants that revision", async () => {
    const root = project()
    expect(await TargetApprovals.store.granted(request(root))).toBe(false)
    expect(await Effect.runPromise(TargetApprovals.decision(request(root)))).toBe("pending")

    const granted = await withControl(root, TargetApprovals.grant(request(root)))
    expect(granted).toMatchObject({ label: "//images:push", revision: "a".repeat(64), receipt: "Accepted" })
    expect(await TargetApprovals.store.granted(request(root))).toBe(true)
    expect((await withControl(root, TargetApprovals.grant(request(root)))).receipt).toBe("AlreadyApplied")
  })

  it("never extends an approval to another revision, label or project", async () => {
    const root = project()
    await withControl(root, TargetApprovals.grant(request(root)))

    expect(await TargetApprovals.store.granted(request(root, "b".repeat(64)))).toBe(false)
    expect(await TargetApprovals.store.granted({ ...request(root), label: "//images:other" })).toBe(false)
    expect(await TargetApprovals.store.granted(request(project()))).toBe(false)
  })

  it("refuses a grant from a caller the host has not delegated approval to", async () => {
    const root = project()
    const refused = await withControl(
      root,
      Effect.flip(TargetApprovals.grant(request(root))),
      { id: "mcp", kind: "agent" }
    )

    expect(refused._tag).toBe("/control/Unauthorized")
    expect(await TargetApprovals.store.granted(request(root))).toBe(false)
  })

  it("keeps a denied revision refused", async () => {
    const root = project()
    await withControl(
      root,
      Effect.gen(function*() {
        const control = yield* Control.Control
        const card = yield* control.plan(TargetApprovals.planInput(request(root)))
        yield* control.deny({
          target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
          scope: "once",
          idempotencyKey: `deny:${card.planId}`
        })
      })
    )

    expect(await TargetApprovals.store.granted(request(root))).toBe(false)
    expect(await withControl(root, Effect.flip(TargetApprovals.grant(request(root))))).toMatchObject({
      _tag: "/control/AlreadyResolved"
    })
  })

  it("lists pending revisions oldest first and grants one by target without the workspace", async () => {
    const root = project()
    const older = request(root, "a".repeat(64))
    const newer = request(root, "b".repeat(64))
    const mirror = { root, label: "//images:mirror", digest: "c".repeat(64) }
    for (const revision of [older, newer, mirror]) expect(await TargetApprovals.store.granted(revision)).toBe(false)

    const listed = await withControl(root, TargetApprovals.pending)
    expect(listed.map((row) => [row.target, row.revision])).toEqual([
      ["//images:push", "a".repeat(64)],
      ["//images:push", "b".repeat(64)],
      ["//images:mirror", "c".repeat(64)]
    ])
    expect(listed[0]!.approval.target).toMatchObject({ _tag: "Plan" })

    const ambiguous = await withControl(root, Effect.flip(TargetApprovals.grantPending("images:push")))
    expect(ambiguous).toMatchObject({
      _tag: "/cli/UsageError",
      message: `//images:push has 2 pending revisions; pass --revision: ${"a".repeat(64)}, ${"b".repeat(64)}`
    })
    const missing = await withControl(root, Effect.flip(TargetApprovals.grantPending("//images:none")))
    expect(missing).toMatchObject({ _tag: "/cli/Refused", code: "approval_not_found" })

    expect(await withControl(root, TargetApprovals.grantPending("//images:push", "b".repeat(64)))).toMatchObject({
      label: "//images:push",
      revision: "b".repeat(64),
      receipt: "Accepted"
    })
    expect(await withControl(root, TargetApprovals.grantPending("images:mirror"))).toMatchObject({
      revision: "c".repeat(64)
    })
    expect(await TargetApprovals.store.granted(newer)).toBe(true)
    expect(await TargetApprovals.store.granted(older)).toBe(false)
    expect((await withControl(root, TargetApprovals.pending)).map((row) => row.revision)).toEqual(["a".repeat(64)])
  })

  it("pages past a full plan listing and skips plans that do not name a target", async () => {
    const root = project()
    await withControl(
      root,
      Effect.gen(function*() {
        const control = yield* Control.Control
        yield* control.plan({ flowId: TargetApprovals.flowId, input: { label: "//images:push" } })
        for (let index = 0; index < 101; index++) {
          yield* control.plan(TargetApprovals.planInput(request(root, index.toString(16).padStart(64, "0"))))
        }
      })
    )

    const listed = await withControl(root, TargetApprovals.pending)
    expect(listed).toHaveLength(101)
    expect(listed.at(-1)!.revision).toBe((100).toString(16).padStart(64, "0"))
  })

  it("refuses a control plane that answers a plan listing with another listing", async () => {
    const other = Control.make({
      ...({} as Control.Service),
      list: () => Effect.succeed({ _tag: "runs", items: [] })
    })
    const refused = await Effect.runPromise(
      Effect.flip(TargetApprovals.pending).pipe(Effect.provideService(Control.Control, other))
    )
    expect(refused).toMatchObject({ _tag: "/cli/Refused", code: "unexpected_listing" })
  })
})
