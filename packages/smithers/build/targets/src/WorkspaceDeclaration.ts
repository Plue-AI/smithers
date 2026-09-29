/**
 * The WORKSPACE.ts declaration surface: `S.Workspace(name, options)` and the
 * typed service declarations it composes — `S.Cache`, `S.Host`, `S.Flags`,
 * `S.Npm.NodeModules`, `S.Nix.Environment`, `S.Sandboxes`, and `S.Sandbox.*`.
 *
 * Every constructor is inert: it validates and freezes data, performs no
 * I/O, and constructs no target. The build CLI's workspace loader validates
 * exactly one `Workspace` export and the package index resolves agent and
 * flag references against these declarations.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import { type AgentsDeclaration, isAgentsDeclaration } from "./AgentTarget.ts"
import * as Config from "./Config.ts"
import * as DependencyDocs from "./DependencyDocs.ts"
import * as Input from "./Input.ts"
import * as LocalRepository from "./LocalRepository.ts"
import { isSmithersCloudDeclaration, type SmithersCloudDeclaration } from "./MemoryTarget.ts"
import * as Nix from "./Nix.ts"
import * as Owners from "./Owners.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Reference from "./Reference.ts"
import * as RemoteCache from "./RemoteCache.ts"
import * as Runtime from "./Runtime.ts"
import * as RustToolchain from "./RustToolchain.ts"
import * as Target from "./Target.ts"
import type * as Toolchain from "./Toolchain.ts"

/**
 * Schema for the workspace cache declaration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CacheDeclaration = Schema.TaggedStruct("Cache", {
  directory: Schema.NonEmptyString,
  hostDirectories: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  remote: Schema.optional(
    Schema.declare<RemoteCache.RemoteCache>(RemoteCache.isRemoteCache, {
      identifier: "smithers-build/RemoteCache",
      title: "remote cache declaration",
      description: "An S.RemoteCache.make declaration"
    })
  )
})

/**
 * The workspace cache declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheDeclaration = typeof CacheDeclaration.Type

/**
 * Checks whether a value is the workspace cache declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isCacheDeclaration: (value: unknown) => value is CacheDeclaration = Schema.is(CacheDeclaration)

/**
 * Declares the workspace cache directory and, optionally, the remote cache
 * (`S.RemoteCache.make(...)`) it replicates to. The remote declaration is
 * inert data here; the CLI reads it when it opens the workspace cache.
 * `hostDirectories` explicitly owns regenerable tool caches as host state:
 * ignored contents are excluded from write-set snapshots and rollback.
 * Tracked files remain guarded. Paths must be canonical and workspace-relative.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Cache = (options: {
  readonly directory: string
  readonly hostDirectories?: ReadonlyArray<string> | undefined
  readonly remote?: RemoteCache.RemoteCache | undefined
}): CacheDeclaration => {
  if (typeof options !== "object" || options === null) throw new TypeError("Cache options must be an object")
  for (const key of Object.getOwnPropertyNames(options)) {
    if (key !== "directory" && key !== "remote" && key !== "hostDirectories") {
      throw new TypeError(`Cache received unknown option ${JSON.stringify(key)}`)
    }
  }
  if (options.remote !== undefined && !RemoteCache.isRemoteCache(options.remote)) {
    throw new TypeError("Cache remote must be an S.RemoteCache.make declaration")
  }
  if (options.hostDirectories !== undefined && !Array.isArray(options.hostDirectories)) {
    throw new TypeError("Cache hostDirectories must be an array of workspace-relative directories")
  }
  const hostDirectories = options.hostDirectories?.map((directory) => {
    const normalized = Config.normalizeCacheDirectory(directory)
    if (normalized !== directory || /[*?[\]{}]/.test(directory)) {
      throw new TypeError("Cache hostDirectories must contain canonical directory paths, not globs")
    }
    return normalized
  })
  return CacheDeclaration.make({
    directory: Config.normalizeCacheDirectory(options.directory),
    ...(hostDirectories === undefined ? {} : { hostDirectories: Object.freeze(hostDirectories) }),
    ...(options.remote === undefined ? {} : { remote: options.remote })
  })
}

/**
 * Schema for the workspace host-binary declaration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const HostDeclaration = Schema.TaggedStruct("Host", {
  bins: Schema.Array(Schema.NonEmptyString)
})

/**
 * The workspace host-binary declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type HostDeclaration = typeof HostDeclaration.Type

/**
 * Checks whether a value is the workspace host declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isHostDeclaration: (value: unknown) => value is HostDeclaration = Schema.is(HostDeclaration)

const makeHost = (options: { readonly bins: ReadonlyArray<string> }): HostDeclaration =>
  HostDeclaration.make({ bins: [...options.bins] })

/**
 * The `S.Host` surface: callable as the workspace declaration constructor
 * (`S.Host({ bins })`) and the reference surface for one declared binary
 * (`S.Host.bin(name)`).
 *
 * @category constructors
 * @since 0.1.0
 */
export const Host: typeof makeHost & { readonly bin: typeof Reference.hostBin } = Object.assign(
  makeHost,
  { bin: Reference.hostBin }
)

/**
 * Runtime marker for the workspace flags declaration.
 *
 * @category type ids
 * @since 0.1.0
 */
export const FlagsTypeId: unique symbol = Symbol.for("smithers-build/Flags") as never

/**
 * The workspace flags declaration: a validated name-to-argv-text record.
 *
 * @category models
 * @since 0.1.0
 */
export interface FlagsDeclaration {
  readonly [FlagsTypeId]: typeof FlagsTypeId
  readonly flags: Readonly<Record<string, string>>
}

/**
 * Checks whether a value is the workspace flags declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isFlagsDeclaration = (value: unknown): value is FlagsDeclaration => {
  if (typeof value !== "object" || value === null) return false
  const descriptor = Object.getOwnPropertyDescriptor(value, FlagsTypeId)
  return descriptor !== undefined && "value" in descriptor && descriptor.value === FlagsTypeId
}

const flagName = /^[A-Za-z_][A-Za-z0-9_-]*$/

const makeFlags = (flags: Readonly<Record<string, string>>): FlagsDeclaration => {
  if (typeof flags !== "object" || flags === null) {
    throw new TypeError("Flags requires a name-to-text record")
  }
  const validated: Record<string, string> = {}
  for (const name of Object.getOwnPropertyNames(flags)) {
    if (!flagName.test(name)) throw new Error(`Flags name is not a legal reference name: ${JSON.stringify(name)}`)
    const text = flags[name]
    if (typeof text !== "string" || text === "") {
      throw new TypeError(`Flags entry ${JSON.stringify(name)} must be non-empty text`)
    }
    validated[name] = text
  }
  const value = Object.create(null) as { flags: Readonly<Record<string, string>> }
  Object.defineProperty(value, FlagsTypeId, {
    configurable: false,
    enumerable: false,
    value: FlagsTypeId,
    writable: false
  })
  value.flags = Object.freeze(validated)
  return Object.freeze(value) as unknown as FlagsDeclaration
}

/**
 * The `S.Flags` surface: callable as the workspace declaration constructor
 * (`S.Flags({ production: "--production" })`) and a property-access
 * reference surface (`S.Flags.production` in a PACKAGE.ts argv).
 *
 * Property access mints a fresh inert {@link Reference.FlagRef}; the name is
 * validated against the workspace declaration at index time. This is the
 * same single sanctioned Proxy pattern `S.Agents` uses, and for the same
 * reason: the names are workspace-defined and cannot be precomputed.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Flags: typeof makeFlags & Record<string, Reference.FlagRef> = Reference.callableReferences(
  makeFlags,
  (name) => Object.freeze({ _tag: "FlagRef", name }) as Reference.FlagRef
)

/**
 * Schema for the installed-modules declaration, `S.Npm.NodeModules`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NodeModulesDeclaration = Schema.TaggedStruct("NpmNodeModules", {
  packageJson: Input.File,
  workspaces: Schema.optional(Input.File)
})

/**
 * The installed-modules declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type NodeModulesDeclaration = typeof NodeModulesDeclaration.Type

/**
 * Checks whether a value is the installed-modules declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isNodeModulesDeclaration: (value: unknown) => value is NodeModulesDeclaration = Schema.is(
  NodeModulesDeclaration
)

/**
 * Declares the installed node_modules tree derived from a manifest.
 *
 * @category constructors
 * @since 0.1.0
 */
export const NodeModules = (options: {
  readonly packageJson: Input.File
  readonly workspaces?: Input.File | undefined
}): NodeModulesDeclaration =>
  NodeModulesDeclaration.make({
    packageJson: options.packageJson,
    ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces })
  })

/**
 * Schema for one sandbox implementation declaration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SandboxDeclaration = Schema.Union([
  Schema.TaggedStruct("SandboxBubblewrap", {}),
  Schema.TaggedStruct("SandboxDocker", { image: Schema.NonEmptyString }),
  Schema.TaggedStruct("SandboxMicrosandbox", {
    image: Schema.optional(Schema.NonEmptyString),
    environment: Schema.optional(Nix.EnvironmentDeclaration)
  }),
  Schema.TaggedStruct("SandboxNone", {})
])

/**
 * Options accepted by `S.Sandbox.Microsandbox`.
 *
 * @category models
 * @since 0.1.0
 */
export interface MicrosandboxOptions {
  /**
   * The OCI image the microVM boots. With an `environment` the image must
   * carry `nix`; `@smthrs/sandbox` defaults it to `nixos/nix` then.
   */
  readonly image?: string | undefined
  /**
   * The Nix environment every command in the microVM runs under. The
   * provider plants the flake and its lock in the guest and wraps each
   * command in `nix develop` of them, so the sandbox holds the workspace's
   * declared toolchain rather than whatever the image shipped.
   */
  readonly environment?: Nix.Environment | undefined
}

const microsandboxOptions: ReadonlySet<string> = new Set(["image", "environment"])

/**
 * One sandbox implementation declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type SandboxDeclaration = typeof SandboxDeclaration.Type

/**
 * Checks whether a value is a sandbox implementation declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isSandboxDeclaration: (value: unknown) => value is SandboxDeclaration = Schema.is(SandboxDeclaration)

/**
 * The sandbox implementation constructors, `S.Sandbox`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Sandbox = Object.freeze({
  /** Bubblewrap on Linux; refused elsewhere. The selection with no declaration on Linux. */
  Bubblewrap: (): SandboxDeclaration => Object.freeze({ _tag: "SandboxBubblewrap" }) as SandboxDeclaration,
  /** `docker run` with the named image supplying the toolchain; the only mechanism on Windows. */
  Docker: (options: { readonly image: string }): SandboxDeclaration => {
    if (typeof options !== "object" || options === null || typeof options.image !== "string" || options.image === "") {
      throw new TypeError("Sandbox.Docker requires an image name")
    }
    return Object.freeze({ _tag: "SandboxDocker", image: options.image })
  },
  /**
   * A Microsandbox microVM holding the workspace's Nix environment: the
   * runtime sandbox `@smthrs/sandbox`'s `MicrosandboxSandbox` provider boots
   * for agent and flow sessions. Build-target confinement does not run under
   * it; `ExecSandbox` refuses the mechanism and names Bubblewrap or Docker.
   */
  Microsandbox: (options: MicrosandboxOptions = {}): SandboxDeclaration => {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("Sandbox.Microsandbox options must be an object")
    }
    for (const key of Object.getOwnPropertyNames(options)) {
      if (!microsandboxOptions.has(key)) {
        throw new TypeError(`Sandbox.Microsandbox received unknown option ${JSON.stringify(key)}`)
      }
    }
    const { environment, image } = options
    if (image !== undefined && (typeof image !== "string" || image === "")) {
      throw new TypeError("Sandbox.Microsandbox image must be a non-empty image name")
    }
    if (environment !== undefined && !Nix.isEnvironment(environment)) {
      throw new TypeError("Sandbox.Microsandbox environment must be an S.Nix.Environment declaration")
    }
    return Object.freeze({
      _tag: "SandboxMicrosandbox",
      ...(image === undefined ? {} : { image }),
      ...(environment === undefined ? {} : { environment })
    })
  },
  /**
   * No confinement at all. The explicit opt-out: every target runs
   * unconfined and no result of such a run enters the shared cache.
   */
  None: (): SandboxDeclaration => Object.freeze({ _tag: "SandboxNone" }) as SandboxDeclaration
})

/**
 * Runtime marker for the workspace sandboxes declaration.
 *
 * @category type ids
 * @since 0.1.0
 */
export const SandboxesTypeId: unique symbol = Symbol.for("smithers-build/Sandboxes") as never

/**
 * The workspace sandboxes declaration: a validated name-to-sandbox record.
 *
 * @category models
 * @since 0.1.0
 */
export interface SandboxesDeclaration {
  readonly [SandboxesTypeId]: typeof SandboxesTypeId
  readonly sandboxes: Readonly<Record<string, SandboxDeclaration>>
}

/**
 * Checks whether a value is the workspace sandboxes declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isSandboxesDeclaration = (value: unknown): value is SandboxesDeclaration => {
  if (typeof value !== "object" || value === null) return false
  const descriptor = Object.getOwnPropertyDescriptor(value, SandboxesTypeId)
  return descriptor !== undefined && "value" in descriptor && descriptor.value === SandboxesTypeId
}

/**
 * Declares the workspace sandbox implementations by name.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Sandboxes = (sandboxes: Readonly<Record<string, SandboxDeclaration>>): SandboxesDeclaration => {
  if (typeof sandboxes !== "object" || sandboxes === null) {
    throw new TypeError("Sandboxes requires a name-to-sandbox record")
  }
  const validated: Record<string, SandboxDeclaration> = {}
  for (const name of Object.getOwnPropertyNames(sandboxes)) {
    if (!flagName.test(name)) throw new Error(`Sandboxes name is not a legal reference name: ${JSON.stringify(name)}`)
    const declaration = sandboxes[name]
    if (!isSandboxDeclaration(declaration)) {
      throw new TypeError(`Sandboxes entry ${JSON.stringify(name)} is not a sandbox declaration`)
    }
    validated[name] = declaration
  }
  const value = Object.create(null) as { sandboxes: Readonly<Record<string, SandboxDeclaration>> }
  Object.defineProperty(value, SandboxesTypeId, {
    configurable: false,
    enumerable: false,
    value: SandboxesTypeId,
    writable: false
  })
  value.sandboxes = Object.freeze(validated)
  return Object.freeze(value) as unknown as SandboxesDeclaration
}

/**
 * The git hook events a workspace may bind targets to.
 *
 * @category constants
 * @since 0.1.0
 */
export const gitHookNames = ["preCommit", "postCommit", "prePush", "postMerge"] as const

/**
 * One git-hook binding table: hook event to gate-capable target.
 *
 * @category models
 * @since 0.1.0
 */
export type GitHooks = Readonly<Partial<Record<(typeof gitHookNames)[number], Target.AnyTarget>>>

/**
 * Runtime marker for the workspace declaration.
 *
 * @category type ids
 * @since 0.1.0
 */
export const WorkspaceTypeId: unique symbol = Symbol.for("smithers-build/WorkspaceDeclaration") as never

/**
 * The validated `S.Workspace(name, options)` declaration.
 *
 * @category models
 * @since 0.1.0
 */
export interface WorkspaceDeclaration {
  readonly [WorkspaceTypeId]: typeof WorkspaceTypeId
  readonly name: string
  readonly repository: string
  readonly cache: CacheDeclaration
  readonly runtime: Runtime.Runtime | Runtime.NodeDeclaration | Runtime.BunDeclaration | undefined
  readonly packageManager:
    | PackageManager.PackageManager
    | PackageManager.YarnDeclaration
    | PackageManager.PnpmDeclaration
    | undefined
  readonly nodeModules: NodeModulesDeclaration | undefined
  /** The Nix closure every tool-running target resolves executables from. */
  readonly environment: Nix.Environment | undefined
  readonly toolchains: ReadonlyArray<Toolchain.Declaration | { readonly _tag: string }>
  readonly flags: FlagsDeclaration | undefined
  readonly host: HostDeclaration | undefined
  readonly memory: SmithersCloudDeclaration | undefined
  readonly sandboxes: SandboxesDeclaration | undefined
  readonly agents: AgentsDeclaration | undefined
  readonly gitHooks: GitHooks | undefined
  readonly repos: Readonly<Record<string, LocalRepository.Declaration>> | undefined
  /** Bounds on the package walk; see {@link DiscoveryDeclaration}. */
  readonly discovery: DiscoveryDeclaration | undefined
  /** Workspace-wide default owners: what a package with no owning ancestor resolves to. */
  readonly owners: Owners.Declaration | undefined
  /** The team roster `team:<name>` references resolve against. */
  readonly teams: Owners.TeamsDeclaration | undefined
  /** Dependency documentation a wiki refresh imports for agent memory; see `S.Docs`. */
  readonly docs: Readonly<Record<string, DependencyDocs.Declaration>> | undefined
}

/**
 * Checks whether a value is the workspace declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isWorkspaceDeclaration = (value: unknown): value is WorkspaceDeclaration => {
  if (typeof value !== "object" || value === null) return false
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, WorkspaceTypeId)
  } catch {
    return false
  }
  return descriptor !== undefined && "value" in descriptor && descriptor.value === WorkspaceTypeId
}

/**
 * Bounds on the package walk.
 *
 * `prune` names workspace-relative directories the walk never enters, for
 * trees no declaration lives in and nothing else can recognise: a toolchain
 * cache without a `CACHEDIR.TAG`, a package store, run evidence. The walk is
 * ignore-blind, so a gitignored tree costs its full size on every command
 * until it is named here.
 *
 * @category models
 * @since 1.0.0
 */
export interface DiscoveryDeclaration {
  readonly prune: ReadonlyArray<string>
}

/**
 * Options accepted by {@link Workspace}.
 *
 * @category models
 * @since 0.1.0
 */
export interface WorkspaceOptions {
  readonly repository: string
  readonly cache: CacheDeclaration
  readonly runtime?: Runtime.Runtime | Runtime.NodeDeclaration | Runtime.BunDeclaration | undefined
  readonly packageManager?:
    | PackageManager.PackageManager
    | PackageManager.YarnDeclaration
    | PackageManager.PnpmDeclaration
    | undefined
  readonly nodeModules?: NodeModulesDeclaration | undefined
  readonly environment?: Nix.Environment | undefined
  readonly toolchains?: ReadonlyArray<Toolchain.Declaration | { readonly _tag: string }> | undefined
  readonly flags?: FlagsDeclaration | undefined
  readonly host?: HostDeclaration | undefined
  readonly memory?: SmithersCloudDeclaration | undefined
  readonly sandboxes?: SandboxesDeclaration | undefined
  readonly agents?: AgentsDeclaration | undefined
  readonly gitHooks?: GitHooks | undefined
  readonly repos?: Readonly<Record<string, LocalRepository.Declaration>> | undefined
  readonly discovery?: { readonly prune?: ReadonlyArray<string> | undefined } | undefined
  readonly owners?: Owners.Options | Owners.Declaration | undefined
  readonly teams?: Owners.TeamsDeclaration | Readonly<Record<string, ReadonlyArray<string>>> | undefined
  readonly docs?: Readonly<Record<string, DependencyDocs.Declaration>> | undefined
}

const knownOptions: ReadonlySet<string> = new Set([
  "repository",
  "cache",
  "runtime",
  "packageManager",
  "nodeModules",
  "environment",
  "toolchains",
  "flags",
  "host",
  "memory",
  "sandboxes",
  "agents",
  "gitHooks",
  "repos",
  "discovery",
  "owners",
  "teams",
  "docs"
])

const workspaceName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Code units of a rejected name one diagnostic may render.
 *
 * Every other validator in this package bounds its rejection detail before
 * rendering it; this is that bound for declaration names.
 */
const maximumRejectedNameCodeUnits = 256

/** Normalizes one portable workspace-relative path; `what` names it in diagnostics. */
const workspacePath = (what: string, value: string): string => {
  if (value === "" || value.includes("\0") || /^[\\/]|^[A-Za-z]:/.test(value)) {
    throw new TypeError(`Workspace ${what} path must be relative: ${JSON.stringify(value)}`)
  }
  const segments = value.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".")
  if (segments.length === 0 || segments.includes("..")) {
    throw new TypeError(`Workspace ${what} path must remain inside the workspace: ${JSON.stringify(value)}`)
  }
  return segments.join("/")
}

/**
 * Declares the workspace: its name plus the typed host and toolchain
 * services every target resolves against.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * export const Workspace = S.Workspace("force", {
 *   repository: "git+https://github.com/artsy/force.git",
 *   cache: S.Cache({ directory: ".flows" }),
 *   runtime: S.Runtime.Node({ manifest: S.file("//package.json") }),
 *   packageManager: S.PackageManager.Yarn({
 *     manifest: S.file("//package.json"),
 *     lockfile: S.file("//yarn.lock")
 *   }),
 *   nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
 *   environment: S.Nix.Environment({ flake: S.file("//flake.nix") })
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Workspace = (name: string, options: WorkspaceOptions): WorkspaceDeclaration => {
  // The two failures are split so a caller who passed the options object first
  // is told that, rather than having their whole declaration — host paths and
  // secret names included — serialized unbounded into a message that reaches
  // CI logs.
  if (typeof name !== "string") {
    throw new TypeError("Workspace name must be a string; Workspace(name, options) takes the name first")
  }
  if (!workspaceName.test(name)) {
    throw new Error(
      `Workspace name must be a portable identifier: ${JSON.stringify(name.slice(0, maximumRejectedNameCodeUnits))}`
    )
  }
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Workspace options must be an object")
  }
  for (const key of Object.getOwnPropertyNames(options)) {
    if (!knownOptions.has(key)) {
      throw new TypeError(`Workspace received unknown option ${JSON.stringify(key)}`)
    }
  }
  if (typeof options.repository !== "string" || options.repository === "") {
    throw new TypeError("Workspace repository must be a non-empty string")
  }
  if (!isCacheDeclaration(options.cache)) {
    throw new TypeError("Workspace cache must be an S.Cache declaration")
  }
  if (options.toolchains !== undefined && !Array.isArray(options.toolchains)) {
    throw new TypeError("Workspace toolchains must be an array")
  }
  const nodeValues = [options.runtime, options.packageManager, options.nodeModules]
  const hasAnyNode = nodeValues.some((value) => value !== undefined)
  const hasAllNode = nodeValues.every((value) => value !== undefined)
  if (hasAnyNode && !hasAllNode) {
    throw new TypeError("Workspace runtime, packageManager, and nodeModules must be declared together")
  }
  if (options.environment !== undefined && !Nix.isEnvironment(options.environment)) {
    throw new TypeError("Workspace environment must be an S.Nix.Environment declaration")
  }
  if (
    !hasAllNode && options.environment === undefined &&
    (options.toolchains === undefined || options.toolchains.length === 0)
  ) {
    throw new TypeError(
      "Workspace requires the Node runtime/packageManager/nodeModules set, an environment, or toolchains"
    )
  }
  if (
    options.runtime !== undefined && !Runtime.isRuntime(options.runtime) &&
    !Runtime.isNodeDeclaration(options.runtime) &&
    !Runtime.isBunDeclaration(options.runtime)
  ) {
    throw new TypeError("Workspace runtime must be an S.Runtime declaration")
  }
  if (
    options.packageManager !== undefined &&
    !PackageManager.isPackageManager(options.packageManager) &&
    !PackageManager.isYarnDeclaration(options.packageManager) &&
    !PackageManager.isPnpmDeclaration(options.packageManager)
  ) {
    throw new TypeError("Workspace packageManager must be an S.PackageManager declaration")
  }
  if (options.nodeModules !== undefined && !isNodeModulesDeclaration(options.nodeModules)) {
    throw new TypeError("Workspace nodeModules must be an S.Npm.NodeModules declaration")
  }
  if (options.toolchains !== undefined) {
    if (options.toolchains.length === 0) {
      throw new TypeError("Workspace toolchains must be a non-empty array")
    }
    for (const toolchain of options.toolchains) {
      if (
        typeof toolchain !== "object" || toolchain === null ||
        typeof (toolchain as { _tag?: unknown })._tag !== "string"
      ) {
        throw new TypeError("Workspace toolchains entries must each be a toolchain layer declaration")
      }
    }
  }
  if (options.flags !== undefined && !isFlagsDeclaration(options.flags)) {
    throw new TypeError("Workspace flags must be an S.Flags declaration")
  }
  if (options.host !== undefined && !isHostDeclaration(options.host)) {
    throw new TypeError("Workspace host must be an S.Host declaration")
  }
  if (options.memory !== undefined && !isSmithersCloudDeclaration(options.memory)) {
    throw new TypeError("Workspace memory must be an S.Memory declaration")
  }
  if (options.sandboxes !== undefined && !isSandboxesDeclaration(options.sandboxes)) {
    throw new TypeError("Workspace sandboxes must be an S.Sandboxes declaration")
  }
  if (options.agents !== undefined && !isAgentsDeclaration(options.agents)) {
    throw new TypeError("Workspace agents must be an S.Agents declaration")
  }
  let repos: Readonly<Record<string, LocalRepository.Declaration>> | undefined
  if (options.repos !== undefined) {
    if (typeof options.repos !== "object" || options.repos === null) {
      throw new TypeError("Workspace repos must be a name-to-S.LocalRepository record")
    }
    const validated: Record<string, LocalRepository.Declaration> = {}
    const paths = new Set<string>()
    for (const [repoName, repo] of Object.entries(options.repos)) {
      if (!workspaceName.test(repoName)) {
        throw new TypeError(
          `Workspace repo name is not portable: ${JSON.stringify(repoName.slice(0, maximumRejectedNameCodeUnits))}`
        )
      }
      if (!LocalRepository.isDeclaration(repo)) {
        throw new TypeError(`Workspace repo ${repoName} must be an S.LocalRepository declaration`)
      }
      const normalized = workspacePath("repo", repo.path)
      if (paths.has(normalized)) {
        throw new TypeError(`Workspace repo paths must be distinct: ${JSON.stringify(normalized)}`)
      }
      paths.add(normalized)
      validated[repoName] = LocalRepository.Declaration.make({ path: normalized, branch: repo.branch })
    }
    repos = Object.freeze(validated)
  }
  let discovery: DiscoveryDeclaration | undefined
  if (options.discovery !== undefined) {
    if (typeof options.discovery !== "object" || options.discovery === null) {
      throw new TypeError("Workspace discovery must be an object")
    }
    for (const key of Object.getOwnPropertyNames(options.discovery)) {
      if (key !== "prune") throw new TypeError(`Workspace discovery received unknown option ${JSON.stringify(key)}`)
    }
    const prune = options.discovery.prune ?? []
    if (!Array.isArray(prune) || prune.some((path) => typeof path !== "string")) {
      throw new TypeError("Workspace discovery prune must be an array of workspace-relative paths")
    }
    const paths = new Set<string>()
    for (const path of prune) {
      const normalized = workspacePath("discovery prune", path)
      if (paths.has(normalized)) {
        throw new TypeError(`Workspace discovery prune paths must be distinct: ${JSON.stringify(normalized)}`)
      }
      paths.add(normalized)
    }
    discovery = Object.freeze({ prune: Object.freeze([...paths]) })
  }
  let gitHooks: GitHooks | undefined
  if (options.gitHooks !== undefined) {
    if (typeof options.gitHooks !== "object" || options.gitHooks === null) {
      throw new TypeError("Workspace gitHooks must be an object")
    }
    const hooks: Record<string, Target.AnyTarget> = {}
    for (const key of Object.getOwnPropertyNames(options.gitHooks)) {
      if (!(gitHookNames as ReadonlyArray<string>).includes(key)) {
        throw new TypeError(`Workspace gitHooks received unknown hook ${JSON.stringify(key)}`)
      }
      const target = (options.gitHooks as Record<string, unknown>)[key]
      if (!Target.isTarget(target)) {
        throw new TypeError(`Workspace gitHook ${key} must be a target`)
      }
      hooks[key] = target
    }
    gitHooks = Object.freeze(hooks)
  }
  if (
    options.docs !== undefined &&
    (typeof options.docs !== "object" || options.docs === null ||
      Object.entries(options.docs).some(([docsName, source]) =>
        !workspaceName.test(docsName) || !DependencyDocs.isDeclaration(source)
      ) ||
      // Each name is a directory; a case-insensitive filesystem would merge two that differ only in case.
      new Set(Object.keys(options.docs).map((docsName) => docsName.toLowerCase())).size !==
        Object.keys(options.docs).length)
  ) {
    throw new TypeError("Workspace docs must be a portable-name-to-S.Docs record")
  }
  const owners = options.owners === undefined ? undefined : Owners.declare(options.owners)
  const teams = options.teams === undefined ? undefined : Owners.Teams(options.teams)
  const value = Object.create(null) as Record<string, unknown>
  Object.defineProperty(value, WorkspaceTypeId, {
    configurable: false,
    enumerable: false,
    value: WorkspaceTypeId,
    writable: false
  })
  value["name"] = name
  value["repository"] = options.repository
  value["cache"] = options.cache
  value["runtime"] = options.runtime
  value["packageManager"] = options.packageManager
  value["nodeModules"] = options.nodeModules
  value["environment"] = options.environment
  value["toolchains"] = Object.freeze([...(options.toolchains ?? [])])
  value["flags"] = options.flags
  value["host"] = options.host
  value["memory"] = options.memory
  value["sandboxes"] = options.sandboxes
  value["agents"] = options.agents
  value["gitHooks"] = gitHooks
  value["repos"] = repos
  value["discovery"] = discovery
  value["owners"] = owners
  value["teams"] = teams
  value["docs"] = options.docs === undefined ? undefined : Object.freeze({ ...options.docs })
  return Object.freeze(value) as unknown as WorkspaceDeclaration
}

/**
 * The agent names a workspace declares, for index-time reference
 * validation.
 *
 * @category accessors
 * @since 0.1.0
 */
export const agentNames = (workspace: WorkspaceDeclaration): ReadonlySet<string> =>
  new Set(workspace.agents === undefined ? [] : Object.keys(workspace.agents.agents))

/**
 * The flag names a workspace declares, for index-time reference validation.
 *
 * @category accessors
 * @since 0.1.0
 */
export const flagNames = (workspace: WorkspaceDeclaration): ReadonlySet<string> =>
  new Set(workspace.flags === undefined ? [] : Object.keys(workspace.flags.flags))

/**
 * The team names a workspace declares, for index-time owner reference
 * validation.
 *
 * @category accessors
 * @since 0.1.0
 */
export const teamNames = (workspace: WorkspaceDeclaration): ReadonlySet<string> =>
  new Set(workspace.teams === undefined ? [] : Object.keys(workspace.teams.teams))

/**
 * The first declared Rust toolchain layer, or undefined for a workspace that
 * declares none.
 *
 * Every `S.Cargo.*` target resolves cargo through this layer, so a workspace
 * without one refuses those targets by name rather than falling back to
 * whatever `cargo` happens to be on PATH.
 *
 * @category accessors
 * @since 0.1.0
 */
export const rustToolchain = (
  workspace: WorkspaceDeclaration
): RustToolchain.ToolchainDeclaration | undefined => workspace.toolchains?.find(RustToolchain.isToolchainDeclaration)

/**
 * The Nix environment a workspace's tools resolve from, or undefined for a
 * workspace that declares none.
 *
 * The `environment` option wins; a `toolchains` entry declared with
 * `S.Nix.Environment` is the same thing in list form. An `S.Nix.DevShell`
 * entry is deliberately not one: it pins the tools `S.Nix.bin` references
 * name and nothing else, so a Go workspace that lists a dev shell beside its
 * Go toolchain keeps resolving `go` the way it declared.
 *
 * @category accessors
 * @since 0.1.0
 */
export const nixEnvironment = (workspace: WorkspaceDeclaration): Nix.Environment | undefined =>
  workspace.environment ?? workspace.toolchains?.find(Nix.isEnvironment)
