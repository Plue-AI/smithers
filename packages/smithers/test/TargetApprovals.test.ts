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
})
