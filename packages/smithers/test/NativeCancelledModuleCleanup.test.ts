/** #3412: cancellation closes the native rows without a module execution catalog. */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"
import { commitCancelBeforeCleanup } from "./fixtures/cancel-before-cleanup.ts"

const modules = fileURLToPath(new URL("../node_modules", import.meta.url))
const source = `import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import { appendFileSync } from "node:fs"
const Hold = Action.make("cleanup/Hold", {
  payload: { marker: Schema.String }, success: Schema.String, error: Schema.Unknown,
  implementationVersion: "3412/v1", nondeterministic: true, tier: "irreversible"
})
export const layer = Hold.toLayer(({ marker }) => Effect.gen(function*() {
  appendFileSync(marker, "entered\\n")
  return yield* Effect.never
}), { implementationVersion: "3412/v1" })
export default Flow.make("cleanup", {
  description: "Hold one unkeyed action until the host closes.", capabilities: ["fs:write:**"],
  effects: { reads: [], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { marker: Schema.String }, success: Schema.String, error: Schema.Unknown,
  body: Node.capture({}, ({ marker }) => Hold.call({ marker }))
})`
const rows = (root: string) => {
  const db = new DatabaseSync(NodeControl.executionDatabasePath(root), { readOnly: true })
  try {
    return db.prepare("SELECT run_id, status, waiting_reason, cancel_requested_at_ms FROM flows_runs ORDER BY run_id")
      .all() as Array<
        { run_id: string; status: string; waiting_reason: string | null; cancel_requested_at_ms: number | null }
      >
  } finally {
    db.close()
  }
}
const until = (predicate: () => boolean, label: string) =>
  Effect.gen(function*() {
    const deadline = Date.now() + 30_000
    while (!predicate()) {
      if (Date.now() > deadline) return yield* Effect.die(`Timed out: ${label}`)
      yield* Effect.sleep("50 millis")
    }
  })

it.each(["new request", "committed request before native cleanup", "cancel with refused catalog"])(
  "#3412 metadata-only cancel settles native module executions: %s",
  async (mode) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-cancelled-module-")))
    try {
      await mkdir(join(root, "flows", "cleanup"), { recursive: true })
      await symlink(modules, join(root, "node_modules"), "dir")
      await writeFile(join(root, "flows", "cleanup", "flow.ts"), source)
      await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
      const marker = join(root, "entered")
      const runId = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const card = yield* control.plan({ flowId: "cleanup", input: { marker } })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "3412-run"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die(receipt)
          yield* until(() => existsSync(marker), "one native handler entered")
          return receipt.runId
        }).pipe(Effect.provide(NodeControl.layerControl({ root, evaluator: ScriptedJudge.layer })), Effect.scoped)
      )
      const before = rows(root)
      expect(before.length).toBeGreaterThanOrEqual(2)
      expect(before.some((row) => row.status === "suspended")).toBe(true)
      expect(before.every((row) => row.cancel_requested_at_ms === null)).toBe(true)
      if (mode !== "new request") {
        await commitCancelBeforeCleanup(root, runId)
        const requested = rows(root).find((row) => row.run_id === runId)!
        expect(requested.status).toBe("suspended")
        expect(requested.cancel_requested_at_ms).not.toBeNull()
      }
      const importMarker = join(root, "late-import")
      const unsafeModule = join(root, "unsafe-late-import.mjs")
      await writeFile(
        unsafeModule,
        `import { appendFileSync } from "node:fs"; appendFileSync(${
          JSON.stringify(importMarker)
        }, "loaded\\n"); throw new Error("cancel must not load this module")`
      )
      // A host-supplied catalog is an existing public embedding boundary. Its
      // lazy loader performs a real module import, not a fake storage/driver.
      const catalog = Layer.succeed(Executable.Catalog, {
        executables: [],
        refused: [
          new Executable.ExecutableError({
            code: "load_timeout",
            flow: "cleanup",
            available: [],
            message: "catalog registration timed out"
          })
        ],
        load: () =>
          Effect.promise(() => import(unsafeModule)).pipe(
            Effect.flatMap(() => Effect.die("unsafe import unexpectedly returned"))
          )
      })
      const receipt = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          return yield* control.cancel({ runId, idempotencyKey: "3412-cancel" })
        }).pipe(
          Effect.provide(
            NodeControl.layerControl(
              { root, startsRuns: false },
              undefined,
              undefined,
              mode === "cancel with refused catalog" ? catalog : undefined
            )
          ),
          Effect.scoped
        )
      )
      expect(existsSync(importMarker)).toBe(false)
      expect(receipt).toMatchObject({ _tag: "Terminal", status: "cancelled" })
      expect(rows(root).map((row) => ({ runId: row.run_id, status: row.status }))).toEqual(
        before.map((row) => ({ runId: row.run_id, status: "cancelled" }))
      )
      expect(readFileSync(marker, "utf8")).toBe("entered\n")
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const page = yield* control.list({ _tag: "runs", filters: { runId } })
          expect(page._tag).toBe("runs")
          if (page._tag === "runs") {
            expect(page.items).toHaveLength(1)
            expect(page.items[0]).toMatchObject({ status: "cancelled" })
          }
        }).pipe(Effect.provide(NodeControl.layerObserve({ root })), Effect.scoped)
      )
      const again = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          return yield* control.cancel({ runId, idempotencyKey: "3412-cancel-again" })
        }).pipe(Effect.provide(NodeControl.layerControl({ root, startsRuns: false })), Effect.scoped)
      )
      expect(again).toMatchObject({ _tag: "Terminal", status: "cancelled" })
      expect(rows(root).map((row) => ({ runId: row.run_id, status: row.status }))).toEqual(
        before.map((row) => ({ runId: row.run_id, status: "cancelled" }))
      )
      expect(readFileSync(marker, "utf8")).toBe("entered\n")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000
)
