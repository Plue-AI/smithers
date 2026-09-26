/** Shared private immutable-source boundary for command and semantic checks. */
import { Effect, type FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CodingError, type Revision } from "./schema.ts"

export const ExportedTree = Schema.Struct({
  commitId: Schema.String,
  changeId: Schema.String,
  treeId: Schema.String,
  path: Schema.String,
  fileCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

export interface ImmutableSourceOptions {
  readonly repositoryPath: string
  /** Existing trusted host filesystem, captured before action workspace guards. */
  readonly fs: FileSystem.FileSystem
  readonly exporterPath?: string | undefined
  /** Host-selected build environment. No operator/provider credentials by default. */
  readonly environment?: Readonly<Record<string, string>> | undefined
}

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const outputLimit = 128 * 1024
/** Drain every byte, retaining only a bounded prefix for the existing receipt. */
const capture = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  Stream.runFold(stream, () => ({ text: "", bytes: 0, kept: 0, decoder: new TextDecoder() }), (state, chunk) => {
    const selected = chunk.subarray(0, Math.max(0, outputLimit - state.kept))
    return {
      text: state.text + state.decoder.decode(selected, { stream: true }),
      bytes: state.bytes + chunk.length,
      kept: state.kept + selected.length,
      decoder: state.decoder
    }
  }).pipe(Effect.map((state) => ({ text: state.text + state.decoder.decode(), truncated: state.bytes > outputLimit })))

export const contained = (root: string, candidate: string, path: Path.Path) => {
  const relative = path.relative(root, candidate)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
export const runSourceProcess = (
  options: ImmutableSourceOptions,
  argv: ReadonlyArray<string>,
  cwd: string,
  timeoutMs: number
) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const process = yield* spawner.spawn(ChildProcess.make(argv[0]!, argv.slice(1), {
      cwd,
      env: options.environment ?? {},
      extendEnv: false,
      stdin: "ignore"
    }))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      capture(process.stdout),
      capture(process.stderr),
      process.exitCode
    ], { concurrency: "unbounded" })
    return { stdout, stderr, exitCode }
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new CodingError({ code: "execution", message: "Revision check process exceeded its declared timeout" })
        )
    })
  )

/** The callback finishes before scoped cleanup. Only captured values may leave. */
export const withImmutableSource = <A, E, R>(
  options: ImmutableSourceOptions,
  revision: Revision,
  use: (tree: typeof ExportedTree.Type, root: string) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function*() {
    if (!/^[0-9a-f]{40}$/.test(revision.commitId) || !/^[0-9a-f]{40}$/.test(revision.treeId)) {
      return yield* invalid("Checks require full immutable native commit and tree IDs")
    }
    const fs = options.fs, path = yield* Path.Path
    // Keep dependency hardlinks on the workspace filesystem. Cloud /tmp is a
    // small tmpfs and copying the monorepo dependencies there exhausts it.
    const checkCache = options.environment?.HOME
      ? path.join(options.environment.HOME, ".cache", "smithers-checks") :
      undefined
    if (checkCache) yield* fs.makeDirectory(checkCache, { recursive: true })
    const temporary = yield* fs.makeTempDirectoryScoped({
      prefix: "smithers-check-",
      ...(checkCache ? { directory: checkCache } : {})
    })
    const temporaryRoot = yield* fs.realPath(temporary)
    const exported = yield* runSourceProcess(
      options,
      [
        options.exporterPath ?? "/usr/local/bin/smithers-jj-export",
        options.repositoryPath,
        revision.commitId,
        temporaryRoot
      ],
      options.repositoryPath,
      60_000
    )
    if (exported.exitCode !== 0 || exported.stdout.truncated) {
      return yield* invalid("Native immutable tree export failed; no check receipt was accepted")
    }
    const tree = yield* Effect.try({
      try: () => JSON.parse(exported.stdout.text) as unknown,
      catch: () => invalid("Native tree exporter returned no valid identity")
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ExportedTree)),
      Effect.mapError(() => invalid("Native tree exporter returned no valid identity"))
    )
    if (tree.commitId !== revision.commitId || tree.treeId !== revision.treeId || tree.changeId !== revision.changeId) {
      return yield* invalid("Native exported tree does not match the planned revision")
    }
    const root = yield* fs.realPath(tree.path)
    if (root === temporaryRoot || !contained(temporaryRoot, root, path)) {
      return yield* invalid("Native exporter returned a path outside its private temporary directory")
    }
    // A committed symlink into the editing checkout would make old source read
    // live bytes. Inspect links before any check starts; internal aliases are
    // allowed and canonical directories are visited only once.
    const pending = [root], visited = new Set<string>()
    while (pending.length) {
      const directory = pending.pop()!
      if (visited.has(directory)) continue
      visited.add(directory)
      for (const name of yield* fs.readDirectory(directory)) {
        const entry = yield* fs.realPath(path.join(directory, name)).pipe(
          Effect.mapError(() => invalid("Exported source contains an unresolved symbolic link or missing entry"))
        )
        if (!contained(root, entry, path)) {
          return yield* invalid("Exported source contains a symbolic link outside its immutable tree")
        }
        if ((yield* fs.stat(entry)).type === "Directory") pending.push(entry)
      }
    }

    return yield* use(tree, root)
  }).pipe(Effect.scoped)
