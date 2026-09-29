/**
 * Operating-system confinement of an approved process, derived from the
 * grants in force.
 *
 * `proc:spawn` decides whether a command starts. It says nothing about what
 * the command may touch once it runs, and a child process holds every access
 * the host process has: an approved `bash` can write any file and reach any
 * host. This module is the seam that closes that gap. After the grant check
 * passes, `ChildProcessSpawner.layer` derives a {@link Profile} from the
 * `fs:read`, `fs:write` and `net:*` rules the `GrantStore` holds in force and
 * asks the confinement in its context to wrap each stage of the command so
 * the operating system enforces the profile. `@smthrs/platform-node`'s
 * `ProcessConfinement` fills the seam with bubblewrap on Linux and seatbelt
 * on macOS; a context with no confinement spawns unconfined, which is what
 * every host did before this seam existed.
 *
 * The profile is a floor under the grants, never a translation of them. A
 * bind mount and a seatbelt rule speak in directory trees, so a glob such as
 * `src/**\/*.ts` opens `src`, a deny narrower than a tree is left to the
 * filesystem check that already enforces it, and a grant outside the
 * workspace opens nothing, because a sandbox never grants a path the
 * workspace key does not cover. What the profile opens is therefore at least
 * what the grants allow inside the workspace, and what it closes is closed at
 * the kernel: an approved `printf x > ../outside` with no write grant fails
 * with `EPERM` or `EROFS`, not with a lexical warning.
 *
 * Governing design: `docs/specs/Concepts/Permission Kernel.md`.
 *
 * @since 1.0.0-rc.1
 */

import { type Action, isLiteralResource } from "@smthrs/capability/Capability"
import type { GrantStoreError, Rule } from "@smthrs/capability/Permission"
import { Context, Effect, Layer, type Path, type Scope } from "effect"
import type * as PlatformError from "effect/PlatformError"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import type * as GrantStore from "./GrantStore.ts"

/**
 * What a confined process may touch, as trees under one workspace root.
 *
 * Every path is workspace-relative and posix-shaped, `.` naming the root
 * itself, so a mechanism can anchor them at the canonical root the way the
 * build sandbox anchors a target's declared inputs and outputs.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Profile {
  /** The absolute workspace root every path below is relative to. */
  readonly workspaceRoot: string
  /** Trees and files an `fs:read` allow in force opens. */
  readonly reads: ReadonlyArray<string>
  /** Directory trees an `fs:write` glob allow in force opens. */
  readonly writes: ReadonlyArray<string>
  /**
   * Paths a literal `fs:write` allow names. A file cannot be mounted
   * writable on its own and may not exist yet, so a mechanism opens its
   * parent directory; the distinction is the mechanism's to draw.
   */
  readonly writeFiles: ReadonlyArray<string>
  /** Trees and paths an `fs:write` deny in force re-closes under a write. */
  readonly readOnly: ReadonlyArray<string>
  /** `open` when any `net:*` allow is in force, `none` otherwise. */
  readonly network: "none" | "open"
}

/**
 * Operations a host confinement provides.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Service {
  /**
   * The command a host must spawn so that `command` runs under `profile`.
   *
   * The result is a stage the host spawner runs in place of the original:
   * the same working directory and streams, an argv the mechanism wraps, and
   * an environment extended with what the wrapper needs. Anything the
   * confinement prepares on the host lives until the scope closes. A host
   * that cannot enforce the profile fails here rather than returning the
   * command unchanged, unless it was built to run unconfined in that case.
   */
  readonly confine: (
    command: ChildProcess.StandardCommand,
    profile: Profile
  ) => Effect.Effect<ChildProcess.StandardCommand, PlatformError.PlatformError, Scope.Scope>
}

/**
 * Service key for the host's process confinement.
 *
 * @category services
 * @since 1.0.0-rc.1
 */
export class ProcessConfinement extends Context.Service<ProcessConfinement, Service>()(
  "@smthrs/kernel/ProcessConfinement"
) {}

/**
 * A confinement that runs every command as it was given.
 *
 * The explicit unconfined choice for a composition that has to name one, and
 * the same behaviour as a context with no confinement at all.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const makeNoop: Service = ProcessConfinement.of({
  confine: Effect.fn("ProcessConfinement.confine")((command) => Effect.succeed(command))
})

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 1.0.0-rc.1
 */
export const layerNoop: Layer.Layer<ProcessConfinement> = Layer.succeed(ProcessConfinement)(makeNoop)

/** Every network action; one allow in force for any of them opens egress. */
const networkActions: ReadonlyArray<Action> = ["net:get", "net:post", "net:private"]

/** Whether a resource names a whole tree: everything below one directory. */
const isTree = (resource: string): boolean => resource === "**" || resource.endsWith("/**")

/**
 * The workspace-relative posix path a pattern's resource opens: its longest
 * leading run of segments free of glob metacharacters, anchored at the root.
 * Nothing when that path lies outside the workspace, because a mechanism can
 * only open what the workspace key covers.
 */
const tree = (resource: string, root: string, path: Path.Path): string | undefined => {
  const segments = resource.split("/")
  const end = segments.findIndex((segment) => /[*?]/.test(segment))
  const prefix = (end === -1 ? segments : segments.slice(0, end)).join("/")
  const relative = path.relative(root, path.resolve(root, prefix))
  if (path.isAbsolute(relative) || relative.split(path.sep)[0] === "..") return undefined
  return relative === "" ? "." : relative.split(path.sep).join("/")
}

const unique = (paths: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(paths)]

/**
 * Derives the profile the grants in force admit under one workspace root.
 *
 * Allows widen to the tree their glob starts in; a literal `fs:write` names a
 * file or directory as it is. A deny re-closes only what it names in full, a
 * whole tree or one literal path, since a narrower deny cannot be spelled as
 * a mount without also closing writes the grants allow. Egress is open when
 * any network allow is in force, because a mechanism cannot allowlist hosts.
 *
 * @category resolution
 * @since 1.0.0-rc.1
 */
export const profile = (
  grants: GrantStore.Service,
  workspaceRoot: string,
  path: Path.Path
): Effect.Effect<Profile, GrantStoreError> =>
  Effect.gen(function*() {
    const root = path.resolve(workspaceRoot)
    const at = (resource: string) => tree(resource, root, path)
    const reads = yield* grants.rules("fs:read")
    const writes = yield* grants.rules("fs:write")
    const network = yield* Effect.forEach(networkActions, (action) => grants.rules(action))
    const opened = (rules: ReadonlyArray<Rule>, keep: (resource: string) => boolean) =>
      unique(
        rules
          .filter((rule) => rule.effect === "allow" && keep(rule.pattern.resource))
          .map((rule) => at(rule.pattern.resource))
          .filter((tree): tree is string => tree !== undefined)
      )
    return {
      workspaceRoot: root,
      reads: opened(reads, () => true),
      writes: opened(writes, (resource) => !isLiteralResource(resource)),
      writeFiles: opened(writes, isLiteralResource),
      readOnly: unique(
        writes
          .filter((rule) =>
            rule.effect === "deny" && (isTree(rule.pattern.resource) || isLiteralResource(rule.pattern.resource))
          )
          .map((rule) => at(rule.pattern.resource))
          .filter((tree): tree is string => tree !== undefined)
      ),
      network: network.some((rules) => rules.some((rule) => rule.effect === "allow")) ? "open" : "none"
    }
  })
