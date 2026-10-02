/** Snapshot recovery must retain the actionable source inspection refusal. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, PlatformError, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as Snapshot from "../src/ExecutionSnapshot.ts"

const platform = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer)
const source = `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("repair", { description: "Diagnostic repair", payload: {}, success: Schema.String,
  body: () => Node.succeed("approved") })`
const markdown = "---\ndescription: Diagnostic repair\n---\n\nApproved prompt.\n"
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(
    Effect.provide(Discovery.layer),
    Effect.provide(platform),
    Effect.scoped
  ) as Effect.Effect<A, E>)

for (const kind of ["module", "markdown"] as const) {
  describe(`${kind} source inspection with approved snapshot recovery`, () => {
    const fixture = Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-snapshot-diagnostic-" })
      const directory = `${root}/flows/repair`
      const entry = `${directory}/${kind === "module" ? "flow.ts" : "flow.mdx"}`
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* fs.writeFileString(entry, kind === "module" ? source : markdown)
      const discovery = yield* Discovery.Discovery
      const scanned = yield* discovery.scan({ source: "project", root: `${root}/flows`, naming: "path" })
      expect(scanned.entries).toHaveLength(1)
      let loads = 0
      let executions = 0
      const flow = Flow.make("agent", {
        payload: Executable.Invocation,
        success: Schema.String,
        body: () => {
          executions++
          return Node.succeed("approved")
        }
      })
      const options: Executable.Options = {
        delegates: [flow],
        load: (_path, verified) => {
          loads++
          expect(new TextDecoder().decode(verified!.bytes)).toBe(source)
          return Effect.succeed({ default: flow })
        }
      }
      const executable = yield* Executable.fromDescriptor(scanned.entries[0]!, options)
      const snapshots = yield* Snapshot.makeFileSystem({ root })
      yield* snapshots.pin(executable)
      const inspection = PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method: "readFile",
        pathOrDescriptor: entry,
        description: "smithers-jj-export is unusable; set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to a usable helper"
      })
      const unavailable = FileSystem.FileSystem.of({
        ...fs,
        readFile: (path) => path === entry ? Effect.fail(inspection) : fs.readFile(path)
      })
      const load = (recovery?: Snapshot.Service, filesystem = unavailable) =>
        Executable.fromDescriptor(executable.descriptor, {
          ...options,
          ...(recovery === undefined ? {} : { snapshots: recovery })
        }).pipe(Effect.provideService(FileSystem.FileSystem, filesystem))
      return { fs, root, entry, executable, snapshots, inspection, load, counts: () => ({ loads, executions }) }
    })

    // The host-owned service seam injects each failure category; real corrupt CAS recovery is tested below.
    it.each(["missing", "corrupt", "lockfile_changed", "unavailable"] as const)(
      "retains the original PlatformError and refuses admission when restoration is %s",
      async (code) => {
        await run(Effect.gen(function*() {
          const f = yield* fixture
          const primary = yield* f.load().pipe(Effect.flip)
          let restores = 0
          const secondary = new Snapshot.ExecutionSnapshotError({ code, message: "SECONDARY_SNAPSHOT_FAILURE" })
          const snapshots: Snapshot.Service = {
            ...f.snapshots,
            restore: (digest) =>
              Effect.sync(() => {
                restores++
                expect(digest).toBe(Descriptor.executionDigest(f.executable.descriptor))
              }).pipe(Effect.andThen(Effect.fail(secondary)))
          }
          const before = f.counts()
          const refused = yield* f.load(snapshots).pipe(Effect.flip)
          expect(restores).toBe(1)
          expect(refused.code).toBe("body_unavailable")
          expect(refused.flow).toBe("repair")
          expect(refused.path).toBe(f.entry)
          expect(refused.message).toBe(`${primary.message}; approved source snapshot ${code}: ${secondary.message}`)
          expect(refused.cause).toBe(f.inspection)
          expect(refused.cause).not.toBe(secondary)
          expect(String(refused.cause)).toContain("smithers-jj-export is unusable")
          expect(f.counts()).toEqual(before)
          expect(f.counts().executions).toBe(0)
          expect(yield* f.fs.exists(`${f.root}/.flows/control.db`)).toBe(false)
          expect(yield* f.fs.exists(`${f.root}/.flows/engine.db`)).toBe(false)
        }))
      }
    )
    it("retains the helper diagnostic when the real persisted snapshot index is corrupt", async () => {
      await run(Effect.gen(function*() {
        const f = yield* fixture
        const digest = Descriptor.executionDigest(f.executable.descriptor)!
        yield* f.fs.writeFileString(`${f.root}/.flows/executions/${digest}.json`, "{}")
        const before = f.counts()
        const refused = yield* f.load(f.snapshots).pipe(Effect.flip)
        expect(refused.cause).toBe(f.inspection)
        expect(refused.message).toContain("the body of flow \"repair\" is unavailable")
        expect(f.counts()).toEqual(before)
      }))
    })

    it("recovers the approved source without evaluating a flow body", async () => {
      await run(Effect.gen(function*() {
        const f = yield* fixture
        let restores = 0
        const snapshots: Snapshot.Service = {
          ...f.snapshots,
          restore: (digest) => Effect.sync(() => restores++).pipe(Effect.andThen(f.snapshots.restore(digest)))
        }
        const before = f.counts()
        const restored = yield* f.load(snapshots)
        expect(restores).toBe(1)
        expect(Descriptor.executionDigest(restored.descriptor)).toBe(
          Descriptor.executionDigest(f.executable.descriptor)
        )
        if (kind === "markdown") expect(restored.invocation({}).prompt).toContain("Approved prompt.")
        expect(f.counts()).toEqual({ loads: before.loads + (kind === "module" ? 1 : 0), executions: 0 })
      }))
    })
    it("does not attempt recovery when source inspection is interrupted", async () => {
      await run(Effect.gen(function*() {
        const f = yield* fixture
        const fs = yield* FileSystem.FileSystem
        const entered = yield* Deferred.make<void>()
        let restores = 0
        const snapshots: Snapshot.Service = {
          ...f.snapshots,
          restore: (digest) => Effect.sync(() => restores++).pipe(Effect.andThen(f.snapshots.restore(digest)))
        }
        const blocked = FileSystem.FileSystem.of({
          ...fs,
          readFile: (path) =>
            path === f.entry
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              : fs.readFile(path)
        })
        const before = f.counts()
        const pending = yield* Effect.forkChild(f.load(snapshots, blocked))
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(pending)
        expect(Exit.hasInterrupts(yield* Fiber.await(pending))).toBe(true)
        expect(restores).toBe(0)
        expect(f.counts()).toEqual(before)
      }))
    })

    it("preserves interruption during snapshot recovery without loading or executing", async () => {
      await run(Effect.gen(function*() {
        const f = yield* fixture
        const entered = yield* Deferred.make<void>()
        const snapshots: Snapshot.Service = {
          ...f.snapshots,
          restore: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
        }
        const before = f.counts()
        const pending = yield* Effect.forkChild(f.load(snapshots))
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(pending)
        const exit = yield* Fiber.await(pending)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.hasInterrupts(exit)).toBe(true)
        expect(f.counts()).toEqual(before)
      }))
    })
  })
}
