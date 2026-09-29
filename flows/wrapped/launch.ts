/**
 * Launches a wrapped harness: one adapter per harness builds the argv and
 * parses the envelope; {@link run} spawns without a shell in its own process
 * group, writes the task to stdin, bounds stdout, enforces a timeout, and
 * kills the whole group when it ends. Every failure is a typed
 * {@link WrappedFailed}, never a guessed answer.
 *
 * Only Claude Code has an adapter: neither `codex exec --help` nor
 * `opencode run --help` names a developer-instructions flag or config key to
 * verify against.
 */
import * as Fault from "@smthrs/flow/Fault"
import { Effect, Schema } from "effect"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { type Harness, type Permission, sha256, tools } from "./prompt.ts"

export class WrappedFailed extends Schema.TaggedError<WrappedFailed>()("wrapped/WrappedFailed", {
  code: Schema.Literals([
    "prompt_failed",
    "prompt_unsendable",
    "spawn_failed",
    "timeout",
    "output_too_large",
    "exit_nonzero",
    "bad_envelope",
    "harness_error",
    "session_unknown",
    "session_malformed",
    "permission_changed",
    "extra_changed",
    "session_record_failed"
  ]),
  message: Schema.String
}) {}
Fault.register(
  "wrapped/WrappedFailed",
  {
    // The caller named a session this working copy cannot resume as asked.
    session_unknown: "user",
    session_malformed: "user",
    permission_changed: "user",
    extra_changed: "user",
    // The host's disk or process table failed; a retry may pass.
    prompt_failed: "infra",
    session_record_failed: "infra",
    spawn_failed: "infra",
    // Claude Code or its model provider failed or misbehaved; another seat may not.
    timeout: "dependency",
    output_too_large: "dependency",
    exit_nonzero: "dependency",
    bad_envelope: "dependency",
    harness_error: "dependency",
    // Memory selected a block no argv can carry: memory must filter it, a retry repeats it.
    prompt_unsendable: "bug"
  } satisfies Fault.Rows<WrappedFailed["code"]>
)

export interface Command {
  readonly executable: string
  readonly args: ReadonlyArray<string>
}

export interface Launched {
  readonly answer: string
  readonly session: string
}

/** The session a launch runs: a new one under a chosen id, or a resumed one. */
export interface SessionArgs {
  readonly session: string
  readonly resume: boolean
  readonly permission: Permission
}

export interface Adapter {
  readonly command: (extra: string, session: SessionArgs) => Command
  /** Parses stdout, refusing an envelope for any session but `session`. */
  readonly parse: (stdout: string, session: string) => Effect.Effect<Launched, WrappedFailed>
}

const bad = (message: string) => new WrappedFailed({ code: "bad_envelope", message })

/** Reads `result` and `session_id` from one `claude -p --output-format json` envelope. */
export const parseClaude = (stdout: string, session: string): Effect.Effect<Launched, WrappedFailed> =>
  Effect.try({ try: () => JSON.parse(stdout) as unknown, catch: () => bad(`not JSON: ${stdout.slice(0, 200)}`) }).pipe(
    Effect.flatMap((envelope) => {
      if (typeof envelope !== "object" || envelope === null) return Effect.fail(bad("envelope is not an object"))
      const { is_error, result, session_id } = envelope as Record<string, unknown>
      if (typeof result !== "string" || typeof session_id !== "string") {
        return Effect.fail(bad("envelope lacks a string result and session_id"))
      }
      if (session_id !== session) return Effect.fail(bad(`envelope is for session ${session_id}, not ${session}`))
      if (is_error === true) return Effect.fail(new WrappedFailed({ code: "harness_error", message: result }))
      return Effect.succeed({ answer: result, session: session_id })
    })
  )

/** The `--mcp-config` a launch passes with `--strict-mcp-config`: zero servers. */
export const noMcpServers = JSON.stringify({ mcpServers: {} })

export const adapters: Record<Harness, Adapter> = {
  "claude-code": {
    command: (extra, { permission, resume, session }) => ({
      executable: "claude",
      args: [
        "-p",
        resume ? "--resume" : "--session-id",
        session,
        "--permission-mode",
        permission,
        // An allowlist: a denylist misses tools that run commands, such as Monitor.
        "--tools",
        tools[permission],
        // No MCP server: the user's configured servers can run commands or publish.
        "--strict-mcp-config",
        "--mcp-config",
        noMcpServers,
        "--output-format",
        "json",
        "--append-system-prompt",
        extra
      ]
    }),
    parse: parseClaude
  }
}

/**
 * Variables a harness never inherits: the host's Jev key, Node injection
 * hooks, and the build cache's credentials, as LlmLint's `spawnEnvironment`
 * withholds them.
 */
export const withheld: ReadonlyArray<string> = [
  "AI_GATEWAY_API_KEY",
  "NODE_OPTIONS",
  "NODE_PATH",
  "SMITHERS_CACHE_URL",
  "SMITHERS_CACHE_TOKEN"
]

/** `base` without {@link withheld}. */
export const childEnvironment = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const name of withheld) delete env[name]
  return env
}

/** How long pipes may drain after the harness exits, for a holder outside its group. */
export const drainMs = 2000

export interface RunOptions {
  readonly cwd: string
  readonly stdin: string
  readonly timeoutMs: number
  readonly maxBytes: number
  readonly env?: NodeJS.ProcessEnv | undefined
}

/**
 * Spawns `command` (no shell) as the leader of a new process group with
 * {@link childEnvironment}, writes stdin, and returns stdout. Timeout,
 * oversized output, interruption and exit all SIGKILL the group, so the
 * harness's own children die with it.
 *
 * The result follows the harness's `exit`, not the pipes: a process the
 * harness left behind may hold stdout open. On exit the group is killed and
 * the pipes drain; after {@link drainMs} whatever arrived is the output.
 */
export const run = (command: Command, options: RunOptions): Effect.Effect<string, WrappedFailed> =>
  Effect.callback<string, WrappedFailed>((resume) => {
    const fail = (code: WrappedFailed["code"], message: string) =>
      resume(Effect.fail(new WrappedFailed({ code, message })))
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command.executable, [...command.args], {
        cwd: options.cwd,
        env: childEnvironment(options.env ?? process.env),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: true
      })
    } catch (error) {
      // Node throws synchronously for an argument with a NUL byte and for E2BIG.
      fail("spawn_failed", `${command.executable}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const killGroup = () => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        // ESRCH: the group is already gone.
      }
    }
    const stdout: Array<Buffer> = []
    let size = 0
    let stderr = ""
    let settled = false
    let drain: ReturnType<typeof setTimeout> | undefined
    const settle = (effect: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(drain)
      killGroup()
      effect()
    }
    const finish = (code: number | null, signal: NodeJS.Signals | null) =>
      settle(() =>
        code === 0
          ? resume(Effect.succeed(Buffer.concat(stdout).toString("utf8")))
          : fail("exit_nonzero", `${command.executable} exited ${code ?? signal}: ${stderr.trim()}`)
      )
    const timer = setTimeout(
      () => settle(() => fail("timeout", `${command.executable} exceeded ${options.timeoutMs} ms`)),
      options.timeoutMs
    )
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > options.maxBytes) {
        settle(() => fail("output_too_large", `${command.executable} printed more than ${options.maxBytes} bytes`))
      } else stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4096)
    })
    child.on("error", (error) => settle(() => fail("spawn_failed", `${command.executable}: ${error.message}`)))
    child.on("exit", (code, signal) => {
      if (settled) return
      // What the harness left holding its pipes dies now; `close` follows once they drain.
      killGroup()
      child.once("close", () => finish(code, signal))
      drain = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        finish(code, signal)
      }, drainMs)
    })
    // A child that exits before reading stdin surfaces through `close`.
    child.stdin.on("error", () => undefined)
    child.stdin.end(options.stdin)
    return Effect.sync(() => {
      settled = true
      clearTimeout(timer)
      clearTimeout(drain)
      killGroup()
    })
  })

export interface LaunchInput extends SessionArgs {
  readonly harness: Harness
  readonly task: string
  readonly cwd: string
  readonly extra: { readonly path: string; readonly digest: string }
}

export interface LaunchOptions {
  readonly timeoutMs?: number | undefined
  readonly maxBytes?: number | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  /** Receives the exact command before it spawns. */
  readonly observe?: ((command: Command) => void) | undefined
  /** Receives the harness's raw stdout before it is parsed. */
  readonly observeOutput?: ((stdout: string) => void) | undefined
}

/** Reads the extra prompt back, refuses it if its digest moved, and returns the command. */
export const commandFor = (input: LaunchInput): Effect.Effect<Command, WrappedFailed> =>
  Effect.gen(function*() {
    const extra = yield* Effect.tryPromise({
      try: () => readFile(input.extra.path, "utf8"),
      catch: (cause) => new WrappedFailed({ code: "prompt_failed", message: String(cause) })
    })
    if (sha256(extra) !== input.extra.digest) {
      return yield* new WrappedFailed({
        code: "extra_changed",
        message: `${input.extra.path} changed after it was written`
      })
    }
    return adapters[input.harness].command(extra, input)
  })

export const launch = (input: LaunchInput, options: LaunchOptions = {}): Effect.Effect<Launched, WrappedFailed> =>
  Effect.gen(function*() {
    const command = yield* commandFor(input)
    options.observe?.(command)
    const stdout = yield* run(command, {
      cwd: input.cwd,
      stdin: input.task,
      timeoutMs: options.timeoutMs ?? 30 * 60_000,
      maxBytes: options.maxBytes ?? 16 * 1024 * 1024,
      env: options.env
    })
    options.observeOutput?.(stdout)
    return yield* adapters[input.harness].parse(stdout, input.session)
  })
