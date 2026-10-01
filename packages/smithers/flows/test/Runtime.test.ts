import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { expect, it } from "@effect/vitest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { FlowEngine } from "@smthrs/engine"
import { StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import * as Jj from "@smthrs/jj/Jj"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { Migrations as RunMigrations, RunStore } from "@smthrs/run-store"
import { Context, Effect, Exit, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Runtime from "../src/Runtime.ts"

const options: Runtime.Options = {
  filename: "runtime.sqlite",
  workspaceRoot: ".",
  owner: { hostId: "injected-runtime" },
  isAlive: () => Effect.succeed(false)
}

it("reports invalid JavaScript configuration before constructing injected services", () => {
  const invalid = [
    [{ filename: "" }, "filename"],
    [{ owner: undefined }, "owner.hostId"],
    [{ isAlive: undefined }, "isAlive"],
    [{ canExecute: "yes" }, "canExecute"],
    [{ requestResume: "yes" }, "requestResume"],
    // Cache key material, so an incomplete declaration is refused where it is
    // written rather than folded into every sealed key this host derives.
    [{ cacheEnvironment: { layers: [""], capabilities: {} } }, "cacheEnvironment"],
    [{ cacheEnvironment: { layers: [] } }, "cacheEnvironment"],
    // A ref a reader could not resolve is not a revision (D-068).
    [{ sourceRevision: "" }, "sourceRevision"],
    [{ privilegedJj: "jj" }, "privilegedJj"]
  ] as const
  for (const [patch, field] of invalid) {
    const parameters = [
      { ...options, ...patch } as unknown as Runtime.Options,
      StepBoundary.layer,
      WorkspaceSandbox.layerFileSystem(),
      Layer.empty
    ] as const
    for (const construct of [() => Runtime.make(...parameters), () => Runtime.layer(...parameters)]) {
      expect(construct).toThrow(expect.objectContaining({ code: "invalid_runtime_configuration", field }))
    }
  }
})

it("uses the caller's SQL instance for every migrated store without opening a second database", async () => {
  const root = mkdtempSync(join(tmpdir(), "flows-injected-runtime-"))
  const filename = join(root, "must-not-open.sqlite")
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        for (const registry of [undefined, Layer.empty]) {
          yield* Effect.scoped(Effect.gen(function*() {
            const parameters = [
              { ...options, filename, workspaceRoot: root },
              StepBoundary.layer,
              WorkspaceSandbox.layerFileSystem(),
              Layer.empty
            ] as const
            const context = yield* registry === undefined
              ? Runtime.make(...parameters)
              : Runtime.make(...parameters, registry)
            const writer = Context.get(context, DurableWriter.DurableWriter)
            expect(yield* sql`SELECT name FROM sqlite_master WHERE name = 'flows_runs'`)
              .toEqual([{ name: "flows_runs" }])
            yield* sql`CREATE TABLE IF NOT EXISTS injected_probe (value INTEGER)`
            const rolledBack = yield* Effect.exit(writer.write(
              sql`INSERT INTO injected_probe VALUES (1)`.pipe(Effect.andThen(Effect.fail("reject")))
            ))
            expect(Exit.isFailure(rolledBack)).toBe(true)
            expect(yield* sql`SELECT * FROM injected_probe`).toEqual([])
          }))
        }
      }).pipe(
        Effect.provide(Layer.mergeAll(
          NodeDatabase.layer({ filename: ":memory:" }),
          AtomicFileSystem.layer,
          NodeCrypto.layer,
          NodePath.layer,
          Jj.layerNoop({})
        )),
        Effect.scoped
      )
    )
    expect(existsSync(filename)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("isolates store instances from an enclosing control database in the same layer memo map", async () => {
  const root = mkdtempSync(join(tmpdir(), "flows-runtime-store-isolation-"))
  const control = RunStore.layer.pipe(Layer.provideMerge(
    RunMigrations.layer.pipe(Layer.provideMerge(
      DurableWriter.layer().pipe(Layer.provideMerge(NodeDatabase.layer({ filename: ":memory:" })))
    ))
  ))
  const engine = Runtime.storage(join(root, "engine.sqlite"), root).pipe(
    Layer.provide(NodeDatabase.layer({ filename: ":memory:" }))
  )
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const controlStore = yield* RunStore.RunStore
        yield* controlStore.create("control-only", "{}")
        const engineContext = yield* Layer.build(engine)
        const engineStore = Context.get(engineContext, RunStore.RunStore)
        expect((yield* Effect.flip(engineStore.get("control-only"))).code).toBe("not_found_row")
        yield* engineStore.create("engine-only", "{}")
        expect((yield* Effect.flip(controlStore.get("engine-only"))).code).toBe("not_found_row")
      }).pipe(
        Effect.provide(Layer.mergeAll(control, NodeFileSystem.layer, NodeCrypto.layer, NodePath.layer)),
        Effect.scoped
      )
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("takes the engine's step snapshots on the privileged Jj and leaves the ambient Jj to actions", async () => {
  const root = mkdtempSync(join(tmpdir(), "flows-runtime-privileged-jj-"))
  const recording = (calls: Array<string>) =>
    Jj.makeNoop({
      snapshot: (message) =>
        Effect.sync(() => calls.push(message ?? "")).pipe(
          Effect.as({ commitId: "c0ffee", changeId: "kkkk", operationId: "0abc" } as Jj.Snapshot)
        )
    })
  const snapshotWith = (privileged: Array<string> | undefined, ambient: Array<string>) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const context = yield* Runtime.make(
          {
            ...options,
            filename: join(root, `${privileged === undefined ? "ambient" : "privileged"}.sqlite`),
            workspaceRoot: root,
            ...(privileged === undefined ? {} : { privilegedJj: Layer.succeed(Jj.Jj, recording(privileged)) })
          },
          StepBoundary.layer,
          WorkspaceSandbox.layerFileSystem(),
          Layer.empty
        )
        const boundary = Context.get(context, FlowEngine.SnapshotBoundary)
        // The boundary reads only the step key and attempt; no flow is dispatched.
        yield* boundary.snapshot({
          flow: undefined as never,
          executionId: "execution",
          key: "step/one",
          attempt: 1,
          metadata: undefined
        })
      }).pipe(
        Effect.provide(Layer.mergeAll(
          NodeDatabase.layer({ filename: ":memory:" }),
          AtomicFileSystem.layer,
          NodeCrypto.layer,
          NodePath.layer,
          Layer.succeed(Jj.Jj, recording(ambient))
        )),
        Effect.scoped
      )
    )
  try {
    const privileged: Array<string> = []
    const ambient: Array<string> = []
    await snapshotWith(privileged, ambient)
    expect(privileged).toEqual(["smithers action step/one attempt 1"])
    expect(ambient).toEqual([])
    // Without a privileged repository the engine snapshots on the ambient one.
    const shared: Array<string> = []
    await snapshotWith(undefined, shared)
    expect(shared).toEqual(["smithers action step/one attempt 1"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
