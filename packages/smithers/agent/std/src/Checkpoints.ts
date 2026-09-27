/**
 * Pinned trees, and the scratch checkouts a call runs against.
 *
 * A checkpoint is a **value**: minting one changes nothing about the workspace,
 * and running a call against one leaves the live tree exactly as it stands.
 * That is the whole of what it buys. Before it existed, the only way a run
 * could answer "did this command fail before my change" was to undo the change
 * — and the journals price that exactly. On `sympy__sympy-13878` the r95repl
 * lane applied one byte-identical 4,789-character patch **five times**, four of
 * those applications preceded by `git checkout -- sympy/stats/crv_types.py`,
 * because a clean fails-before proof required reverting the very work it was
 * meant to prove.
 *
 * This module is the host half of `@smthrs/harness`'s `ctx.checkpoint()` and
 * `ctx.call(flow, input, { at })`. The harness owns the surface, the identity,
 * the bound and the refusals; nothing in it knows what a tree is. This owns the
 * two host operations that need one:
 *
 * - {@link Checkpoints.capture} records the working tree under an id, and
 * - {@link Checkpoints.materialize} gives that tree back as a directory for the
 *   length of one call.
 *
 * ## The git binding, and the container constraint it is shaped by
 *
 * {@link layerGit} records a checkpoint with `git stash create`, then names the
 * commit it prints in this repository's own git config rather than with a ref —
 * see {@link configSection} for why a ref would hand the agent its own edit back
 * as history. `stash create` is the one git command
 * that records the working tree and changes nothing else: it does not write the
 * repository's index, does not move the worktree, and does not touch the stash
 * ref. That matters more than it sounds. The agent runs `git` in this same
 * workspace and its own `git diff` is the run's evidence, so a capture that
 * staged into the real index would be the harness editing the evidence while
 * recording it. A tree with nothing to record prints nothing, and the
 * checkpoint is then `HEAD` — which is exactly what the tree is.
 *
 * Untracked files are not in the recorded tree, which matches how the rig
 * captures a patch: `capture-patch.sh` drops paths that did not exist when the
 * agent started, so a checkpoint holds what a patch would hold.
 *
 * The materialization is a detached worktree at `<root>/.flows-checkpoints/<id>-<lease>`
 * — **inside** the workspace, which looks wrong and is the only thing that
 * works. A benchmark check runs through `docker exec` inside `/testbed`, and
 * `/testbed` is a bind mount of the live workspace. A scratch checkout anywhere
 * else on the host is simply not visible to the container, so the call would run
 * against a path that does not exist. Placed under the workspace it is visible
 * at the same subpath under the mount, needs no second mount, and needs no
 * change to how the rig starts its container. `TestRun`'s `against: "base"`
 * reached the same conclusion first and this reuses its shape;
 * `evals/swebench/run-instance.sh` excludes the directory from patch capture for
 * the same reason it excludes `.flows-test-base`.
 *
 * The worktree is added and removed around **one call**, which is stricter than
 * the frame lifetime the design asks for and much simpler: there is no cache to
 * invalidate, no id to leak, and a checkpoint used by three calls pays three
 * checkouts rather than risking one stale directory. A run that reuses a
 * checkpoint across frames simply re-materializes it, because the ref is what
 * persists.
 *
 * ## What can be pointed at a checkpoint, and what cannot
 *
 * {@link relocate} is the closed answer, and `Relocate.ts` owns it. That half
 * knows the input shapes of `bash`, `read`, `ls`, `grep` and `glob`; this half
 * knows git. They change for different reasons, so they are different modules,
 * and {@link relocate} is re-exported here because the harness reaches the whole
 * feature through this one.
 *
 * @since 1.0.0
 */

import { ChildProcessSpawner } from "@smthrs/kernel/ChildProcessSpawner"
import { Context, Effect, Layer, Schema } from "effect"
import * as Exec from "./internal/Exec.ts"
import { GitWorktree } from "./internal/GitWorktree.ts"
import { withoutTrailingSlash } from "./internal/Paths.ts"
import * as Prune from "./internal/Prune.ts"
import * as StdError from "./StdError.ts"
import * as TestRunner from "./TestRunner.ts"

/**
 * The id naming the tree a run opened on.
 *
 * It is not minted: the host either recorded one before the agent started or it
 * did not. {@link layerGit} resolves it to {@link TestRunner.captureBase} and
 * then to `HEAD`, which is the same precedence `TestRun` uses for the same
 * question — so a workspace that has one answer for a baseline has one answer
 * for both.
 *
 * @category constants
 * @since 1.0.0
 */
export const baseId = "base"

/**
 * The directory checkpoints are materialized into, relative to the repository
 * root and therefore also relative to a container's view of it.
 *
 * @category constants
 * @since 1.0.0
 */
export const scratchDirectory = Prune.checkpointScratch

/**
 * The git-config section {@link layerGit} records minted checkpoints under.
 *
 * Config and **not a ref**, and that is the whole of the decision. A ref is
 * history: `git log --all` lists it, `git show` prints it, and `git log --all
 * -S` searches it — so a checkpoint named by a ref would hand an agent a commit
 * containing its own edit and let it read that back as if it were upstream
 * work. That exact class cost the measured program real money before the rig
 * moved jj's store out of the workspace (`evals/swebench/run-instance.sh`:
 * django-13346 applied two of its own snapshots as a fake fix), and a ref here
 * would reintroduce it one wave later.
 *
 * The commit object itself is unreferenced. It stays alive for the life of the
 * run — nothing in a run prunes — and `git worktree add --detach <sha>` checks
 * one out perfectly well, which is measured in `CheckpointsFixture.test.ts`. So
 * the tree is reachable by id and no command that walks refs can reach it:
 * `git log`, `git log --all`, `git log -S` and `git show <ref>` all answer
 * exactly as they did before the capture.
 *
 * Two commands still see it, and both are measured rather than argued in
 * `CheckpointsFixture.test.ts`. `git fsck` reports it as a dangling commit,
 * because that is what an unreferenced commit is; and while a checkpoint is
 * checked out, `git log --all` includes the other worktree's detached `HEAD`,
 * because `--all` spans worktrees unless `--single-worktree` says otherwise.
 * Neither is reachable by a name that looks like project history, and the cell
 * contract's environment section says outright that a dangling commit is this
 * harness holding the agent's own tree — which is the half of the django-13346
 * lesson that a store cannot enforce.
 *
 * @category constants
 * @since 1.0.0
 */
export const configSection = "flows-checkpoint"

/**
 * One tree this run has pinned.
 *
 * `ref` is the store's own name for it. Nothing above this module interprets
 * it; it travels so the journal says which tree a checkpointed call read.
 *
 * @category models
 * @since 1.0.0
 */
export class Snapshot extends Schema.Class<Snapshot>("@smthrs/std/Checkpoints/Snapshot")({
  id: Schema.String,
  ref: Schema.String
}) {}

/**
 * A tree handed back as a directory, for the length of one call.
 *
 * `host` is where the process running on this machine finds it. `guest` is
 * where a container finds the same directory, which is the same path when no
 * container is in play. They differ exactly as `TestRunner.Runner`'s `cwd` and
 * `root` differ, and for the same reason: one directory, two names.
 *
 * `root` and `guestRoot` are the workspace itself under those same two names.
 * They travel because a call that named a directory *inside* the workspace has
 * to keep it: a check that runs in `tests/` and is pointed at a checkpoint must
 * run in the checkpoint's `tests/`, not at its top. Silently dropping that
 * subpath is how a baseline comes back failing for a reason nobody chose, which
 * is the one failure a checkpoint exists to make impossible.
 *
 * @category models
 * @since 1.0.0
 */
export interface Materialized {
  readonly id: string
  readonly host: string
  readonly guest: string
  /** The workspace this checkpoint is a tree of, as this machine names it. */
  readonly root: string
  /** The workspace as a container names it; the same as {@link Materialized.root} when none does. */
  readonly guestRoot: string
}

/**
 * The two host operations a checkpoint needs.
 *
 * @category services
 * @since 1.0.0
 */
export interface Checkpoints {
  /** Records the working tree as it stands, under `id`. */
  readonly capture: (id: string) => Effect.Effect<Snapshot, StdError.StdError>
  /**
   * Hands `id` back as a directory for the length of the effect it wraps.
   *
   * Scoped rather than returned, because the directory has to be removed
   * however the call ends — a benchmark run killed at its wall-clock budget
   * would otherwise leave a second checkout of the whole repository in a tree
   * whose diff is the run's answer.
   */
  readonly materialize: <A, E, R>(
    id: string,
    use: (materialized: Materialized) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | StdError.StdError, R>
}

/**
 * The {@link Checkpoints} service tag.
 *
 * @category services
 * @since 1.0.0
 */
export const Checkpoints: Context.Service<Checkpoints, Checkpoints> = Context.Service("@smthrs/std/Checkpoints")

/**
 * Builds a store from its two operations.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (service: Checkpoints): Checkpoints => Checkpoints.of(service)

/**
 * The refusal a host with nowhere to pin a tree answers with.
 *
 * @category errors
 * @since 1.0.0
 */
export const unavailable = (id: string): StdError.StdError =>
  new StdError.StdError({
    code: "provider_unavailable",
    message: `This host pins no trees, so it holds no checkpoint "${id}". Take the reading on the live tree instead.`
  })

/**
 * Builds a store for a host that pins nothing.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeNoop = (): Checkpoints =>
  make({
    capture: (id) => Effect.fail(unavailable(id)),
    materialize: (id) => Effect.fail(unavailable(id))
  })

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerNoop: Layer.Layer<Checkpoints> = Layer.succeed(Checkpoints, makeNoop())

/**
 * What {@link layerGit} needs to know about the repository it pins.
 *
 * @category models
 * @since 1.0.0
 */
export interface GitOptions {
  /** The host path of the git repository whose trees are pinned. */
  readonly root: string
  /**
   * Where a container sees {@link GitOptions.root}, when one does.
   *
   * Absent means there is no container, and the guest path of a materialized
   * checkpoint is then its host path.
   */
  readonly cwd?: string | undefined
  /**
   * The ref naming the tree the run opened on, for {@link baseId}.
   *
   * Absent takes `TestRunner.captureBase` and then `HEAD`, which is the
   * precedence `TestRun` already uses.
   */
  readonly baseRef?: string | undefined
}

const failed = (message: string, code: StdError.Code = "command_failed"): StdError.StdError =>
  new StdError.StdError({ code, message })

/**
 * A checkpoint id, restricted to what can safely become a git-config key and a
 * directory name. No dots: a dot would split the config key into another
 * subsection.
 */
const namable = /^[A-Za-z0-9][A-Za-z0-9-]*$/

const git = (
  root: string,
  args: ReadonlyArray<string>
): Effect.Effect<Exec.ExecResult, StdError.StdError, ChildProcessSpawner> =>
  Exec.exec("git", { args: ["-C", root, ...args] }).pipe(
    Effect.mapError((error) => failed(`git could not run: ${error.message}`))
  )

/**
 * Builds the git-backed store.
 *
 * The capture writes through a temporary index so the workspace's own index is
 * untouched — the agent's `git diff` is the run's evidence and must not move
 * because the harness recorded something. `core.fileMode=false` matches
 * `snapshot-base.sh`: a `docker cp` extraction does not preserve permission
 * bits, so the modes recorded are the image's.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeGit = (
  options: GitOptions
): Effect.Effect<Checkpoints, never, ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    return gitStore(options, spawner)
  })

/**
 * The store itself, with the spawner it runs git through already resolved.
 *
 * Resolving it here rather than threading it through {@link Checkpoints} keeps
 * the service's own requirement empty, which is what lets a browser host bind
 * {@link layerNoop} against the identical interface — the same shape
 * `TestRunner` and `Container` take.
 */
const gitStore = (options: GitOptions, spawner: ChildProcessSpawner["Service"]): Checkpoints => {
  const spawn = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner>): Effect.Effect<A, E> =>
    Effect.provideService(effect, ChildProcessSpawner, spawner)
  const root = withoutTrailingSlash(options.root)
  const guestRoot = options.cwd === undefined ? root : withoutTrailingSlash(options.cwd)
  const keyOf = (id: string) => `${configSection}.${id}`
  const baseRefs = options.baseRef === undefined ? [TestRunner.captureBase, "HEAD"] : [options.baseRef]

  /**
   * The commit one id names.
   *
   * `base` is the one id nobody mints, so it is resolved from refs — the same
   * precedence `TestRun` uses. Every other id was recorded by {@link capture}
   * into this repository's config, which is where a checkpoint is named
   * *without* becoming history. See {@link configSection}.
   */
  const commitOf = (id: string) =>
    Effect.gen(function*() {
      if (id === baseId) return (yield* GitWorktree.resolveCommit(root, baseRefs)).commit
      const found = yield* git(root, ["config", "--local", "--get", keyOf(id)])
      const commit = found.stdout.trim()
      if (found.exitCode !== 0 || commit === "") {
        return yield* Effect.fail(
          failed(
            `No checkpoint is stored under ${id} in ${root}. Take the reading on the live tree instead.`,
            "not_found"
          )
        )
      }
      return commit
    })

  const capture = (id: string) =>
    spawn(Effect.gen(function*() {
      if (!namable.test(id)) {
        return yield* Effect.fail(
          failed(`A checkpoint id must match ${namable.source}; ${id} does not.`, "invalid_input")
        )
      }
      const recorded = yield* git(root, ["stash", "create", `flows checkpoint ${id}`])
      if (recorded.exitCode !== 0) {
        return yield* Effect.fail(failed(`Could not record the working tree: ${recorded.stderr.trim()}`))
      }
      // Nothing to record means the working tree IS the commit it is on, so
      // that commit is the checkpoint. `stash create` says so by printing
      // nothing, which is not an error and must not be read as one.
      const commit = recorded.stdout.trim() === ""
        ? (yield* GitWorktree.resolveCommit(root, ["HEAD"])).commit
        : recorded.stdout.trim()
      const named = yield* git(root, ["config", "--local", keyOf(id), commit])
      if (named.exitCode !== 0) {
        return yield* Effect.fail(failed(`Could not name the checkpoint: ${named.stderr.trim()}`))
      }
      return new Snapshot({ id, ref: commit })
    }))

  const materialize = <A, E, R>(
    id: string,
    use: (materialized: Materialized) => Effect.Effect<A, E, R>
  ): Effect.Effect<A, E | StdError.StdError, R> =>
    Effect.gen(function*() {
      if (!namable.test(id)) {
        return yield* Effect.fail(
          failed(`A checkpoint id must match ${namable.source}; ${id} does not.`, "invalid_input")
        )
      }
      const commit = yield* spawn(commitOf(id))
      const context = yield* Effect.context<R>()
      return yield* GitWorktree.withDetachedWorktree(
        root,
        `${scratchDirectory}/${id}`,
        commit,
        (host) =>
          use({ id, host, guest: `${guestRoot}${host.slice(root.length)}`, root, guestRoot }).pipe(
            Effect.provideContext(context)
          )
      ).pipe(Effect.provideService(ChildProcessSpawner, spawner))
    })

  return make({ capture, materialize })
}

/**
 * Provides {@link makeGit}.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerGit = (options: GitOptions): Layer.Layer<Checkpoints, never, ChildProcessSpawner> =>
  Layer.effect(Checkpoints)(makeGit(options))
/**
 * Rewrites one call's input so the call runs against a materialized checkpoint.
 *
 * Re-exported from {@link Relocate}, which owns the table of flows and fields
 * this rewrite is driven by. It is exported here because the harness reaches the
 * whole checkpoint feature through this module.
 *
 * @category conversions
 * @since 1.0.0
 */
export { relocate, type Relocation } from "./Relocate.ts"
