/**
 * Durable, content-addressed source closures retained at execution admission.
 * @since 1.0.0-rc.1
 */

import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as FileLease from "@smthrs/artifacts/FileLease"
import * as Digest from "@smthrs/core/Digest"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Descriptor from "./Descriptor.ts"
import type { ClosureModule, Executable, VerifiedSource } from "./Executable.ts"
import * as Prompt from "./Prompt.ts"

/** Snapshot integrity, availability, and dependency drift failures.
 * @category errors
 * @since 1.0.0-rc.1
 */
export class ExecutionSnapshotError extends Schema.TaggedError<ExecutionSnapshotError>()(
  "@smthrs/registry/ExecutionSnapshotError",
  {
    code: Schema.Literals(["missing", "corrupt", "lockfile_changed", "unavailable"]),
    message: Schema.String,
    /** No admission index exists; a missing blob behind an index is damaged stored state. */
    indexMissing: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/** The verified source closure and its approved descriptor.
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Restored extends VerifiedSource {
  readonly descriptor: Descriptor.FlowDescriptor
}
/** Source and dependency identities for one loaded flow version.
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Version {
  readonly digest: string
  readonly executionDigest: string
  readonly lockfileDigest: string
  readonly modules: ReadonlyArray<string>
}
/** Admission persistence and approved source restoration.
 * @category services
 * @since 1.0.0-rc.1
 */
export interface Service {
  readonly pin: (executable: Executable) => Effect.Effect<void, ExecutionSnapshotError>
  readonly descriptor: (digest: string) => Effect.Effect<Descriptor.FlowDescriptor, ExecutionSnapshotError>
  readonly restore: (digest: string) => Effect.Effect<Restored, ExecutionSnapshotError>
  readonly roots: (digests: Iterable<string>) => Effect.Effect<ReadonlyArray<string>, ExecutionSnapshotError>
}
/** The host-owned execution snapshot service.
 * @category services
 * @since 1.0.0-rc.1
 */
export class ExecutionSnapshot
  extends Context.Service<ExecutionSnapshot, Service>()("@smthrs/registry/ExecutionSnapshot")
{}

const Link = Schema.Struct({ start: Schema.Number, end: Schema.Number, target: Schema.String })
const Manifest = Schema.Struct({
  executionDigest: Schema.String,
  entry: Schema.String,
  descriptor: Descriptor.FlowDescriptor,
  modules: Schema.Record(Schema.String, Schema.String),
  lockfileDigest: Schema.String,
  compiled: Schema.Record(Schema.String, Schema.Struct({ source: Schema.String, links: Schema.Array(Link) }))
})
const fail = (code: ExecutionSnapshotError["code"], message: string, cause?: unknown, indexMissing?: true) =>
  new ExecutionSnapshotError({ code, message, cause, ...(indexMissing ? { indexMissing } : {}) })
const address = (value: string) => /^[a-f0-9]{64}$/.test(value)
const lockfiles = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"]
const measureLockfiles = (fs: FileSystem.FileSystem, path: Path.Path, root: string) =>
  Effect.gen(function*() {
    const measured: Array<readonly [string, string]> = []
    for (const name of lockfiles) {
      const filename = path.join(root, name)
      const bytes = yield* fs.readFile(filename).pipe(
        Effect.map(Option.some),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none()))
      )
      if (Option.isSome(bytes)) measured.push([name, Digest.digest(bytes.value)])
    }
    return Digest.digest(new TextEncoder().encode(JSON.stringify(measured)))
  })
/** Measures a flow version without importing modules or writing a snapshot.
 * The version combines the execution closure and the repository lockfiles.
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const version = (
  root: string,
  executable: Executable
): Effect.Effect<Version, ExecutionSnapshotError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    root = path.resolve(root)
    const executionDigest = Descriptor.executionDigest(executable.descriptor)
    if (executionDigest === undefined || executable.source === undefined) {
      return yield* Effect.fail(fail("unavailable", "Executable has no verified source closure"))
    }
    const lock = yield* measureLockfiles(fs, path, root)
    // spec §11.3.0; C-J5-02 distinguishes version and execution identities.
    return {
      digest: Digest.digest(new TextEncoder().encode(JSON.stringify([executionDigest, lock]))),
      executionDigest,
      lockfileDigest: lock,
      modules: [...executable.source.modules.keys()].map((file) => path.relative(root, file)).sort()
    }
  }).pipe(Effect.mapError((cause) =>
    cause instanceof ExecutionSnapshotError ? cause : fail("unavailable", "Cannot measure flow version", cause)
  ))

const verifiedCompilation = (filename: string, module: ClosureModule, descriptor: Descriptor.FlowDescriptor) =>
  Effect.gen(function*() {
    const raw = new TextDecoder().decode(module.bytes)
    const expected = yield* Effect.try(() =>
      descriptor.body._tag === "Module" && filename.endsWith(".mdx")
        ? Prompt.compile(raw) :
        raw
    )
    if (
      module.source !== expected ||
      module.links.some((link) =>
        !Number.isInteger(link.start) || !Number.isInteger(link.end) || link.start < 0 || link.end <= link.start ||
        link.end > module.source.length
      )
    ) {
      return yield* Effect.fail(fail("corrupt", "Execution source compilation or static links differ"))
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ExecutionSnapshotError ? cause : fail("corrupt", "Cannot verify source compilation", cause)
    )
  )

/** Builds durable snapshots over a verified content-addressed store.
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const makeFileSystem = (options: { readonly root: string; readonly store?: ArtifactStore.Service }) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const root = path.resolve(options.root)
    const directory = path.join(root, ".flows", "executions")
    const store = options.store ??
      ArtifactStore.makeFileSystem(fs, path, { directory: path.join(root, ".flows", "objects") })
    const put = (bytes: Uint8Array) => store.put(bytes).pipe(Effect.provideService(Crypto.Crypto, crypto))
    const get = (digest: string) => store.get(digest).pipe(Effect.provideService(Crypto.Crypto, crypto))
    const syncDirectories = Effect.gen(function*() {
      for (const parent of [directory, path.dirname(directory), root]) {
        yield* Effect.scoped(Effect.flatMap(fs.open(parent, { flag: "r" }), (file) => file.sync))
      }
    })
    const lockfileDigest = measureLockfiles(fs, path, root)
    const readManifest = (digest: string, checkLockfiles = true) =>
      Effect.gen(function*() {
        if (!address(digest)) return yield* Effect.fail(fail("corrupt", "Invalid execution digest"))
        // Read without a prior existence check: a concurrent pin may retire the index at any moment.
        const indexBytes = yield* fs.readFile(path.join(directory, `${digest}.json`)).pipe(
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            (_, cause) => Effect.fail(fail("missing", "Execution snapshot is unavailable", cause, true))
          ),
          Effect.mapError((cause) =>
            cause instanceof ExecutionSnapshotError
              ? cause
              : fail("unavailable", "Cannot read execution snapshot index", cause)
          )
        )
        const blob = yield* Effect.try(() => JSON.parse(new TextDecoder().decode(indexBytes)) as unknown)
        if (typeof blob !== "string" || !address(blob)) {
          return yield* Effect.fail(fail("corrupt", "Invalid execution snapshot index"))
        }
        const manifestBytes = yield* get(blob)
        const manifest = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(Manifest))(
          yield* Effect.try(() => JSON.parse(new TextDecoder().decode(manifestBytes)))
        )
        if (manifest.executionDigest !== digest || Descriptor.executionDigest(manifest.descriptor) !== digest) {
          return yield* Effect.fail(fail("corrupt", "Execution snapshot descriptor identity differs"))
        }
        if (checkLockfiles && manifest.lockfileDigest !== (yield* lockfileDigest)) {
          return yield* Effect.fail(fail("lockfile_changed", "Project lockfiles changed after admission"))
        }
        return { manifest, blob }
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ExecutionSnapshotError
            ? cause
            : fail(
              cause instanceof ArtifactStore.ArtifactMissing ? "missing" : "corrupt",
              "Cannot read execution snapshot",
              cause
            )
        )
      )
    const restore: Service["restore"] = (digest) =>
      Effect.gen(function*() {
        const { manifest } = yield* readManifest(digest)
        const modules = new Map<string, ClosureModule>()
        for (const [filename, blob] of Object.entries(manifest.modules)) {
          const bytes = yield* get(blob)
          const compiled = manifest.compiled[filename]
          if (compiled === undefined || compiled.links.some((link) => manifest.modules[link.target] === undefined)) {
            return yield* Effect.fail(fail("corrupt", "Incomplete execution closure"))
          }
          yield* verifiedCompilation(filename, { bytes, ...compiled }, manifest.descriptor)
          modules.set(filename, { bytes, ...compiled })
        }
        const entry = modules.get(manifest.entry)
        if (entry === undefined || Digest.digest(entry.bytes) !== manifest.descriptor.body.contentDigest) {
          return yield* Effect.fail(fail("corrupt", "Execution entry digest differs"))
        }
        if (manifest.descriptor.body._tag === "Module") {
          const expected = manifest.descriptor.body.imports ?? []
          if (modules.size !== expected.length + 1) {
            return yield* Effect.fail(fail("corrupt", "Execution closure size differs"))
          }
          for (const module of expected) {
            const filename = path.resolve(path.dirname(manifest.entry), module.path)
            const bytes = modules.get(filename)?.bytes
            if (bytes === undefined || Digest.digest(bytes) !== module.contentDigest) {
              return yield* Effect.fail(fail("corrupt", "Execution helper digest differs"))
            }
          }
        }
        return { descriptor: manifest.descriptor, entry: manifest.entry, bytes: entry.bytes, modules }
      }).pipe(Effect.mapError((cause) =>
        cause instanceof ExecutionSnapshotError
          ? cause
          : fail(
            cause instanceof ArtifactStore.ArtifactMissing ? "missing" : "corrupt",
            "Cannot restore execution closure",
            cause
          )
      ))
    const pinUnlocked: Service["pin"] = (executable) =>
      Effect.gen(function*() {
        const executionDigest = Descriptor.executionDigest(executable.descriptor)
        const captured = executable.source
        const source = captured === undefined ? undefined : {
          entry: captured.entry,
          bytes: captured.bytes.slice(),
          modules: new Map([...captured.modules].map(([filename, module]) => [filename, {
            bytes: module.bytes.slice(),
            source: module.source,
            links: module.links.map((link) => ({ ...link }))
          }]))
        }
        if (executionDigest === undefined || source === undefined) {
          return yield* Effect.fail(fail("unavailable", "Executable has no verified source closure"))
        }
        if (
          Digest.digest(source.bytes) !== executable.descriptor.body.contentDigest ||
          Digest.digest(source.modules.get(source.entry)?.bytes ?? new Uint8Array()) !==
            executable.descriptor.body.contentDigest
        ) {
          return yield* Effect.fail(fail("corrupt", "Verified entry bytes changed before admission"))
        }
        if (executable.descriptor.body._tag === "Module") {
          for (const module of executable.descriptor.body.imports ?? []) {
            const bytes = source.modules.get(path.resolve(path.dirname(source.entry), module.path))?.bytes
            if (bytes === undefined || Digest.digest(bytes) !== module.contentDigest) {
              return yield* Effect.fail(fail("corrupt", "Verified helper bytes changed before admission"))
            }
          }
        }
        const indexPath = path.join(directory, `${executionDigest}.json`)
        if (yield* fs.exists(indexPath)) {
          const retained = yield* restore(executionDigest).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              error.cause instanceof ArtifactStore.ArtifactMissing
                ? fs.remove(indexPath).pipe(
                  Effect.as(false),
                  Effect.mapError((cause) => fail("unavailable", "Cannot retire collected snapshot index", cause))
                )
                : Effect.fail(error)
            )
          )
          if (retained) {
            yield* Effect.scoped(Effect.flatMap(fs.open(indexPath, { flag: "r+" }), (file) => file.sync))
            yield* syncDirectories
            return
          }
        }
        const modules: Record<string, string> = {}
        const compiled: Record<string, { readonly source: string; readonly links: ReadonlyArray<typeof Link.Type> }> =
          {}
        for (const [filename, module] of source.modules) {
          yield* verifiedCompilation(filename, module, executable.descriptor)
          modules[filename] = yield* put(module.bytes)
          compiled[filename] = { source: module.source, links: module.links }
        }
        const manifest = {
          executionDigest,
          entry: source.entry,
          modules,
          compiled,
          descriptor: executable.descriptor,
          lockfileDigest: yield* lockfileDigest
        }
        const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(Manifest))(manifest)
        const bytes = new TextEncoder().encode(yield* Effect.try(() => JSON.stringify(encoded)))
        const blob = yield* put(bytes)
        yield* fs.makeDirectory(directory, { recursive: true })
        yield* Effect.scoped(Effect.gen(function*() {
          // The index is published once linked; failing to reclaim the temporary must not undo that.
          const temporary = yield* Effect.acquireRelease(
            fs.makeTempFile({ directory, prefix: ".snapshot-" }),
            (file) => {
              const parent = path.dirname(file)
              // Delete recursively only a private `.snapshot-*` directory directly inside the store.
              const reclaim = path.dirname(parent) === directory && path.basename(parent).startsWith(".snapshot-")
                ? fs.remove(parent, { recursive: true })
                : Effect.logWarning("Snapshot temporary is not in a private directory", file).pipe(
                  Effect.andThen(fs.remove(file))
                )
              return reclaim.pipe(
                Effect.catch((cause) => Effect.logWarning("Cannot reclaim snapshot temporary", cause))
              )
            }
          )
          yield* fs.writeFileString(temporary, JSON.stringify(blob))
          yield* Effect.scoped(Effect.flatMap(fs.open(temporary, { flag: "r+" }), (file) => file.sync))
          yield* fs.link(temporary, indexPath).pipe(Effect.catch((cause) =>
            fs.exists(indexPath).pipe(Effect.flatMap((exists) =>
              exists
                ? Effect.asVoid(restore(executionDigest)) :
                Effect.fail(fail("unavailable", "Cannot publish snapshot index", cause))
            ))
          ))
          yield* syncDirectories
        }))
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ExecutionSnapshotError ? cause : fail("unavailable", "Cannot pin execution closure", cause)
        )
      )
    const pin: Service["pin"] = (executable) =>
      Effect.gen(function*() {
        const digest = Descriptor.executionDigest(executable.descriptor)
        if (digest === undefined) return yield* Effect.fail(fail("unavailable", "Executable source is unmeasured"))
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
        yield* FileLease.withLease(
          fs,
          path.join(directory, `${digest}.lock`),
          pinUnlocked(executable),
          (cause) => fail("unavailable", "Cannot acquire execution snapshot publication lease", cause),
          { label: "Execution snapshot", annotations: { digest } }
        )
      }).pipe(Effect.mapError((cause) =>
        cause instanceof ExecutionSnapshotError
          ? cause
          : fail("unavailable", "Cannot publish execution snapshot", cause)
      ))
    const roots: Service["roots"] = (digests) =>
      Effect.gen(function*() {
        const roots = new Set<string>()
        for (const digest of digests) {
          const { manifest, blob } = yield* readManifest(digest, false)
          roots.add(blob)
          for (const value of Object.values(manifest.modules)) roots.add(value)
        }
        return [...roots]
      })
    return {
      pin,
      restore,
      roots,
      descriptor: (digest: string) => Effect.map(readManifest(digest), ({ manifest }) => manifest.descriptor)
    } satisfies Service
  })

/** Provides the filesystem execution snapshot service.
 * @category layers
 * @since 1.0.0-rc.1
 */
export const layerFileSystem = (options: { readonly root: string; readonly store?: ArtifactStore.Service }) =>
  Layer.effect(ExecutionSnapshot)(makeFileSystem(options))
