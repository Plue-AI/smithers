/**
 * Resolves a declared Nix environment to the closure its tools run from.
 *
 * A `S.Nix.Environment` names a flake and lock, or a Nix expression file. This
 * module turns that declaration into what the planner and the executor need:
 * the store path the environment evaluates to, the store hash that names it
 * in key material, the `PATH` a tool spawns with, the exported variables tools
 * need to run from the closure, and the transitive store closure a sandbox
 * may bind-mount as the toolchain read set.
 *
 * Resolution is fail-closed. A host without `nix`, a flake without its lock,
 * an evaluation that fails, or a closure that does not satisfy a declared
 * runtime version is a typed {@link NixEnvironmentError}, never a fallback to
 * whatever the host has on `PATH`.
 *
 * Evaluation runs once per declaration per process and its result is memoized
 * under the workspace cache directory, keyed on the declared inputs' digests,
 * the host system, and the `nix` version. A memoized entry is reused only
 * while its store path still exists on the host.
 *
 * @since 0.1.0
 */

import type * as Exec from "@smthrs/targets/Exec"
import * as Input from "@smthrs/targets/Input"
import * as Nix from "@smthrs/targets/Nix"
import * as Data from "effect/Data"
import * as NodeChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as Environment from "./Environment.ts"
import * as PackageTree from "./PackageTree.ts"

/**
 * The reasons a declared environment cannot be used.
 *
 * @category models
 * @since 0.1.0
 */
export type NixEnvironmentErrorCode =
  | "nix_absent"
  | "nix_input_missing"
  | "nix_evaluation_failed"
  | "nix_environment_incomplete"
  | "nix_tool_absent"
  | "nix_version_mismatch"

/**
 * A declared Nix environment that cannot be resolved or does not satisfy the
 * workspace's declarations.
 *
 * @category errors
 * @since 0.1.0
 */
export class NixEnvironmentError extends Data.TaggedError("smithers-build/NixEnvironmentError")<{
  readonly code: NixEnvironmentErrorCode
  readonly message: string
}> {
  constructor(code: NixEnvironmentErrorCode, message: string) {
    super({ code, message })
  }
}

/**
 * One declared input file with its content digest.
 *
 * @category models
 * @since 0.1.0
 */
export interface EnvironmentInput {
  readonly path: string
  readonly digest: string
}

/**
 * A declared environment resolved on this host.
 *
 * @category models
 * @since 0.1.0
 */
export interface ResolvedEnvironment {
  /** The store path the environment evaluates to. */
  readonly storePath: string
  /** The 32-character store hash of {@link storePath}; the `nix:<hash>` layer. */
  readonly hash: string
  /** Every store path {@link storePath} references, itself included. */
  readonly closure: ReadonlyArray<string>
  /** The `PATH` entries a tool spawns with, in order. */
  readonly path: ReadonlyArray<string>
  /** Exported variables tools need to run from the closure. */
  readonly variables: Readonly<Record<string, string>>
  /** The `nix` that evaluated the environment. */
  readonly nix: { readonly executable: string; readonly version: string }
  /** The Nix system the environment was resolved for. */
  readonly system: string
  /** The declared inputs and their digests at resolution time. */
  readonly inputs: ReadonlyArray<EnvironmentInput>
}

/**
 * The exported variables carried from the closure into every tool spawn.
 *
 * `PATH` is handled on its own. The rest are the variables that tell a
 * closure's `curl`, `git`, and libc where the certificate bundle, the locale
 * archive, and the time zone database live; without them those programs
 * look in FHS paths the closure does not populate.
 *
 * @category constants
 * @since 0.1.0
 */
export const carriedVariables: ReadonlyArray<string> = Object.freeze([
  "SSL_CERT_FILE",
  "NIX_SSL_CERT_FILE",
  "GIT_SSL_CAINFO",
  "LOCALE_ARCHIVE",
  "TZDIR",
  "NIX_LD",
  "NIX_LD_LIBRARY_PATH"
])

/**
 * A store path: an absolute directory whose basename is a 32-character Nix
 * hash and a name. `/nix/store` is the default store; a relocated store root
 * (`nix --store`) produces the same shape elsewhere.
 */
const storePathShape = /^\/.*\/([0-9a-df-np-sv-z]{32})-[^/\s]+$/

/**
 * Maps the host to the Nix system name a flake is evaluated for.
 *
 * @category accessors
 * @since 0.1.0
 */
export const hostSystem = (
  platform: string = process.platform,
  arch: string = process.arch
): string => {
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform
  return `${cpu}-${os}`
}

const maximumOutputBytes = 16 * 1024 * 1024

const execFile = (
  executable: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly signal?: AbortSignal | undefined
    readonly timeoutMs?: number | undefined
  }
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      executable,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: maximumOutputBytes,
        encoding: "utf8",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs })
      },
      (error, stdout, stderr) => {
        if (error !== null && !("code" in error && typeof error.code === "number")) {
          reject(error)
          return
        }
        const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode })
      }
    )
  })

/** The last non-empty line of a tool's standard output. */
const lastLine = (text: string): string => {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "")
  return lines[lines.length - 1] ?? ""
}

/** The tail of a tool's standard error, bounded for a diagnostic. */
const tail = (text: string, bytes = 4 * 1024): string => {
  const trimmed = text.trim()
  return trimmed.length <= bytes ? trimmed : trimmed.slice(trimmed.length - bytes)
}

/** The store hash of one store path, or undefined for a path outside the store. */
const storeHash = (path: string): string | undefined => storePathShape.exec(path)?.[1]

/** The `nix` invocation prefix: the experimental features every command below needs. */
const nixArguments = (args: ReadonlyArray<string>): ReadonlyArray<string> => [
  "--extra-experimental-features",
  "nix-command flakes",
  ...args
]

/**
 * The installable arguments that name the declared environment for `nix
 * build` and `nix print-dev-env`, resolved against the workspace root.
 */
const installable = (root: string, declaration: Nix.Environment, system: string): ReadonlyArray<string> => {
  if (declaration.file !== undefined) {
    return ["--file", NodePath.join(root, Input.resolvePath("", declaration.file.path))]
  }
  const directory = Nix.flakeDirectory(declaration)
  const attribute = Nix.outputAttribute(declaration, system) ?? `devShells.${system}.default`
  return [`${directory === "" ? root : NodePath.join(root, directory)}#${attribute}`]
}

const digestInputs = async (
  root: string,
  declaration: Nix.Environment,
  signal: AbortSignal | undefined
): Promise<ReadonlyArray<EnvironmentInput>> => {
  const inputs: Array<EnvironmentInput> = []
  for (const file of Nix.environmentInputs(declaration)) {
    const relative = Input.resolvePath("", file.path)
    const digest = await Input.digestFile(NodePath.join(root, relative), { workspaceRoot: root, signal })
    if (digest === undefined) {
      const hint = relative.endsWith("flake.lock")
        ? "; run `nix flake lock` and commit the lock so the environment is reproducible"
        : ""
      throw new NixEnvironmentError("nix_input_missing", `Nix environment input ${relative} does not exist${hint}`)
    }
    inputs.push({ path: relative, digest })
  }
  return inputs
}

const memoKey = (
  inputs: ReadonlyArray<EnvironmentInput>,
  declaration: Nix.Environment,
  system: string,
  nixVersion: string
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        inputs,
        attr: declaration.attr ?? null,
        file: declaration.file?.path ?? null,
        system,
        nixVersion
      })
    )
    .digest("hex")

const memoPath = (root: string, cacheDirectory: string, key: string): string =>
  NodePath.join(root, cacheDirectory, "nix", `${key}.json`)

const readMemo = async (path: string): Promise<ResolvedEnvironment | undefined> => {
  let text: string
  try {
    text = await Fs.readFile(path, "utf8")
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const value = parsed as Partial<ResolvedEnvironment>
  if (
    typeof value.storePath !== "string" || storeHash(value.storePath) !== value.hash ||
    !Array.isArray(value.closure) || !Array.isArray(value.path) || typeof value.variables !== "object"
  ) return undefined
  try {
    await Fs.access(value.storePath)
  } catch {
    return undefined
  }
  return value as ResolvedEnvironment
}

const writeMemo = async (path: string, resolved: ResolvedEnvironment): Promise<void> => {
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await Fs.writeFile(temporary, JSON.stringify(resolved), "utf8")
  await Fs.rename(temporary, path)
}

const inFlight = new Map<string, Promise<ResolvedEnvironment>>()

/**
 * Resolves one declared environment on this host.
 *
 * @category resolution
 * @since 0.1.0
 */
export const resolveEnvironment = async (options: {
  readonly root: string
  readonly declaration: Nix.Environment
  /** The workspace-relative cache directory the memo lives under; omit to skip the memo. */
  readonly cacheDirectory?: string | undefined
  /** The host environment `nix` is looked up in and spawned with. */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly signal?: AbortSignal | undefined
  readonly log?: ((line: string) => void) | undefined
}): Promise<ResolvedEnvironment> => {
  const hostEnvironment = options.environment ?? Environment.ambientEnvironment()
  const nix = PackageTree.findOnPath("nix", hostEnvironment)
  if (nix === undefined) {
    throw new NixEnvironmentError(
      "nix_absent",
      "the workspace declares a Nix environment but `nix` is not present on PATH; " +
        "install Nix (https://nixos.org/download) or remove the S.Nix.Environment declaration"
    )
  }
  const inputs = await digestInputs(options.root, options.declaration, options.signal)
  const system = hostSystem()
  const version = await execFile(nix, ["--version"], {
    cwd: options.root,
    env: hostEnvironment,
    signal: options.signal,
    timeoutMs: 30_000
  })
  if (version.exitCode !== 0) {
    throw new NixEnvironmentError("nix_evaluation_failed", `nix --version failed: ${tail(version.stderr)}`)
  }
  const nixVersion = lastLine(version.stdout)
  const key = memoKey(inputs, options.declaration, system, nixVersion)
  const running = inFlight.get(key)
  if (running !== undefined) return running
  const work = (async (): Promise<ResolvedEnvironment> => {
    const memo = options.cacheDirectory === undefined
      ? undefined
      : memoPath(options.root, options.cacheDirectory, key)
    if (memo !== undefined) {
      const known = await readMemo(memo)
      if (known !== undefined) return known
    }
    const target = installable(options.root, options.declaration, system)
    options.log?.(`nix environment: evaluating ${target.join(" ")}`)
    const built = await execFile(
      nix,
      nixArguments(["build", "--no-link", "--print-out-paths", "--no-write-lock-file", ...target]),
      { cwd: options.root, env: hostEnvironment, signal: options.signal }
    )
    if (built.exitCode !== 0) {
      throw new NixEnvironmentError(
        "nix_evaluation_failed",
        `nix build failed for the declared environment (exit ${built.exitCode}): ${tail(built.stderr)}`
      )
    }
    const storePath = lastLine(built.stdout)
    const hash = storeHash(storePath)
    if (hash === undefined) {
      throw new NixEnvironmentError(
        "nix_evaluation_failed",
        `nix build printed no store path for the declared environment: ${JSON.stringify(storePath)}`
      )
    }
    const printed = await execFile(
      nix,
      nixArguments(["print-dev-env", "--json", ...target]),
      { cwd: options.root, env: hostEnvironment, signal: options.signal }
    )
    if (printed.exitCode !== 0) {
      throw new NixEnvironmentError(
        "nix_evaluation_failed",
        `nix print-dev-env failed for the declared environment (exit ${printed.exitCode}): ${tail(printed.stderr)}`
      )
    }
    let variables: Record<string, string> = {}
    let path: Array<string> = []
    try {
      const parsed = JSON.parse(printed.stdout) as {
        readonly variables?: Record<string, { readonly type?: string; readonly value?: unknown }>
      }
      const exported = parsed.variables ?? {}
      const pathEntry = exported["PATH"]
      if (pathEntry !== undefined && typeof pathEntry.value === "string") {
        path = pathEntry.value.split(NodePath.delimiter).filter((entry) => entry !== "")
      }
      for (const name of carriedVariables) {
        const entry = exported[name]
        if (entry !== undefined && typeof entry.value === "string" && entry.value !== "") {
          variables[name] = entry.value
        }
      }
    } catch {
      throw new NixEnvironmentError("nix_environment_incomplete", "nix print-dev-env printed no readable JSON")
    }
    if (path.length === 0) {
      throw new NixEnvironmentError(
        "nix_environment_incomplete",
        "the declared environment exports no PATH; a dev shell or buildEnv with at least one package is required"
      )
    }
    const closureListing = await execFile(
      nix,
      nixArguments(["path-info", "--recursive", storePath]),
      { cwd: options.root, env: hostEnvironment, signal: options.signal }
    )
    if (closureListing.exitCode !== 0) {
      throw new NixEnvironmentError(
        "nix_evaluation_failed",
        `nix path-info failed for ${storePath}: ${tail(closureListing.stderr)}`
      )
    }
    const closure = closureListing.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "").sort()
    variables = Object.freeze(variables)
    const resolved: ResolvedEnvironment = {
      storePath,
      hash,
      closure,
      path,
      variables,
      nix: { executable: nix, version: nixVersion },
      system,
      inputs
    }
    if (memo !== undefined) {
      try {
        await writeMemo(memo, resolved)
      } catch (cause) {
        options.log?.(`nix environment: could not memoize the resolution: ${String(cause)}`)
      }
    }
    return resolved
  })()
  inFlight.set(key, work)
  try {
    return await work
  } finally {
    inFlight.delete(key)
  }
}

/**
 * The exec-layer environment one resolved closure supplies.
 *
 * @category accessors
 * @since 0.1.0
 */
export const toolEnvironment = (resolved: ResolvedEnvironment): Exec.ToolEnvironment => ({
  path: resolved.path.join(NodePath.delimiter),
  variables: resolved.variables
})

/**
 * A host environment copy whose `PATH` is the closure's, for executable
 * lookups that read a whole environment record.
 *
 * @category accessors
 * @since 0.1.0
 */
export const hostEnvironmentWith = (
  resolved: ResolvedEnvironment,
  source: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string | undefined>> =>
  Object.freeze({ ...source, ...resolved.variables, PATH: resolved.path.join(NodePath.delimiter) })

/**
 * The layer identity a resolved environment contributes to key material.
 *
 * @category accessors
 * @since 0.1.0
 */
export const layer = (resolved: ResolvedEnvironment): string => `nix:${resolved.hash}`

/** Parses a version out of `--version` output: the first `x.y.z` it contains. */
const parseVersion = (text: string): string | undefined => /(\d+)\.(\d+)\.(\d+)/.exec(text)?.[0]

const compareVersions = (left: string, right: string): number => {
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Reports whether a measured version satisfies a declared requirement of the
 * two forms declarations use: `>=x.y.z`, or an exact `x.y.z`.
 *
 * @category accessors
 * @since 0.1.0
 */
export const satisfies = (measured: string, requirement: string): boolean => {
  const trimmed = requirement.trim()
  if (trimmed === "" || trimmed === ">=0.0.0") return true
  if (trimmed.startsWith(">=")) return compareVersions(measured, trimmed.slice(2).trim()) >= 0
  return compareVersions(measured, trimmed) === 0
}

const measured = new Map<string, Promise<string>>()

/**
 * Asserts that one tool the closure supplies satisfies the version the
 * workspace declared for it.
 *
 * The tool is looked up on the closure's `PATH` alone. An absent tool and a
 * version outside the requirement are both {@link NixEnvironmentError}s that
 * name the declaration and what the closure provides.
 *
 * @category resolution
 * @since 0.1.0
 */
export const assertToolVersion = async (
  resolved: ResolvedEnvironment,
  tool: { readonly name: string; readonly executable?: string | undefined; readonly requirement: string },
  options: { readonly root: string; readonly signal?: AbortSignal | undefined }
): Promise<string> => {
  const executable = tool.executable ?? tool.name
  const environment = { PATH: resolved.path.join(NodePath.delimiter) }
  const found = PackageTree.findOnPath(executable, environment)
  if (found === undefined) {
    throw new NixEnvironmentError(
      "nix_tool_absent",
      `the declared Nix environment provides no ${JSON.stringify(executable)}; ` +
        `the workspace declares ${tool.name} ${tool.requirement}`
    )
  }
  const key = `${resolved.hash}\0${found}`
  let probe = measured.get(key)
  if (probe === undefined) {
    probe = execFile(found, ["--version"], {
      cwd: options.root,
      env: { ...resolved.variables, PATH: environment.PATH },
      signal: options.signal,
      timeoutMs: 30_000
    }).then((output) => {
      const version = parseVersion(`${output.stdout}\n${output.stderr}`)
      if (output.exitCode !== 0 || version === undefined) {
        throw new NixEnvironmentError(
          "nix_tool_absent",
          `${found} --version did not report a version (exit ${output.exitCode}): ${tail(output.stderr)}`
        )
      }
      return version
    })
    measured.set(key, probe)
  }
  const version = await probe
  if (!satisfies(version, tool.requirement)) {
    throw new NixEnvironmentError(
      "nix_version_mismatch",
      `the workspace declares ${tool.name} ${tool.requirement} but the Nix environment provides ${tool.name} ${version} (${found})`
    )
  }
  return version
}
