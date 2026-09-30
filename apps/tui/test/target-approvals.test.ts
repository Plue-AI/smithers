/** Build target approvals for the TUI inbox, over a real workspace control database. */
import * as BunControl from "@smthrs/cli/BunControl"
import { Control } from "@smthrs/control"
import { expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as TargetApprovals from "../src/target-approvals.ts"

const workspace = () => mkdtempSync(join(tmpdir(), "tui-target-approvals-"))

/** What a refused build leaves: one pending `system/target` plan per revision. */
const seed = (cwd: string, inputs: ReadonlyArray<unknown>) =>
  Effect.runPromise(
    Control.Control.pipe(
      Effect.flatMap((control) => Effect.forEach(inputs, (input) => control.plan({ flowId: "system/target", input }))),
      Effect.provide(BunControl.layerControl({ root: cwd, startsRuns: false }))
    )
  )

const decisions = (cwd: string) =>
  Effect.runPromise(
    Control.Control.pipe(
      Effect.flatMap((control) => control.list({ _tag: "plans", filters: { flowId: "system/target" } })),
      Effect.map((page) => page._tag === "plans" ? page.items.map((item) => item.decision) : []),
      Effect.provide(BunControl.layerControl({ root: cwd, startsRuns: false }))
    )
  )

it("has nothing pending in a workspace with no control database, and creates none", async () => {
  const cwd = workspace()
  expect(await TargetApprovals.make({ cwd }).pending()).toEqual([])
  expect(await Bun.file(join(cwd, ".flows", "control.db")).exists()).toBe(false)
}, 60_000)

it("lists pending revisions, decides them, and a fresh open reads the decisions back", async () => {
  const cwd = workspace()
  const [push, mirror] = await seed(cwd, [
    { label: "//images:push", digest: "177f95506bee0123456789" },
    { label: "//images:mirror", digest: "abcdef" },
    { suite: "not a target" }
  ])

  const port = TargetApprovals.make({ cwd })
  const rows = await port.pending()
  expect(rows).toEqual([
    { key: push!.planId, target: "//images:push", revision: "177f95506bee0123456789", approval: push!.approval },
    { key: mirror!.planId, target: "//images:mirror", revision: "abcdef", approval: mirror!.approval }
  ])
  expect(rows.map(TargetApprovals.label)).toEqual(["//images:push 177f95506bee", "//images:mirror abcdef"])

  expect((await port.decide(rows[0]!, "approve"))._tag).toBe("Accepted")
  expect((await port.decide(rows[1]!, "deny"))._tag).toBe("Accepted")

  // A new port opens the database afresh, as a restarted TUI does.
  expect(await TargetApprovals.make({ cwd }).pending()).toEqual([])
  expect(await decisions(cwd)).toEqual(["approved", "denied", "pending"])
  // Deciding a decided revision again is refused, never silently applied.
  await expect(port.decide(rows[1]!, "approve")).rejects.toBeDefined()
}, 120_000)

it("reads every page of a long listing", async () => {
  const cwd = workspace()
  await seed(cwd, Array.from({ length: 101 }, (_, index) => ({ label: "//images:push", digest: String(index) })))
  const rows = await TargetApprovals.make({ cwd }).pending()
  expect(rows).toHaveLength(101)
  expect(rows.at(-1)!.revision).toBe("100")
}, 120_000)

it("fails a decision the control plane answers with a conflict", async () => {
  const conflicting = {
    approve: () => Effect.succeed({ _tag: "Conflict", message: "stale" })
  } as unknown as Control.Service
  const row = { key: "p", target: "//t", revision: "r", approval: {} as never }
  const failed = await Effect.runPromise(Effect.flip(TargetApprovals.decide(conflicting, row, "approve")))
  expect(failed).toEqual(new Error("stale"))
  const other = { list: () => Effect.succeed({ _tag: "runs", items: [] }) } as unknown as Control.Service
  expect(await Effect.runPromise(TargetApprovals.pending(other))).toEqual([])
})
