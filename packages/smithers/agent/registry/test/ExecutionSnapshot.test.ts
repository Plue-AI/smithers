/** Filesystem and CAS persistence are exercised without a retained host module. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as Snapshot from "../src/ExecutionSnapshot.ts"
import * as Registry from "../src/Registry.ts"

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
  it("verifies the production issue-sweep closure before evaluating any module", async () => {
    await run(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = fileURLToPath(new URL("../../../../../flows", import.meta.url))
      // Select this entry and its work child; measure their real transitive closure.
      const discovery = Discovery.make({
        ...fs,
        readDirectory: (directory) => directory === root ? Effect.succeed(["issue-sweep"]) : fs.readDirectory(directory)
      }, path)
      const scanned = yield* discovery.scan({ source: "project", root, naming: "path" })
      const descriptor = scanned.entries.find((entry) => entry.name === "issue-sweep")!
      expect(descriptor).toBeDefined()
      const verified = new Error("Verified closure reached evaluation boundary")
      let loads = 0
      const failure = yield* Executable.fromDescriptor(descriptor, {
        delegates: [],
        load: (_specifier, closure) => {
          loads++
          expect(closure!.modules.size).toBe(
            (descriptor.body._tag === "Module" ? descriptor.body.imports!.length : 0) + 1
          )
          return Effect.fail(verified)
        }
      }).pipe(Effect.flip)
      expect(loads).toBe(1)
      expect(failure.cause).toBe(verified)
    }))
  })

  it.each(["missing", "corrupt", "lockfile_changed"] as const)(
    "keeps live verification and snapshot %s diagnostics without evaluating unapproved source",
    async (mode) => {
      await run(Effect.gen(function*() {
        const { fs, root, entry, digest, executable } = yield* fixture
        const index = `${root}/.flows/executions/${digest}.json`
        yield* fs.writeFileString(entry, "throw 'UNAPPROVED_SOURCE_MUST_NOT_RUN'")
        if (mode === "missing") {
          const blob = JSON.parse(yield* fs.readFileString(index)) as string
          yield* fs.remove(`${root}/.flows/objects/${blob.slice(0, 2)}/${blob}`)
        }
        if (mode === "corrupt") yield* fs.writeFileString(index, "{\"token\":\"SECRET_SNAPSHOT_CONTENT\"}")
        if (mode === "lockfile_changed") yield* fs.writeFileString(`${root}/pnpm-lock.yaml`, "lockfileVersion: '9.0'")
        const snapshots = yield* Snapshot.makeFileSystem({ root })
        let loads = 0
        const failure = yield* Executable.fromDescriptor(executable.descriptor, {
          delegates: [],
          snapshots,
          load: () => {
            loads++
            return Effect.succeed({ default: flow })
          }
        }).pipe(Effect.flip)
        expect(loads).toBe(0)
        expect(failure.message).toContain("changed")
        expect(failure.message).toContain(`snapshot ${mode}:`)
        expect(failure.message).not.toContain("SECRET_SNAPSHOT_CONTENT")
        expect(failure.message).not.toContain("UNAPPROVED_SOURCE_MUST_NOT_RUN")
        expect(failure.cause).toMatchObject({ code: mode })
        const registry = yield* Registry.Registry.pipe(Effect.provide(
          Registry.layerFromDescriptors([executable.descriptor], [], snapshots)
        ))
        const refused = yield* registry.loadBody("snapshot", digest).pipe(Effect.flip)
        expect(refused.message).toContain("changed")
        expect(refused.message).toContain(`snapshot ${mode}:`)
        expect(refused.cause).toMatchObject({ code: mode })
        // An absent approved identity cannot fall through to the current body.
        const missingApproval = yield* registry.loadBody("snapshot", "0".repeat(64)).pipe(Effect.flip)
        expect(missingApproval.code).toBe("execution_changed")
        expect(missingApproval.message).toContain("Approved source snapshot could not be restored; snapshot missing:")
      }))
    }
  )

  it("restores from the pinned checkout despite branch helper and lockfile edits", async () => {
    // spec §11.4.1: branch helpers/lockfiles never supply Retry or Resume source.
    await run(Effect.gen(function*() {
      const { fs, root, helper, executable, digest } = yield* fixture
      const branch = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-editable-" })
      yield* fs.makeDirectory(`${branch}/flows/snapshot`, { recursive: true })
      yield* fs.writeFileString(`${branch}/flows/snapshot/flow.ts`, "throw 'BRANCH_IMPORT_MARKER'")
      yield* fs.writeFileString(`${branch}/flows/snapshot/helper.ts`, "throw 'BRANCH_HELPER_MARKER'")
      yield* fs.writeFileString(`${branch}/pnpm-lock.yaml`, "changed branch lockfile")
      // Recreate the service, as machine restart does, using only the pinned root.
      const snapshots = yield* Snapshot.makeFileSystem({ root })
      const restored = yield* snapshots.restore(digest)
      expect(new TextDecoder().decode(restored.modules.get(helper)!.bytes))
        .toBe('export const value = "approved"')
      // This unit observes verified loader bytes; the fixture has no installed package environment.
      let loads = 0
      yield* Executable.fromDescriptor(executable.descriptor, {
        delegates: [], snapshots,
        load: (_specifier, closure) => {
          loads++
          expect(new TextDecoder().decode(closure!.modules.get(helper)!.bytes))
            .toBe('export const value = "approved"')
          return Effect.succeed({ default: flow })
        }
      })
      expect(loads).toBe(1)
    }))
  })

  it("retains markdown verification diagnostics before snapshot admission", async () => {
    await run(Effect.gen(function*() {
      const { fs, root } = yield* fixture
      const entry = `${root}/flows/prompt/flow.mdx`
      yield* fs.makeDirectory(`${root}/flows/prompt`, { recursive: true })
      yield* fs.writeFileString(entry, "---\ndescription: A retained prompt\nflows: [snapshot]\n---\nApproved body")
      const discovery = yield* Discovery.Discovery
      const descriptor = (yield* discovery.scan({ source: "project", root: `${root}/flows`, naming: "path" }))
        .entries.find((entry) => entry.name === "prompt")!
      yield* fs.writeFileString(entry, "UNAPPROVED_PROMPT_MUST_NOT_LOAD")
      const snapshots = yield* Snapshot.makeFileSystem({ root })
      const failure = yield* Executable.fromDescriptor(descriptor, { delegates: [flow], snapshots }).pipe(Effect.flip)
      expect(failure.code).toBe("body_unavailable")
      expect(failure.message).toContain("changed")
      expect(failure.message).not.toContain("approved source snapshot")
      expect(failure.message).not.toContain("UNAPPROVED_PROMPT_MUST_NOT_LOAD")
      expect(failure.cause).toBeUndefined()
    }))
  })

  it("retains the unsupported import refusal when a fresh plan has no admitted snapshot", async () => {
    await run(Effect.gen(function*() {
      const { fs, root, entry } = yield* fixture
      yield* fs.writeFileString(entry, `${source}\nexport type Options = Pick<import("./helper.ts").Options, "name">`)
      const discovery = yield* Discovery.Discovery
      const descriptor = (yield* discovery.scan({ source: "project", root: `${root}/flows`, naming: "path" }))
        .entries[0]!
      const snapshots = yield* Snapshot.makeFileSystem({ root })
      let loads = 0
      const failure = yield* Executable.fromDescriptor(descriptor, {
        delegates: [],
        snapshots,
        load: () => {
          loads++
          return Effect.succeed({ default: flow })
        }
      }).pipe(Effect.flip)
      expect(loads).toBe(0)
      expect(failure.message).toContain("runtime module cache")
      expect(failure.message).toContain("import() or require()")
      expect(failure.message).not.toContain("approved source snapshot")
      expect(failure.cause).toBeUndefined()
      yield* fs.writeFileString(
        entry,
        `${source}\nimport type { Options } from "./helper.ts"\nexport type Selected = Pick<Options, "name">`
      )
      const fresh = (yield* discovery.scan({ source: "project", root: `${root}/flows`, naming: "path" })).entries[0]!
      yield* Executable.fromDescriptor(fresh, {
        delegates: [],
        snapshots,
        load: () => {
          loads++
          return Effect.succeed({ default: flow })
        }
      })
      expect(loads).toBe(1)
    }))
  })

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

  it.each(["missing-index", "retired-index", "corrupt-index", "missing-blob", "corrupt-blob", "lockfile"] as const)(
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
        // A concurrent pin retires the index just before the index read; the read then
        // returns the operating system's real NotFound. Every other syscall stays real.
        const retiring = FileSystem.FileSystem.of({
          ...fs,
          readFile: (path) =>
            path === index ? fs.remove(index).pipe(Effect.andThen(fs.readFile(path))) : fs.readFile(path)
        })
        const fresh = yield* Snapshot.makeFileSystem({ root }).pipe(
          Effect.provideService(FileSystem.FileSystem, mode === "retired-index" ? retiring : fs)
        )
        if (mode === "lockfile") {
          const refused = yield* fresh.pin(executable).pipe(Effect.flip)
          expect(refused.code).toBe("lockfile_changed")
        }
        const failure = yield* fresh.restore(digest).pipe(Effect.flip)
        const indexMissing = mode === "missing-index" || mode === "retired-index"
        expect(failure.indexMissing).toBe(indexMissing ? true : undefined)
        expect(Object.hasOwn(failure, "indexMissing")).toBe(indexMissing)
        expect(failure.code).toBe(
          mode === "lockfile"
            ? "lockfile_changed"
            : indexMissing || mode === "missing-blob"
            ? "missing"
            : "corrupt"
        )
        if (indexMissing) expect(failure.message).toBe("Execution snapshot is unavailable")
      }))
    }
  )
})
