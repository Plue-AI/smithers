/**
 * Executes `Memory.Retain` against the Smithers Cloud memory backend.
 *
 * The backend is the `smithers` CLI. It is resolved, never assumed: when the
 * workspace declares no `S.Memory.SmithersCloud` backend, or the CLI is not
 * on PATH, the invocation fails with the typed
 * {@link MemoryBackendUnavailable} notice. That notice is deliberately not
 * green and not a crash: the caller reports it as the target's outcome, so a
 * host without the backend says so instead of pretending the memory was
 * retained.
 *
 * The CLI invocation goes through the {@link MemoryCli} service so the
 * integration can respell the documented `smithers memory` surface in one
 * place; the default implementation shells out to the resolved binary.
 *
 * @since 0.1.0
 */

import * as Exec from "@smthrs/targets/Exec"
import * as MemoryTarget from "@smthrs/targets/MemoryTarget"
import type * as Target from "@smthrs/targets/Target"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as Data from "effect/Data"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as Environment from "./Environment.ts"
import * as ContainedProcess from "./internal/ContainedProcess.ts"

/**
 * The memory backend is not available on this host or in this workspace.
 *
 * `no_backend_declared`: the WORKSPACE.ts declares no
 * `S.Memory.SmithersCloud`. `cli_not_found`: the `smithers` binary is not on
 * PATH. Either way nothing ran, nothing is green, and the message says what
 * to configure.
 *
 * @category errors
 * @since 0.1.0
 */
export class MemoryBackendUnavailable extends Data.TaggedError("smithers-build/MemoryBackendUnavailable")<{
  readonly code: "no_backend_declared" | "cli_not_found"
  readonly message: string
}> {
  constructor(code: "no_backend_declared" | "cli_not_found", message: string) {
    super({ code, message: `memory backend unavailable (${code}): ${message}` })
  }
}

/**
 * Checks whether a value is the unavailable-backend notice.
 *
 * @category guards
 * @since 0.1.0
 */
export const isMemoryBackendUnavailable = (value: unknown): value is MemoryBackendUnavailable =>
  value instanceof MemoryBackendUnavailable

/**
 * The subcommands `smithers memory` ships (`smithers memory --help`,
 * captured in `test/fixtures/smithers-memory-help.txt`). Every argv this
 * module builds names one of them; asking for anything else is a typed
 * {@link MemoryCapabilityMissing} refusal, never a blind spawn that exits 4
 * with no text.
 *
 * @category constants
 * @since 0.1.0
 */
export const memoryCliCommands: ReadonlyArray<string> = ["get", "list", "rm", "set"]

/**
 * Parses the `Commands:` section of `smithers memory --help` into the
 * subcommand names it lists. The captured-fixture test compares this
 * against {@link memoryCliCommands}, so a CLI surface drift fails a test
 * instead of a run.
 *
 * @category constructors
 * @since 0.1.0
 */
export const parseMemoryHelpCommands = (help: string): ReadonlyArray<string> => {
  const commands: Array<string> = []
  let inCommands = false
  for (const line of help.split("\n")) {
    if (/^Commands:/.test(line)) {
      inCommands = true
      continue
    }
    if (inCommands) {
      const match = line.match(/^ {2}([a-z][a-z-]*)\s/)
      if (match === null) break
      commands.push(match[1]!)
    }
  }
  return commands
}

/**
 * A required memory operation has no counterpart in the installed CLI.
 *
 * @category errors
 * @since 0.1.0
 */
export class MemoryCapabilityMissing extends Data.TaggedError("smithers-build/MemoryCapabilityMissing")<{
  readonly capability: string
  readonly message: string
}> {
  constructor(capability: string) {
    super({
      capability,
      message: `the smithers CLI has no \`memory ${capability}\` subcommand ` +
        `(it ships: ${memoryCliCommands.join(", ")}); this capability cannot run on this host`
    })
  }
}

/**
 * Checks whether a value is the missing-capability refusal.
 *
 * @category guards
 * @since 0.1.0
 */
export const isMemoryCapabilityMissing = (value: unknown): value is MemoryCapabilityMissing =>
  value instanceof MemoryCapabilityMissing

/**
 * Asserts one subcommand is in the shipped `smithers memory` surface.
 *
 * @category constructors
 * @since 0.1.0
 */
export const assertMemoryCliCommand = (subcommand: string): void => {
  if (!memoryCliCommands.includes(subcommand)) throw new MemoryCapabilityMissing(subcommand)
}

/**
 * The resolved backend ran and refused the retain.
 *
 * The message always names the argv; the body is stderr when the backend
 * wrote any, else stdout (smithers answers an unknown subcommand with exit
 * 4 and nothing on stderr), else an explicit "(no output)".
 *
 * @category errors
 * @since 0.1.0
 */
export class MemoryCommandFailed extends Data.TaggedError("smithers-build/MemoryCommandFailed")<{
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
  readonly args: ReadonlyArray<string>
  readonly message: string
}> {
  constructor(exitCode: number, output: {
    readonly args: ReadonlyArray<string>
    readonly stdout: string
    readonly stderr: string
  }) {
    const body = output.stderr.trim() !== ""
      ? output.stderr.trim()
      : output.stdout.trim() !== ""
      ? output.stdout.trim()
      : "(no output)"
    super({
      exitCode,
      stderr: output.stderr,
      stdout: output.stdout,
      args: output.args,
      message: `smithers ${output.args.join(" ")} exited ${exitCode}: ${body}`
    })
  }
}

/**
 * Checks whether a value is a backend command failure.
 *
 * @category guards
 * @since 0.1.0
 */
export const isMemoryCommandFailed = (value: unknown): value is MemoryCommandFailed =>
  value instanceof MemoryCommandFailed

/**
 * Finds the `smithers` binary, or undefined when the host has none.
 *
 * @category models
 * @since 0.1.0
 */
export interface CliLocator {
  find(): Promise<string | undefined>
}

/**
 * Runs one resolved backend invocation.
 *
 * @category models
 * @since 0.1.0
 */
export interface MemoryCli {
  run(binary: string, args: ReadonlyArray<string>, cwd: string): Promise<{
    readonly exitCode: number
    readonly stdout: string
    readonly stderr: string
  }>
}

const executableCandidates = (name: string): ReadonlyArray<string> =>
  process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name]

/**
 * The default locator: scans PATH for an executable `smithers`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const pathLocator = (environment: Readonly<Record<string, string | undefined>>): CliLocator => ({
  find: async () => {
    const path = environment["PATH"] ?? ""
    for (const directory of path.split(NodePath.delimiter)) {
      if (directory === "") continue
      for (const candidate of executableCandidates("smithers")) {
        const absolute = NodePath.join(directory, candidate)
        try {
          await Fs.access(absolute, Fs.constants.X_OK)
          const stats = await Fs.stat(absolute)
          if (stats.isFile()) return absolute
        } catch {
          // Not here; keep scanning.
        }
      }
    }
    return undefined
  }
})

/**
 * Options for {@link spawnCli}.
 *
 * @category models
 * @since 0.1.0
 */
export interface SpawnCliOptions {
  /** Positive wall-clock cap on one subprocess. @default 60000 */
  readonly timeoutMs?: number | undefined
  /** Cancels both ref resolution and backend subprocesses. */
  readonly signal?: AbortSignal | undefined
  /** Explicit host environment; cache credentials are removed before spawning. */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  /** Additional workspace cache credential names to withhold. */
  readonly sensitiveNames?: ReadonlyArray<string> | undefined
}

const subprocessEnvironment = (options: SpawnCliOptions): NodeJS.ProcessEnv =>
  Exec.toolEnvironment(
    Object.fromEntries(
      Object.entries(options.environment ?? Environment.ambientEnvironment()).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),
    options.sensitiveNames ?? []
  )

const subprocessTimeout = (options: SpawnCliOptions): number => {
  const timeout = options.timeoutMs ?? 60_000
  if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError("Memory timeoutMs must be positive and finite")
  return timeout
}

/**
 * The default runner: spawns the resolved binary with no shell.
 *
 * @category constructors
 * @since 0.1.0
 */
export const spawnCli = (options: SpawnCliOptions = {}): MemoryCli => ({
  run: async (binary, args, cwd) => {
    const timeout = subprocessTimeout(options)
    let stdout = ""
    let stderr = ""
    try {
      const exitCode = await ContainedProcess.run({
        command: binary,
        args,
        cwd,
        maxOutputBytes: 8 * 1024 * 1024,
        signal: options.signal,
        timeoutMs: timeout,
        environment: subprocessEnvironment(options),
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        }
      })
      return { exitCode, stdout, stderr }
    } catch (cause) {
      if (!(cause instanceof ContainedProcess.ProcessError) || cause.code === "cleanup_failed") throw cause
      if (cause.code === "cancelled") {
        throw Object.assign(new Error("memory subprocess aborted", { cause }), { code: "ABORT_ERR" })
      }
      return {
        exitCode: 1,
        stdout,
        stderr: cause.code === "timed_out"
          ? `${stderr}\nsmithers memory timed out after ${timeout}ms`.trim()
          : stderr || cause.message
      }
    }
  }
})

/**
 * Options accepted by {@link retain}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RetainOptions extends SpawnCliOptions {
  /** The workspace root the CLI runs in. */
  readonly root: string
  /** The `Memory.Retain` target whose validated attrs drive the invocation. */
  readonly target: Target.AnyTarget
  /** The workspace memory declaration, or undefined when none is declared. */
  readonly memory: WorkspaceDeclaration.WorkspaceDeclaration["memory"]
  /** @default {@link pathLocator} over the process environment */
  readonly locator?: CliLocator | undefined
  /** @default {@link spawnCli} */
  readonly cli?: MemoryCli | undefined
  /** Resolves the declared source ref to a commit sha. @default git rev-parse in `root` */
  readonly resolveSource?: ((root: string, ref: string) => Promise<string>) | undefined
}

/**
 * One written fact: its namespace, key, and the argv that wrote it.
 *
 * @category models
 * @since 0.1.0
 */
export interface RetainedFact {
  readonly namespace: string
  readonly key: string
  readonly args: ReadonlyArray<string>
  readonly stdout: string
}

/**
 * The completed retain: the binary that ran and the facts it wrote.
 *
 * @category models
 * @since 0.1.0
 */
export interface RetainResult {
  readonly binary: string
  readonly facts: ReadonlyArray<RetainedFact>
}

/** Resolves one git ref to its commit sha, readably failing otherwise. */
const gitResolveSource = async (root: string, ref: string, options: SpawnCliOptions): Promise<string> => {
  let stdout = ""
  let stderr = ""
  try {
    const exitCode = await ContainedProcess.run({
      command: "git",
      args: ["rev-parse", "--verify", `${ref}^{commit}`],
      cwd: root,
      maxOutputBytes: 1024 * 1024,
      signal: options.signal,
      timeoutMs: subprocessTimeout(options),
      environment: { ...subprocessEnvironment(options), GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      }
    })
    if (exitCode !== 0) throw new Error(stderr.trim() || `git exited ${exitCode}`)
    return stdout.trim()
  } catch (cause) {
    const detail = cause instanceof ContainedProcess.ProcessError && cause.code === "cancelled"
      ? "git subprocess aborted" :
      cause instanceof Error
      ? cause.message
      : stderr.trim()
    throw new Error(`cannot resolve ${ref} to a commit in ${root}: ${detail}`, { cause })
  }
}

/**
 * Retains the referenced commit in the declared Smithers Cloud banks.
 *
 * The backend surface is the installed CLI's real command family
 * (`smithers memory get|list|rm|set`): a retained fact is one
 * `memory set <bank> commit:<sha> <record>` per declared bank, where the
 * sha comes from resolving the declared source ref in the workspace root
 * and the record is the structured JSON the declaration implies
 * (`{ source, commit, tags }`). Reading it back is
 * `smithers memory list <bank>`. The declaration's `init` and `autoInject`
 * options configure the bank's initialization script and agent-context
 * injection; neither gates a retain, so they are inert here. Any memory
 * operation the shipped CLI lacks is a typed
 * {@link MemoryCapabilityMissing} refusal naming the capability.
 *
 * @category execution
 * @since 0.1.0
 */
export const retain = async (options: RetainOptions): Promise<RetainResult> => {
  const attrs = MemoryTarget.retainAttrsOf(options.target)
  if (options.memory === undefined) {
    throw new MemoryBackendUnavailable(
      "no_backend_declared",
      "the WORKSPACE.ts declares no S.Memory.SmithersCloud backend"
    )
  }
  if (options.memory.bank.length === 0) {
    throw new MemoryBackendUnavailable(
      "no_backend_declared",
      "the S.Memory.SmithersCloud declaration names no bank to retain into"
    )
  }
  const locator = options.locator ?? pathLocator(options.environment ?? Environment.ambientEnvironment())
  const binary = await locator.find()
  if (binary === undefined) {
    throw new MemoryBackendUnavailable(
      "cli_not_found",
      "the smithers CLI is not on PATH; install it or remove the memory declaration"
    )
  }
  const resolveSource = options.resolveSource ?? ((root, ref) => gitResolveSource(root, ref, options))
  const sha = await resolveSource(options.root, attrs.source.ref)
  const key = `commit:${sha}`
  const record = JSON.stringify({ source: attrs.source.ref, commit: sha, tags: attrs.tags })
  const cli = options.cli ?? spawnCli(options)
  assertMemoryCliCommand("set")
  const facts: Array<RetainedFact> = []
  for (const bank of options.memory.bank) {
    const args: ReadonlyArray<string> = ["memory", "set", bank, key, record]
    const output = await cli.run(binary, args, options.root)
    if (output.exitCode !== 0) {
      throw new MemoryCommandFailed(output.exitCode, { args, stdout: output.stdout, stderr: output.stderr })
    }
    facts.push({ namespace: bank, key, args, stdout: output.stdout })
  }
  return { binary, facts }
}
