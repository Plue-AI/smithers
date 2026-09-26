/** Where a configured coding host keeps its own mutable state.
 *
 * `serve --root <workspace>` is handed a live JJ working copy, and every
 * durable layer puts `.flows/control.db`, `.flows/engine.db` and their
 * `-wal`/`-shm` companions under the root it is given. JJ auto-tracks new
 * files, so each engine write changed the working-copy tree digest, `jj status`
 * reported `A .flows/control.db`, and `coding/PreparePlan` failed its own
 * freshness check three seconds after start with
 * `{"_tag":"coding/Error","code":"stale_revision","message":"Native code
 * changed during planning or clarification; gather and plan again"}`.
 *
 * Host state therefore resolves beside the working copy, never inside it. The
 * pre-fix in-root layout stays reachable for a single-repository local run, but
 * only when an operator names it.
 */
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"

/** Explicit state directory, equivalent to `--state-dir`. */
export const directoryVariable = "SMITHERS_CODING_STATE_DIR"
/** Documented opt-in to the pre-fix `<root>/.flows` layout. */
export const inRootVariable = "SMITHERS_CODING_STATE_IN_ROOT"

/** Whether `child` is `parent` itself or lives under it. */
export const inside = (parent: string, child: string): boolean => {
  const from = resolve(parent), to = resolve(child)
  return to === from || to.startsWith(from.endsWith(sep) ? from : from + sep)
}

const truthy = (value: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase())

/**
 * The sibling directory this host keeps its databases in when nothing names
 * another: `<parent>/.smithers-coding-state/<basename>`. A root with no parent
 * of its own falls back to `$XDG_STATE_HOME/smithers/coding/<hash of root>`.
 */
export const defaultStateRoot = (
  root: string,
  environment: Readonly<Record<string, string | undefined>> = {}
): string => {
  const repository = resolve(root)
  const parent = dirname(repository)
  if (parent !== repository) return join(parent, ".smithers-coding-state", basename(repository))
  const base = environment.XDG_STATE_HOME?.trim() || join(environment.HOME?.trim() || tmpdir(), ".local", "state")
  return join(resolve(base), "smithers", "coding", createHash("sha256").update(repository).digest("hex").slice(0, 16))
}

/**
 * Resolves, and refuses, where this host keeps control and engine state.
 *
 * The refusal is the belt to the relocation's braces: a state directory inside
 * the served working copy is the exact defect this module exists to prevent, so
 * it is reported at startup by name rather than three seconds later as a stale
 * revision.
 */
export const resolveStateRoot = (options: {
  readonly root: string
  readonly explicit?: string | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
}): string => {
  const environment = options.environment ?? {}
  const root = resolve(options.root)
  const named = (options.explicit ?? environment[directoryVariable] ?? "").trim()
  const optedIn = truthy(environment[inRootVariable])
  const stateRoot = named === ""
    ? (optedIn ? root : defaultStateRoot(root, environment))
    : resolve(root, named)
  // A root that is the filesystem root has no outside, so the XDG fallback it
  // resolves to is the best available answer rather than a refusal.
  if (dirname(root) !== root && inside(root, stateRoot) && !optedIn) {
    throw new Error(
      `Refusing to keep coding host state at ${stateRoot}: it is inside the served working copy ${root}, ` +
        "where .flows/control.db and .flows/engine.db become untracked JJ files and fail every planning " +
        `freshness check. Pass --state-dir (or ${directoryVariable}) a path outside the repository, or set ` +
        `${inRootVariable}=1 to accept the in-root layout for a local single-repository run.`
    )
  }
  return stateRoot
}
