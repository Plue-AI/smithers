/**
 * The package manager and runtime a target resolves from the workspace.
 *
 * `WORKSPACE.ts` declares the workspace's package manager and runtime once.
 * Before this module every PACKAGE.ts restated them: the root declaration
 * exported `packageManager` and `runtime` values and ~75 package declarations
 * imported them back so they could pass them as attrs. That is the workspace's
 * business, not a package's, and the import direction is the wrong one anyway
 * — `PackageLoader` refuses a PACKAGE.ts that imports WORKSPACE.ts.
 *
 * A rule now names the attrs it resolves from the workspace
 * ({@link Target.Metadata.workspaceAttrs}) and leaves them optional. The
 * planner fills each named attr in here, before it keys the node and before it
 * runs the body, so the manager and the interpreter stay key material and the
 * rule bodies keep computing their own argv from one declaration. A
 * declaration that passes the attr explicitly always wins: that is how the Bun
 * compatibility matrix re-runs a package's suite under a second interpreter.
 *
 * @since 0.1.0
 */

import * as RuntimeService from "@smthrs/build/Runtime"
import * as Input from "@smthrs/targets/Input"
import * as PackageManager from "@smthrs/targets/PackageManager"
import * as Runtime from "@smthrs/targets/Runtime"
import * as SafeFs from "@smthrs/targets/SafeFs"
import type * as Target from "@smthrs/targets/Target"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as Schema from "effect/Schema"
import * as NodePath from "node:path"

/**
 * The workspace-declared tool identities legacy rules resolve against.
 *
 * Either may be undefined: a Cargo or Go workspace declares no JavaScript
 * package manager at all, and a rule that needs one then refuses by name
 * rather than spawning whatever is on PATH.
 *
 * @category models
 * @since 0.1.0
 */
export interface WorkspaceToolchain {
  readonly repository?: string | undefined
  readonly packageManager: PackageManager.PackageManager | undefined
  readonly runtime: Runtime.Runtime | undefined
}

/** The workspace toolchain of a workspace that declares neither. */
const none: WorkspaceToolchain = Object.freeze({ packageManager: undefined, runtime: undefined })

/**
 * The manager legacy rules run tools through.
 *
 * A workspace may declare the manager in either era's form. The legacy form is
 * already the record the rules take. The WORKSPACE.ts form pins the manager
 * through the repository's own manifest and lockfile instead, so it is lowered
 * to the record shape here when its version is literal. Manifest-derived
 * requirements need the asynchronous resolver; never invent an ambient pin.
 */
const managerOf = (
  workspace: WorkspaceDeclaration.WorkspaceDeclaration,
  runtime: Runtime.Runtime | undefined
): PackageManager.PackageManager | undefined => {
  const declared: unknown = workspace.packageManager
  if (declared === undefined) return undefined
  if (PackageManager.isPackageManager(declared)) return declared
  // Yarn has no legacy rule that speaks it, and lowering a manager the rules
  // cannot run would produce `yarn exec` argv from a `pnpm` code path.
  if (!PackageManager.isPnpmDeclaration(declared)) return undefined
  // The lowered record's `runtime` is the workspace's own; without one there
  // is nothing to lower to, because the record type requires it.
  if (runtime === undefined || declared.version === undefined) return undefined
  return PackageManager.ResolvedPnpmPackageManager.make({
    name: "pnpm",
    version: requirement(declared.version, "pnpm version"),
    executable: "pnpm",
    runtime
  })
}

/** Only the exact and single-comparator forms the runtime verifier understands. */
const requirementPattern = /^(?:>=|<=|>|<|=)? *v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

const requirement = (value: unknown, what: string): string => {
  if (
    typeof value !== "string" || !Schema.is(Runtime.VersionRequirement)(value) ||
    !requirementPattern.test(value) || RuntimeService.satisfies(value, "0.0.0") === "unsupported_requirement"
  ) throw new Error(`workspace toolchain ${what} must be a supported exact version or single-comparator requirement`)
  return value
}

/** Literal runtime declarations do not need filesystem access. */
const runtimeOf = (declared: unknown): Runtime.Runtime | undefined => {
  if (Runtime.isRuntime(declared)) return declared
  if (Runtime.isNodeDeclaration(declared) && declared.version !== undefined) {
    return Runtime.ResolvedNodeRuntime.make({
      name: "node",
      version: requirement(declared.version, "Node version"),
      executable: "node"
    })
  }
  if (Runtime.isBunDeclaration(declared)) {
    return Runtime.ResolvedBunRuntime.make({
      name: "bun",
      version: requirement(declared.version, "Bun version"),
      executable: declared.executable
    })
  }
  return undefined
}

/**
 * Reads literal workspace toolchain declarations without I/O.
 * Manifest-derived fields stay unresolved until {@link resolve} is called.
 *
 * @category constructors
 * @since 0.1.0
 */
export const of = (workspace: WorkspaceDeclaration.WorkspaceDeclaration): WorkspaceToolchain => {
  const runtime = runtimeOf(workspace.runtime)
  const packageManager = managerOf(workspace, runtime)
  if (runtime === undefined && packageManager === undefined) return { ...none, repository: workspace.repository }
  return Object.freeze({ packageManager, runtime, repository: workspace.repository })
}

/**
 * A resolved workspace toolchain and the exact manifest texts it consumed.
 *
 * @category models
 * @since 1.0.0
 */
export interface ResolvedWorkspaceToolchain extends WorkspaceToolchain {
  readonly manifestDigests: ReadonlyArray<Input.FileDigest>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Resolves declared toolchain manifests within the workspace before keying.
 * Each bounded, validated text read supplies both the requirement and its
 * digest, so an intervening second read cannot key different manifest bytes.
 * No package manager or runtime is installed or executed while resolving.
 *
 * @category constructors
 * @since 1.0.0
 */
export const resolve = async (
  workspace: WorkspaceDeclaration.WorkspaceDeclaration,
  options: { readonly root: string; readonly signal?: AbortSignal | undefined }
): Promise<ResolvedWorkspaceToolchain> => {
  options.signal?.throwIfAborted()
  const manifests = new Map<string, { readonly contents: Record<string, unknown>; readonly digest: string }>()
  const readManifest = async (file: Input.File): Promise<Record<string, unknown>> => {
    const path = Input.resolvePath("", file.path)
    const previous = manifests.get(path)
    if (previous !== undefined) return previous.contents
    const text = await SafeFs.readText(NodePath.join(options.root, path), {
      root: options.root,
      signal: options.signal,
      limit: 1024 * 1024,
      what: "workspace toolchain manifest"
    })
    if (text === undefined) throw new Error(`workspace toolchain manifest is missing: ${path}`)
    let contents: unknown
    try {
      contents = JSON.parse(text)
    } catch {
      throw new Error(`workspace toolchain manifest is not valid JSON: ${path}`)
    }
    if (!isRecord(contents)) throw new Error(`workspace toolchain manifest must be a JSON object: ${path}`)
    manifests.set(path, { contents, digest: Input.digestText(text) })
    return contents
  }
  let runtime = runtimeOf(workspace.runtime)
  if (Runtime.isNodeDeclaration(workspace.runtime) && workspace.runtime.manifest !== undefined) {
    const manifest = await readManifest(workspace.runtime.manifest)
    const engines = manifest["engines"]
    runtime = Runtime.ResolvedNodeRuntime.make({
      name: "node",
      version: requirement(isRecord(engines) ? engines["node"] : undefined, "manifest engines.node"),
      executable: "node"
    })
  }
  let packageManager = managerOf(workspace, runtime)
  if (PackageManager.isPnpmDeclaration(workspace.packageManager)) {
    const declared = workspace.packageManager
    const manifest = await readManifest(declared.manifest)
    const pin = manifest["packageManager"]
    const manifestVersion = typeof pin === "string" && pin.startsWith("pnpm@") ? pin.slice(5) : undefined
    if (declared.version === undefined && manifestVersion === undefined) {
      throw new Error("workspace toolchain manifest packageManager must declare pnpm@<version>")
    }
    const version = requirement(declared.version ?? manifestVersion, "pnpm version")
    if (runtime !== undefined) {
      packageManager = PackageManager.ResolvedPnpmPackageManager.make({
        name: "pnpm",
        version,
        executable: "pnpm",
        runtime
      })
    }
  }
  options.signal?.throwIfAborted()
  const manifestDigests = Object.freeze(
    [...manifests].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([path, manifest]) =>
      Object.freeze({ path, digest: manifest.digest })
    )
  )
  return Object.freeze({ runtime, packageManager, manifestDigests, repository: workspace.repository })
}

/**
 * Fills a target's workspace-resolved attrs from the workspace declaration.
 *
 * Only the attrs the rule named are considered, and only when the declaration
 * left them absent, so a target that never declared one is returned untouched
 * and a target that declared one keeps what it wrote.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fill = (
  workspaceAttrs: ReadonlyArray<Target.WorkspaceAttr>,
  attrs: unknown,
  toolchain: WorkspaceToolchain
): unknown => {
  if (
    workspaceAttrs.length === 0 || typeof attrs !== "object" || attrs === null ||
    (toolchain.packageManager === undefined && toolchain.runtime === undefined && toolchain.repository === undefined)
  ) return attrs
  const declared = attrs as Record<string, unknown>
  let filled: Record<string, unknown> | undefined
  for (const name of workspaceAttrs) {
    if (declared[name] !== undefined) continue
    const value = name === "repository"
      ? toolchain.repository
      : name === "packageManager"
      ? toolchain.packageManager
      : toolchain.runtime
    if (value === undefined) continue
    filled = filled ?? { ...declared }
    filled[name] = value
  }
  return filled === undefined ? attrs : Object.freeze(filled)
}
