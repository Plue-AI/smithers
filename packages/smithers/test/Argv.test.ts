import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { TestConsole } from "effect/testing"
import { Command } from "effect/unstable/cli"
import { describe, expect, it } from "vitest"
import * as Argv from "../src/cli/Argv.ts"
import { agentArguments, legacyArguments } from "../src/cli/Compatibility.ts"
import { connectionOptions } from "../src/cli/ControlBridge.ts"
import { cli } from "../src/Command.ts"
import { executionRunId } from "../src/history/ExecutionTarget.ts"

/** Every shared flag the root command advertises, with a sample spelling. */
const declaredGlobals = async (): Promise<Array<{ readonly flag: string; readonly words: Array<string> }>> => {
  const lines = await Effect.runPromise(
    Effect.gen(function*() {
      yield* Command.runWith(cli, { version: "test" })(["--help"]).pipe(Effect.ignore)
      return yield* TestConsole.logLines
    }).pipe(Effect.provide(TestConsole.layer), Effect.provide(NodeServices.layer)) as Effect.Effect<
      ReadonlyArray<unknown>
    >
  )
  const declared: Array<{ flag: string; words: Array<string> }> = []
  for (const line of lines.map(String).join("\n").split("\n")) {
    // The shared flags print as `--name [string|choice]  description`; the
    // parser's own built-ins (`--help, -h`, `--wizard`, ...) follow them.
    if (/^\s+--help\b/.test(line)) break
    const match = /^\s+(--[a-z-]+)( (?:string|choice))?\s{2,}/.exec(line)
    if (match === null) continue
    const valued = match[2] !== undefined
    const value = match[1] === "--audience" ? "human" : match[1] === "--remote" ? "https://plane.invalid" : "value"
    declared.push({ flag: match[1]!, words: valued ? [match[1]!, value] : [match[1]!] })
  }
  return declared
}

describe("the shared globals", () => {
  it("are every flag the root command declares, and each one is claimed wherever it appears", async () => {
    const declared = await declaredGlobals()
    // The root command carries the whole shared table; a scanner that misses
    // one of these is how `resume <fork> --silent` lost its worktree.
    expect(declared.map((entry) => entry.flag).sort()).toEqual(
      ["--audience", "--json", "--mcp-config", "--quiet", "--remote", "--root", "--silent", "--verbose"]
    )
    for (const { flag, words } of [...declared, { flag: "--backend", words: ["--backend", "sqlite"] }]) {
      const inline = words.length === 2 ? [`${words[0]}=${words[1]}`] : words
      for (const spelling of [words, inline]) {
        for (const argv of [["resume", "fork-run", ...spelling], [...spelling, "resume", "fork-run"]]) {
          expect(Argv.parse(argv).rest, `${flag}: ${argv.join(" ")}`).toEqual(["resume", "fork-run"])
          expect(executionRunId(argv), `${flag}: ${argv.join(" ")}`).toBe("fork-run")
          expect(legacyArguments(argv), `${flag}: ${argv.join(" ")}`).toEqual(argv)
        }
      }
    }
  })

  it("covers the bridge connection schema and reuses an already parsed vector", () => {
    const parsed = Argv.parse([
      "--root",
      "/project",
      "--remote",
      "https://plane.test",
      "--mcp-config",
      "servers.json",
      "--quiet",
      "resume",
      "fork-run"
    ])
    for (const key of Object.keys(connectionOptions.shape)) {
      expect(parsed, key).toHaveProperty(key)
    }
    expect(connectionOptions.parse(parsed)).toEqual({
      root: "/project",
      remote: "https://plane.test",
      mcpConfig: "servers.json",
      quiet: true
    })
    expect(Argv.parse(parsed)).toBe(parsed)
    expect(legacyArguments(parsed)).toEqual(parsed.argv)
    expect(executionRunId(parsed)).toBe("fork-run")
  })

  it("keeps option values opaque even when they look like global flags", () => {
    expect(Argv.parse(["steer", "fork-run", "--message", "--silent"])).toMatchObject({
      silent: false,
      rest: ["steer", "fork-run", "--message", "--silent"]
    })
    expect(executionRunId(["steer", "fork-run", "--message", "--silent"])).toBe("fork-run")
    expect(Argv.parse(["--quiet", "toString", "resume", "fork-run"]).rest)
      .toEqual(["toString", "resume", "fork-run"])
  })

  it("keeps the first value, an inline empty value, and leaves a trailing valued flag unclaimed", () => {
    expect(Argv.parse(["--remote", "https://first.test", "--remote", "https://second.test"]).remote)
      .toBe("https://first.test")
    expect(Argv.parse(["--remote="]).remote).toBe("")
    expect(Argv.parse(["--remote", "--credential", "secret"])).toMatchObject({
      remote: "--credential",
      rest: ["secret"]
    })
    expect(Argv.parse(["resume", "--root"])).toMatchObject({ root: undefined, rest: ["resume", "--root"], first: 0 })
  })

  it("reads switches the way the command tree does: bare, inline, a following literal, or negated", () => {
    expect(Argv.parse(["--json"])).toMatchObject({ json: true, rest: [] })
    expect(Argv.parse(["--json=false", "ps"])).toMatchObject({ json: false, rest: ["ps"], first: 1 })
    expect(Argv.parse(["ps", "--silent", "no"])).toMatchObject({ silent: false, rest: ["ps"], first: 0 })
    expect(Argv.parse(["--no-verbose", "ps"])).toMatchObject({ verbose: false, rest: ["ps"] })
    expect(Argv.parse(["--quiet", "ps"])).toMatchObject({ quiet: true, rest: ["ps"], first: 1 })
    // A value the parser would reject is not a value this table guesses at.
    expect(Argv.parse(["--json=maybe", "ps"]).rest).toEqual(["--json=maybe", "ps"])
    expect(Argv.parse(["--no-json=true", "ps"]).rest).toEqual(["--no-json=true", "ps"])
  })

  it("never reads past `--` and leaves every other word in place", () => {
    expect(Argv.parse(["steer", "run-1", "--message", "go", "--", "--json", "--root", "x"])).toMatchObject({
      json: false,
      root: undefined,
      rest: ["steer", "run-1", "--message", "go", "--", "--json", "--root", "x"],
      first: 0
    })
    expect(Argv.parse([])).toMatchObject({ rest: [], first: 0 })
  })

  it("offers the verb lookup the words a command line leads with", () => {
    expect(Argv.words(["ls"])).toEqual(["ls"])
    expect(Argv.words(["--root", "/p", "--json", "ps"])).toEqual(["ps"])
    expect(Argv.words(["--audience", "human", "resume", "fork-run"])).toEqual(["resume", "fork-run"])
    expect(Argv.words(["workflow", "list"])).toEqual(["workflow", "list"])
    // A valued option this pre-parser knows takes its value with it, so a
    // message spelled like a verb is not one.
    expect(Argv.words(["steer", "run-1", "--message", "up"])).toEqual(["steer", "run-1"])
    expect(Argv.words(["--ui", "plain", "ls"])).toEqual(["ls"])
    // An unknown option is a switch, because guessing an arity would swallow
    // the verb standing behind it.
    expect(Argv.words(["--detached", "up", "demo"])).toEqual(["up", "demo"])
    expect(Argv.words(["--port=4096", "serve"])).toEqual(["serve"])
    expect(Argv.words(["up", "demo", "--", "--json"])).toEqual(["up", "demo"])
    expect(Argv.words([])).toEqual([])
  })

  it("routes the agent aliases through the same table", () => {
    expect(agentArguments(["--silent", "resume", "fork-run"])).toEqual(["runs", "resume", "--silent", "fork-run"])
    expect(agentArguments(["resume", "--verbose", "fork-run"])).toEqual(["runs", "resume", "--verbose", "fork-run"])
    expect(agentArguments(["resume", "fork-run", "--json=true"])).toBeUndefined()
  })
})
