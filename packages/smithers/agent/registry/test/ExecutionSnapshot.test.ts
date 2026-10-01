/** Filesystem and CAS persistence are exercised without a retained host module. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as Snapshot from "../src/ExecutionSnapshot.ts"

const platform = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer)
const source = `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { value } from "./helper.ts"
export default Flow.make("snapshot", { description: "Snapshot persistence", payload: {}, success: Schema.String,
  body: Node.capture({}, () => Node.succeed(value)) })`
const flow = Flow.make("snapshot", {
  description: "Snapshot persistence",
  payload: {},
  success: Schema.String,
  body: Node.capture({}, () => Node.succeed("approved"))
})
const fixture = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-pinned-source-" })
  const entry = `${root}/flows/snapshot/flow.ts`
  const helper = `${root}/flows/snapshot/helper.ts`
  yield* fs.makeDirectory(`${root}/flows/snapshot`, { recursive: true })
  yield* fs.writeFileString(entry, source)
  yield* fs.writeFileString(helper, "export const value = \"approved\"")
  const discovery = yield* Discovery.Discovery
  const scanned = yield* discovery.scan({ source: "project", root: `${root}/flows`, naming: "path" })
  expect(scanned.entries).toHaveLength(1)
  const executable = yield* Executable.fromDescriptor(scanned.entries[0]!, {
    delegates: [],
    load: () => Effect.succeed({ default: flow })
  })
  const digest = Descriptor.executionDigest(executable.descriptor)!
  const snapshots = yield* Snapshot.makeFileSystem({ root })
  yield* snapshots.pin(executable)
  return { fs, root, entry, helper, executable, digest, snapshots }
})
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(
    Effect.provide(Discovery.layer),
    Effect.provide(platform),
    Effect.scoped
  ) as Effect.Effect<A, E>)

describe("durable execution snapshots", () => {
  it.each(["changed", "deleted"] as const)(
    "restores approved helper and entry in a fresh service after %s live bytes",
    async (mode) => {
      await run(Effect.gen(function*() {
        const { fs, root, entry, helper, digest, snapshots, executable } = yield* fixture
        const before = yield* fs.readFileString(`${root}/.flows/executions/${digest}.json`)
        if (mode === "deleted") {
          yield* fs.remove(helper)
          yield* fs.remove(entry)
        } else {
          yield* fs.writeFileString(helper, "export const value = \"unapproved\"")
          yield* fs.writeFileString(entry, "throw 'unapproved'")
        }
        const fresh = yield* Snapshot.makeFileSystem({ root })
        const restored = yield* fresh.restore(digest)
        expect(new TextDecoder().decode(restored.bytes)).toBe(source)
        expect(new TextDecoder().decode(restored.modules.get(helper)!.bytes)).toBe("export const value = \"approved\"")
        yield* snapshots.pin(executable)
        expect(yield* fs.readFileString(`${root}/.flows/executions/${digest}.json`)).toBe(before)
        expect(restored.descriptor).toEqual(executable.descriptor)
      }))
    }
  )

  it("loads a persisted executable's original closure after live files change", async () => {
    await run(Effect.gen(function*() {
      const { fs, root, entry, helper, executable, digest } = yield* fixture
      yield* fs.writeFileString(entry, "throw 'CURRENT_ENTRY_MUST_NOT_LOAD'")
      yield* fs.writeFileString(helper, "export const value = \"unapproved\"")
      const snapshots = yield* Snapshot.makeFileSystem({ root })
      let loads = 0
      const restored = yield* Executable.fromDescriptor(executable.descriptor, {
        delegates: [],
        snapshots,
        load: (_specifier, verified) => {
          loads++
          expect(new TextDecoder().decode(verified!.bytes)).toBe(source)
          expect(new TextDecoder().decode(verified!.modules.get(helper)!.bytes)).toBe(
            "export const value = \"approved\""
          )
          return Effect.succeed({ default: flow })
        }
      })
      expect(loads).toBe(1)
      expect(Descriptor.executionDigest(restored.descriptor)).toBe(digest)
      expect(restored.source?.entry).toBe(entry)
    }))
  })

  it("explicit adoption retains the execution adapter identity and measures the new source", async () => {
    await run(Effect.gen(function*() {
      const { fs, root, helper, digest } = yield* fixture
      yield* fs.writeFileString(helper, "export const value = \"adopted\"")
      const discovery = yield* Discovery.Discovery
      const scanned = yield* discovery.scan({ source: "project", root: `${root}/flows`, naming: "path" })
      const adopted = yield* Executable.fromDescriptor(scanned.entries[0]!, {
        delegates: [],
        adapterExecutionDigest: () => digest,
        load: () => Effect.succeed({ default: flow })
      })
      expect(adopted.flow._tag).toBe(`registry/entry/${digest}/snapshot`)
      expect(Descriptor.executionDigest(adopted.descriptor)).not.toBe(digest)
      expect(new TextDecoder().decode(adopted.source!.modules.get(helper)!.bytes)).toBe(
        "export const value = \"adopted\""
      )
    }))
  })

  it("re-pins identical verified bytes after terminal collection removed its manifest object", async () => {
    await run(Effect.gen(function*() {
      const { fs, root, digest, executable } = yield* fixture
      const index = `${root}/.flows/executions/${digest}.json`
      const blob = JSON.parse(yield* fs.readFileString(index)) as string
      yield* fs.remove(`${root}/.flows/objects/${blob.slice(0, 2)}/${blob}`)
      const fresh = yield* Snapshot.makeFileSystem({ root })
      yield* fresh.pin(executable)
      expect((yield* fresh.restore(digest)).descriptor).toEqual(executable.descriptor)
      expect(JSON.parse(yield* fs.readFileString(index))).toBe(blob)
    }))
  })

  it("two fresh services admit the same closure concurrently without replacing its index", async () => {
    await run(Effect.gen(function*() {
      const { fs, root, digest, executable } = yield* fixture
      const index = `${root}/.flows/executions/${digest}.json`
      const original = yield* fs.readFileString(index)
      yield* fs.remove(index)
      const first = yield* Snapshot.makeFileSystem({ root })
      const second = yield* Snapshot.makeFileSystem({ root })
      yield* Effect.all([first.pin(executable), second.pin(executable)], { concurrency: "unbounded" })
      expect(yield* fs.readFileString(index)).toBe(original)
      expect((yield* first.restore(digest)).descriptor).toEqual(executable.descriptor)
      expect((yield* second.restore(digest)).descriptor).toEqual(executable.descriptor)
    }))
  })

  it.each(["entry", "helper", "source"] as const)(
    "rejects changed captured %s data before publishing admission",
    async (mode) => {
      await run(Effect.gen(function*() {
        const { fs, root, entry, helper, executable, digest } = yield* fixture
        const index = `${root}/.flows/executions/${digest}.json`
        yield* fs.remove(index)
        const modules = new Map(executable.source!.modules)
        const filename = mode === "entry" ? entry : helper
        modules.set(
          filename,
          mode === "source"
            ? { ...modules.get(filename)!, source: "tampered compiled source" }
            : { ...modules.get(filename)!, bytes: new TextEncoder().encode("tampered") }
        )
        const snapshots = yield* Snapshot.makeFileSystem({ root })
        const failure = yield* snapshots.pin({ ...executable, source: { ...executable.source!, modules } }).pipe(
          Effect.flip
        )
        expect(failure.code).toBe("corrupt")
        expect(yield* fs.exists(index)).toBe(false)
      }))
    }
  )

  it.each(["missing-index", "corrupt-index", "missing-blob", "corrupt-blob", "lockfile"] as const)(
    "fails closed for %s",
    async (mode) => {
      await run(Effect.gen(function*() {
        const { fs, root, digest, executable } = yield* fixture
        const index = `${root}/.flows/executions/${digest}.json`
        const blob = JSON.parse(yield* fs.readFileString(index)) as string
        const object = `${root}/.flows/objects/${blob.slice(0, 2)}/${blob}`
        if (mode === "missing-index") yield* fs.remove(index)
        if (mode === "corrupt-index") yield* fs.writeFileString(index, "{}")
        if (mode === "missing-blob") yield* fs.remove(object)
        if (mode === "corrupt-blob") yield* fs.writeFileString(object, "tampered")
        if (mode === "lockfile") yield* fs.writeFileString(`${root}/pnpm-lock.yaml`, "lockfileVersion: '9.0'\n")
        const fresh = yield* Snapshot.makeFileSystem({ root })
        if (mode === "lockfile") {
          const refused = yield* fresh.pin(executable).pipe(Effect.flip)
          expect(refused.code).toBe("lockfile_changed")
        }
        const failure = yield* fresh.restore(digest).pipe(Effect.flip)
        expect(failure.code).toBe(
          mode === "lockfile"
            ? "lockfile_changed"
            : mode === "missing-index" || mode === "missing-blob"
            ? "missing"
            : "corrupt"
        )
      }))
    }
  )
})
