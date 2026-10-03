/** Real source, CAS and index bytes; injected syscall failures exercise publication errors. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as Digest from "@smthrs/core/Digest"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Crypto, Deferred, Effect, Fiber, FileSystem, Layer, Logger, Path, PlatformError, Schema } from "effect"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as Snapshot from "../src/ExecutionSnapshot.ts"
import * as Prompt from "../src/Prompt.ts"
import * as Registry from "../src/Registry.ts"

const platform = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer)
const source = `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { value } from "./helper.ts"
export default Flow.make("snapshot", { description: "Snapshot boundaries", payload: {}, success: Schema.String,
body: () => Node.succeed(value) })`
const flow = Flow.make("snapshot", {
  description: "Snapshot boundaries",
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("approved")
})
interface Manifest {
  executionDigest: string
  entry: string
  descriptor: Descriptor.FlowDescriptor
  modules: Record<string, string>
  lockfileDigest: string
  compiled: Record<string, { source: string; links: Array<{ start: number; end: number; target: string }> }>
}
const fixture = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-snapshot-boundaries-" })
  const entry = `${root}/flows/snapshot/flow.ts`
  const helper = `${root}/flows/snapshot/helper.ts`
  yield* fs.makeDirectory(path.dirname(entry), { recursive: true })
  yield* fs.writeFileString(entry, source)
  yield* fs.writeFileString(helper, "export const value = \"approved\"")
  const scanned = yield* (yield* Discovery.Discovery).scan({ source: "project", root: `${root}/flows`, naming: "path" })
  const executable = yield* Executable.fromDescriptor(scanned.entries[0]!, {
    delegates: [],
    load: () => Effect.succeed({ default: flow })
  })
  const digest = Descriptor.executionDigest(executable.descriptor)!
  const store = ArtifactStore.makeFileSystem(fs, path, { directory: `${root}/.flows/objects` })
  const snapshots = yield* Snapshot.makeFileSystem({ root, store })
  yield* snapshots.pin(executable)
  const index = `${root}/.flows/executions/${digest}.json`
  const blob: string = JSON.parse(yield* fs.readFileString(index))
  const manifest: Manifest = JSON.parse(new TextDecoder().decode(
    yield* store.get(blob).pipe(Effect.provideService(Crypto.Crypto, crypto))
  ))
  const publishBytes = (bytes: Uint8Array) =>
    Effect.gen(function*() {
      const blob = yield* store.put(bytes).pipe(
        Effect.provideService(Crypto.Crypto, crypto)
      )
      yield* fs.writeFileString(index, JSON.stringify(blob))
      return blob
    })
  const publish = (value: Manifest) => publishBytes(new TextEncoder().encode(JSON.stringify(value)))
  return { fs, path, root, entry, helper, executable, digest, snapshots, index, blob, manifest, publish, publishBytes }
})
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(
    Effect.provide(Discovery.layer),
    Effect.provide(platform),
    Effect.scoped
  ) as Effect.Effect<A, E>)
const denied = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: "Injected publication syscall denial"
  })

describe("execution snapshot admission boundaries", () => {
  it("exposes the exact approved descriptor and deduplicated CAS roots despite later lockfile changes", async () => {
    await run(Effect.gen(function*() {
      const { fs, root, digest, executable, blob, manifest } = yield* fixture
      const snapshots = yield* Snapshot.ExecutionSnapshot.pipe(Effect.provide(Snapshot.layerFileSystem({ root })))
      expect(yield* snapshots.descriptor(digest)).toEqual(executable.descriptor)
      const expected = new Set([blob, ...Object.values(manifest.modules)])
      expect(new Set(yield* snapshots.roots([digest, digest]))).toEqual(expected)
      expect(yield* snapshots.roots([])).toEqual([])
      yield* fs.writeFileString(`${root}/pnpm-lock.yaml`, "changed")
      expect(new Set(yield* snapshots.roots([digest]))).toEqual(expected)
      expect((yield* snapshots.descriptor(digest).pipe(Effect.flip)).code).toBe("lockfile_changed")
    }))
  })

  it.each(["", "../outside", "A".repeat(64), "f".repeat(63)])("rejects invalid public digest %s", async (digest) => {
    await run(Effect.gen(function*() {
      const { snapshots } = yield* fixture
      const reads: ReadonlyArray<Effect.Effect<unknown, Snapshot.ExecutionSnapshotError>> = [
        snapshots.restore(digest),
        snapshots.descriptor(digest),
        snapshots.roots([digest])
      ]
      for (const read of reads) {
        const failure = yield* read.pipe(Effect.flip)
        expect(failure.code).toBe("corrupt")
        expect(failure.message).toBe("Invalid execution digest")
        expect(failure.indexMissing).toBeUndefined()
      }
    }))
  })

  it.each(
    [
      "identity",
      "descriptor",
      "missing-compiled",
      "missing-link-target",
      "compiled-source",
      "link-range",
      "missing-entry",
      "entry-digest",
      "closure-size",
      "helper-digest",
      "missing-helper-key",
      "missing-module-blob",
      "corrupt-module-blob"
    ] as const
  )("refuses a verified CAS manifest with %s damage", async (mode) => {
    await run(Effect.gen(function*() {
      const { fs, root, entry, helper, digest, manifest, publish } = yield* fixture
      if (mode === "identity") manifest.executionDigest = "0".repeat(64)
      if (mode === "descriptor") manifest.descriptor = { ...manifest.descriptor, description: "another identity" }
      if (mode === "missing-compiled") delete manifest.compiled[entry]
      if (mode === "missing-link-target") manifest.compiled[entry]!.links[0]!.target = `${root}/outside.ts`
      if (mode === "compiled-source") manifest.compiled[entry]!.source = "UNAPPROVED_COMPILED_SOURCE"
      if (mode === "link-range") manifest.compiled[entry]!.links[0]!.end = source.length + 1
      if (mode === "missing-entry") manifest.entry = `${root}/absent.ts`
      if (mode === "entry-digest") manifest.entry = helper
      if (mode === "closure-size") {
        manifest.modules[`${root}/extra.ts`] = manifest.modules[helper]!
        manifest.compiled[`${root}/extra.ts`] = manifest.compiled[helper]!
      }
      if (mode === "helper-digest") {
        manifest.modules[helper] = manifest.modules[entry]!
        manifest.compiled[helper] = manifest.compiled[entry]!
      }
      if (mode === "missing-helper-key") {
        manifest.modules[`${root}/extra.ts`] = manifest.modules[helper]!
        manifest.compiled[`${root}/extra.ts`] = manifest.compiled[helper]!
        delete manifest.modules[helper]
        manifest.compiled[entry]!.links = []
      }
      if (mode === "missing-module-blob" || mode === "corrupt-module-blob") {
        const blob = manifest.modules[helper]!
        const object = `${root}/.flows/objects/${blob.slice(0, 2)}/${blob}`
        if (mode === "missing-module-blob") yield* fs.remove(object)
        else yield* fs.writeFileString(object, "UNAPPROVED_OBJECT")
      }
      yield* publish(manifest)
      const fresh = yield* Snapshot.makeFileSystem({ root })
      const failure = yield* fresh.restore(digest).pipe(Effect.flip)
      expect(failure.code).toBe(mode === "missing-module-blob" ? "missing" : "corrupt")
      expect(failure.indexMissing).toBeUndefined()
      expect(failure.message).not.toContain("UNAPPROVED")
    }))
  })

  it.each(["source", "source-bytes", "entry", "helper", "unmeasured"] as const)(
    "cannot admit an executable with missing %s",
    async (mode) => {
      await run(Effect.gen(function*() {
        const { fs, root, entry, helper, executable, index } = yield* fixture
        yield* fs.remove(index)
        const modules = new Map(executable.source!.modules)
        if (mode === "entry") modules.delete(entry)
        if (mode === "helper") modules.delete(helper)
        const descriptor = mode === "unmeasured"
          ? { ...executable.descriptor, body: { ...executable.descriptor.body, contentDigest: undefined } }
          : executable.descriptor
        const snapshots = yield* Snapshot.makeFileSystem({ root })
        const failure = yield* snapshots.pin({
          ...executable,
          descriptor,
          source: mode === "source" ? undefined : {
            ...executable.source!,
            modules,
            bytes: mode === "source-bytes" ? new TextEncoder().encode("unapproved") : executable.source!.bytes
          }
        }).pipe(Effect.flip)
        expect(failure.code).toBe(mode === "source" || mode === "unmeasured" ? "unavailable" : "corrupt")
        expect(yield* fs.exists(index)).toBe(false)
      }))
    }
  )

  it.each(["invalid-json", "invalid-schema"] as const)("refuses a hash-valid %s manifest", async (mode) => {
    await run(Effect.gen(function*() {
      const { root, digest, publishBytes } = yield* fixture
      yield* publishBytes(new TextEncoder().encode(mode === "invalid-json" ? "{" : "{}"))
      const fresh = yield* Snapshot.makeFileSystem({ root })
      const failure = yield* fresh.restore(digest).pipe(Effect.flip)
      expect(failure.code).toBe("corrupt")
      expect(failure.message).toBe("Cannot read execution snapshot")
    }))
  })

  it.each(["valid", "invalid"] as const)("verifies %s measured MDX compilation at admission", async (mode) => {
    await run(Effect.gen(function*() {
      const { root, executable } = yield* fixture
      const entry = `${root}/flows/snapshot/flow.mdx`
      const text = mode === "valid" ? "# Approved prompt" : "<Unclosed>"
      const bytes = new TextEncoder().encode(text)
      const descriptor = new Descriptor.FlowDescriptor({
        ...executable.descriptor,
        body: new Descriptor.BodyRefModule({ path: entry, contentDigest: Digest.digest(bytes), imports: [] })
      })
      const captured = {
        ...executable,
        descriptor,
        source: {
          entry,
          bytes,
          modules: new Map([[entry, { bytes, source: mode === "valid" ? Prompt.compile(text) : text, links: [] }]])
        }
      }
      const snapshots = yield* Snapshot.makeFileSystem({ root })
      if (mode === "valid") {
        yield* snapshots.pin(captured)
        expect(Array.from((yield* snapshots.restore(Descriptor.executionDigest(descriptor)!)).bytes)).toEqual(
          Array.from(bytes)
        )
      } else {
        const failure = yield* snapshots.pin(captured).pipe(Effect.flip)
        expect(failure.code).toBe("corrupt")
        expect(failure.message).toBe("Cannot verify source compilation")
      }
    }))
  })

  it("retains a measured legacy module descriptor with no imports field", async () => {
    await run(Effect.gen(function*() {
      const { fs, root, entry, executable } = yield* fixture
      const text = source.replace("import { value } from \"./helper.ts\"\n", "").replace(
        "Node.succeed(value)",
        "Node.succeed(\"approved\")"
      )
      const bytes = new TextEncoder().encode(text)
      yield* fs.writeFileString(entry, text)
      const descriptor = new Descriptor.FlowDescriptor({
        ...executable.descriptor,
        body: new Descriptor.BodyRefModule({
          path: entry,
          contentDigest: Digest.digest(bytes)
        })
      })
      const captured = {
        ...executable,
        descriptor,
        source: {
          entry,
          bytes,
          modules: new Map([[entry, { bytes, source: text, links: [] }]])
        }
      }
      const snapshots = yield* Snapshot.makeFileSystem({ root })
      yield* snapshots.pin(captured)
      const restored = yield* snapshots.restore(Descriptor.executionDigest(descriptor)!)
      expect(Array.from(restored.bytes)).toEqual(Array.from(bytes))
      expect(restored.modules.size).toBe(1)
      expect(restored.descriptor.body._tag).toBe("Module")
      if (restored.descriptor.body._tag === "Module") expect(restored.descriptor.body.imports).toBeUndefined()
      expect(JSON.parse(JSON.stringify(restored.descriptor.body))).not.toHaveProperty("imports")
    }))
  })

  it("refuses source identity changed while admission waits for its filesystem boundary", async () => {
    await run(Effect.gen(function*() {
      const { fs, root, executable } = yield* fixture
      const captured = { ...executable }
      const boundary = FileSystem.FileSystem.of({
        ...fs,
        makeDirectory: (path, options) => {
          captured.descriptor = {
            ...executable.descriptor,
            body: { ...executable.descriptor.body, contentDigest: undefined }
          }
          return fs.makeDirectory(path, options)
        }
      })
      const snapshots = yield* Snapshot.makeFileSystem({ root }).pipe(
        Effect.provideService(FileSystem.FileSystem, boundary)
      )
      const failure = yield* snapshots.pin(captured).pipe(Effect.flip)
      expect(failure.code).toBe("unavailable")
      expect(failure.message).toBe("Executable has no verified source closure")
    }))
  })

  it("reports a denied temporary index allocation without changing the old admission", async () => {
    await run(Effect.gen(function*() {
      const { fs, root, executable, index } = yield* fixture
      yield* fs.remove(index)
      const failing = FileSystem.FileSystem.of({
        ...fs,
        makeTempFile: () => Effect.fail(denied("makeTempFile", index))
      })
      const snapshots = yield* Snapshot.makeFileSystem({ root }).pipe(
        Effect.provideService(FileSystem.FileSystem, failing)
      )
      const failure = yield* snapshots.pin(executable).pipe(Effect.flip)
      expect(failure.code).toBe("unavailable")
      expect(failure.message).toBe("Cannot pin execution closure")
      expect(yield* fs.exists(index)).toBe(false)
    }))
  })

  it("refuses denied publication lease acquisition without replacing retained admission", async () => {
    await run(Effect.gen(function*() {
      const { fs, root, executable, digest, index, blob } = yield* fixture
      const lock = `${root}/.flows/executions/${digest}.lock`
      const failing = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (path, value, options) =>
          path === lock
            ? Effect.fail(denied("writeFileString", path)) :
            fs.writeFileString(path, value, options)
      })
      const snapshots = yield* Snapshot.makeFileSystem({ root }).pipe(
        Effect.provideService(FileSystem.FileSystem, failing)
      )
      const failure = yield* snapshots.pin(executable).pipe(Effect.flip)
      expect(failure.code).toBe("unavailable")
      expect(failure.message).toBe("Cannot acquire execution snapshot publication lease")
      expect(yield* fs.readFileString(index)).toBe(JSON.stringify(blob))
      expect(yield* fs.exists(lock)).toBe(false)
    }))
  })

  it.each(["start", "end", "fractional-start", "fractional-end", "empty"] as const)(
    "cannot publish an invalid compiled %s link",
    async (mode) => {
      await run(Effect.gen(function*() {
        const { fs, root, entry, helper, executable, index } = yield* fixture
        yield* fs.remove(index)
        const link = {
          start: mode === "start" ? -1 : mode === "fractional-start" ? 0.5 : 0,
          end: mode === "end" ? source.length + 1 : mode === "fractional-end" ? 1.5 : mode === "empty" ? 0 : 1,
          target: helper
        }
        const modules = new Map(executable.source!.modules)
        modules.set(entry, { ...modules.get(entry)!, links: [link] })
        const snapshots = yield* Snapshot.makeFileSystem({ root })
        const failure = yield* snapshots.pin({ ...executable, source: { ...executable.source!, modules } }).pipe(
          Effect.flip
        )
        expect(failure.code).toBe("corrupt")
        expect(yield* fs.exists(index)).toBe(false)
      }))
    }
  )

  it.each(["publish", "concurrent-valid", "concurrent-corrupt"] as const)(
    "handles %s index publication without overwriting retained state",
    async (mode) => {
      await run(Effect.gen(function*() {
        const { fs, root, digest, executable, index, blob } = yield* fixture
        yield* fs.remove(index)
        // One intercepted syscall recreates a competing publisher or a portable permission denial;
        // CAS verification, index contents, all other syscalls and cleanup remain real.
        const failing = FileSystem.FileSystem.of({
          ...fs,
          link: (from, to) =>
            to !== index ?
              fs.link(from, to) :
              mode === "publish" ?
              Effect.fail(denied("link", index)) :
              fs.writeFileString(
                index,
                mode === "concurrent-valid" ? JSON.stringify(blob) : "{}"
              ).pipe(Effect.andThen(fs.link(from, to)))
        })
        const snapshots = yield* Snapshot.makeFileSystem({ root }).pipe(
          Effect.provideService(FileSystem.FileSystem, failing)
        )
        if (mode === "concurrent-valid") {
          yield* snapshots.pin(executable)
          expect((yield* snapshots.restore(digest)).descriptor).toEqual(executable.descriptor)
          expect(yield* fs.readFileString(index)).toBe(JSON.stringify(blob))
        } else {
          const failure = yield* snapshots.pin(executable).pipe(Effect.flip)
          expect(failure.code).toBe(mode === "publish" ? "unavailable" : "corrupt")
          expect(yield* fs.exists(index)).toBe(mode !== "publish")
        }
        expect((yield* fs.readDirectory(`${root}/.flows/executions`)).filter((name) => name.startsWith(".snapshot-")))
          .toEqual([])
      }))
    }
  )

  it("removes the temporary publication directory and lease on cancellation, then permits retry", async () => {
    await run(Effect.gen(function*() {
      const { fs, root, digest, executable, index } = yield* fixture
      yield* fs.remove(index)
      const publishing = yield* Deferred.make<void>()
      // Hold the actual hard-link syscall after allocation and file sync so interruption
      // deterministically exercises the public scoped filesystem cleanup boundary.
      const blocked = FileSystem.FileSystem.of({
        ...fs,
        link: (from, to) =>
          to === index
            ? Deferred.succeed(publishing, undefined).pipe(Effect.andThen(Effect.never))
            : fs.link(from, to)
      })
      const snapshots = yield* Snapshot.makeFileSystem({ root }).pipe(
        Effect.provideService(FileSystem.FileSystem, blocked)
      )
      const pending = yield* Effect.forkChild(snapshots.pin(executable))
      yield* Deferred.await(publishing)
      expect((yield* fs.readDirectory(`${root}/.flows/executions`)).filter((name) => name.startsWith(".snapshot-")))
        .toHaveLength(1)
      yield* Fiber.interrupt(pending)
      expect(yield* fs.exists(index)).toBe(false)
      expect(yield* fs.exists(`${root}/.flows/executions/${digest}.lock`)).toBe(false)
      expect((yield* fs.readDirectory(`${root}/.flows/executions`)).filter((name) => name.startsWith(".snapshot-")))
        .toEqual([])
      const retry = yield* Snapshot.makeFileSystem({ root })
      yield* retry.pin(executable)
      expect((yield* retry.restore(digest)).descriptor).toEqual(executable.descriptor)
      expect((yield* fs.readDirectory(`${root}/.flows/executions`)).filter((name) => name.startsWith(".snapshot-")))
        .toEqual([])
    }))
  })

  it("keeps the published, synced index when reclaiming its temporary directory is denied", async () => {
    await run(Effect.gen(function*() {
      const { fs, root, digest, executable, index, blob } = yield* fixture
      yield* fs.remove(index)
      const executions = `${root}/.flows/executions`
      const events: Array<string> = []
      const denials: Array<PlatformError.PlatformError> = []
      const warnings: Array<unknown> = []
      // Only reclaiming the private temporary directory is denied, as EACCES, EBUSY or virtiofs
      // ENOTEMPTY do in production; link, open, sync, CAS and index bytes stay real.
      const failing = FileSystem.FileSystem.of({
        ...fs,
        link: (from, to) => Effect.sync(() => events.push(`link ${to}`)).pipe(Effect.andThen(fs.link(from, to))),
        open: (path, options) =>
          Effect.sync(() => events.push(`open ${path}`)).pipe(Effect.andThen(fs.open(path, options))),
        remove: (path, options) => {
          if (!path.startsWith(`${executions}/.snapshot-`)) return fs.remove(path, options)
          const denial = denied("remove", path)
          denials.push(denial)
          return Effect.fail(denial)
        }
      })
      const capture = Logger.layer([
        Logger.make((entry) => {
          if (entry.logLevel === "Warn") warnings.push(entry.message)
        })
      ], { mergeWithExisting: false })
      const snapshots = yield* Snapshot.makeFileSystem({ root }).pipe(
        Effect.provideService(FileSystem.FileSystem, failing)
      )
      yield* snapshots.pin(executable).pipe(Effect.provide(capture))
      expect(yield* fs.readFileString(index)).toBe(JSON.stringify(blob))
      expect((yield* snapshots.restore(digest)).descriptor).toEqual(executable.descriptor)
      expect(denials).toHaveLength(1)
      expect(warnings).toEqual([["Cannot reclaim snapshot temporary", denials[0]]])
      const published = events.indexOf(`link ${index}`)
      expect(published).toBeGreaterThanOrEqual(0)
      expect(events.slice(published)).toEqual(
        expect.arrayContaining([`open ${executions}`, `open ${root}/.flows`, `open ${root}`])
      )
    }))
  })

  it.each(["flat", "foreign"] as const)(
    "reclaims only the temporary file when the host allocates it outside a private directory (%s)",
    async (mode) => {
      await run(Effect.gen(function*() {
        const { fs, root, digest, executable, index, blob } = yield* fixture
        yield* fs.remove(index)
        const executions = `${root}/.flows/executions`
        const parent = mode === "flat" ? executions : `${executions}/foreign`
        const keep = `${parent}/keep`
        yield* fs.makeDirectory(parent, { recursive: true })
        yield* fs.writeFileString(keep, "kept")
        const temporary = `${parent}/.snapshot-temporary`
        const warnings: Array<unknown> = []
        // A host FileSystem need not allocate temporaries with mkdtemp. This double creates a real
        // file directly in the store (flat) or in a directory it does not own (foreign); the rest stays real.
        const shared = FileSystem.FileSystem.of({
          ...fs,
          makeTempFile: () => fs.writeFileString(temporary, "").pipe(Effect.as(temporary))
        })
        const capture = Logger.layer([
          Logger.make((entry) => {
            if (entry.logLevel === "Warn") warnings.push(entry.message)
          })
        ], { mergeWithExisting: false })
        const snapshots = yield* Snapshot.makeFileSystem({ root }).pipe(
          Effect.provideService(FileSystem.FileSystem, shared)
        )
        yield* snapshots.pin(executable).pipe(Effect.provide(capture))
        expect(yield* fs.readFileString(index)).toBe(JSON.stringify(blob))
        expect(yield* fs.readFileString(keep)).toBe("kept")
        expect(yield* fs.exists(temporary)).toBe(false)
        expect((yield* snapshots.restore(digest)).descriptor).toEqual(executable.descriptor)
        expect(warnings).toEqual([["Snapshot temporary is not in a private directory", temporary]])
      }))
    }
  )

  it("keeps a collected index intact if retiring it is denied", async () => {
    await run(Effect.gen(function*() {
      const { fs, root, executable, index, blob } = yield* fixture
      yield* fs.remove(`${root}/.flows/objects/${blob.slice(0, 2)}/${blob}`)
      const failing = FileSystem.FileSystem.of({
        ...fs,
        remove: (path, options) =>
          path === index
            ? Effect.fail(denied("remove", index)) :
            fs.remove(path, options)
      })
      const snapshots = yield* Snapshot.makeFileSystem({ root }).pipe(
        Effect.provideService(FileSystem.FileSystem, failing)
      )
      const failure = yield* snapshots.pin(executable).pipe(Effect.flip)
      expect(failure.code).toBe("unavailable")
      expect(failure.message).toBe("Cannot retire collected snapshot index")
      expect(yield* fs.readFileString(index)).toBe(JSON.stringify(blob))
    }))
  })

  it("refuses publication when the containing directory cannot be created", async () => {
    await run(Effect.gen(function*() {
      const { fs, root, executable } = yield* fixture
      const failing = FileSystem.FileSystem.of({
        ...fs,
        makeDirectory: (path, options) =>
          path.endsWith("/executions")
            ? Effect.fail(denied("makeDirectory", path)) :
            fs.makeDirectory(path, options)
      })
      const snapshots = yield* Snapshot.makeFileSystem({ root }).pipe(
        Effect.provideService(FileSystem.FileSystem, failing)
      )
      const failure = yield* snapshots.pin(executable).pipe(Effect.flip)
      expect(failure.code).toBe("unavailable")
      expect(failure.message).toBe("Cannot publish execution snapshot")
    }))
  })

  it("registry source loading restores the approved module after live bytes change", async () => {
    await run(Effect.gen(function*() {
      const { fs, entry, digest, executable, snapshots } = yield* fixture
      yield* fs.writeFileString(entry, "UNAPPROVED_SOURCE")
      const registry = yield* Registry.Registry.pipe(Effect.provide(Registry.layerFromDescriptors(
        [executable.descriptor],
        [],
        snapshots
      )))
      expect(yield* registry.loadBody("snapshot", digest)).toMatchObject({ _tag: "Module", path: entry })
    }))
  })

  it("registry loading refuses an approved snapshot belonging to another flow", async () => {
    await run(Effect.gen(function*() {
      const { executable, snapshots, digest } = yield* fixture
      const registry = yield* Registry.Registry.pipe(Effect.provide(Registry.layerFromDescriptors([], [], snapshots)))
      const failure = yield* registry.loadBody("another-flow", digest).pipe(Effect.flip)
      expect(failure.code).toBe("execution_changed")
      expect(failure.message).toContain("Approved snapshot belongs to another flow")
      expect(executable.descriptor.name).toBe("snapshot")
    }))
  })

  it("registry loading uses the approved descriptor when the live registry no longer lists it", async () => {
    await run(Effect.gen(function*() {
      const { entry, snapshots, digest } = yield* fixture
      const registry = yield* Registry.Registry.pipe(Effect.provide(Registry.layerFromDescriptors([], [], snapshots)))
      expect(yield* registry.loadBody("snapshot", digest)).toMatchObject({ _tag: "Module", path: entry })
    }))
  })

  it("registry loading refuses an absent approved source when no snapshot port is installed", async () => {
    await run(Effect.gen(function*() {
      const { digest } = yield* fixture
      const registry = yield* Registry.Registry.pipe(Effect.provide(Registry.layerFromDescriptors([])))
      const failure = yield* registry.loadBody("snapshot", digest).pipe(Effect.flip)
      expect(failure.code).toBe("execution_changed")
      expect(failure.message).toContain("create and approve a new plan")
    }))
  })

  it("registry loading rechecks the identity returned by its host-owned snapshot port", async () => {
    await run(Effect.gen(function*() {
      const { snapshots, digest } = yield* fixture
      // The real CAS service cannot return this mismatch; this unit contract exercises
      // the registry's independent check of an alternative host implementation's response.
      const invalid: Snapshot.Service = {
        ...snapshots,
        restore: (digest) =>
          snapshots.restore(digest).pipe(
            Effect.map((source) => ({
              ...source,
              descriptor: new Descriptor.FlowDescriptor({ ...source.descriptor, description: "different identity" })
            }))
          )
      }
      const registry = yield* Registry.Registry.pipe(Effect.provide(Registry.layerFromDescriptors([], [], invalid)))
      const failure = yield* registry.loadBody("snapshot", digest).pipe(Effect.flip)
      expect(failure.code).toBe("execution_changed")
      expect(failure.message).toContain("changed after planning")
    }))
  })

  it("does not import a module when the host rejects its final file URL locator", async () => {
    await run(Effect.gen(function*() {
      const { path, entry, executable } = yield* fixture
      const descriptor = new Descriptor.FlowDescriptor({
        ...executable.descriptor,
        body: {
          ...executable.descriptor.body,
          path: pathToFileURL(entry).href
        }
      })
      const rejection = new PlatformError.BadArgument({
        module: "Path",
        method: "fromFileUrl",
        description: "Locator refused"
      })
      let resolutions = 0
      let imports = 0
      // A deterministic host-port refusal after source and closure reads reaches the
      // final import-locator contract; a real stable Node Path always answers identically.
      const rejecting = Path.Path.of({
        ...path,
        fromFileUrl: (url) =>
          ++resolutions === 3
            ? Effect.fail(rejection) :
            path.fromFileUrl(url)
      })
      const failure = yield* Executable.fromDescriptor(descriptor, {
        delegates: [],
        load: () => {
          imports++
          return Effect.succeed({ default: flow })
        }
      }).pipe(Effect.provideService(Path.Path, rejecting), Effect.flip)
      expect(failure.code).toBe("body_unavailable")
      expect(failure.message).toContain("Invalid module source locator")
      expect(failure.cause).toBe(rejection)
      expect(imports).toBe(0)
    }))
  })
})
