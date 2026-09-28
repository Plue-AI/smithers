/**
 * Runtime adapter between the CLI and the install package.
 *
 * Every assumption about the install package's exports stays in this file, so
 * a surface change there reconciles in one place. The executor composes the
 * layers exported here beside each target's own interpreter registration.
 *
 * @since 0.1.0
 */

import {
  NodeChildProcessSpawner,
  NodeCrypto,
  NodeFileSystem,
  NodePath as EffectNodePath,
  NodeStdio
} from "@effect/platform-node"
import { Install, PackageManager, Runtime } from "@smthrs/build"
import { FlowEngine } from "@smthrs/engine"
import { Action, Graph, Interpreter } from "@smthrs/flow"
import * as Config from "@smthrs/targets/Config"
import * as TargetPackageManager from "@smthrs/targets/PackageManager"
import * as TargetRuntime from "@smthrs/targets/Runtime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as NodeUtil from "node:util/types"
import * as Environment from "./Environment.ts"

/**
 * Node host services needed by non-interactive smithers-build execution.
 *
 * `NodeServices.layer` also acquires `NodeTerminal`, which attaches listeners
 * to process stdin. The executor gives every target an isolated flow runtime;
 * acquiring the aggregate layer in sixteen concurrent runtimes therefore
 * attached sixteen terminal listeners even though no target reads a terminal,
 * producing leak warnings during ordinary CI. Keeping the host layer to the
 * services the CLI actually uses avoids shared-terminal state and preserves
 * per-target flow isolation.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNonInteractiveNodeServices = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.mergeAll(
    NodeFileSystem.layer,
    NodeCrypto.layer,
    EffectNodePath.layer,
    NodeStdio.layer
  )
)

/**
 * Structured result returned by the install command.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface InstallResult {
  readonly workspace: string
  readonly manager: PackageManager.Name
  readonly plan: ReadonlyArray<{
    readonly id: string
    readonly kind: string
    readonly dependencies: ReadonlyArray<string>
  }>
  readonly result: Install.LinkManifest
}

/**
 * The POSIX convention for an environment name: what `export NAME=` accepts.
 */
const portableEnvironmentName = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The Windows environment block's own rule: `NAME=VALUE` entries separated by
 * NUL, so a name is non-empty and carries neither `=` nor a control character.
 *
 * Windows itself sets names the POSIX convention never produces.
 * `ProgramFiles(x86)` and `CommonProgramFiles(x86)` are on every 64-bit image,
 * including the GitHub Actions `windows-latest` runner, so holding a Windows
 * host to the POSIX rule refuses the whole environment before any command runs.
 */
const windowsEnvironmentName = /^[^=\u0000-\u001F\u007F]+$/

/** Whether a name is one the host can carry into a child environment. */
const usableEnvironmentName = (name: string, windows: boolean): boolean =>
  windows ? windowsEnvironmentName.test(name) : portableEnvironmentName.test(name)

const normalizeSensitiveEnvironment = (value: unknown): ReadonlyArray<string> => {
  let length: number
  try {
    if (!Array.isArray(value)) throw new TypeError("sensitiveEnvironment must be an array")
    const descriptor = Object.getOwnPropertyDescriptor(value, "length")
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "number") {
      throw new TypeError("sensitiveEnvironment length is invalid")
    }
    length = descriptor.value
  } catch {
    throw new TypeError("sensitiveEnvironment must be an inspectable array of at most 64 names")
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > 64) {
    throw new TypeError("sensitiveEnvironment must be an array of at most 64 names")
  }
  const names: Array<string> = []
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    } catch {
      throw new TypeError("sensitiveEnvironment could not be inspected safely")
    }
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError("sensitiveEnvironment must contain only data entries")
    }
    const name = descriptor.value
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError("sensitiveEnvironment contains an invalid environment name")
    }
    names.push(name)
  }
  return Object.freeze(names)
}

/**
 * Copies the host environment without remote-cache credentials.
 *
 * The package-manager implementation selects only its own bootstrap and
 * project-declared variables from this copy. Removing cache credentials here
 * also covers a custom token name that a project `.npmrc` happens to mention.
 *
 * @category security
 * @since 0.1.0
 * @slop
 */
export const packageManagerEnvironment = (
  source: Readonly<Record<string, string | undefined>>,
  sensitiveEnvironment: ReadonlyArray<string> = [],
  windows = process.platform === "win32"
): Readonly<Record<string, string | undefined>> => {
  if (typeof windows !== "boolean") throw new TypeError("windows must be a boolean")
  const sensitiveNames = normalizeSensitiveEnvironment(sensitiveEnvironment)
  const blocked = new Set(
    ["SMITHERS_CACHE_TOKEN", "SMITHERS_CACHE_URL", ...sensitiveNames]
      .map((name) => windows ? name.toUpperCase() : name)
  )
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new TypeError("environment source must be an object")
  }
  let keys: Array<string | symbol>
  try {
    keys = Reflect.ownKeys(source)
  } catch {
    throw new TypeError("environment source could not be inspected safely")
  }
  if (keys.length > 4_096) throw new TypeError("environment source has more than 4096 entries")
  const output: Array<readonly [string, string]> = []
  const seen = new Set<string>()
  let bytes = 0
  for (const key of keys) {
    if (typeof key !== "string" || !usableEnvironmentName(key, windows)) {
      // A Windows name outside the environment block's own grammar cannot be
      // carried by any spawn, so a source holding one is corrupt and the whole
      // copy is refused. A POSIX name outside the `export NAME=` convention is
      // a different thing: bash exports shell functions as `BASH_FUNC_which%%`
      // and environment-modules adds more, every child inherits them, and
      // refusing here failed every target on such a host. The package-manager
      // layer selects from a 16-name allowlist anyway, so a name this copy
      // drops could never have reached a child; skipping it is the honest
      // answer, refusing the command is not.
      if (windows || typeof key !== "string") {
        throw new TypeError(
          `environment source contains a non-portable name: ${JSON.stringify(String(key))}`
        )
      }
      continue
    }
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, key)
    } catch {
      throw new TypeError("environment source could not be inspected safely")
    }
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`environment source ${key} must be an enumerable data property`)
    }
    const member = descriptor.value
    if (member !== undefined && typeof member !== "string") {
      throw new TypeError(`environment source ${key} must be a string or undefined`)
    }
    if (typeof member === "string") {
      if (member.includes("\0") || !member.isWellFormed()) {
        throw new TypeError(`environment source ${key} is not usable text`)
      }
      bytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(member, "utf8")
      if (!Number.isSafeInteger(bytes) || bytes > 256 * 1024) {
        throw new TypeError("environment source exceeds 262144 bytes")
      }
    }
    const normalizedName = windows ? key.toUpperCase() : key
    if (seen.has(normalizedName)) {
      throw new TypeError(`environment source repeats a case-insensitive name: ${key}`)
    }
    seen.add(normalizedName)
    if (typeof member === "string" && !blocked.has(normalizedName)) output.push([key, member])
  }
  return Object.freeze(Object.fromEntries(output))
}

/**
 * The toolchain one target declared.
 *
 * A target's attrs carry the manager and runtime declarations.
 * This is the shape the CLI needs out of them to build the two layers.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Toolchain {
  readonly manager: PackageManager.Name
  readonly managerVersion: string
  readonly managerExecutable: string | undefined
  readonly runtime: Runtime.Name
  readonly runtimeVersion: string
  readonly runtimeExecutable: string | undefined
}

/**
 * The toolchain used when a target declares none.
 *
 * Both requirements accept any version. A target that does not run a tool has
 * no business failing because of the interpreter on the host, and inventing a
 * requirement the author never wrote would do exactly that.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultToolchain: Toolchain = Object.freeze({
  manager: "pnpm",
  managerVersion: ">=0.0.0",
  managerExecutable: undefined,
  runtime: "node",
  runtimeVersion: ">=0.0.0",
  runtimeExecutable: undefined
})

/** Reads one own data property without invoking an author-supplied accessor. */
const ownString = (value: object, name: string): string | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined
}

/** Reads one data record without granting a getter or Proxy execution authority. */
const ownRecord = (value: unknown, name: string): object | undefined => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  const member: unknown = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  return typeof member === "object" && member !== null && !NodeUtil.isProxy(member) ? member : undefined
}

/**
 * The declared tools an action-backed target actually uses.
 *
 * The two file generators carry package-manager data to render configuration,
 * not to execute a manager. Vitest's explicit Bun runtime selects Bun itself
 * as the manager, exactly as its target implementation does.
 *
 * @category models
 * @since 1.0.0
 */
export interface TargetToolchain {
  readonly runtime: TargetRuntime.Runtime | undefined
  readonly packageManager: TargetPackageManager.PackageManager | undefined
}

/**
 * Selects tools from already validated target attrs without executing a probe.
 *
 * @category constructors
 * @since 1.0.0
 */
export const targetToolchain = (target: string, attrs: unknown): TargetToolchain => {
  if (target === "GithubCiGen" || target === "PnpmWorkspace") {
    return { runtime: undefined, packageManager: undefined }
  }
  const runtimeRecord = ownRecord(attrs, "runtime")
  const managerRecord = ownRecord(attrs, "packageManager")
  const runtime = TargetRuntime.isRuntime(runtimeRecord) ? runtimeRecord : undefined
  const declaredManager = TargetPackageManager.isPackageManager(managerRecord) ? managerRecord : undefined
  const packageManager = target === "Vitest"
    ? TargetPackageManager.under(declaredManager, runtime)
    : declaredManager
  return { runtime, packageManager }
}

/** The service-layer fields of one validated target runtime. */
const runtimeToolchain = (runtime: TargetRuntime.Runtime): Toolchain => ({
  ...defaultToolchain,
  runtime: runtime.name,
  runtimeVersion: runtime.version,
  runtimeExecutable: runtime.executable
})

/**
 * Verifies declarations before the target can execute a tool.
 *
 * The existing runtime and package-manager services own version parsing,
 * deadlines and typed refusals. No install or fetch operation is performed.
 * Bun's package-manager install service is deliberately unsupported; its tool
 * runner is the Bun executable itself, so its version is verified through the
 * real Bun runtime service instead.
 *
 * @category execution
 * @since 1.0.0
 */
export const verifyTargetToolchain = (
  toolchain: TargetToolchain,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  sensitiveEnvironment: ReadonlyArray<string> = []
) => {
  const verifyRuntime = (runtime: TargetRuntime.Runtime) =>
    Effect.flatMap(Runtime.Runtime, (service) => service.verify).pipe(
      Effect.provide(layerRuntime(runtimeToolchain(runtime), environment))
    )
  const verify = Effect.gen(function*() {
    const manager = toolchain.packageManager
    const runtime = toolchain.runtime
    if (runtime !== undefined) yield* verifyRuntime(runtime)
    if (manager === undefined) return
    if (
      runtime === undefined || runtime.name !== manager.runtime.name ||
      runtime.version !== manager.runtime.version || runtime.executable !== manager.runtime.executable
    ) yield* verifyRuntime(manager.runtime)
    if (manager.name === "bun") {
      // The public manager may explicitly name a different Bun executable.
      // It must satisfy its own requirement as well as the runtime declaration.
      if (manager.executable !== manager.runtime.executable || manager.version !== manager.runtime.version) {
        yield* Effect.flatMap(Runtime.Runtime, (service) => service.verify).pipe(
          Effect.provide(layerRuntime({
            ...runtimeToolchain(manager.runtime),
            runtime: "bun",
            runtimeVersion: manager.version,
            runtimeExecutable: manager.executable
          }, environment))
        )
      }
      return
    }
    yield* Effect.flatMap(PackageManager.PackageManager, (service) => service.verify).pipe(
      Effect.provide(layerPackageManager(
        cwd,
        {
          ...runtimeToolchain(manager.runtime),
          manager: manager.name,
          managerVersion: manager.version,
          managerExecutable: manager.executable
        },
        sensitiveEnvironment,
        environment
      ))
    )
  })
  // Runtime's public service deliberately has no cwd setting. The public
  // command combinator makes its probe observe the actual target directory,
  // including relative PATH entries and executable spellings, without a
  // global chdir or a different native-spawn implementation.
  return Effect.flatMap(ChildProcessSpawner, (spawner) =>
    verify.pipe(Effect.provideService(
      ChildProcessSpawner,
      makeSpawner((command) => spawner.spawn(ChildProcess.setCwd(command, cwd)))
    )))
}

const managerNames = new Set(["pnpm", "bun"])
const runtimeNames = new Set(["node", "bun"])

/**
 * Extracts the toolchain a target declared, falling back to
 * {@link defaultToolchain}.
 *
 * A declaration is a trust boundary, so every field is read as an own data property
 * and validated. A malformed declaration yields the default rather than a
 * crash: the target's own attrs schema already rejected anything malformed, and
 * this reader runs on the far side of that check.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const declaredToolchain = (attrs: unknown): Toolchain => {
  if (typeof attrs !== "object" || attrs === null || NodeUtil.isProxy(attrs)) return defaultToolchain
  const directRuntime = ownRecord(attrs, "runtime")
  const fallback = TargetRuntime.isRuntime(directRuntime) ? runtimeToolchain(directRuntime) : defaultToolchain
  const descriptor = Object.getOwnPropertyDescriptor(attrs, "packageManager")
  const declaration = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  if (typeof declaration !== "object" || declaration === null || NodeUtil.isProxy(declaration)) {
    return fallback
  }
  const manager = ownString(declaration, "name")
  const managerVersion = ownString(declaration, "version")
  if (manager === undefined || !managerNames.has(manager) || managerVersion === undefined) {
    return fallback
  }
  const runtimeDescriptor = Object.getOwnPropertyDescriptor(declaration, "runtime")
  const runtimeDeclaration = runtimeDescriptor !== undefined && "value" in runtimeDescriptor
    ? runtimeDescriptor.value
    : undefined
  const hasRuntime = typeof runtimeDeclaration === "object" && runtimeDeclaration !== null &&
    !NodeUtil.isProxy(runtimeDeclaration)
  const runtime = hasRuntime ? ownString(runtimeDeclaration, "name") : undefined
  const runtimeVersion = hasRuntime ? ownString(runtimeDeclaration, "version") : undefined
  return Object.freeze({
    manager: manager as PackageManager.Name,
    managerVersion,
    managerExecutable: ownString(declaration, "executable"),
    runtime: runtime !== undefined && runtimeNames.has(runtime)
      ? runtime as Runtime.Name
      : defaultToolchain.runtime,
    runtimeVersion: runtimeVersion ?? defaultToolchain.runtimeVersion,
    runtimeExecutable: hasRuntime ? ownString(runtimeDeclaration, "executable") : undefined
  })
}

/**
 * The runtime layer for this host.
 *
 * The platform and a sanitized host-environment snapshot are read here, at
 * the composition root, and passed in. The runtime selects only executable
 * lookup names from that snapshot, so a workspace-declared `--version` probe
 * cannot inherit CI credentials.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerRuntime = (
  toolchain: Toolchain,
  environment: Readonly<Record<string, string | undefined>> = packageManagerEnvironment(process.env)
) => {
  const options = {
    requirement: toolchain.runtimeVersion,
    platform: {
      os: process.platform,
      arch: process.arch,
      libc: null
    },
    environment,
    ...(toolchain.runtimeExecutable === undefined ? {} : { executable: toolchain.runtimeExecutable })
  }
  return toolchain.runtime === "bun" ? Runtime.layerBun(options) : Runtime.layerNode(options)
}

/**
 * The operator variable naming the registry hosts a project `.npmrc` may bind
 * a host credential to, as a comma-separated list of `host` or `host:port`.
 *
 * It is read from the host environment, never from the checkout, because the
 * checkout is what the list constrains. Unset, only `registry.npmjs.org` may
 * receive one.
 *
 * @category security
 * @since 0.1.0
 * @slop
 */
export const credentialHostsVariable = "SMITHERS_NPM_CREDENTIAL_HOSTS"

/**
 * Reads {@link credentialHostsVariable} from the host environment.
 *
 * @category security
 * @since 0.1.0
 * @slop
 */
export const credentialHostsOf = (
  source: Readonly<Record<string, string | undefined>>
): ReadonlyArray<string> | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(source, credentialHostsVariable)
  const value = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  if (typeof value !== "string") return undefined
  return Object.freeze(value.split(",").map((host) => host.trim()).filter((host) => host !== ""))
}

/**
 * The package-manager layer for this host, over the runtime it declared.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerPackageManager = (
  projectRoot: string,
  toolchain: Toolchain = defaultToolchain,
  sensitiveEnvironment: ReadonlyArray<string> = [],
  /**
   * The host environment executables are looked up in. A workspace with a
   * declared Nix environment passes a copy whose `PATH` is the closure's, so
   * the manager and the runtime come from the closure and never from the host.
   */
  source?: Readonly<Record<string, string | undefined>> | undefined
) => {
  const host = source ?? Environment.ambientEnvironment()
  const environment = packageManagerEnvironment(host, sensitiveEnvironment)
  const credentialHosts = credentialHostsOf(host)
  const options = {
    projectRoot,
    environment,
    requirement: toolchain.managerVersion,
    ...(credentialHosts === undefined ? {} : { credentialHosts }),
    ...(toolchain.managerExecutable === undefined ? {} : { executable: toolchain.managerExecutable })
  }
  const manager = toolchain.manager === "bun"
    ? PackageManager.layerBun(options)
    : PackageManager.layerPnpm(options)
  return manager.pipe(Layer.provideMerge(layerRuntime(toolchain, environment)))
}

/**
 * The install action implementations plus the registered install flow.
 *
 * The flow no longer trampolines, so registration is no longer what resolves a
 * round-two handoff. It stays because the executor merges this beside a
 * target's own interpreter registration, which is what lets an install target
 * reached from any dependency graph execute.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerInstall = Layer.mergeAll(
  Install.layer,
  Interpreter.layer(Install.Install)
)

/** Whether a value is a plain object whose own keys are all enumerable data. */
const plainData = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || NodeUtil.isProxy(value)) return false
  let prototype: object | null
  let keys: Array<string | symbol>
  try {
    prototype = Object.getPrototypeOf(value) as object | null
    keys = Reflect.ownKeys(value)
  } catch {
    return false
  }
  if (prototype !== Object.prototype && prototype !== null) return false
  for (const key of keys) {
    if (typeof key !== "string") return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return false
  }
  return true
}

/**
 * Validates a caller-supplied toolchain into a frozen plain-data copy.
 *
 * The value crosses the same boundary as the rest of the install options, so
 * it is read the same way: enumerable own data properties only, no accessors,
 * no proxies, and every field checked before anything spawns.
 */
const normalizeToolchain = (value: unknown): Toolchain => {
  if (!plainData(value)) throw new TypeError("install toolchain must be a plain object")
  const text = (key: string, optional: boolean): string | undefined => {
    const member = value[key]
    if (member === undefined && optional) return undefined
    if (typeof member !== "string" || member === "" || member.includes("\0") || !member.isWellFormed()) {
      throw new TypeError(`install toolchain ${key} must be non-empty usable text`)
    }
    return member
  }
  const manager = text("manager", false)!
  if (!managerNames.has(manager)) {
    throw new TypeError(`install toolchain manager is not a package manager: ${JSON.stringify(manager)}`)
  }
  const runtime = text("runtime", false)!
  if (!runtimeNames.has(runtime)) {
    throw new TypeError(`install toolchain runtime is not a runtime: ${JSON.stringify(runtime)}`)
  }
  return Object.freeze({
    manager: manager as PackageManager.Name,
    managerVersion: text("managerVersion", false)!,
    managerExecutable: text("managerExecutable", true),
    runtime: runtime as Runtime.Name,
    runtimeVersion: text("runtimeVersion", false)!,
    runtimeExecutable: text("runtimeExecutable", true)
  })
}

const normalizeRunInstallOptions = (value: unknown): {
  readonly cacheDirectory: string
  readonly sensitiveEnvironment: ReadonlyArray<string>
  readonly signal: AbortSignal | undefined
  readonly toolchain: Toolchain | undefined
} => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("install options must be a plain object")
  }
  let prototype: object | null
  let keys: Array<string | symbol>
  try {
    prototype = Object.getPrototypeOf(value) as object | null
    keys = Reflect.ownKeys(value)
  } catch {
    throw new TypeError("install options could not be inspected safely")
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("install options must be a plain object")
  }
  const allowed = new Set(["cacheDirectory", "sensitiveEnvironment", "signal", "toolchain"])
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`install options contain an unknown property: ${String(key)}`)
    }
  }
  const read = (key: string): unknown => {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      throw new TypeError(`install option ${key} could not be inspected safely`)
    }
    if (descriptor === undefined) return undefined
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`install option ${key} must be an enumerable data property`)
    }
    return descriptor.value
  }
  const configuredCacheDirectory = read("cacheDirectory")
  if (configuredCacheDirectory !== undefined && typeof configuredCacheDirectory !== "string") {
    throw new TypeError("install cacheDirectory must be a string")
  }
  const configuredSignal = read("signal")
  if (configuredSignal !== undefined && !(configuredSignal instanceof AbortSignal)) {
    throw new TypeError("install signal must be an AbortSignal")
  }
  const sensitive = read("sensitiveEnvironment")
  const configuredToolchain = read("toolchain")
  return Object.freeze({
    cacheDirectory: Config.normalizeCacheDirectory(configuredCacheDirectory ?? Config.defaultCacheDirectory),
    sensitiveEnvironment: normalizeSensitiveEnvironment(sensitive ?? []),
    signal: configuredSignal,
    toolchain: configuredToolchain === undefined ? undefined : normalizeToolchain(configuredToolchain)
  })
}

/**
 * Plans and executes the install package's Install Flow under the declared
 * toolchain, or under {@link defaultToolchain} when the caller passes none.
 *
 * The package-manager service carries the absolute workspace root, so this
 * operation never mutates the process-wide current directory and independent
 * callers can safely run against different workspaces at the same time.
 *
 * Only pnpm installs. A Bun toolchain is refused with a `PackageManagerError`
 * whose code is `unsupported` before the workspace is read.
 *
 * @category execution
 * @since 0.1.0
 * @slop
 */
export const runInstall = async (
  workspaceRoot: string,
  options: {
    readonly cacheDirectory?: string | undefined
    readonly sensitiveEnvironment?: ReadonlyArray<string> | undefined
    readonly signal?: AbortSignal | undefined
    /**
     * The toolchain the workspace declared. The `install` verb runs one target
     * that the workspace may not have declared at all, so the caller passes what it
     * read; omitting it accepts whatever the host has.
     */
    readonly toolchain?: Toolchain | undefined
  } = {}
): Promise<InstallResult> => {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0 || workspaceRoot.includes("\0")) {
    throw new TypeError("install workspaceRoot must be non-empty usable text")
  }
  const normalized = normalizeRunInstallOptions(options)
  normalized.signal?.throwIfAborted()
  // The normalized copy, never the caller's object: the awaits below give a
  // caller time to mutate what it passed, and the manager this pins is what
  // actually spawns.
  const toolchain = normalized.toolchain ?? defaultToolchain
  // Bun cannot meet the fetch-then-link contract; refuse it as configured
  // rather than planning an install whose manager refuses every operation.
  if (toolchain.manager !== "pnpm") throw PackageManager.bunInstallUnsupported()
  if (normalized.cacheDirectory !== Config.defaultCacheDirectory) {
    throw new Error(
      `install requires cacheDirectory ${JSON.stringify(Config.defaultCacheDirectory)} because its declared ` +
        `store boundary is ${JSON.stringify(PackageManager.storeRoot)}; received ${
          JSON.stringify(normalized.cacheDirectory)
        }`
    )
  }
  const workspace = await Fs.realpath(NodePath.resolve(workspaceRoot))
  const runtime = layerInstall.pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(layerPackageManager(workspace, toolchain, normalized.sensitiveEnvironment)),
    Layer.provideMerge(layerNonInteractiveNodeServices)
  )
  const payload = { manager: "pnpm" as const }
  const graph = Graph.build(Install.Install, payload)
  const executionId = `smithers-build-install-${createHash("sha256").update(workspace).digest("hex").slice(0, 16)}`
  const result = await Effect.runPromise(
    Install.Install.execute(payload, { executionId }).pipe(Effect.provide(runtime)),
    { signal: normalized.signal }
  )
  return {
    workspace,
    manager: toolchain.manager,
    plan: Graph.nodes(graph).map((node) => ({
      id: node.id,
      kind: node.kind,
      dependencies: node.dependencies
    })),
    result
  }
}
