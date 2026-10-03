/**
 * Bash flow declaration and portable handler.
 *
 * Two ways in, and the difference is where the payload is parsed. `command` is
 * a line for the platform shell, exactly as before. `script` is program text
 * delivered to an interpreter on standard input, as data: nothing quotes it,
 * escapes it, or terminates it with a heredoc marker, so the class of failure
 * that produced `docker exec c bash -lc '…python - <<EOF…'` cannot occur. Its
 * `args` reach the script as arguments rather than as interpolated text.
 *
 * `container` names a container the host knows how to reach, and the argv is
 * built by the injected {@link Container} transport rather than typed by the
 * caller. A host that binds no transport refuses such a call by saying so; the
 * requirement is optional here precisely so a host without containers is not
 * forced to declare one.
 *
 * @since 1.0.0
 */

import type * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Path from "@smthrs/kernel/Path"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Container from "./Container.ts"
import { capability, envelope } from "./internal/Declaration.ts"
import * as Diagnostics from "./internal/Diagnostics.ts"
import { outsideEnvelope } from "./internal/EnvelopePrecheck.ts"
import * as Exec from "./internal/Exec.ts"
import { MAX_SHELL_OUTPUT_BYTES, truncateBytes } from "./internal/Text.ts"
import * as Probe from "./Probe.ts"
import * as StdError from "./StdError.ts"
import * as TreeFingerprint from "./TreeFingerprint.ts"

/**
 * Registry name for the bash flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "bash"

/**
 * Model-facing description of the bash flow.
 *
 * Capped at 200 characters and read every frame, which is why the
 * invalid-probe contract is not restated here: the cell contract teaches it
 * once, and a result that has one explains itself.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description =
  "Run a shell command, or an interpreter over a script passed as data instead of quoted into a line. container routes it through the host's container transport. mode:hermetic pre-checks path tokens."

/**
 * Default command timeout in milliseconds.
 *
 * Ten minutes lets full builds and test suites finish while ensuring a stalled
 * process eventually releases the flow.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_TIMEOUT_MS = 600_000

const Command = Schema.optional(Schema.String.annotate({
  description: "Shell command line to execute; give this or script, never both"
}))
const Script = Schema.optional(Schema.String.annotate({
  description: "Program text delivered to the interpreter on stdin as data, so it needs no quoting or heredoc"
}))
const Interpreter = Schema.optional(Schema.String.annotate({
  description:
    "Program that reads script on stdin; defaults to bash. python, python3, sh, zsh, node, ruby and perl are known"
}))
const Args = Schema.optional(
  Schema.Array(Schema.String).annotate({
    description: "Arguments passed to the script as data, never interpolated into it"
  })
)
const Stdin = Schema.optional(Schema.String.annotate({
  description: "Text written to the command's standard input; use script instead when the text is the program"
}))
const ContainerName = Schema.optional(Schema.String.annotate({
  description: "Run inside this container through the host's container transport; requires mode:unhermetic"
}))
const Cwd = Schema.optional(Schema.String).annotate({
  description: "Working directory for the command",
  message: "cwd must be a path string. For a checkpoint, pass { at: ctx.base } as the third ctx.call argument."
})
const Env = Schema.optional(
  Schema.Record(Schema.String, Schema.String).annotate({ description: "Environment variables for the command" })
)
const TimeoutMs = Schema.optional(Schema.Number).annotate({
  description: "Wall-clock timeout in milliseconds; defaults to 600000 ms",
  message: "timeoutMs must be a number of milliseconds."
})

/**
 * Input schema for the bash flow.
 *
 * The mode named `hermetic` requires explicit read and write envelopes for a
 * lexical pre-check; it does not by itself confine the process. Unhermetic mode
 * deliberately omits those declarations so the distinction stays visible in
 * the input shape.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("hermetic").annotate({
      description: "Lexically pre-check explicit path tokens against declared reads and writes; does not sandbox"
    }),
    command: Command,
    script: Script,
    interpreter: Interpreter,
    args: Args,
    stdin: Stdin,
    container: ContainerName,
    reads: Schema.Array(Schema.NonEmptyString).annotate({ description: "Paths or path globs the command may read" }),
    writes: Schema.Array(Schema.NonEmptyString).annotate({ description: "Paths or path globs the command may write" }),
    cwd: Cwd,
    env: Env,
    timeoutMs: TimeoutMs
  }),
  Schema.Struct({
    // Omitted means unhermetic: it is the envelope `effects` already declares
    // for every call, so the default grants nothing a named mode would not.
    mode: Schema.Literal("unhermetic").annotate({
      description: "Run without a declared filesystem envelope as an irreversible effect; the default"
    }).pipe(Schema.optionalKey, Schema.withDecodingDefaultKey(Effect.succeed("unhermetic" as const))),
    command: Command,
    script: Script,
    interpreter: Interpreter,
    args: Args,
    stdin: Stdin,
    container: ContainerName,
    cwd: Cwd,
    env: Env,
    timeoutMs: TimeoutMs
  })
])

/**
 * Decoded input accepted by the bash handler.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * Output schema for the bash flow.
 *
 * `invalidProbe` is present when the shell itself refused to start the
 * command, which its exit code says outright: 127 for a program it could not
 * find, 126 for one it could not execute. Only that. Reading a runner's own
 * wording is a judgment rather than a fact, and `Probe.classify` makes it with
 * Jev for the `test` flow, whose caller is asking about a suite; a shell call
 * is any command at all and stays free of the gateway. See `Probe`.
 *
 * The `<stream>Truncated` flags are a wire convention, not a display detail.
 * A truncated capture is a fragment of what the process printed, and the
 * harness reads these flags to refuse a later write of those exact bytes —
 * `@smthrs/harness/TruncatedOutput` is the consuming half. Renaming a flag, or
 * dropping it when the capture is cut, disarms that guard silently.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  exitCode: Schema.Number.annotate({ description: "Command exit code, including non-zero codes" }),
  stdout: Schema.String.annotate({
    description: "Captured stdout; only the tail, and not the whole output, when stdoutTruncated is true"
  }),
  stderr: Schema.String.annotate({
    description: "Captured stderr; only the tail, and not the whole output, when stderrTruncated is true"
  }),
  stdoutTruncated: Schema.Boolean.annotate({
    description:
      "Whether stdout exceeded the capture limit, leaving stdout a fragment that must not be written to a file"
  }),
  stderrTruncated: Schema.Boolean.annotate({
    description:
      "Whether stderr exceeded the capture limit, leaving stderr a fragment that must not be written to a file"
  }),
  stdoutDroppedBytes: Schema.Number.annotate({ description: "UTF-8 bytes omitted from the start of stdout" }),
  stderrDroppedBytes: Schema.Number.annotate({ description: "UTF-8 bytes omitted from the start of stderr" }),
  invalidProbe: Schema.optional(
    Probe.InvalidProbe.annotate({
      description: "Reserved for a confirmed launch failure; an exit code alone does not establish one"
    })
  ),
  mutated: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Present for a containerised command whose working directory was measured before and after it: true when the tree changed, false when it held still. Absent when the tree was not measured, which is never read as unchanged."
    })
  )
})

/**
 * Decoded output returned by the bash handler.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * Static conservative effect envelope for the bash flow.
 *
 * The declaration is the registry-time worst case because the mode is not
 * known until an invocation is decoded.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({
  tier: "irreversible",
  mode: "expected",
  reads: [],
  writes: []
})

/**
 * Narrows the effect envelope for a decoded invocation.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (input: Input) =>
  input.mode === "hermetic"
    ? envelope({
      tier: "irreversible",
      mode: "hermetic",
      reads: input.reads,
      writes: input.writes
    })
    : envelope({
      tier: "irreversible",
      mode: "expected",
      reads: [],
      writes: []
    })

/**
 * Capabilities required by the bash flow.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("proc:spawn", "*")]

/**
 * Declaration-only bash flow.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = { name, description, input: Input, output: Output, capabilities, effects } as const

/*
 * `bash` declares no activity on purpose. What a shell call does is in the
 * command, not in the declaration: the same flow runs a test suite, a type
 * check, and `cat`. A reader that recognises a direct runner says so from the
 * recorded command; everything else stays unknown, which is what an absent
 * activity means.
 */

/**
 * How one recorded call to this flow reads: the verb for each settlement, the
 * input field that is its subject, and the measured output fields a one-line
 * summary may count.
 *
 * Display metadata only, governed by `@smthrs/registry`
 * `Descriptor.CallPresentation` and checked where `StandardFlows` binds it.
 *
 * @category presentation
 * @since 1.0.0-rc.0
 */
export const presentation = {
  verb: { pending: "running", success: "ran", failure: "failed to run" },
  subject: "command",
  result: "command"
} as const

/**
 * Select standard input explicitly. Shells need `--` before script arguments
 * so even an argument such as `-c` cannot replace the stdin program.
 * Other supported interpreters treat arguments after `-` as program data.
 */
const stdinArguments = (interpreter: string): ReadonlyArray<string> | undefined => {
  switch (interpreter) {
    case "bash":
    case "zsh":
    case "sh":
    case "dash":
      return ["-s", "--"]
    case "python":
    case "python3":
    case "node":
    case "ruby":
    case "perl":
      return ["-"]
    default:
      return undefined
  }
}

/** Whether a script is shell text the lexical pre-check can actually read. */
const shells = new Set(["bash", "zsh", "sh", "dash"])

/** What one invocation runs, before any container transport rewrites it. */
interface Plan {
  readonly file: string
  readonly args: ReadonlyArray<string> | undefined
  readonly stdin: string | undefined
  readonly env: Record<string, string> | undefined
  readonly quoted: string
}

const invalid = (message: string): StdError.StdError => new StdError.StdError({ code: "invalid_input", message })

/** The invocation an input names, or the failure explaining why it names none. */
const plan = (input: Input): Plan | StdError.StdError => {
  const interpreter = input.interpreter ?? "bash"
  if (input.command !== undefined && input.script !== undefined) {
    return invalid("Give command or script, never both: a script is program text, a command is a shell line")
  }
  if (input.command === undefined && input.script === undefined) {
    return invalid("Give either command (a shell line) or script (program text run by interpreter)")
  }
  if (input.script !== undefined && input.stdin !== undefined) {
    return invalid("A script already arrives on standard input, so it cannot also carry stdin")
  }
  if (input.command !== undefined && input.args !== undefined) {
    return invalid("args belong to a script; a command carries its own arguments in the line")
  }
  if (input.command !== undefined && input.interpreter !== undefined) {
    return invalid("interpreter runs a script; a command runs in the platform shell")
  }
  if (input.mode === "hermetic" && input.container !== undefined) {
    return invalid(
      "A container has its own filesystem, so declared reads and writes cannot describe it. Use mode:unhermetic for a containerised command"
    )
  }
  if (input.mode === "hermetic" && input.script !== undefined && !shells.has(interpreter)) {
    return invalid(
      `The hermetic pre-check reads shell text, and ${interpreter} is not a shell. Run this script with mode:unhermetic, or express it as shell`
    )
  }
  if (input.command !== undefined) {
    return { file: input.command, args: undefined, stdin: input.stdin, env: input.env, quoted: input.command }
  }
  const selector = stdinArguments(interpreter)
  if (selector === undefined) {
    return invalid(`Unsupported script interpreter: ${interpreter}`)
  }
  const args = [...selector, ...(input.args ?? [])]
  return {
    file: interpreter,
    args,
    stdin: input.script,
    env: input.env,
    quoted: [interpreter, ...args].join(" ")
  }
}

/** The plan as the host will spawn it, once the container transport has had it. */
const routed = (
  plan: Plan,
  input: Input,
  transport: Option.Option<Container.Container>
): Effect.Effect<Plan, StdError.StdError> => {
  if (input.container === undefined) return Effect.succeed(plan)
  if (Option.isNone(transport)) return Effect.fail(Container.unavailable(input.container))
  return Effect.map(
    transport.value.exec(request(plan, input)),
    (routing): Plan => ({
      file: routing.file,
      args: routing.args,
      stdin: plan.stdin,
      env: routing.env,
      // Diagnostics describe the logical invocation, not transport arguments.
      quoted: plan.quoted
    })
  )
}

/**
 * One containerised request, always through a login shell.
 *
 * A container's environment is what its profile makes it. The images this
 * harness runs against activate the project's interpreter — a conda env, a
 * virtualenv, a modified `PATH` — from `/etc/profile.d`, so a program spawned
 * directly by `docker exec` gets a different Python from the one that owns the
 * repository's dependencies. That is measured, not theoretical: r90 typed
 * `docker exec … bash -lc '…'` by hand and got the activation for free, r91
 * routed `interpreter: "python3"` straight at the container and filled its
 * traces with `ModuleNotFoundError: No module named 'numpy'` and
 * `exec: "/usr/local/bin/python": no such file or directory`. Thirty of 45
 * instances then spent 138 cells scanning `/opt` for the real interpreter.
 *
 * So the login shell is the transport's, not the caller's. A command line is
 * one argument to `bash -lc`, as before. A program run under an interpreter
 * becomes `bash -lc 'exec "$@"' bash <interpreter> <args…>`: the shell reads
 * the profile, then `exec` replaces it with the interpreter, so the script
 * still arrives on the inherited standard input and no argument is ever
 * re-parsed as shell text.
 */
const request = (plan: Plan, input: Input): Container.Request => ({
  container: input.container ?? "",
  file: "bash",
  args: plan.args === undefined
    ? ["-lc", plan.file]
    : ["-lc", `exec "$@"`, "bash", plan.file, ...plan.args],
  ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  ...(input.env === undefined ? {} : { env: input.env }),
  stdin: plan.stdin !== undefined
})

/** How long one fingerprint of the container's working directory may take. */
const FINGERPRINT_TIMEOUT_MS = 60_000

/**
 * Measures the tree a containerised command is about to run in, or just ran in.
 *
 * The host's workspace walk cannot see a container's filesystem, so the
 * measurement is taken where the tree is: `TreeFingerprint.script` runs
 * through the same transport as the command, in the same working directory,
 * and answers with one checksum. Every way this can fail — no transport, a
 * container without `find` or `stat`, a timeout, a bounded listing — is read
 * as "unmeasured" and reported as an absent `mutated`, never as a tree that
 * held still. The time it costs is bounded by the command's own timeout so a
 * stalled container cannot spend more waiting to be measured than it may
 * spend running.
 */
const fingerprint = (
  input: Input,
  transport: Option.Option<Container.Container>
): Effect.Effect<TreeFingerprint.Measurement | undefined, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    if (input.container === undefined || Option.isNone(transport)) return undefined
    const routing = yield* transport.value.exec({
      container: input.container,
      file: "sh",
      args: ["-c", TreeFingerprint.script()],
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      stdin: false
    })
    const result = yield* Exec.exec(routing.file, {
      ...(routing.env === undefined ? {} : { env: routing.env }),
      timeoutMs: Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, FINGERPRINT_TIMEOUT_MS),
      maxCaptureBytes: MAX_SHELL_OUTPUT_BYTES,
      args: routing.args
    })
    return result.exitCode === 0 ? TreeFingerprint.parse(result.stdout) : undefined
  }).pipe(Effect.orElseSucceed(() => undefined))

/**
 * Executes a shell command through the permission-aware kernel service.
 *
 * Non-zero exit codes remain successful values. Only timeout, host, permission,
 * and declared-envelope pre-check failures use the typed error channel.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("Bash.run")(function*(
  input: Input
): Effect.fn.Return<Output, StdError.StdError, ChildProcessSpawner.ChildProcessSpawner | Path.Path> {
  const path = yield* Path.Path
  const intent = plan(input)
  if (intent instanceof StdError.StdError) return yield* Effect.fail(intent)
  if (input.mode === "hermetic") {
    const violation = outsideEnvelope(input, input.command ?? input.script ?? "", path)
    if (violation !== undefined) return yield* Effect.fail(violation)
  }
  // The working directory belongs to the container. The transport supplies
  // any environment overrides its host process needs to forward into it.
  const contained = input.container !== undefined
  const transport = yield* Effect.serviceOption(Container.Container)
  const spawned = yield* routed(intent, input, transport)

  // The tree the command runs in, before it runs. Measured in the container
  // because nothing on this host can see it; see `TreeFingerprint`.
  const before = yield* fingerprint(input, transport)
  const result = yield* Exec.exec(spawned.file, {
    ...(input.cwd === undefined || contained ? {} : { cwd: input.cwd }),
    ...(spawned.env === undefined ? {} : { env: spawned.env }),
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxCaptureBytes: MAX_SHELL_OUTPUT_BYTES,
    ...(spawned.args === undefined ? {} : { args: spawned.args }),
    ...(spawned.stdin === undefined ? {} : { stdin: spawned.stdin })
  }).pipe(Effect.mapError((error) => Exec.toStdError(spawned.quoted, error)))
  const mutated = TreeFingerprint.moved(before, yield* fingerprint(input, transport))
  // A command on this host may have changed files a language server holds
  // open; a container's files are not the ones it was sent.
  if (!contained) yield* Diagnostics.refresh
  const stdout = truncateBytes(result.stdout, MAX_SHELL_OUTPUT_BYTES, { keep: "tail" })
  const stderr = truncateBytes(result.stderr, MAX_SHELL_OUTPUT_BYTES, { keep: "tail" })
  // Exit codes alone cannot establish whether the shell refused to launch a
  // command or a launched runner chose that status after executing tests.
  return {
    exitCode: result.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: result.stdoutDroppedBytes > 0 || stdout.truncated,
    stderrTruncated: result.stderrDroppedBytes > 0 || stderr.truncated,
    stdoutDroppedBytes: result.stdoutDroppedBytes + stdout.droppedBytes,
    stderrDroppedBytes: result.stderrDroppedBytes + stderr.droppedBytes,
    ...(mutated === undefined ? {} : { mutated })
  }
})

/**
 * The refusal a sealed host answers a call outside its container with.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export const outsideContainer = (sealedTo: string, requested: string | undefined): StdError.StdError =>
  new StdError.StdError({
    code: "outside_container",
    message: requested === undefined
      ? `This host runs commands only inside container "${sealedTo}". Name it: { mode: "unhermetic", container: "${sealedTo}", command: "..." }.`
      : `This host runs commands only inside container "${sealedTo}", not "${requested}".`
  })

/**
 * {@link run}, sealed to one container.
 *
 * A host that must not be reachable from the cell (a benchmark host holding
 * other tasks' tests and reference solutions, say) binds this instead of
 * {@link run}: a call naming `sealedTo` runs as usual, and every other call,
 * including one with no container that would run on the host, fails with
 * `outside_container` before anything is spawned.
 *
 * @category handlers
 * @since 1.0.0-rc.1
 */
export const sealed = (sealedTo: string) =>
(
  input: Input
): Effect.Effect<Output, StdError.StdError, ChildProcessSpawner.ChildProcessSpawner | Path.Path> =>
  input.container === sealedTo ? run(input) : Effect.fail(outsideContainer(sealedTo, input.container))
