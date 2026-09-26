/** Private host composition: immutable native source in scoped scratch, never copy-back. */
import { Effect, type FileSystem, Layer, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { NativeCoding, type NativeOptions } from "./native.ts"
import { CapturePocSource, RetainPoc, invalid, sourceDigest, validPath } from "./poc.ts"
import { CodingError, sameRevision, validatePlan } from "./schema.ts"

const Export = Schema.Struct({ commitId: Schema.String, treeId: Schema.String, changeId: Schema.String, path: Schema.String })
export interface PocHostOptions extends NativeOptions {
  /** The existing host filesystem owns scratch creation and cleanup only. */
  readonly fs: FileSystem.FileSystem
  readonly exporterPath?: string | undefined
}
const fail = (message: string) => new CodingError({ code: "stale_revision", message })
const capture = <E>(stream: Stream.Stream<Uint8Array, E>) => Stream.runFoldEffect(stream,
  () => ({ decoder: new TextDecoder(), text: "", bytes: 0 }), (state, chunk) => state.bytes + chunk.length > 65_536
    ? Effect.fail(invalid("Native POC export output exceeded its bounded identity response"))
    : Effect.succeed({ decoder: state.decoder, text: state.text + state.decoder.decode(chunk, { stream: true }), bytes: state.bytes + chunk.length })
).pipe(Effect.map(state => state.text + state.decoder.decode()))
const execution = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.mapError(error =>
  error instanceof CodingError ? error : new CodingError({ code: "execution", message: "POC source export, verification or scratch cleanup failed" })))

export const pocSource = (options: PocHostOptions) => Layer.mergeAll(
  CapturePocSource.toLayer(({ plan, source }) => execution(Effect.gen(function*() {
    yield* Effect.try({ try: () => validatePlan(plan), catch: error => error instanceof CodingError ? error : invalid("Invalid prototype plan") })
    if (plan.observedHead !== undefined && !sameRevision(plan.observedHead, source)) {
      return yield* fail("The POC source does not match the plan's observed head")
    }
    const paths = [...new Set(plan.changes.flatMap(change => change.atoms.flatMap(atom => [...atom.reads, ...atom.writes])))].sort()
    const writable = [...new Set(plan.changes.flatMap(change => change.atoms.flatMap(atom => atom.writes)))].sort()
    if (paths.length === 0 || paths.length > 48 || writable.length === 0 || paths.some(path => !validPath(path))) {
      return yield* invalid("A file-level POC needs at most 48 explicit relative paths and at least one predicted write")
    }
    const native = yield* NativeCoding
    const current = yield* native.read([plan.base.changeId])
    const base = current.revisions.find(revision => revision.changeId === plan.base.changeId)
    if (current.head.kind !== "resolved" || !sameRevision(current.head, source) || !base || base.kind !== "resolved" ||
      base.commitId !== plan.base.commitId || base.treeId !== plan.base.treeId ||
      base.parentCommitIds.length !== plan.base.parentCommitIds.length || base.parentCommitIds.some((id, i) => id !== plan.base.parentCommitIds[i])) {
      return yield* fail("The POC source head or plan base changed; capture and plan again")
    }
    if (!/^[0-9a-f]{40}$/.test(source.commitId) || !/^[0-9a-f]{40}$/.test(source.treeId)) return yield* invalid("POC source needs full immutable native commit and tree IDs")
    const fs = options.fs, path = yield* Path.Path, spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-poc-" })
    const canonical = yield* fs.realPath(scratch)
    const process = yield* spawner.spawn(ChildProcess.make(options.exporterPath ?? "/usr/local/bin/smithers-jj-export",
      [options.repositoryPath, source.commitId, canonical], { cwd: options.repositoryPath, env: {}, extendEnv: false, stdin: "ignore" }))
    const [stdout, , exit] = yield* Effect.all([capture(process.stdout), capture(process.stderr), process.exitCode], { concurrency: "unbounded" })
    if (exit !== 0) return yield* invalid("Native POC source export failed")
    const exported = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Export))(stdout)
    if (exported.commitId !== source.commitId || exported.treeId !== source.treeId || exported.changeId !== source.changeId) {
      return yield* invalid("Native POC export differs from the explicitly captured source")
    }
    const inside = (root: string, target: string) => {
      const suffix = path.relative(root, target)
      return suffix !== ".." && !suffix.startsWith(`..${path.sep}`) && !path.isAbsolute(suffix)
    }
    const root = yield* fs.realPath(exported.path)
    if (root === canonical || !inside(canonical, root)) return yield* invalid("Native POC export escaped its private scratch directory")
    const files: Array<{ path: string; content: string | null }> = []
    let total = 0
    for (const name of paths) {
      const segments = name.split("/")
      let missing = false
      for (let i = 1; i <= segments.length; i++) {
        const candidate = path.join(root, ...segments.slice(0, i))
        const real = yield* fs.realPath(candidate).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)))
        if (real === null) {
          // A dangling committed symlink is not an absent file.
          const link = yield* fs.readLink(candidate).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)))
          if (link !== null) return yield* invalid("POC source includes an unresolved symbolic link")
          missing = true
          break
        }
        if (!inside(root, real)) return yield* invalid("POC source path resolves outside its immutable export")
      }
      if (missing) { files.push({ path: name, content: null }); continue }
      const target = path.join(root, name), info = yield* fs.stat(target)
      if (info.type !== "File" || info.size > 65_536n) return yield* invalid("POCs accept only bounded UTF-8 source files; narrow the predicted path set")
      const content = yield* fs.readFile(target)
      total += content.byteLength
      if (content.byteLength > 65_536 || total > 524_288) return yield* invalid("POC captured source exceeds its bounded file-level budget")
      const text = yield* Effect.try({ try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content), catch: () => invalid("POC source must be valid UTF-8 text") })
      files.push({ path: name, content: text })
    }
    const snapshot = { revision: source, files, writable }
    return { ...snapshot, digest: sourceDigest(snapshot) }
  }).pipe(Effect.scoped, Effect.timeout("2 minutes")))),
  RetainPoc.toLayer(({ source, changes, review }) => execution(Effect.gen(function*() {
    const current = yield* (yield* NativeCoding).read()
    if (current.head.kind !== "resolved" || !sameRevision(current.head, source.revision)) {
      return yield* fail("Native revision changed during the discarded prototype; its findings cannot silently steer a different source")
    }
    if (changes.sourceDigest !== source.digest) return yield* invalid("POC review does not identify its captured source")
    const feedback = [
      "Saved disposable file-level POC: drafted-unvalidated. No build or tests ran.",
      `Source commit: ${source.revision.commitId}; captured input digest: ${source.digest}`,
      `Measured changed files: ${changes.files.map(file => file.path).join(", ")}`,
      "Review findings (model hypotheses unless directly supported by the retained diff):", ...review.findings,
      `Second-plan guidance: ${review.nextPlan}`
    ].join("\n")
    return { status: "drafted-unvalidated" as const, source: source.revision, changes, findings: review.findings,
      feedback: feedback.length <= 32_768 ? feedback : feedback.slice(0, 32_650) + "\n[Feedback truncated; inspect the retained prototype for full findings.]" }
  })))
)
