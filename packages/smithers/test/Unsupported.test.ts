/**
 * Every removed verb and flag of the release policy, driven through the
 * real parser.
 *
 * The complete sets live here rather than in `Bin.test.ts` because the fact
 * being pinned — this invocation fails with `UnsupportedError`, whose exit
 * status is 1 and whose message names the replacement — is decided before any
 * process boundary. `Bin.test.ts` proves the boundary carries it.
 */
import { NodeServices } from "@effect/platform-node"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Cause, Effect, Exit, Layer } from "effect"
import { TestConsole } from "effect/testing"
import { Command } from "effect/unstable/cli"
import { describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import { cli } from "../src/Command.ts"
import * as Environment from "../src/Environment.ts"
import * as Output from "../src/Output.ts"
import * as Unsupported from "../src/Unsupported.ts"
import { packageVersion } from "../src/Version.ts"
import { invokeCanonical } from "./fixtures/invokeCanonical.ts"

const runCommand = Command.runWith(cli, { version: packageVersion })

const services = Layer.mergeAll(TestConsole.layer, Output.layer, TestControl.layer({ now: () => 0 }))

/** The failure one invocation produced, or `undefined` when it succeeded. */
const failure = async (args: ReadonlyArray<string>): Promise<unknown> => {
  if (args.includes("init")) {
    const result = await invokeCanonical([...args, "--json"])
    return JSON.parse(result.stdout) as unknown
  }
  const exit = await Effect.runPromise(
    Effect.exit(runCommand(args)).pipe(
      Effect.provide(services),
      Effect.provide(NodeServices.layer)
    )
  )
  return Exit.isSuccess(exit) ? undefined : Cause.squash(exit.cause)
}

/** The two removed entries whose bare form is a live alias, not a refusal. */
const ownGroups = new Set(["gateway", "workflow"])

describe("every removed verb", () => {
  it.each(Unsupported.removedVerbs.map((verb) => [verb.name, verb] as const))(
    "`smithers %s` fails with the migration message and exit status 1",
    async (name, verb) => {
      // Two removed entries have a bare form that still does something:
      // `gateway` is the `serve` alias and `workflow list` is the `ls` alias.
      // Both are driven through a removed subcommand instead, which is the
      // only form the removed-command contract removed.
      const error = await failure(
        verb.subcommands === undefined || !ownGroups.has(name) ? [name] : [name, verb.subcommands[0]!]
      )

      expect(error).toBeInstanceOf(CliError.UnsupportedError)
      const message = (error as CliError.UnsupportedError).message
      expect(message).toContain("was removed in 1.0.0-rc.0")
      expect(message).toContain(verb.reason)
      expect(message).toContain(`${Unsupported.migrationUrl}#${verb.name}`)
      expect(CliError.exitCode(error as CliError.UnsupportedError)).toBe(1)
    }
  )

  it("carries the sub-verb into the message of a removed group", async () => {
    for (const [group, sub] of [["agents", "add"], ["cron", "list"], ["human", "resolve"], ["packs", "update"]]) {
      const error = await failure([group!, sub!])

      expect((error as CliError.UnsupportedError).message).toContain(`smthrs ${group} ${sub} was removed`)
    }
  })
})

describe("the refusal `cli/LegacyBin.ts` answers before the control plane boots", () => {
  /**
   * Every form the removed-command contract removes, spelled the way an operator types it:
   * the bare verbs, and the removed subcommands of the two parents that live.
   */
  const forms = Unsupported.removedVerbs.flatMap((verb) =>
    verb.subcommands === undefined || !ownGroups.has(verb.name)
      ? [[verb.name]]
      : verb.subcommands.map((subcommand) => [verb.name, subcommand])
  )

  it.each(forms.map((args) => [args.join(" "), args] as const))(
    "`smithers %s` gets the same sentence before boot as the command tree gives after it",
    async (_label, args) => {
      // The short-circuit exists so a refusal never opens a database. It earns
      // that only while it says exactly what the parser says: two tables that
      // drift are worse than one slow table.
      const early = Unsupported.refusal(args)
      const parsed = await failure(args)

      expect(early).toBeInstanceOf(CliError.UnsupportedError)
      expect(early!.message).toBe((parsed as CliError.UnsupportedError).message)
      expect(CliError.exitCode(early!)).toBe(1)
    }
  )

  it("carries the sub-verb of a removed group, as the command tree does", () => {
    expect(Unsupported.refusal(["agents", "add"])!.message).toContain("smthrs agents add was removed")
    expect(Unsupported.refusal(["worktrees", "prune", "extra"])!.message).toContain("smthrs worktrees prune was")
    // A verb with no subcommands names itself whatever follows it, because
    // `Command.ts` reads the group's sub-verb and ignores a plain argument.
    expect(Unsupported.refusal(["rewind", "run-1"])!.message).toContain("smthrs rewind was removed")
  })

  it("leaves every surviving invocation to the command tree", () => {
    // `gateway` is `serve` and `workflow list` is `ls`; a short-circuit that
    // swallowed either would turn a working command into a refusal.
    for (const args of [[], ["ls"], ["gateway"], ["gateway", "serve"], ["workflow", "list"], ["--version"]]) {
      expect(Unsupported.refusal(args)).toBeUndefined()
    }
  })

  it("declines to read any vector carrying a flag, and refuses nothing", () => {
    // A flag can take a value and a value can be spelled like a verb, so a
    // vector with a flag in it is handed to the parser, which knows which is
    // which. These still refuse; they refuse one layer later.
    for (const args of [["--backend", "pglite", "ui"], ["ui", "--json"], ["worktrees", "--json", "prune"]]) {
      expect(Unsupported.refusal(args)).toBeUndefined()
    }
  })

  it.each([
    ["init", "change", "--global"],
    ["init", "--global"],
    ["init", "change", "--root", "/tmp/project", "--global"],
    ["--root=/tmp/project", "init", "change", "--global=true"],
    ["--audience", "human", "init", "change", "--global", "--json"]
  ])("refuses the removed initializer before boot: %j", async (...args) => {
    const early = Unsupported.refusal(args)
    const parsed = await failure(args)
    expect(early).toBeInstanceOf(CliError.UnsupportedError)
    expect(early!.message).toBe((parsed as CliError.UnsupportedError).message)
  })

  it("leaves ambiguous or malformed initializer arguments to the parser", () => {
    for (
      const args of [
        ["init", "change"],
        ["init", "--global", "false"],
        ["init", "--global=false"],
        ["init", "--global", "--no-global"],
        ["init", "--", "--global"],
        ["init", "change", "--root", "--global"],
        ["init", "change", "--root=--global"],
        ["--audience", "invalid", "init", "--global"],
        ["--global", "init"],
        ["init", "change", "--global", "--help"],
        ["init", "change", "--global", "--global"],
        ["init", "one", "two", "--global"],
        ["init", "--unknown", "--global"]
      ]
    ) expect(Unsupported.refusal(args)).toBeUndefined()
  })
})

describe("every removed flag", () => {
  it("renders a removed root flag without an empty command segment", () => {
    expect(Unsupported.flagMessage({ parent: "", flag: "legacy", reason: "gone", anchor: "legacy" }))
      .toContain("smthrs --legacy was removed")
  })

  /** How each removed flag is spelled on its surviving parent command. */
  const invocation = (flag: Unsupported.RemovedFlag): ReadonlyArray<string> => {
    if (flag.parent === "") return ["--backend", "mysql", "ls"]
    if (flag.parent === "steer") return ["steer", "run-1", "--message", "hello", "--takeover"]
    if (flag.parent === "migrate") return ["migrate", "--to", "postgres"]
    if (flag.parent === "init") return ["init", "example", "--global"]
    if (flag.flag === "max-concurrency") return ["up", "system/test", "--max-concurrency", "4"]
    return ["up", "system/test", `--${flag.flag}`]
  }

  it.each(Unsupported.removedFlags.map((flag) => [`${flag.parent} --${flag.flag}`.trim(), flag] as const))(
    "`%s` fails with the migration message and exit status 1",
    async (_label, flag) => {
      const error = await failure(invocation(flag))

      if (flag.parent === "init") expect(error).toMatchObject({ code: "UnsupportedError" })
      else expect(error).toBeInstanceOf(CliError.UnsupportedError)
      const message = (error as CliError.UnsupportedError).message
      // `--backend` is the one entry whose refusal is the database contract's
      // own error code rather than the removal sentence, because
      // `--backend sqlite` is accepted (the release policy).
      expect(message).toContain(flag.flag === "backend" ? "unsupported_database" : "was removed in 1.0.0-rc.0")
      expect(message).toContain(`${Unsupported.migrationUrl}#${flag.anchor}`)
      expect(CliError.exitCode(error as CliError.UnsupportedError)).toBe(1)
    }
  )

  it("declares every removed flag on a command that ships, so none is a usage error", () => {
    const shipped = new Set(["", "up", "steer", "migrate", "init"])
    for (const flag of Unsupported.removedFlags) expect(shipped.has(flag.parent)).toBe(true)
  })

  it("refuses to look up a flag the contract does not list", () => {
    expect(() => Unsupported.findFlag("up", "invented")).toThrow(/No removed flag/)
  })
})

describe("the SQLite-only backend flag", () => {
  it("accepts `--backend sqlite` as a no-op", async () => {
    expect(await failure(["--backend", "sqlite", "ls"])).toBeUndefined()
  })

  it("refuses every other backend with unsupported_database", async () => {
    for (const backend of ["pglite", "mysql"]) {
      const error = await failure(["--backend", backend, "ls"])

      // the release policy prints one exact sentence for every rejected
      // value, so the message names the fix rather than echoing the value.
      expect((error as CliError.UnsupportedError).message).toBe(Environment.unsupportedBackend(backend))
    }
  })
})
