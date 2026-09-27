/**
 * Plan-time resolution of opaque local-repository target edges.
 *
 * Child declarations never enter the parent module graph. Resolution invokes
 * this same CLI in the child directory, parses its JSON query result, and
 * reduces every failure to data carried by the parent target.
 *
 * @since 0.1.0
 */

import type * as LocalRepository from "@smthrs/targets/LocalRepository"
import * as RepoTarget from "@smthrs/targets/RepoTarget"
import * as Target from "@smthrs/targets/Target"
import { spawn } from "node:child_process"
import * as NodePath from "node:path"
import type * as PackageIndex from "./PackageIndex.ts"
import * as Workspace from "./Workspace.ts"

/**
 * The source entry point every child invocation executes.
 *
 * @category constants
 * @since 0.1.0
 */
export const buildCliPath = NodePath.join(import.meta.dirname, "main.js")

/**
 * The child metadata attached to one repository target at plan time.
 *
 * @category models
 * @since 0.1.0
 */
export interface Resolution {
  readonly repoName: string
  readonly repoPath: string
  readonly absolutePath: string
  readonly label: string
  readonly args: ReadonlyArray<string>
  readonly kinds: ReadonlyArray<Target.Kind>
  readonly refusal: string | undefined
  readonly externalLabel: string
}

/**
 * The git state that keys execution of a child repository.
 *
 * @category models
 * @since 0.1.0
 */
export interface GitState {
  readonly head: string
  readonly dirty: boolean
  readonly status: string
}

/**
 * A child CLI execution failed after streaming its output.
 *
 * @category errors
 * @since 0.1.0
 */
export class ExecutionError extends Error {
  override readonly name = "RepoTargetExecutionError"
  readonly code = "repo_target_failed"
  readonly exitCode: number
  readonly stderrTail: string

  constructor(resolution: Resolution, exitCode: number, stderrTail: string) {
    super(
      `child target ${resolution.externalLabel} failed with exit ${exitCode}${
        stderrTail === "" ? "" : `\n${stderrTail}`
      }`
    )
    this.exitCode = exitCode
    this.stderrTail = stderrTail
  }
}

/**
 * One operation's view of the workspace's child repositories: the index, the
 * environment every child spawn inherits, and the memoized resolutions keyed
 * by target identity.
 *
 * The environment is scrubbed on construction, so no child repository ever
 * inherits the parent's remote-cache credentials. Only `resolver` builds one.
 *
 * @category models
 * @since 0.1.0
 */
export class Resolver {
  readonly index: PackageIndex.PackageIndex
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly cache = new Map<Target.AnyTarget, Promise<Resolution>>()

  private constructor(
    index: PackageIndex.PackageIndex,
    environment: Readonly<Record<string, string | undefined>>
  ) {
    this.index = index
    this.environment = environment
  }

  /** @internal */
  static make(
    index: PackageIndex.PackageIndex,
    environment: Readonly<Record<string, string | undefined>>
  ): Resolver {
    return new Resolver(index, environment)
  }
}

/**
 * Builds the resolver one operation shares. `ambient` is the caller's host
 * environment; the default cache names and every credential name the
 * workspace declares are withheld from it before any child sees it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolver = (
  index: PackageIndex.PackageIndex,
  ambient: Readonly<Record<string, string | undefined>>
): Resolver =>
  Resolver.make(
    index,
    Workspace.withheldEnvironment(ambient, Workspace.remoteCacheOf(index.workspace.cache.remote)?.credentials)
  )

interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const maximumOutputBytes = 1024 * 1024
const diagnosticTail = 8 * 1024

/** Runs one bounded child process without a shell. */
const runProcess = (
  cwd: string,
  argv: readonly [string, ...Array<string>],
  env: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal | undefined
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const [command, ...args] = argv
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    const stdout: Array<Buffer> = []
    const stderr: Array<Buffer> = []
    let bytes = 0
    let settled = false
    const finish = (operation: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", abort)
      operation()
    }
    const abort = (): void => {
      child.kill("SIGKILL")
      finish(() => reject(signal?.reason ?? new Error("child process aborted")))
    }
    const append = (target: Array<Buffer>) => (chunk: Buffer): void => {
      if (settled) return
      bytes += chunk.length
      if (bytes > maximumOutputBytes) {
        child.kill("SIGKILL")
        finish(() => reject(new Error(`child CLI output exceeds ${maximumOutputBytes} bytes`)))
        return
      }
      target.push(chunk)
    }
    child.stdout.on("data", append(stdout))
    child.stderr.on("data", append(stderr))
    child.on("error", (cause) => finish(() => reject(cause)))
    child.on("close", (code) =>
      finish(() =>
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        })
      ))
    if (signal?.aborted === true) abort()
    else signal?.addEventListener("abort", abort, { once: true })
  })

const tail = (value: string): string =>
  value.length <= diagnosticTail ? value : value.slice(value.length - diagnosticTail)

const kindNames: ReadonlySet<string> = new Set(["build", "test", "lint", "run", "docs", "review"])

const repositoryOf = (
  index: PackageIndex.PackageIndex,
  value: string | LocalRepository.Declaration
): { readonly name: string; readonly path: string } | undefined => {
  const repositories = Object.entries(index.workspace.repos ?? {})
  if (typeof value === "string") {
    const declaration = index.workspace.repos?.[value]
    return declaration === undefined ? undefined : { name: value, path: declaration.path }
  }
  const found = repositories.find(([, declaration]) => declaration.path === value.path)
  return found === undefined ? undefined : { name: found[0], path: found[1].path }
}

const refused = (
  index: PackageIndex.PackageIndex,
  attrs: RepoTarget.TargetAttrs,
  message: string
): Resolution => ({
  repoName: typeof attrs.repo === "string" ? attrs.repo : "unknown",
  repoPath: typeof attrs.repo === "string" ? attrs.repo : attrs.repo.path,
  absolutePath: index.root,
  label: attrs.label,
  args: attrs.args ?? [],
  kinds: [],
  refusal: message,
  externalLabel: `@${typeof attrs.repo === "string" ? attrs.repo : "unknown"}${attrs.label}`
})

const query = async (
  resolver: Resolver,
  target: Target.AnyTarget,
  signal?: AbortSignal | undefined
): Promise<Resolution> => {
  const index = resolver.index
  const attrs = RepoTarget.attrsOf(target)
  const repository = repositoryOf(index, attrs.repo)
  if (repository === undefined) {
    return refused(
      index,
      attrs,
      `Repo.Target repository ${
        typeof attrs.repo === "string" ? JSON.stringify(attrs.repo) : JSON.stringify(attrs.repo.path)
      } is not declared in Workspace repos`
    )
  }
  const absolutePath = NodePath.join(index.root, ...repository.path.split("/"))
  const base = {
    repoName: repository.name,
    repoPath: repository.path,
    absolutePath,
    label: attrs.label,
    args: attrs.args ?? [],
    externalLabel: `@${repository.name}${attrs.label}`
  }
  try {
    const result = await runProcess(
      absolutePath,
      [process.execPath, buildCliPath, "query", attrs.label, "--workspace", absolutePath, "--format", "json"],
      resolver.environment,
      signal
    )
    if (result.exitCode !== 0) {
      const detail = tail((result.stderr.trim() || result.stdout.trim()) || `exit ${result.exitCode}`)
      return { ...base, kinds: [], refusal: `child repository @${repository.name} refused ${attrs.label}: ${detail}` }
    }
    const decoded: unknown = JSON.parse(result.stdout)
    const targets = typeof decoded === "object" && decoded !== null && "targets" in decoded
      ? (decoded as { readonly targets?: unknown }).targets
      : undefined
    const row = Array.isArray(targets)
      ? targets.find((entry) =>
        typeof entry === "object" && entry !== null &&
        (entry as { readonly label?: unknown }).label === attrs.label
      )
      : undefined
    const rawKinds = typeof row === "object" && row !== null && "kinds" in row
      ? (row as { readonly kinds?: unknown }).kinds
      : undefined
    if (!Array.isArray(rawKinds) || !rawKinds.every((kind) => typeof kind === "string" && kindNames.has(kind))) {
      return {
        ...base,
        kinds: [],
        refusal: `child repository @${repository.name} query returned no valid target row for ${attrs.label}`
      }
    }
    return { ...base, kinds: rawKinds as ReadonlyArray<Target.Kind>, refusal: undefined }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return {
      ...base,
      kinds: [],
      refusal: `child repository @${repository.name} could not query ${attrs.label}: ${tail(message)}`
    }
  }
}

/**
 * Resolves one repository target, memoized within the caller's operation.
 *
 * @category resolution
 * @since 0.1.0
 */
export const resolve = (
  resolver: Resolver,
  target: Target.AnyTarget,
  signal?: AbortSignal | undefined
): Promise<Resolution> => {
  const existing = resolver.cache.get(target)
  if (existing !== undefined) return existing
  const pending = query(resolver, target, signal)
  resolver.cache.set(target, pending)
  return pending
}

/**
 * Returns a target's effective kinds, mirroring a repository target through
 * Alias while leaving every ordinary target unchanged.
 *
 * @category resolution
 * @since 0.1.0
 */
export const effectiveKinds = async (
  resolver: Resolver,
  target: Target.AnyTarget,
  signal?: AbortSignal | undefined
): Promise<ReadonlyArray<Target.Kind>> => {
  const metadata = Target.metadata(target)
  if (metadata.target === "Repo.Target") return (await resolve(resolver, target, signal)).kinds
  if (metadata.target === "Alias" && metadata.dependencies[0] !== undefined) {
    return effectiveKinds(resolver, metadata.dependencies[0], signal)
  }
  return metadata.kinds
}

/**
 * Reads the commit and dirty status used by one child execution key.
 *
 * @category resolution
 * @since 0.1.0
 */
export const gitState = async (
  resolver: Resolver,
  resolution: Resolution,
  signal?: AbortSignal | undefined
): Promise<GitState> => {
  const head = await runProcess(
    resolution.absolutePath,
    ["git", "-C", resolution.absolutePath, "rev-parse", "HEAD"],
    resolver.environment,
    signal
  )
  if (head.exitCode !== 0) throw new Error(`could not read child repository HEAD: ${tail(head.stderr || head.stdout)}`)
  const status = await runProcess(
    resolution.absolutePath,
    ["git", "-C", resolution.absolutePath, "status", "--porcelain"],
    resolver.environment,
    signal
  )
  if (status.exitCode !== 0) {
    throw new Error(`could not read child repository status: ${tail(status.stderr || status.stdout)}`)
  }
  return { head: head.stdout.trim(), dirty: status.stdout !== "", status: status.stdout }
}

/**
 * Executes one repository target through this CLI, under the resolver's
 * scrubbed environment, and streams both output
 * pipes to `output` while retaining a bounded diagnostic tail. `output`
 * defaults to the parent process streams; a run passes its reporter so an
 * injected terminal receives the child's output.
 *
 * @category execution
 * @since 0.1.0
 */
export const execute = (
  resolver: Resolver,
  resolution: Resolution,
  options: {
    readonly write?: boolean | undefined
    readonly plan?: boolean | undefined
    readonly signal?: AbortSignal | undefined
    readonly output?: ((stream: "stdout" | "stderr", chunk: string) => void) | undefined
  } = {}
): Promise<void> =>
  new Promise((resolve, reject) => {
    const args = [
      buildCliPath,
      resolution.label,
      "--workspace",
      resolution.absolutePath,
      ...(options.write === true ? ["--write"] : []),
      ...(options.plan === true ? ["--plan"] : []),
      ...resolution.args
    ]
    const child = spawn(process.execPath, args, {
      cwd: resolution.absolutePath,
      detached: true,
      env: { ...resolver.environment, SMTHRS_REPO_CHILD: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stderrTail = ""
    let settled = false
    const finish = (operation: () => void): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener("abort", abort)
      operation()
    }
    const kill = (): void => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL")
          return
        } catch {
          // Fall through on hosts without process-group signals.
        }
      }
      child.kill("SIGKILL")
    }
    const abort = (): void => {
      kill()
      finish(() => reject(options.signal?.reason ?? new Error("child target aborted")))
    }
    const output = options.output ??
      ((stream: "stdout" | "stderr", chunk: string) =>
        void (stream === "stdout" ? process.stdout : process.stderr).write(chunk))
    child.stdout.on("data", (chunk: Buffer) => output("stdout", chunk.toString("utf8")))
    child.stderr.on("data", (chunk: Buffer) => {
      output("stderr", chunk.toString("utf8"))
      stderrTail = tail(stderrTail + chunk.toString("utf8"))
    })
    child.on("error", (cause) => finish(() => reject(cause)))
    child.on("close", (code) =>
      finish(() => {
        const exitCode = code ?? -1
        if (exitCode === 0) resolve()
        else reject(new ExecutionError(resolution, exitCode, stderrTail.trim()))
      }))
    if (options.signal?.aborted === true) abort()
    else options.signal?.addEventListener("abort", abort, { once: true })
  })
