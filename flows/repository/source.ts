/** Immutable native commit capture, without moving the editing checkout. */
import { Effect, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { contained, ExportedTree, type ImmutableSourceOptions, runSourceProcess } from "../coding/immutable-source.ts"
import { normalizePath } from "../coding/planning-sources.ts"
import { CodingError, type Revision } from "../coding/schema.ts"
const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
/** Check every ancestor before creating a directory or opening a destination. */
export const admitSourcePath = (options: ImmutableSourceOptions, root: string, relative: string) =>
  Effect.gen(function*() {
    if (normalizePath(relative) !== relative) return yield* invalid("A source path must be canonical and relative")
    const fs = options.fs, path = yield* Path.Path, canonical = yield* fs.realPath(root)
    let target = canonical
    for (const part of relative.split("/")) {
      target = path.join(target, part)
      const link = yield* fs.readLink(target).pipe(Effect.result)
      if (link._tag === "Success") return yield* invalid("A source path cannot cross a symbolic link")
      const resolved = yield* fs.realPath(target).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined))
      )
      if (resolved !== undefined && (resolved !== target || !contained(canonical, resolved, path))) {
        return yield* invalid("A source path leaves its captured tree")
      }
    }
    return target
  }).pipe(
    Effect.mapError((error) =>
      error instanceof CodingError ? error : invalid("The source destination could not be admitted")
    )
  )
const Metadata = Schema.Struct({
  commit_id: Schema.String,
  change_id: Schema.String,
  parents: Schema.Array(Schema.String)
})
export const withCapturedCommit = <A, E, R>(
  options: ImmutableSourceOptions,
  commitId: string,
  operationId: string,
  use: (root: string, revision: Revision) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function*() {
    if (!/^[0-9a-f]{40}$/.test(commitId) || !/^[0-9a-f]{128}$/.test(operationId)) {
      return yield* invalid("Capture needs full immutable native commit and operation IDs")
    }
    const fs = options.fs, path = yield* Path.Path, spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-repository-source-" }),
      canonical = yield* fs.realPath(scratch)
    const exported = yield* runSourceProcess(
      options,
      [options.exporterPath ?? "/usr/local/bin/smithers-jj-export", options.repositoryPath, commitId, canonical],
      options.repositoryPath,
      60000
    )
    if (exported.exitCode !== 0 || exported.stdout.truncated) {
      return yield* invalid("The selected source commit is unavailable on this repository host")
    }
    const tree = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ExportedTree))(exported.stdout.text)
    const root = yield* fs.realPath(tree.path)
    if (tree.commitId !== commitId || root === canonical || !contained(canonical, root, path)) {
      return yield* invalid("The native exporter returned another source or path")
    }
    // This is a fixed host-owned JJ read, never an event-provided command.
    const command = yield* spawner.spawn(
      ChildProcess.make("jj", [
        "-R",
        options.repositoryPath,
        "--ignore-working-copy",
        `--at-op=${operationId}`,
        "log",
        "--no-graph",
        "-r",
        `commit_id("${commitId}")`,
        "-T",
        "json(self)"
      ], { cwd: options.repositoryPath, stdin: "ignore" })
    )
    const text = yield* Stream.runFoldEffect(command.stdout, () => "", (text, chunk) =>
      text.length + chunk.length > 65536
        ? Effect.fail(invalid("Native commit metadata exceeded its bound")) :
        Effect.succeed(text + new TextDecoder().decode(chunk)))
    const exit = yield* command.exitCode
    if (exit !== 0) return yield* invalid("The selected immutable commit has no native metadata")
    const metadata = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Metadata))(text)
    if (
      metadata.commit_id !== tree.commitId || metadata.change_id !== tree.changeId ||
      metadata.parents.some((id) => !/^[0-9a-f]{40}$/.test(id))
    ) return yield* invalid("Native commit identity disagrees with its export")
    return yield* use(root, {
      changeId: tree.changeId,
      commitId,
      treeId: tree.treeId,
      operationId,
      parentCommitIds: metadata.parents
    })
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => error instanceof CodingError ? error : invalid("Immutable source capture failed"))
  )
