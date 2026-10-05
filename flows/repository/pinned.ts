/**
 * Pinned flow versions (engineering spec §11.4.1).
 *
 * A TODO attempt pins `(todo, source commit, digest)` when it enters Starting.
 * The lane's coding host reads `flows/todo/flow.ts` from that commit, or the
 * built-in composition when the commit has none, never from the working copy
 * it serves, and serves it only when it measures the pinned digest: the same
 * version digest flow-load measured (`versionDigest`). A TODO that edits the
 * flow, or rebases onto such an edit, therefore still runs its pinned
 * version. The version is materialized in this host's state, outside the
 * working copy, and loaded with the host's own loader; its steps come from
 * the coding host the install ships (§11.3.0), so no closure is stored.
 */
import * as Digest from "@smthrs/core/Digest"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { RegistryError, registryError } from "@smthrs/registry/RegistryError"
import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process"
import type * as PinnedFlow from "../../packages/smithers/src/internal/PinnedFlow.ts"
import { versionDigest } from "../coding/flow-load.ts"

/** The flows a TODO pins. Each runs only from a pinned launch. */
export const pinnable: ReadonlySet<string> = new Set(["todo"])

const sourceLimit = 1_000_000

export interface PinnedFlows {
  /** The registry serving `name`'s activated version, if one is active. */
  readonly active: (name: string) => Registry.Registry | undefined
  readonly activate: PinnedFlow.Activate
}

const refuse = (description: string, path?: string) =>
  registryError({ code: "execution_changed", method: "loadBody", description, ...(path === undefined ? {} : { path }) })

/**
 * Reads one file of the repository at a commit from its Git object store,
 * never through the working copy or JJ's working-copy state: a colocated JJ
 * checkout's store, or JJ's internal one. A read with
 * `--ignore-working-copy` would miss a commit Git fetched since JJ's last
 * import. Answers `undefined` when the commit has no such file.
 */
export const repositorySource = (
  repositoryPath: string,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  fs: FileSystem.FileSystem,
  path: Path.Path,
  /** Brings a commit this store lacks into it: the stack retains the pin's commit for the lane. */
  fetch?: (commit: string) => Effect.Effect<void, string>
) =>
(commit: string, relative: string): Effect.Effect<string | undefined, RegistryError> =>
  Effect.gen(function*() {
    if (!/^[0-9a-f]{40}$/.test(commit) || !/^flows\/[a-z][a-z0-9-]*\/flow\.ts$/.test(relative)) {
      return yield* Effect.fail(refuse(`The pinned source ${commit}:${relative} is not a commit and flow file`))
    }
    const colocated = path.join(repositoryPath, ".git")
    const gitDir = (yield* fs.exists(colocated)) ? colocated : path.join(repositoryPath, ".jj", "repo", "store", "git")
    const run = (args: ReadonlyArray<string>) =>
      Effect.scoped(Effect.gen(function*() {
        const child = yield* spawner.spawn(
          ChildProcess.make("git", ["--git-dir", gitDir, ...args], { cwd: repositoryPath, stdin: "ignore" })
        )
        const bytes = yield* Stream.runFoldEffect(child.stdout, () => new Uint8Array(0), (all, chunk) => {
          if (all.length + chunk.length > sourceLimit) {
            return Effect.fail(refuse(`${relative} at ${commit} exceeds ${sourceLimit} bytes`))
          }
          const next = new Uint8Array(all.length + chunk.length)
          next.set(all)
          next.set(chunk, all.length)
          return Effect.succeed(next)
        })
        const failure = yield* Stream.runFold(child.stderr, () => "", (text, chunk) =>
          text.length > 2000 ? text : text + new TextDecoder().decode(chunk))
        const exit = yield* child.exitCode
        const text = yield* Effect.try(() =>
          new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        )
        return { exit, text, failure: failure.trim().slice(0, 2000) }
      }))
    let present = yield* run(["cat-file", "-e", `${commit}^{commit}`])
    if (present.exit !== 0 && fetch !== undefined) {
      yield* fetch(commit).pipe(
        Effect.mapError((message) => refuse(`The pinned source commit ${commit} could not be imported: ${message}`))
      )
      present = yield* run(["cat-file", "-e", `${commit}^{commit}`])
    }
    if (present.exit !== 0) {
      return yield* Effect.fail(
        refuse(`The pinned source commit ${commit} is not in this repository: ${present.failure}`)
      )
    }
    const listed = yield* run(["ls-tree", "--name-only", commit, "--", relative])
    if (listed.exit !== 0) return yield* Effect.fail(refuse(`${commit} could not be listed: ${listed.failure}`))
    if (listed.text.trim() !== relative) return undefined
    const shown = yield* run(["cat-file", "blob", `${commit}:${relative}`])
    if (shown.exit !== 0) {
      return yield* Effect.fail(refuse(`${relative} could not be read at ${commit}: ${shown.failure}`))
    }
    return shown.text
  }).pipe(Effect.mapError((error) =>
    error instanceof RegistryError
      ? error
      : refuse(`The pinned source at ${commit} could not be read: ${String(error)}`)
  ))

/**
 * One host's pinned versions. `read` answers a file at a commit (undefined:
 * none there); `builtin` the built-in source of a pinnable flow.
 */
export const makePinnedFlows = (options: {
  /** Where versions are materialized: a directory the catalog's guarded file system reads but no run snapshots. */
  readonly root: string
  readonly read: (commit: string, relative: string) => Effect.Effect<string | undefined, RegistryError>
  readonly builtin: (name: string) => string | undefined
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
}): PinnedFlows => {
  const { fs, path } = options
  const active = new Map<string, Registry.Registry>()
  const activate: PinnedFlow.Activate = (pin) =>
    Effect.gen(function*() {
      if (!pinnable.has(pin.flow)) return yield* Effect.fail(refuse(`${pin.flow} is not a pinned flow`))
      const relative = `flows/${pin.flow}/flow.ts`
      const source = (yield* options.read(pin.sourceCommit, relative)) ?? options.builtin(pin.flow)
      if (source === undefined) return yield* Effect.fail(refuse(`${pin.flow} has no built-in version on this host`))
      // One directory per version's bytes, outside the tracked working copy
      // a run edits; the catalog rereads them only at their measured digest.
      const root = path.join(options.root, Digest.digest(source))
      const file = path.join(root, pin.flow, "flow.ts")
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      if ((yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined))) !== source) {
        yield* fs.writeFileString(file, source)
      }
      const registry = yield* Registry.make({ sources: [{ root, source: "project", naming: "path" }] }).pipe(
        Effect.provide(Discovery.layer),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path)
      )
      const descriptor: Descriptor.FlowDescriptor = yield* registry.get(pin.flow)
      const measured = versionDigest(descriptor)
      if (measured !== pin.executionDigest) {
        return yield* Effect.fail(
          refuse(
            `${relative} at ${pin.sourceCommit} measures ${measured ?? "nothing"}, not its pin ${pin.executionDigest}`,
            relative
          )
        )
      }
      active.set(pin.flow, registry)
      return descriptor
    }).pipe(Effect.mapError((error) =>
      error instanceof RegistryError ? error : refuse(`The pinned ${pin.flow} could not be loaded: ${String(error)}`)
    ))
  return { active: (name) => active.get(name), activate }
}
