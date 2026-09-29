/**
 * The `smithers` entrypoint's exit-status contract, exercised in process.
 *
 * `Bin.test.ts` proves three statuses end to end through a real spawn. These
 * cases pin the whole mapping — signals, interruption, every CLI failure
 * class, and the ordinary success path — by capturing the teardown the
 * entrypoint hands to the Node runtime and running it against each exit shape.
 * The Node runtime is stubbed so importing the module does not start the CLI
 * against the test runner's own arguments.
 */
import { Cause, Effect, Exit } from "effect"
import { CliError as EffectCliError } from "effect/unstable/cli"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { packageVersion } from "../src/Version.ts"

const runMain = vi.fn()

vi.mock("@effect/platform-node", async (importOriginal) => {
  const original = await importOriginal<typeof import("@effect/platform-node")>()
  return { ...original, NodeRuntime: { ...original.NodeRuntime, runMain } }
})

type Teardown = (exit: Exit.Exit<unknown, unknown>, onExit: (code: number) => void) => void

interface Entrypoint {
  readonly main: Effect.Effect<void>
  readonly teardown: Teardown
  readonly onSigint: () => void
  readonly onSigterm: () => void
  /** The failure classes of the same module instance the entrypoint matches on. */
  readonly cliError: typeof import("../src/CliError.ts")
  /** The database refusal class of that same module instance, for the same reason. */
  readonly database: typeof import("@smthrs/database/node/NodeDatabase")
}

/** Imports a fresh copy of the entrypoint and captures what it registered. */
const load = async (): Promise<Entrypoint> => {
  const beforeSigint = process.listeners("SIGINT")
  const beforeSigterm = process.listeners("SIGTERM")
  runMain.mockClear()
  vi.resetModules()
  // The entrypoint matches its own failures with `instanceof`, so the classes
  // it is checked against must come from the same fresh module graph.
  const cliError = await import("../src/CliError.ts")
  const database = await import("@smthrs/database/node/NodeDatabase")
  // Each fresh offline host explicitly chooses its completion judge.
  const [ScriptedJudge, { platform }] = await Promise.all([
    import("@smthrs/agent/ScriptedJudge"),
    import("../src/internal/NodeControlHost.ts")
  ])
  Object.assign(platform, { evaluator: ScriptedJudge.layer })
  // These assertions exercise the Effect runtime teardown owned by the
  // transition entrypoint. The public bin now dispatches canonical commands
  // through Incur, whose lifecycle is covered by UnifiedEntry.test.ts.
  await import("../src/cli/LegacyBin.ts")
  const call = runMain.mock.calls[0]
  expect(runMain).toHaveBeenCalledTimes(1)
  if (call === undefined) throw new Error("the entrypoint did not start a Node runtime")
  const onSigint = process.listeners("SIGINT").find((listener) => !beforeSigint.includes(listener))
  const onSigterm = process.listeners("SIGTERM").find((listener) => !beforeSigterm.includes(listener))
  if (onSigint === undefined || onSigterm === undefined) {
    throw new Error("the entrypoint did not install signal handlers")
  }
  return {
    main: call[0] as Effect.Effect<void>,
    teardown: (call[1] as { readonly teardown: Teardown }).teardown,
    onSigint: onSigint as () => void,
    onSigterm: onSigterm as () => void,
    cliError,
    database
  }
}

/** The status one teardown reports for one exit. */
const status = (entrypoint: Entrypoint, exit: Exit.Exit<unknown, unknown>): number => {
  let reported: number | undefined
  entrypoint.teardown(exit, (code) => {
    reported = code
  })
  if (reported === undefined) throw new Error("teardown reported no status")
  return reported
}

const failure = (error: unknown): Exit.Exit<never, unknown> => Exit.failCause(Cause.fail(error))

let entrypoint: Entrypoint
let previousExitCode: number | string | null | undefined

// `load()` imports the entrypoint, which pulls the whole command tree through
// tsx under coverage instrumentation. On a loaded host that import alone can
// outrun the suite's 30 s hook budget, which then reports eleven skipped cases
// rather than a real failure. The budget here is for the import, not for the
// assertions.
beforeAll(async () => {
  previousExitCode = process.exitCode
  entrypoint = await load()
}, 120_000)

afterAll(() => {
  process.exitCode = previousExitCode
})

describe("smithers entrypoint", () => {
  it("starts the command tree on the Node runtime with a teardown", () => {
    expect(entrypoint.main).toBeDefined()
    expect(typeof entrypoint.teardown).toBe("function")
  })

  it("reports the accumulated process status on success", () => {
    process.exitCode = 3
    expect(status(entrypoint, Exit.succeed(undefined))).toBe(3)
  })

  it("reports zero on success when nothing set a status", () => {
    process.exitCode = undefined
    expect(status(entrypoint, Exit.succeed(undefined))).toBe(0)
  })

  it("reports an interrupt without a signal on stderr and exits 1", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect(status(entrypoint, Exit.failCause(Cause.interrupt(1)))).toBe(1)
      expect(stderr).toHaveBeenCalledWith("smthrs: startup was interrupted without a signal\n")
    } finally {
      stderr.mockRestore()
    }
  })

  it("reports success for a help request and a usage status for one with errors", () => {
    // `ShowHelp` with no errors is `--help`, which is a successful
    // invocation; with errors it is a rejected one.
    expect(status(entrypoint, failure(new EffectCliError.ShowHelp({ commandPath: ["smthrs"], errors: [] })))).toBe(0)
    expect(
      status(
        entrypoint,
        failure(
          new EffectCliError.ShowHelp({
            commandPath: ["smthrs"],
            errors: [new EffectCliError.UnrecognizedOption({ option: "--filter", suggestions: [] })]
          })
        )
      )
    ).toBe(2)
  })

  it("reports a usage status for a parse failure that never asked for help", () => {
    expect(
      status(entrypoint, failure(new EffectCliError.UnrecognizedOption({ option: "--filter", suggestions: [] })))
    ).toBe(2)
  })

  it("reports the projection's own status for each failure it owns", () => {
    expect(status(entrypoint, failure(new entrypoint.cliError.UsageError({ message: "bad" })))).toBe(2)
    expect(status(entrypoint, failure(new entrypoint.cliError.UnsupportedError({ message: "no" })))).toBe(1)
  })

  it("reports the generic failure status for anything else", () => {
    expect(status(entrypoint, failure(new Error("boom")))).toBe(1)
  })

  it("names a tagged failure by its class and a refused open by its contract code", () => {
    const written: Array<string> = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    try {
      // Every `@smthrs/control` failure carries a namespaced `_tag`, and
      // Effect makes that whole path the error's `name`. The operator wants
      // the class out of it, not the namespace it lives in.
      status(entrypoint, failure(Object.assign(new Error("no wait matched"), { _tag: "/control/NoMatchingWait" })))
      // the release policy promises a refused database open renders by its
      // stable code, which is what a script greps for. The refusal arrives as
      // a defect rather than a typed failure because `NodeDatabase.layer`
      // keeps the `never` error channel eleven packages compose against.
      status(
        entrypoint,
        failure(
          new entrypoint.database.UnsupportedDatabase({
            code: "unsupported_runtime",
            message: "the durable engine requires Node.js >=26.4.0"
          })
        )
      )
      // A thrown non-Error still owes the operator a line rather than silence.
      status(entrypoint, failure("a bare string"))
    } finally {
      stderr.mockRestore()
    }

    expect(written).toEqual([
      "NoMatchingWait: no wait matched\n",
      "unsupported_runtime: the durable engine requires Node.js >=26.4.0\n",
      "a bare string\n"
    ])
  })

  it("redacts diagnostic credential spellings from a failure sentence", () => {
    const written: Array<string> = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    try {
      status(entrypoint, failure(new Error("sshpass -p ZqSynthetic7Secret4Value9 ssh host")))
      status(entrypoint, failure("Authorization: Token ZqSynthetic7Secret4Value9"))
    } finally {
      stderr.mockRestore()
    }
    expect(written.join("")).not.toContain("ZqSynthetic7Secret4Value9")
    expect(written).toEqual(["Error: sshpass -p [REDACTED] ssh host\n", "Authorization: [REDACTED]\n"])
  })

  it.each([
    { args: ["--json", "plan"], code: 2, error: ["flow-id", "--wizard"], document: "" },
    { args: ["--json", "steer", "run-1"], code: 2, error: ["--message", "--wizard"], document: "" },
    { args: ["--json"], code: 2, error: ["subcommand", "plan, run, up"], document: "SUBCOMMANDS" }
  ])("preserves the parser output contract for $args", async ({ args, code, error, document }) => {
    const argv = process.argv
    const cwd = process.cwd()
    const project = mkdtempSync(join(tmpdir(), "flows-cli-bin-"))
    const descriptor = Object.getOwnPropertyDescriptor(process, "stdin")!
    const stdout: Array<string> = []
    const stderr: Array<string> = []
    const log = vi.spyOn(globalThis.console, "log").mockImplementation((...parts: ReadonlyArray<unknown>) => {
      stdout.push(parts.map(String).join(" "))
    })
    const diagnostic = vi.spyOn(globalThis.console, "error").mockImplementation((...parts: ReadonlyArray<unknown>) => {
      stderr.push(parts.map(String).join(" "))
    })
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk))
      return true
    })
    Object.defineProperty(process, "stdin", { configurable: true, value: new PassThrough() })
    try {
      process.chdir(project)
      process.argv = [process.execPath, "smthrs", ...args]
      const exit = await Effect.runPromiseExit(entrypoint.main)
      expect(status(entrypoint, exit)).toBe(code)
      for (const text of error) expect(stderr.join("\n")).toContain(text)
      if (document === "") {
        expect(stdout).toEqual([])
        expect(existsSync(join(project, ".flows"))).toBe(false)
        expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBeInstanceOf(
          entrypoint.cliError.UsageError
        )
      } else {
        expect(stdout.join("\n")).toContain(document)
      }
      if (error.length === 0) expect(stderr).toEqual([])
    } finally {
      Object.defineProperty(process, "stdin", descriptor)
      log.mockRestore()
      diagnostic.mockRestore()
      write.mockRestore()
      process.argv = argv
      process.chdir(cwd)
      rmSync(project, { recursive: true, force: true })
    }
  })

  it("prefers a received signal over the exit the runtime produced", async () => {
    const interrupted = await load()
    interrupted.onSigint()
    // A signal outranks a clean exit: the shell must see the run was
    // interrupted, not that it finished.
    process.exitCode = 0
    expect(status(interrupted, Exit.succeed(undefined))).toBe(130)
  })

  it("reports the termination status after SIGTERM", async () => {
    const terminated = await load()
    terminated.onSigterm()
    expect(status(terminated, Exit.succeed(undefined))).toBe(143)
  })

  it("runs the command tree against the process arguments", async () => {
    const fresh = await load()
    const argv = process.argv
    const cwd = process.cwd()
    const project = mkdtempSync(join(tmpdir(), "flows-cli-bin-"))
    const written: Array<string> = []
    const write = vi.spyOn(globalThis.console, "log").mockImplementation((...parts: ReadonlyArray<unknown>) => {
      written.push(parts.map(String).join(" "))
    })
    try {
      process.chdir(project)
      process.argv = [process.execPath, "smthrs", "--version"]
      await Effect.runPromise(fresh.main)
    } finally {
      write.mockRestore()
      process.argv = argv
      process.chdir(cwd)
      rmSync(project, { recursive: true, force: true })
    }

    // The entrypoint reads its configuration from the real process arguments
    // and runs the tree over the Node composition those arguments select.
    expect(written.join("")).toContain(packageVersion)
  }, 60_000)

  it("refuses a removed verb before it resolves a project or opens a database", async () => {
    const fresh = await load()
    const argv = process.argv
    const cwd = process.cwd()
    const project = mkdtempSync(join(tmpdir(), "flows-cli-bin-"))
    let exit: Exit.Exit<void, unknown>
    try {
      process.chdir(project)
      // No flag anywhere in the vector, which is the only way the document
      // scan runs off the end of the arguments and answers "not a document".
      process.argv = [process.execPath, "smthrs", "hijack"]
      exit = await Effect.runPromiseExit(fresh.main)
    } finally {
      process.argv = argv
      process.chdir(cwd)
    }

    // The refusal is the entrypoint's own, raised before `NodeControl.config`
    // reads anything, and the teardown maps it to exit 1.
    const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
    expect(error).toBeInstanceOf(fresh.cliError.UnsupportedError)
    expect((error as InstanceType<typeof fresh.cliError.UnsupportedError>).message)
      .toBe(
        "smthrs hijack was removed in 1.0.0-rc.0: not available; use `smthrs runs steer|signal|cancel|resume` " +
          "and `smthrs approvals approve|deny`. See https://smithers.sh/migration/1.0#hijack"
      )
    expect(status(fresh, exit)).toBe(1)

    // The point of refusing here rather than from the hidden command in the
    // tree: a removed verb leaves no `.flows/` behind in the directory an
    // operator happened to type it in.
    expect(existsSync(join(project, ".flows"))).toBe(false)
    rmSync(project, { recursive: true, force: true })
  }, 60_000)

  it("builds the durable composition inside the handler a real verb selects", async () => {
    const fresh = await load()
    const argv = process.argv
    const cwd = process.cwd()
    const home = process.env.HOME
    const project = mkdtempSync(join(tmpdir(), "flows-cli-bin-"))
    const written: Array<string> = []
    const write = vi.spyOn(globalThis.console, "log").mockImplementation((...parts: ReadonlyArray<unknown>) => {
      written.push(parts.map(String).join(" "))
    })
    try {
      // `Project.root` walks up for a `.flows/` marker, and this checkout grows
      // one, so the case has to run somewhere outside the repository with a
      // `HOME` that cannot reach it either.
      process.chdir(project)
      process.env.HOME = project
      process.argv = [process.execPath, "smthrs", "ls", "--json"]
      await Effect.runPromise(fresh.main)
    } finally {
      write.mockRestore()
      process.argv = argv
      process.chdir(cwd)
      if (home === undefined) delete process.env.HOME
      else process.env.HOME = home
    }

    // `Command.provide` puts `NodeControl.layer` inside the selected handler,
    // so a verb that really runs gets the whole durable stack: the state
    // directory exists afterwards and the document is the empty listing this
    // project honestly has. The refusal case above is the other half of the
    // same promise — that an invocation which never reaches a handler leaves
    // the directory alone.
    expect(JSON.parse(written.join(""))).toEqual({ _tag: "flows", items: [] })
    expect(existsSync(join(project, ".flows"))).toBe(true)
    rmSync(project, { recursive: true, force: true })
  }, 120_000)
})
