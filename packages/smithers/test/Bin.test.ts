/**
 * The `smithers` executable, driven as an operator drives it.
 *
 * Everything here is a real process: the help surface, the exit-code contract,
 * the `--json` stdout contract, and every removed verb and flag from
 * The release policy. Those refusals only mean anything at the process
 * boundary. The promise is "exit 1 with a migration message", not "the
 * handler returns a typed error", so they are asserted there.
 */
import { spawn, spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as CodexAuth from "../src/CodexAuth.ts"
import { cli } from "../src/Command.ts"
import * as Environment from "../src/Environment.ts"
import { Version } from "../src/index.ts"
import * as Providers from "../src/Providers.ts"
import * as Unsupported from "../src/Unsupported.ts"
import * as Verb from "../src/Verb.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const scriptedHost = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const binDirectory = fileURLToPath(new URL("../bin", import.meta.url))
const shim = join(binDirectory, "smithers.mjs")
// Outside the repository on purpose. `Project.root` walks up for `.flows/`,
// and this checkout grows one the moment any command runs in it, so a working
// directory under `packages/` would resolve the repository as the project root
// and every case would read the repository's own run state instead of the
// empty one it staged.
const temporaryDirectoryPrefix = join(tmpdir(), "smithers-cli-bin-")

/**
 * Every case here starts at least one real `smithers`, and starting one means
 * parsing the whole module graph through Node's type stripping. That is
 * seconds on an idle machine and much longer under a loaded one, so these
 * describes carry their own budget rather than the package's 30 s default.
 * The budget stays finite: a genuine hang still fails the run.
 */
const processBudget = { timeout: 240_000 }

/**
 * Blocks this thread for a real wall-clock interval.
 *
 * A retention window is compared against the host clock inside a spawned
 * process, so a case that sweeps a run it just settled has to let the window
 * actually elapse. These cases drive `spawnSync`, so the wait is synchronous
 * too.
 */
const waitOut = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

const run = (args: ReadonlyArray<string>, environment: Readonly<Record<string, string>> = {}) => {
  const cwd = mkdtempSync(temporaryDirectoryPrefix)
  try {
    return spawnSync(process.execPath, ["--no-warnings", "--import", scriptedHost, executable, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, ...environment }
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

const runIn = (
  cwd: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> = {}
) =>
  spawnSync(process.execPath, ["--no-warnings", "--import", scriptedHost, executable, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    // `HOME` points at the same empty directory so a fallback that writes to
    // the home tree instead of the working directory is caught by the same
    // assertion.
    env: { ...process.env, HOME: cwd, ...environment }
  })

const inEmptyDirectory = <A>(use: (cwd: string) => A): A => {
  const cwd = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
  try {
    return use(cwd)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

/**
 * A real process with no judge preloaded and no gateway key.
 *
 * Every `run`/`runIn` above preloads `scripted-native-host.ts`, which binds an
 * explicit offline judge, so this whole file was blind to which verbs the
 * startup contract refuses: on the landed tree `ls`, `ps`, `status` and
 * `runs list` all exited 2 asking for a gateway key in an empty directory, and
 * nothing here could see it. These cases are deliberately the raw executable,
 * and `NODE_OPTIONS` is cleared so no ambient preload can put a judge back.
 */
const keyless = (cwd: string, args: ReadonlyArray<string>) =>
  spawnSync(process.execPath, ["--no-warnings", executable, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, HOME: cwd, NODE_OPTIONS: "", AI_GATEWAY_API_KEY: "", SMITHERS_REMOTE: "" }
  })

const refusal = "smithers run/serve needs AI_GATEWAY_API_KEY,"

describe("keyless host startup", processBudget, () => {
  it("boots the real serve entry without a gateway key", async () => {
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    const child = spawn(process.execPath, ["--no-warnings", executable, "serve", "--port", "5308"], {
      cwd,
      env: {
        HOME: cwd,
        PATH: process.env.PATH,
        CI: "1",
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
    try {
      child.stdout.resume()
      child.stderr.resume()
      let ready = false
      for (let attempt = 0; attempt < 240; attempt++) {
        if (child.exitCode !== null) throw new Error(`host exited: ${child.exitCode}`)
        try {
          ready = (await fetch("http://127.0.0.1:5308/health")).ok
        } catch { /* still starting */ }
        if (ready) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      expect(ready).toBe(true)
    } finally {
      child.kill("SIGTERM")
      await closed
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  // A host that cannot reach a completion has nothing to judge, so a verb that
  // lists, diagnoses, or reads a log works in a project that has never had a
  // gateway key. The whole read surface is here rather than one sample,
  // because the regression this replaces hit every one of them at once.
  it.each([
    [["ls", "--json"]],
    [["workflow", "list", "--json"]],
    [["ps", "--json"]],
    [["status", "--json"]],
    [["flow", "list", "--json"]],
    [["runs", "list", "--json"]],
    [["approvals", "list", "--json"]],
    [["doctor", "--json"]],
    [["gc", "--json"]],
    [["down", "--json"]],
    [["runs", "cancel-all", "--json"]]
  ])("runs %j with no gateway key at all", (args) => {
    inEmptyDirectory((cwd) => {
      const result = keyless(cwd, args)
      const output = result.stdout + result.stderr
      expect(output).not.toContain(refusal)
      expect(result.status, output).toBe(0)
      expect(() => JSON.parse(result.stdout)).not.toThrow()
    })
  })

  // The five verbs that start or resume a run, by both spellings that reach
  // them, plus the two aliases. A decision restarts the run it answers on this
  // process's own executor, which is why `approve` and `deny` are launches.
  it.each([
    [["up", "demo"]],
    [["run", "{}"]],
    [["run", "run-1", "--resume"]],
    [["resume", "run-1"]],
    [["approve", "{}"]],
    [["deny", "{}"]],
    [["flow", "start", "demo"]],
    [["flow", "execute", "{}"]],
    [["runs", "resume", "run-1"]],
    [["approvals", "approve", "{}"]],
    [["approvals", "deny", "{}"]]
  ])("validates %j without requiring a gateway key", (args) => {
    inEmptyDirectory((cwd) => {
      const result = keyless(cwd, args)
      const output = result.stdout + result.stderr
      expect(result.status, output).not.toBeNull()
      expect(output).not.toContain(refusal)
    })
  })

  it("keeps reading a project a keyless launch refused to touch", () => {
    inEmptyDirectory((cwd) => {
      expect(keyless(cwd, ["up", "demo"]).status).not.toBe(0)
      const listed = keyless(cwd, ["ls", "--json"])
      expect(listed.status, listed.stdout + listed.stderr).toBe(0)
      expect(JSON.parse(listed.stdout)).toMatchObject({ _tag: "flows", items: [] })
    })
  })
})

describe("canonical verb ownership", processBudget, () => {
  it("documents run as the default approval scope in the executable schema", () => {
    const result = run(["approvals", "approve", "--schema", "--json"])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).options.properties.scope.default).toBe("run")
  })

  it("registers the documented MCP entry using the current executable", () => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["mcp", "add", "--agent", "claude", "--json"])
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual([{
        agent: "claude",
        path: join(cwd, ".claude.json"),
        status: "written"
      }])
      expect(JSON.parse(readFileSync(join(cwd, ".claude.json"), "utf8"))).toEqual({
        mcpServers: { smithers: { command: process.execPath, args: [executable, "--mcp"] } }
      })
      expect(existsSync(join(cwd, ".flows"))).toBe(false)
      const repeated = runIn(cwd, ["mcp", "add", "--agent", "claude", "--json"])
      expect(repeated.status, repeated.stdout + repeated.stderr).toBe(0)
      expect(JSON.parse(repeated.stdout)[0].status).toBe("unchanged")
    })
  })

  it.each(
    [
      [["memory", "get"], "key"],
      [["memory", "set", "key"], "value"]
    ] as const
  )("uses canonical validation for incomplete %j", (args, field) => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, [...args, "--json"])
      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: expect.arrayContaining([expect.objectContaining({ path: field, missing: true })])
      })
      expect(readdirSync(cwd)).toEqual([])
    })
  })
})

describe("observing verbs", processBudget, () => {
  it.each(
    [
      [["runs", "list"], 0, { items: [] }],
      [["runs", "show", "absent-run"], 1, { code: "command_failed" }],
      [["runs", "logs", "absent-run"], 0, []],
      [["approvals", "list"], 0, []]
    ] as const
  )("%j creates no files in an empty project", (args, status, body) => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, [...args, "--json"], { SMITHERS_REMOTE: "" })
      expect(result.status, result.stdout + result.stderr).toBe(status)
      expect(JSON.parse(result.stdout)).toMatchObject(body)
      expect(readdirSync(cwd)).toEqual([])
    })
  })
})

describe("legacy fork routing", processBudget, () => {
  it.each([
    ["resume", "fork-run", "--silent"],
    ["--audience", "human", "resume", "fork-run"],
    ["run", "fork-run", "--resume", "--verbose"]
  ])("prepares the retained workspace with presentation flags: %j", (...args) => {
    inEmptyDirectory((cwd) => {
      mkdirSync(join(cwd, ".flows"))
      const workspace = join(cwd, "missing-fork-workspace")
      const database = new DatabaseSync(join(cwd, ".flows", "engine.db"))
      try {
        database.exec(
          "CREATE TABLE flows_migrations (migration_id INTEGER PRIMARY KEY, created_at TEXT, name TEXT NOT NULL); CREATE TABLE smthrs_history_workspaces(run_id TEXT PRIMARY KEY, workspace TEXT NOT NULL)"
        )
        database.prepare("INSERT INTO smthrs_history_workspaces VALUES (?, ?)").run("fork-run", workspace)
      } finally {
        database.close()
      }
      // Only History.prepare reports this retained-workspace error. It must
      // run after parsing and before the default executor opens its layers.
      const result = runIn(cwd, args, { SMITHERS_AUDIENCE: "human", SMITHERS_REMOTE: "" })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`Run workspace no longer exists: ${workspace}`)
      expect(existsSync(join(cwd, ".flows", "control.db"))).toBe(false)
    })
  })
})

describe("bulk cancellation", processBudget, () => {
  it.each([
    { args: ["down"] },
    { args: ["--json", "down"] },
    { args: ["--json", "--quiet", "down"] },
    { args: ["runs", "cancel-all", "--json"] }
  ])("$args cancels an older live run after 101 newer terminal records", ({ args }) => {
    inEmptyDirectory((cwd) => {
      mkdirSync(join(cwd, ".flows"))
      const environment = { SMITHERS_REMOTE: "", SMITHERS_AUDIENCE: "human" }
      const initialized = runIn(cwd, ["--json", "ps"], environment)
      expect(initialized.status, initialized.stderr).toBe(0)
      const seeded = new DatabaseSync(join(cwd, ".flows", "control.db"))
      try {
        const insert = seeded.prepare(
          "INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES (?, ?, ?, ?)"
        )
        insert.run(
          "older-live-run",
          "suspended",
          1,
          JSON.stringify({
            runId: "older-live-run",
            flowId: "demo/ship",
            status: "parked",
            createdAt: 1,
            updatedAt: 1
          })
        )
        // Control-launched runs sort before unindexed engine children,
        // even when the child is older than all the terminal history.
        const indexRun = seeded.prepare("INSERT INTO control_runs (run_id, created_seq) VALUES (?, ?)")
        for (let index = 0; index < 101; index++) {
          const runId = `terminal-${index}`
          indexRun.run(runId, index + 1)
          insert.run(
            runId,
            "completed",
            index + 2,
            JSON.stringify({
              runId,
              flowId: "demo/ship",
              status: "completed",
              createdAt: index + 2,
              updatedAt: index + 2
            })
          )
        }
      } finally {
        seeded.close()
      }
      const firstPage = JSON.parse(runIn(cwd, ["--json", "ps"], environment).stdout)
      expect(firstPage.items).toHaveLength(100)
      expect(firstPage.items.every((run: { status: string }) => run.status === "completed")).toBe(true)
      expect(firstPage.nextCursor).toBeDefined()
      const result = runIn(cwd, args, environment)
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout).cancelled).toEqual([{
        runId: "older-live-run",
        receipt: { _tag: "Terminal", status: "cancelled", runId: "older-live-run" }
      }])
      const database = new DatabaseSync(join(cwd, ".flows", "control.db"), { readOnly: true })
      try {
        expect(database.prepare("SELECT status FROM flows_runs WHERE run_id = ?").get("older-live-run"))
          .toEqual({ status: "cancelled" })
        expect(database.prepare("SELECT COUNT(*) AS count FROM flows_runs WHERE status = 'completed'").get())
          .toEqual({ count: 101 })
      } finally {
        database.close()
      }
    })
  })
})

describe("smithers executable", processBudget, () => {
  it("reports the package version", () => {
    const result = run(["--version"])

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(Version.packageVersion)
  })

  /**
   * `--version` and `--help` are documents, not work. They resolved a project
   * root, scanned its `flows/` tree, and opened both SQLite databases before
   * `effect/unstable/cli` decided the invocation only wanted a document. In
   * the release validation that cost more than ten minutes: the invocation
   * directory held no project marker, the walk climbed to `$HOME`, and
   * discovery scanned the whole home tree.
   *
   * The staged tree below is that shape in miniature: an ancestor holding
   * `.flows/` (so the walk anchors there) and a `flows/` directory with
   * enough entries that a scan is unmistakably slower than the budget.
   */
  const stageHomeProject = (entries: number): string => {
    const home = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
    mkdirSync(join(home, ".flows"), { recursive: true })
    for (let index = 0; index < entries; index++) {
      const directory = join(home, "flows", `pkg${index}`, "sub")
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, "README.md"), "x")
    }
    mkdirSync(join(home, "deep", "nested"), { recursive: true })
    return home
  }

  it("answers --version without discovery or a database, from a directory with no project marker", () => {
    const home = stageHomeProject(24)
    try {
      const result = spawnSync(process.execPath, ["--no-warnings", "--import", scriptedHost, executable, "--version"], {
        cwd: join(home, "deep", "nested"),
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, HOME: home }
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(Version.packageVersion)
      expect(existsSync(join(home, ".flows", "control.db"))).toBe(false)
      expect(existsSync(join(home, ".flows", "engine.db"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("answers --help without discovery or a database, from a directory with no project marker", () => {
    const home = stageHomeProject(24)
    try {
      const result = spawnSync(process.execPath, ["--no-warnings", "--import", scriptedHost, executable, "--help"], {
        cwd: join(home, "deep", "nested"),
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, HOME: home }
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("plan")
      expect(existsSync(join(home, ".flows", "control.db"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("exits with usage status for malformed JSON input", () => {
    const result = run(["plan", "system/test", "--data", "{"])

    expect(result.status).toBe(2)
  })

  it("reports a missing project root as a usage error", () => {
    inEmptyDirectory((cwd) => {
      const path = join(cwd, "absent")
      const result = runIn(cwd, ["--root", path, "ls"], { SMITHERS_AUDIENCE: "human" })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("--root")
      expect(result.stderr).toContain(path)
      expect(result.stderr).not.toMatch(/ENOENT|realpath|stat '/)
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it.each([
    ["memory", ["list", "get", "set", "rm"]],
    ["claude", ["tick", "node-wait", "monitor", "subscribe", "unsubscribe"]],
    ["mcp", ["add"]]
  ])("shows the available subcommands for bare %s", (verb, subcommands) => {
    const result = run([verb as string])
    expect(result.status).toBe(verb === "claude" ? 2 : 0)
    for (const subcommand of subcommands) expect(result.stdout + result.stderr).toContain(subcommand)
  })

  it("reports invalid pre-parse configuration as flag-specific usage errors", () => {
    inEmptyDirectory((cwd) => {
      const missing = join(cwd, "missing.json")
      const malformed = join(cwd, "malformed.json")
      writeFileSync(malformed, "{")

      const remoteResult = runIn(cwd, ["runs", "list", "--remote", "nota", "--json"])
      const missingResult = runIn(cwd, ["runs", "list", "--mcp-config", missing, "--json"])
      const malformedResult = runIn(cwd, ["runs", "list", "--mcp-config", malformed, "--json"])

      expect(remoteResult.status).toBe(2)
      expect(JSON.parse(remoteResult.stdout).message).toContain(
        "--remote must be an http:// or https:// URL; got \"nota\""
      )
      expect(missingResult.status).toBe(2)
      expect(JSON.parse(missingResult.stdout).message).toContain(`--mcp-config ${missing}: file not found`)
      expect(malformedResult.status).toBe(2)
      expect(JSON.parse(malformedResult.stdout).message).toContain(`--mcp-config ${malformed} is not valid JSON:`)
      for (
        const output of [
          remoteResult.stdout,
          missingResult.stdout,
          malformedResult.stdout
        ]
      ) {
        expect(output).not.toContain("TypeError")
        expect(output).not.toContain("ENOENT")
        expect(output).not.toContain("SyntaxError")
      }
    })
  })

  it("exits with usage status for a flag no command declares", () => {
    const result = run(["ls", "--filter", "review"])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain("--filter")
  })
})

describe("the help surface", processBudget, () => {
  const help = run(["--help"])

  it("lists canonical target and durable command groups", () => {
    expect(help.status).toBe(0)
    for (
      const name of [
        "build",
        "test",
        "targets",
        "flow",
        "runs",
        "approvals",
        "generate",
        "eval",
        "memory",
        "credentials",
        "triggers"
      ]
    ) {
      expect(help.stdout).toMatch(new RegExp(`^\\s+${name}\\s{2,}`, "m"))
    }
  })

  it("advertises no removed verb", () => {
    // Matched on the help layout's own leading indentation so a word that
    // merely appears inside a description is not read as a listed command.
    for (const verb of Unsupported.removedVerbs) {
      expect(help.stdout).not.toMatch(new RegExp(`^\\s+${verb.name}\\s{2,}`, "m"))
    }
  })

  it("advertises no alias, which is what keeps the list the contract's list", () => {
    for (const alias of ["resume", "inspect", "why", "events", "gateway"]) {
      expect(help.stdout).not.toMatch(new RegExp(`^\\s+${alias}\\s{2,}`, "m"))
    }
  })
})

describe("removed verbs and flags at the process boundary", processBudget, () => {
  // The complete sets are driven through the parser in `Unsupported.test.ts`;
  // one process per entry would be several minutes of spawns for the same
  // fact. These cases pin what only a real process can show: the status code
  // and the message on stderr.
  it("refuses a removed verb with exit 1 and a migration message", () => {
    const result = run(["rewind", "run-1"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smthrs rewind was removed in 1.0.0-rc.0")
    expect(result.stderr).toContain(`${Unsupported.migrationUrl}#rewind`)
  })

  it("names the sub-verb when a removed group is called with one", () => {
    const result = run(["worktrees", "prune"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smthrs worktrees prune was removed in 1.0.0-rc.0")
  })

  it("refuses a removed flag with exit 1 rather than the parser's exit 2", () => {
    // Exit 2 would mean the parser rejected an unknown flag, which carries no
    // migration message: declaring these hidden is what buys the sentence.
    const result = run(["steer", "run-1", "--message", "hello", "--takeover"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smthrs steer --takeover was removed in 1.0.0-rc.0")
  })

  it("refuses the plural `workflows`, which is the spelling the removed-command contract lists", () => {
    // The singular is a command group only so `workflow list` stays reachable.
    // `workflows` is the 0.x did-you-mean key, so it is what a migrating
    // script says, and leaving it unregistered answered with the parser's
    // usage error (exit 2) and no migration message at all.
    const result = run(["workflows"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smthrs workflows was removed in 1.0.0-rc.0")
    expect(result.stderr).toContain(`${Unsupported.migrationUrl}#workflows`)
  })

  it("answers `gateway status` and `gateway stop` with the removed-command message, not a usage error", () => {
    // The removed-command contract keeps bare `gateway` as the `serve` alias and removes the
    // two subcommands. Leaving them unregistered made the parser reject them
    // as stray positional arguments: exit 2, serve's help, and no migration
    // message, the same defect the plural `workflows` had.
    const status = run(["gateway", "status"])
    const stop = run(["gateway", "stop"])

    expect(status.status).toBe(1)
    expect(status.stderr).toContain("smthrs gateway status was removed in 1.0.0-rc.0")
    expect(status.stderr).toContain(`${Unsupported.migrationUrl}#gateway`)
    expect(stop.status).toBe(1)
    expect(stop.stderr).toContain("smthrs gateway stop was removed in 1.0.0-rc.0")
  })

  it("refuses `workflow run` under the packs reason and the singular spelling", () => {
    // The removed-command contract lists `workflow run|path|create|inspect|skills|doctor` under
    // "Packs and scaffolding". Reusing the `workflows` entry printed the
    // plural spelling and the "use `ls`" reason, which sends an operator
    // looking for a listing when what they lost was pack tooling.
    const result = run(["workflow", "path", "ship.tsx"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smthrs workflow path was removed in 1.0.0-rc.0")
    expect(result.stderr).toContain("JSX pack tooling is gone")
    expect(result.stderr).toContain(`${Unsupported.migrationUrl}#workflow`)
  })

  it("keeps `workflow list` alive as the `ls` alias while removing the rest", () => {
    const listed = run(["--json", "workflow", "list"])
    const removed = run(["workflow", "run"])

    expect(listed.status).toBe(0)
    expect(JSON.parse(listed.stdout)).toMatchObject({ _tag: "flows" })
    expect(removed.status).toBe(1)
    expect(removed.stderr).toContain("was removed in 1.0.0-rc.0")
  })
})

describe("a removed verb refuses before the control plane boots", processBudget, () => {
  /**
   * A refusal is a sentence, not work.
   *
   * Every removed verb used to run under `NodeControl.layer`, so before the
   * one documented sentence reached stderr the process created
   * `<cwd>/.flows/`, opened `engine.db`, and opened `control.db`. Two costs
   * followed. An operator who typed a 0.x verb in any directory got a project
   * state directory there as the side effect of being told the verb is gone.
   * And `scripts/docs-removals.test.mjs` spawns the 75 removed forms eight at
   * a time in one working directory, so eight processes contended on the same
   * two SQLite files and answered with `disk I/O error` or with nothing before
   * the harness's fifteen-second bound.
   *
   * The proof is the file system: run the refusal in an empty directory and
   * assert that it is still empty afterwards.
   */
  it("prints its sentence and leaves the working directory empty", () => {
    const ui = Unsupported.removedVerbs.find((verb) => verb.name === "ui")!

    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["ui"])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr.trim()).toBe(Unsupported.message("ui", ui.reason, "ui"))
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("leaves the working directory empty for a removed form of a surviving parent", () => {
    const gateway = Unsupported.removedVerbs.find((verb) => verb.name === "gateway")!

    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["gateway", "status"])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr.trim()).toBe(Unsupported.message("gateway status", gateway.reason, "gateway"))
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("refuses `--mcp` on a legacy verb and names the unified server", () => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["ls", "--json", "--mcp"], { SMITHERS_REMOTE: "" })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr.trim()).toBe("--mcp takes no command; run `smthrs --mcp`")
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("still boots the control plane for a surviving verb", () => {
    // The guard is scoped to the removal table. `ls` is a real verb, so it
    // still resolves a project and opens its databases, and a guard that
    // swallowed it would show up here rather than as a silent listing of
    // nothing.
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["--json", "ls"])

      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "flows" })
      expect(readdirSync(join(cwd, ".flows")).sort()).toContain("control.db")
    })
  })
})

describe("an invocation that never runs a command answers before the control plane boots", processBudget, () => {
  /**
   * A removed verb refused file-free, and every other non-running invocation
   * did not.
   *
   * `smthrs lss` is a typo. The parser answers it with exit 2 and a
   * did-you-mean list, and no handler ever runs, yet the process still built
   * `NodeControl.layer` on its way to the parse: it created `<cwd>/.flows/`
   * and opened `engine.db` and `control.db` before printing usage. The same
   * held for a one-token verb (`smithers "gateway status"`, the shape a shell
   * script produces when it quotes a whole command) and for an unrecognized
   * flag on a real verb (`smthrs ps --nope`).
   *
   * The rule is the same one the removed verbs got: an invocation that will
   * not run a real command touches no file. `bin.ts` now attaches the durable
   * layer to the command's handler rather than to the program, so the command
   * tree itself decides, and the layer is built only once a handler is about
   * to run.
   */
  it("answers an unknown subcommand with usage and leaves the working directory empty", () => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["lss"])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("lss")
      expect(result.stdout).toContain("COMMAND_NOT_FOUND")
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("leaves the working directory empty for a one-token command line", () => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["gateway status"])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("gateway status")
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("leaves the working directory empty for an unrecognized flag on a real verb", () => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["ps", "--nope"])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("Unrecognized flag: --nope in command smthrs ps")
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it.each(
    [
      [["plan"], "flow-id"],
      [["up"], "flow"],
      [["resume"], "run-id"],
      [["deny"], "approval"],
      [["claude", "node-wait", "run-1"], "node-id"],
      [["bug"], "summary"],
      [["approve"], "approval"],
      [["cancel"], "run-id"],
      [["signal", "run-1"], "signal-json"],
      [["steer", "--message", "continue"], "run-id"],
      [["output"], "run-id"]
    ] as const
  )("names a missing required argument for %j without opening the project", (args, argument) => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, args, { SMITHERS_AUDIENCE: "human" })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(2)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain(argument)
      expect(result.stderr).toContain("--wizard")
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("names a missing canonical target without opening the project", () => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["run", "--json"])
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("VALIDATION_ERROR")
      expect(JSON.parse(result.stdout).fieldErrors).toContainEqual(
        expect.objectContaining({ path: "patterns", missing: true })
      )
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("still builds the control plane for a real command", () => {
    // The other half of the contract. Moving the layer onto the handler must
    // not leave a shipped verb running without the services it declares, so a
    // verb that reads the durable stores is asserted to still open them.
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["--json", "ps"])

      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "runs" })
      expect(readdirSync(join(cwd, ".flows")).sort()).toContain("control.db")
    })
  })

  // This one spawns the executable once per shipped verb, so its budget is the
  // describe's 26 times over rather than one invocation's. Measured 24.7s
  // locally and 259.3s on a two-core CI runner, a ratio of 10.5 that the
  // shared 240s budget lands just under; 600s keeps the headroom real without
  // hiding a regression, since a verb that started booting the control plane
  // would still blow through it.
  it("classifies every shipped verb as a real command, not an unknown subcommand", { timeout: 600_000 }, () => {
    // The resolver is the command tree, so every name the tree declares has to
    // resolve through it. A verb that stopped resolving would reach an
    // operator as a did-you-mean list for a verb that exists. The removed
    // verbs are swept by `scripts/docs-removals.test.mjs`, which spawns all 75
    // of them; this covers the surviving half.
    const declared = cli.subcommands.flatMap((group) => group.commands.map((command) => command.name))
    const shipped = Verb.subcommands.map((verb) => verb.name)

    expect(shipped.length).toBeGreaterThan(0)
    for (const name of shipped) {
      if (["serve", "init", "suggest", "memory", "mcp"].includes(name)) expect(declared, name).not.toContain(name)
      else expect(declared, name).toContain(name)
      const result = inEmptyDirectory((cwd) => ({ ...runIn(cwd, [name, "--help"]), files: readdirSync(cwd) }))

      expect(result.stderr, name).not.toContain("Unknown subcommand")
      expect(result.status, name).toBe(0)
      expect(result.files, name).toEqual([])
    }
  })
})

describe("reserved system flow ids", processBudget, () => {
  // `SystemFlows.catalog` reserves 22 `system/*` ids so the control plane can
  // project a verb onto a flow row. None of them has a body in rc.0, so a
  // launch parks at `accepted` and never moves: the "partial appearance"
  // the release policy forbids. They are not flows an operator may name.
  it("refuses to plan a reserved system flow", () => {
    const result = run(["plan", "system/replay", "--json"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smthrs flow plan system/replay")
    expect(result.stderr).toContain("reserved system flow")
    expect(result.stdout).not.toContain("planId")
  })

  it("refuses to launch a reserved system flow instead of parking a run forever", () => {
    const result = run(["up", "system/release", "--json"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smthrs flow start system/release")
    expect(result.stdout).not.toContain("Accepted")
  })

  it("lists no reserved system flow", () => {
    const result = run(["ls", "--json"])
    const listed = JSON.parse(result.stdout) as {
      readonly items: ReadonlyArray<{ readonly flowId: string }>
    }

    expect(result.status).toBe(0)
    expect(listed.items.filter((item) => item.flowId.startsWith("system/"))).toEqual([])
  })
})

describe("the SQLite-only database contract", processBudget, () => {
  it("accepts `--backend sqlite` as a no-op and exits 0", () => {
    const result = run(["--backend", "sqlite", "--json", "ls"])

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "flows" })
  })

  it("refuses `--backend pglite` with the release policy's sentence", () => {
    const result = run(["--backend", "pglite", "ls"])

    expect(result.status).toBe(1)
    // The whole sentence, not a substring: the unsupported-name contract fixes it, and a
    // paraphrase that still contains "unsupported_database" is a contract
    // change an operator's script would not see coming.
    expect(result.stderr.trim()).toBe(Environment.unsupportedBackendMessage)
  })

  it.each([
    ["flow", "list"],
    ["flow", "show", "absent"],
    ["runs", "list"],
    ["runs", "show", "absent"],
    ["runs", "logs", "absent"],
    ["approvals", "list"]
  ])("refuses SMITHERS_BACKEND=mysql, which a script exports rather than passes (%s %s)", (...args) => {
    const result = run([...args, "--json"], { SMITHERS_BACKEND: "mysql", SMITHERS_REMOTE: "" })

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).message).toBe(Environment.unsupportedBackendMessage)
  })

  it("recognizes PostgreSQL configuration and announces only unused test configuration", () => {
    const result = run(["--json", "ls"], {
      SMITHERS_BACKEND: "sqlite",
      SMITHERS_POSTGRES_URL: "postgres://localhost/smithers",
      SMITHERS_TEST_PG_URL: "postgres://localhost/test"
    })

    // A notice, not a refusal: these names are ignored, and an
    // ignored name must not change what the command does or what it returns.
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "flows" })
    expect(result.stderr.split("\n").filter((line) => line.startsWith("ignored: "))).toEqual([
      "ignored: SMITHERS_TEST_PG_URL has no effect in 1.0.0-rc.1 (use SMITHERS_POSTGRES_URL to select PostgreSQL)"
    ])
  })

  it("refuses a 0.x database file by its contract code in structured output", () => {
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    try {
      mkdirSync(join(cwd, ".flows"))
      // One table and no `flows_migrations`: exactly the shape the guard
      // refuses, and exactly the shape a 0.x `smithers.db` has.
      const zeroX = new DatabaseSync(join(cwd, ".flows", "control.db"))
      zeroX.exec("CREATE TABLE _smithers_runs (id TEXT PRIMARY KEY)")
      zeroX.close()

      const result = spawnSync(process.execPath, [
        "--no-warnings",
        "--import",
        scriptedHost,
        executable,
        "runs",
        "list",
        "--json"
      ], {
        cwd,
        encoding: "utf8",
        timeout: 180_000,
        env: { ...process.env }
      })

      expect(result.status).toBe(1)
      const error = JSON.parse(result.stdout)
      expect(error.code).toBe("unsupported_database_file")
      expect(error.message).toContain("is not a Smithers 1.0 database")
      // The tagged-error name is how the value travelled, not what the
      // contract promises an operator or what a script greps for.
      expect(result.stdout).not.toContain("@smthrs/database/UnsupportedDatabase")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe("the served gateway", processBudget, () => {
  /** A loopback port nothing else in this suite is using. */
  const port = 34_000 + Math.floor(Math.random() * 8000)

  it.each(["serve", "gateway"])("%s answers every mount and starts the scheduler", async (verb) => {
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    const child = spawn(process.execPath, [
      "--no-warnings",
      "--import",
      scriptedHost,
      executable,
      verb,
      "--port",
      String(port)
    ], {
      cwd,
      env: { ...process.env }
    })
    const exited = new Promise((resolve) => child.once("exit", resolve))
    let banner = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      banner += chunk
    })
    try {
      const base = `http://127.0.0.1:${port}`
      const deadline = Date.now() + 120_000
      let health: Response | undefined
      for (;;) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Gateway exited before readiness: ${banner}`)
        }
        try {
          health = await fetch(`${base}/health`)
          break
        } catch (cause) {
          if (Date.now() > deadline) throw cause
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }

      // `GET /health` is the probe a supervisor uses to decide whether the
      // gateway it found belongs to this workspace, so it answers unauthenticated
      // and carries identity only.
      expect(health!.status).toBe(200)
      const identity = await health!.json() as Record<string, unknown>
      expect(typeof identity.workspaceHash).toBe("string")
      expect(identity.version).toBe(Version.packageVersion)

      const database = new DatabaseSync(join(cwd, ".flows", "control.db"), { readOnly: true })
      try {
        const heartbeat = database.prepare("SELECT ticked_at_ms FROM flows_scheduler_heartbeat")
        const deadline = Date.now() + 10_000
        while (heartbeat.get() === undefined && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        expect(heartbeat.get()).toEqual({ ticked_at_ms: expect.any(Number) })
      } finally {
        database.close()
      }

      // The three RPC mounts. A 404 here is the defect this case exists for:
      // the banner advertised routes only the control server carried.
      for (const path of ["/rpc", "/projections", "/sync"]) {
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/ndjson" },
          body: ""
        })
        expect({ path, status: response.status }).not.toEqual({ path, status: 404 })
      }

      // Every line the banner advertises is a route that answered.
      expect(banner).toContain(`${base}/health`)
      expect(banner).toContain(`${base}/sync`)
      expect(banner).toContain("/projections/ws")
    } finally {
      child.kill("SIGTERM")
      await exited
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 240_000)
})

describe("the --json stdout contract", processBudget, () => {
  it("prints exactly one JSON document on stdout and nothing else", () => {
    const result = run(["--json", "ls"])

    expect(result.status).toBe(0)
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1)
    expect(() => JSON.parse(result.stdout)).not.toThrow()
  })

  it("keeps the JSON document on stdout under --quiet", () => {
    const result = run(["--json", "--quiet", "ls"])

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "flows" })
  })
})

describe("flow start outside a repository", processBudget, () => {
  it("names the empty directory instead of silently exiting 130", () =>
    inEmptyDirectory((cwd) => {
      const result = spawnSync(process.execPath, ["--no-warnings", executable, "flow", "start", "missing"], {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, HOME: cwd, NODE_OPTIONS: "" }
      })
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
      expect(result.status).not.toBe(130)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain(cwd)
    }))
})

describe("the signal exit codes", processBudget, () => {
  const interrupted = async (signal: "SIGINT" | "SIGTERM") => {
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    try {
      const child = spawn(
        process.execPath,
        ["--no-warnings", "--import", scriptedHost, executable, "logs", "--follow"],
        {
          cwd,
          stdio: ["ignore", "pipe", "pipe"]
        }
      )
      const exited = new Promise<{ readonly status: number | null; readonly signal: string | null }>((resolve) => {
        child.on("exit", (status, killedBy) => resolve({ status, signal: killedBy }))
      })
      // The signal has to land after the handler is installed and the engine
      // has opened its database. A fixed sleep is a race: on a loaded machine
      // the module graph alone can take seconds to parse, and the process then
      // dies from the default action instead of running its teardown. The
      // control database appearing is the readiness proof.
      const database = join(cwd, ".flows", "control.db")
      const deadline = Date.now() + 120_000
      while (!existsSync(database) && Date.now() < deadline) await new Promise((wake) => setTimeout(wake, 25))
      expect(existsSync(database)).toBe(true)
      child.kill(signal)
      return await exited
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  it("exits 130 on SIGINT", async () => {
    expect(await interrupted("SIGINT")).toEqual({ status: 130, signal: null })
  }, 240_000)

  it("exits 143 on SIGTERM", async () => {
    expect(await interrupted("SIGTERM")).toEqual({ status: 143, signal: null })
  }, 240_000)
})

describe("the smithers bin shim", processBudget, () => {
  it("declares smthrs and its smithers alias on one shim, and ships it in the tarball", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      readonly bin?: Record<string, string>
      readonly files?: ReadonlyArray<string>
    }

    // The imported `flows` bin is gone. `smthrs` is the primary spelling and
    // `smithers` stays as an alias; both names run the same shim.
    expect(manifest.bin).toEqual({ smithers: "./bin/smithers.mjs", smthrs: "./bin/smithers.mjs" })
    expect(manifest.files).toContain("bin/**/*.mjs")
  })

  it("runs the built entry when dist is present, and leaves src alone", () => {
    // The packaged install: a tarball ships `dist/esm/bin.js` beside `src`,
    // and the shim must run the build. Staging the build here rather than
    // gating on `existsSync(dist)` is the point. `dist` is gitignored, so the
    // gated form skipped in every fresh clone and in this worktree, which is
    // no pin at all. The marker proves which entry ran, where asserting
    // `--version` could not: both entries print the same version.
    const root = mkdtempSync(temporaryDirectoryPrefix)
    try {
      cpSync(binDirectory, join(root, "bin"), { recursive: true })
      symlinkSync(join(packageRoot, "src"), join(root, "src"), "dir")
      mkdirSync(join(root, "dist", "esm"), { recursive: true })
      writeFileSync(join(root, "dist", "esm", "bin.js"), "process.stdout.write(\"built entry ran\\n\")\n")

      const result = spawnSync(process.execPath, [join(root, "bin", "smithers.mjs"), "--version"], {
        cwd: root,
        encoding: "utf8",
        timeout: 180_000
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("built entry ran")
      // `src/bin.ts` is right there and must not have run: an installed CLI
      // that type-stripped its own sources would be running unbuilt code.
      expect(result.stdout).not.toContain(Version.packageVersion)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("runs the working-tree source when dist is absent", () => {
    // The development path `scripts/check-local-smithers.mjs` requires: a fresh
    // checkout has no `dist`, and `pnpm exec smithers` must still run the code
    // under edit rather than a published build. The shim is copied into a
    // package root that has `src` and no `dist`, which is exactly that shape.
    const root = mkdtempSync(temporaryDirectoryPrefix)
    try {
      // The whole directory, not just the entry: the shim imports its
      // sibling helpers, and copying one file made this case fail the moment a
      // second one appeared.
      cpSync(binDirectory, join(root, "bin"), { recursive: true })
      symlinkSync(join(packageRoot, "src"), join(root, "src"), "dir")
      expect(existsSync(join(root, "dist"))).toBe(false)

      const result = spawnSync(process.execPath, [join(root, "bin", "smithers.mjs"), "--version"], {
        cwd: root,
        encoding: "utf8",
        timeout: 180_000
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(Version.packageVersion)
      // Type stripping is stable on Node 26, so a development invocation
      // prints no experimental warning ahead of its output.
      expect(result.stderr).not.toContain("Type Stripping")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * Stages a Smithers 0.x project whose runs are all terminal, so the 0.x-project guard
 * refusal has nothing to hold and the verb gets as far as the migration tool.
 */
const stageLegacyProject = (directory: string): string => {
  mkdirSync(join(directory, ".smithers", "workflows"), { recursive: true })
  writeFileSync(join(directory, ".smithers", "workflows", "ship.tsx"), "export default null\n")
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "legacy" }))
  const database = new DatabaseSync(join(directory, "smithers.db"))
  // The 0.x run table with the columns the migration tool's run-state scan
  // reads. A three-column stand-in made every scan report the database as one
  // it "could not open read only", which is the message for a lock and reads
  // as a defect in the project rather than in the fixture.
  database.exec(
    `CREATE TABLE _smithers_runs (
       run_id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, workflow_path TEXT, status TEXT NOT NULL,
       heartbeat_at_ms INTEGER, runtime_owner_id TEXT, parent_run_id TEXT,
       pause_requested_at_ms INTEGER, cancel_requested_at_ms INTEGER
     )`
  )
  database.exec(
    "INSERT INTO _smithers_runs (run_id, workflow_name, workflow_path, status) " +
      "VALUES ('run-old-1','ship','.smithers/workflows/ship.tsx','finished')"
  )
  database.close()
  return directory
}

/**
 * One `smithers` process, run from inside a staged project.
 *
 * `environment` overrides this process's environment for configuration cases.
 * Safety gates run before the migration asks its subscription judge.
 */
const inProject = (
  cwd: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> = {}
) =>
  spawnSync(process.execPath, ["--no-warnings", "--import", scriptedHost, executable, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, ...environment }
  })

/** Safety gates need no model credentials and must not read local subscriptions. */
const keylessMigration = { AI_GATEWAY_API_KEY: "", CODEX_HOME: "/nonexistent" }

/**
 * The release policy detection, at the process boundary.
 *
 * The rule is "0.x markers and no `.flows/` beside them", and the CLI creates
 * `<root>/.flows` as soon as it opens the control database. Sampling the
 * markers from a handler therefore looked at a directory the same invocation
 * had just written, and the notice never printed on the projects it exists
 * for. Only a real process can catch that, because in-process assertions on
 * `Project.legacyState` pass either way.
 */
describe("Smithers 0.x detection", processBudget, () => {
  const stage = (): string => {
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    mkdirSync(join(cwd, ".smithers", "workflows"), { recursive: true })
    writeFileSync(join(cwd, ".smithers", "workflows", "ship.tsx"), "export default null\n")
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "legacy" }))
    // The real 0.x table and column names, because the point of the check is
    // that it reads a database the old CLI wrote. The columns are the ones
    // `@smthrs/migrate`'s run-state scan selects, and every one of them is in
    // the original 16 that `packages/smithers/migrate/test/fixtures/persisted-db/old-schema.sql`
    // records verbatim from a live 0.x database. A narrower stand-in made the
    // scan report every project as one it could not read, which reads as a
    // defect in the project rather than in the fixture.
    const database = new DatabaseSync(join(cwd, "smithers.db"))
    database.exec(
      `CREATE TABLE _smithers_runs (
         run_id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, workflow_path TEXT, status TEXT NOT NULL,
         heartbeat_at_ms INTEGER, runtime_owner_id TEXT, parent_run_id TEXT,
         pause_requested_at_ms INTEGER, cancel_requested_at_ms INTEGER
       )`
    )
    database.exec(
      "INSERT INTO _smithers_runs (run_id, workflow_name, status) " +
        "VALUES ('run-old-1','ship','running'),('run-old-2','ship','finished')"
    )
    database.close()
    return cwd
  }

  it("prints the 0.x-project notice on a first command in a 0.x project", () => {
    const cwd = stage()
    try {
      const result = inProject(cwd, ["ls", "--json"])

      // Informational: it names the state and does not change the exit code.
      expect(result.status).toBe(0)
      expect(result.stderr).toContain("Found Smithers 0.x state at")
      expect(result.stderr).toContain("does not load, resume, or migrate 0.x run databases")
      expect(result.stderr).toContain("https://smithers.sh/migration/1.0#run-data")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("prints the notice whichever command runs first, not only `ls` and `up`", () => {
    // The 0.x-project guard says "when a command runs in a directory", and an operator
    // arriving at a 0.x project types `ps` or `status` at least as often as
    // `ls`. Wiring the notice into two handlers meant the notice depended on
    // which verb happened to be typed first, and the second command never
    // printed it because the first had written `.flows/`.
    for (const argv of [["ps", "--json"], ["status"], ["doctor", "--json"]]) {
      const cwd = stage()
      try {
        const result = inProject(cwd, argv)

        expect(result.stderr).toContain("Found Smithers 0.x state at")
        expect(result.stderr).toContain("https://smithers.sh/migration/1.0#run-data")
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    }
  })

  it("prints the notice once per invocation", () => {
    const cwd = stage()
    try {
      const result = inProject(cwd, ["ls", "--json"])
      const notices = result.stderr.split("Found Smithers 0.x state at").length - 1

      expect(notices).toBe(1)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("refuses to migrate a project that still holds non-terminal 0.x runs", () => {
    const cwd = stage()
    try {
      const result = inProject(cwd, ["migrate", "--json"])

      // The 0.x-project guard has to win over every later check: the
      // operator's next step is the 0.x CLI, not installing a flow.
      expect(result.status).toBe(1)
      const error = JSON.parse(result.stdout)
      expect(error.message).toContain("Refusing to migrate")
      expect(error.message).toContain("run-old-1 running (ship)")
      expect(error.message).not.toContain("run-old-2")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("still refuses once the project has an rc.0 state directory", () => {
    const cwd = stage()
    try {
      // The realistic order: the operator runs something in the project
      // first, which writes `.flows/`, and only then reaches for `migrate`.
      // The 0.x-project guard gates the informational notice on `.flows/` being absent;
      // it does not gate the refusal, and gating it there would retire the
      // guard for every project that ever ran an rc.0 command.
      expect(inProject(cwd, ["ls", "--json"]).status).toBe(0)
      expect(existsSync(join(cwd, ".flows"))).toBe(true)

      const result = inProject(cwd, ["migrate", "--json"])

      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout).message).toContain("Refusing to migrate")
      expect(JSON.parse(result.stdout).message).toContain("run-old-1 running (ship)")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("reaches the migration tool shipped in @smthrs/migrate, not a project-local flow file", () => {
    // A 0.x project has no `flows/` directory by definition, so demanding one
    // made the verb unreachable for every project it exists for. The flow
    // ships inside `@smthrs/migrate` (the release policy, the release scope);
    // the verb runs that, and what it answers is the migration tool's own
    // report or the migration tool's own refusal.
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    try {
      mkdirSync(join(cwd, ".smithers", "workflows"), { recursive: true })
      writeFileSync(join(cwd, ".smithers", "workflows", "ship.tsx"), "export default null\n")
      writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "legacy" }))
      const database = new DatabaseSync(join(cwd, "smithers.db"))
      database.exec(
        `CREATE TABLE _smithers_runs (
           run_id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, workflow_path TEXT, status TEXT NOT NULL,
           heartbeat_at_ms INTEGER, runtime_owner_id TEXT, parent_run_id TEXT,
           pause_requested_at_ms INTEGER, cancel_requested_at_ms INTEGER
         )`
      )
      // Terminal only: the 0.x-project guard has nothing to hold, so the verb
      // gets as far as the tool.
      database.exec("INSERT INTO _smithers_runs (run_id, workflow_name, status) VALUES ('run-old-1','ship','finished')")
      database.close()

      const result = inProject(cwd, ["migrate", "--json"])
      const output = `${result.stdout}${result.stderr}`

      expect(output).not.toContain("is not installed in this project")
      expect(output).not.toContain("Add it under flows/")
      expect(JSON.parse(result.stdout)).toMatchObject({ tool: { name: "@smthrs/migrate" }, mode: "plan" })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("keeps reporting the old database in doctor after the state directory exists", () => {
    const cwd = stage()
    try {
      expect(inProject(cwd, ["ls", "--json"]).status).toBe(0)

      const report = JSON.parse(inProject(cwd, ["doctor", "--json"]).stdout) as {
        readonly checks: ReadonlyArray<{ readonly name: string; readonly detail: string }>
      }
      const legacy = report.checks.filter((check) => check.name === "smithers 0.x")

      expect(legacy.some((check) => check.detail.includes("1 non-terminal runs"))).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("reports the 0.x paths and the runs the old database still holds", () => {
    const cwd = stage()
    try {
      const result = inProject(cwd, ["doctor", "--json"])
      const report = JSON.parse(result.stdout) as {
        readonly checks: ReadonlyArray<{ readonly name: string; readonly detail: string }>
      }
      const legacy = report.checks.filter((check) => check.name === "smithers 0.x")

      expect(legacy.map((check) => check.detail).join("\n")).toContain(".smithers")
      // `running` is non-terminal and `finished` is not, and the count is
      // what tells an operator whether the 0.x CLI still has work to finish.
      expect(legacy.some((check) => check.detail.includes("1 non-terminal runs"))).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * The `migrate` command's process-level shape.
 *
 * The verb runs the flow that ships inside `@smthrs/migrate`, which is the
 * same entry `smithers-migrate` runs. A verb that reached that entry with
 * `apply: false` hardcoded could plan and nothing else, so the transformation
 * the contract row promises was unreachable however the operator typed it.
 * Only a real process can prove the flag set, because the parser is what
 * rejects an undeclared flag.
 */
describe("the migrate verb's option surface", processBudget, () => {
  /** A 0.x project whose runs are all terminal, so the 0.x-project guard has nothing to hold. */
  const stageTerminal = (): string => stageLegacyProject(mkdtempSync(temporaryDirectoryPrefix))

  it("declares the migration tool's own flags", () => {
    const help = run(["migrate", "--help"])
    const text = `${help.stdout}${help.stderr}`

    // The set `packages/smithers/migrate/src/flow/bin.ts` declares, minus `--json`,
    // which is a shared global here.
    for (
      const flag of [
        "--scan",
        "--apply",
        "--seat",
        "--allow-unsafe",
        "--acknowledge-run-state",
        "--allow-no-vcs",
        "--keep-old-sources",
        "--unit",
        "--max-repair-rounds",
        "--report-dir",
        "--flows-dir",
        "--verify-install",
        "--verify-format",
        "--verify-typecheck",
        "--verify-test"
      ]
    ) {
      expect(text, flag).toContain(flag)
    }
  })

  it("runs the tool in scan mode when --scan is given", () => {
    const cwd = stageTerminal()
    try {
      const result = inProject(cwd, ["migrate", "--scan", "--json"])
      const output = `${result.stdout}${result.stderr}`

      expect(output).not.toContain("Unrecognized flag")
      // The tool's own heading names the mode it ran in, so this is the mode
      // reaching the flow rather than the flag being parsed and dropped.
      expect(JSON.parse(result.stdout)).toMatchObject({ mode: "scan", tool: { name: "@smthrs/migrate" } })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("reaches apply mode with --apply, where plan mode never writes", () => {
    const cwd = stageTerminal()
    try {
      const result = inProject(cwd, ["migrate", "--apply", "--json"], keylessMigration)
      const output = `${result.stdout}${result.stderr}`

      expect(output).not.toContain("Unrecognized flag")
      // Plan mode renders its own heading and exits 0; apply mode is the only
      // one the run-state gate parks. Reaching that park is the proof the mode
      // arrived, and 3 is the status `smithers-migrate` gives a park.
      expect(output).not.toContain("smthrs migrate plan:")
      expect(result.status).toBe(3)
      expect(output).toContain("--acknowledge-run-state")
      expect(JSON.parse(result.stdout).code).toBe("run-state-blocked")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("parks a keyless apply at the run-state gate", () => {
    const cwd = stageTerminal()
    try {
      const result = inProject(cwd, ["migrate", "--apply", "--json"], keylessMigration)
      const output = `${result.stdout}${result.stderr}`

      expect(result.status).toBe(3)
      expect(JSON.parse(result.stdout).code).toBe("run-state-blocked")
      expect(output).toContain("--acknowledge-run-state")
      expect(output).not.toContain("AI_GATEWAY_API_KEY")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * Which project `smthrs migrate` converts.
 *
 * The verb's default target used to be the rc.0 project root, whose walk
 * anchors on `.flows/`. A 0.x project has none, which is what makes it a 0.x
 * project, so a project without a `.git`/`.jj` marker of its own resolved to
 * whatever rc.0 project sat above it, and `--apply` rewrote the ancestor's
 * tree. Only a real process shows it: the resolution happens while the layers
 * are built, before any handler runs.
 */
describe("the migrate verb's target", processBudget, () => {
  /** An rc.0 project with a 0.x project inside it and no VCS marker between them. */
  const stageNested = (): { readonly ancestor: string; readonly project: string } => {
    const ancestor = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
    // The `.flows/` the root walk anchors on, and nothing else.
    mkdirSync(join(ancestor, ".flows"), { recursive: true })
    return { ancestor, project: stageLegacyProject(join(ancestor, "legacy-project")) }
  }

  it("converts the project the operator is standing in, not an rc.0 ancestor", () => {
    const { ancestor, project } = stageNested()
    try {
      const result = inProject(project, ["migrate", "--scan", "--json"])
      const report = JSON.parse(result.stdout) as {
        readonly root: string
        readonly units: ReadonlyArray<{ readonly id: string }>
      }

      expect(report.root).toBe(project)
      // The fixture's own units, and only those: its `package.json`, the one
      // workflow under `.smithers/workflows`, and the project itself. The scan
      // walks down, so these three appear from the ancestor too. `root` is
      // what separates the two answers, and `root` is what `--apply` writes
      // against.
      expect(report.units.map((unit) => unit.id)).toEqual(["dependencies", "workflow:ship", "project"])
    } finally {
      rmSync(ancestor, { recursive: true, force: true })
    }
  })

  it("names the tree it would rewrite when apply stops at the version-control gate", () => {
    const { ancestor, project } = stageNested()
    try {
      // The gate refuses before anything is written, and the refusal quotes the
      // directory the migration would have rewritten, so it reports the target
      // without producing one.
      const result = inProject(
        project,
        ["migrate", "--apply", "--acknowledge-run-state", "--json"],
        keylessMigration
      )

      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout).message).toContain(`"${project}" is under no version control`)
      expect(JSON.parse(result.stdout).message).not.toContain(`"${ancestor}" is under no version control`)
      // The read-only VCS preflight precedes even lock metadata creation.
      expect(existsSync(join(ancestor, ".smithers-migrate"))).toBe(false)
      expect(existsSync(join(project, ".smithers-migrate"))).toBe(false)
      expect(readFileSync(join(project, ".smithers/workflows/ship.tsx"), "utf8")).toBe("export default null\n")
      expect(readFileSync(join(project, "package.json"), "utf8")).toBe(JSON.stringify({ name: "legacy" }))
    } finally {
      rmSync(ancestor, { recursive: true, force: true })
    }
  })

  it("refuses a keyless apply without version control or rewriting either nested project", () => {
    const { ancestor, project } = stageNested()
    try {
      // Version-control safety is checked before any model is needed.
      const result = inProject(
        project,
        ["migrate", "--apply", "--acknowledge-run-state", "--json"],
        keylessMigration
      )

      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout).message).toContain(`"${project}" is under no version control`)
      expect(result.stdout).not.toContain("AI_GATEWAY_API_KEY")
      // Safety checks precede even lock metadata creation.
      expect(existsSync(join(ancestor, ".smithers-migrate"))).toBe(false)
      expect(existsSync(join(project, ".smithers-migrate"))).toBe(false)
      expect(readFileSync(join(project, ".smithers/workflows/ship.tsx"), "utf8")).toBe("export default null\n")
      expect(readFileSync(join(project, "package.json"), "utf8")).toBe(JSON.stringify({ name: "legacy" }))
    } finally {
      rmSync(ancestor, { recursive: true, force: true })
    }
  })
})

/**
 * What an attached launch reports to the shell that started it.
 *
 * An attached `up` launch reports an exit code that follows the terminal
 * status, and that promise only exists at the process
 * boundary: a script, a `pipeline-*.yml` step, or a sandbox `run-workflow.sh`
 * reads `$?`, not a receipt. The release validation measured the opposite:
 * `smthrs up ci-fast --json` returned 0 in three seconds while `smthrs ps`
 * reported `failed`.
 *
 * The run below fails for real, with no provider and no network. The flow
 * declares an `openai` seat, `SMITHERS_OPENAI_AUTH=chatgpt` routes that seat
 * to the codex CLI's credential store, and the store this project points at
 * holds a file with no token set. The seat resolves because the file exists,
 * so the launch is accepted and the driver starts. The turn then fails locally
 * reading it. That is a real `control.run.failed` settlement, written by the
 * real agent session into the project's own `.flows/control.db`.
 */
/** A project whose one flow's seat resolves and whose turns cannot. */
const stageUnservableSeat = (): string => {
  const cwd = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
  mkdirSync(join(cwd, "flows", "failing"), { recursive: true })
  writeFileSync(
    join(cwd, "flows", "failing", "flow.mdx"),
    [
      "---",
      "name: failing",
      "description: A flow whose seat resolves and whose first turn cannot.",
      "capabilities: []",
      "model: openai:gpt-5-mini",
      "---",
      "",
      "# failing",
      "",
      "Report the repository state.",
      ""
    ].join("\n")
  )
  mkdirSync(join(cwd, "codex"), { recursive: true })
  // A store the resolver accepts and the turn cannot use: `CodexAuth.locate`
  // only asks whether the file is there.
  writeFileSync(join(cwd, "codex", "auth.json"), "{}")
  return cwd
}

const launch = (cwd: string, args: ReadonlyArray<string>) =>
  spawnSync(process.execPath, ["--no-warnings", "--import", scriptedHost, executable, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    env: {
      ...process.env,
      SMITHERS_OPENAI_AUTH: "chatgpt",
      CODEX_HOME: join(cwd, "codex")
    }
  })

describe("an attached launch's exit status", processBudget, () => {
  it("exits 1 for a run that settled failed, and still prints the receipt", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json", "--verbose"])

      expect(launched.error).toBeUndefined()
      expect(launched.status).toBe(1)
      // The `--json` contract does not move: stdout is one document, the
      // launch receipt, and `runId` is the only place a caller learns the run.
      // The run's own lifecycle warnings are diagnostics and belong on stderr;
      // written to stdout they land inside the document a pipeline parses.
      expect(launched.stdout.trimEnd().split("\n")).toHaveLength(1)
      const receipt = JSON.parse(launched.stdout) as { readonly runId?: unknown }
      expect(receipt.runId).toMatch(/^run-/)
      expect(launched.stderr).toContain("An agent run failed")

      // And the status the exit code claims is the status the control plane
      // recorded, read back by a second process.
      const listed = launch(cwd, ["ps", "--json"])
      expect(listed.status).toBe(0)
      const runs = (JSON.parse(listed.stdout) as {
        readonly items: ReadonlyArray<{ readonly runId: string; readonly status: string }>
      }).items
      expect(runs.find((entry) => entry.runId === receipt.runId)?.status).toBe("failed")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  /**
   * One refusal is one operator line.
   *
   * The billing refusal in the release validation printed two WARN stacks for one
   * failure (observation N1): the run's own `An agent run failed`, and
   * `engine-store: the settlement of agent/run could not be encoded through
   * its own codec`. The second is not a second failure. It fires because the
   * `agent/run` flow declares `error: Schema.Unknown` and the body fails with
   * an `Error` instance, which is not a JSON value, so EVERY agent failure
   * degraded its durable settlement into a projection and told the operator
   * about it in a second stack trace. The cause is the same one the first line
   * already named.
   */
  it("prints one operator-facing warning for one refusal", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json", "--verbose"])

      expect(launched.error).toBeUndefined()
      expect(launched.status).toBe(1)
      const warnings = launched.stderr.split("\n").filter((line) => line.includes("WARN"))

      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("An agent run failed")
      expect(launched.stderr).not.toContain("could not be encoded through its own codec")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  /** Every run decision the engine journal holds for a run, in order. */
  const engineDecisions = (cwd: string, runId: string): ReadonlyArray<string> => {
    const handle = new DatabaseSync(join(cwd, ".flows", "engine.db"), { readOnly: true })
    try {
      return (handle.prepare(
        "SELECT payload_json FROM flows_journal_events WHERE run_id = ? " +
          "AND event_type = 'flows.engine.run-decision' ORDER BY seq"
      ).all(runId) as unknown as ReadonlyArray<{ readonly payload_json: string }>)
        .map((row) => String((JSON.parse(row.payload_json) as { decision?: unknown }).decision))
    } finally {
      handle.close()
    }
  }

  /** One run's engine row, as the next process finds it. */
  const engineRun = (cwd: string, runId: string): { status: string; finished_at_ms: number | null } | undefined => {
    const handle = new DatabaseSync(join(cwd, ".flows", "engine.db"), { readOnly: true })
    try {
      return handle.prepare(
        "SELECT status, finished_at_ms FROM flows_runs WHERE run_id = ?"
      ).get(runId) as unknown as { status: string; finished_at_ms: number | null } | undefined
    } finally {
      handle.close()
    }
  }

  /** How many turns the control journal recorded for a run. */
  const turnsOpened = (cwd: string, runId: string): number => {
    const handle = new DatabaseSync(join(cwd, ".flows", "control.db"), { readOnly: true })
    try {
      return (handle.prepare(
        "SELECT COUNT(*) AS turns FROM flows_journal_events WHERE run_id = ? " +
          "AND event_type = 'control.agent.turn-opened'"
      ).get(runId) as unknown as { readonly turns: number }).turns
    } finally {
      handle.close()
    }
  }

  /**
   * What the launching process leaves in `engine.db` when it exits.
   *
   * The control settlement and the engine's terminal write are two writes, and
   * this process returns on the first. In the release validation it then closed its
   * scope and interrupted its own executor 10 to 14 ms before the second one
   * landed, leaving the row `suspended`/`released`; every later process that
   * composed an executor claimed that row and re-drove the run. The pin is at
   * the process boundary because the promise is about what is on disk after
   * the process is gone.
   */
  it("leaves a terminal engine row behind, with no interrupt-released decision", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json"])
      expect(launched.status).toBe(1)
      const runId = (JSON.parse(launched.stdout) as { readonly runId: string }).runId

      const row = engineRun(cwd, runId)
      expect(row?.status).toBe("failed")
      expect(row?.finished_at_ms).not.toBeNull()
      expect(engineDecisions(cwd, runId)).not.toContain("interrupt-released")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("is not claimed, re-driven, or re-opened by the next process over the same project", () => {
    const cwd = stageUnservableSeat()
    try {
      const first = launch(cwd, ["up", "failing", "--json"])
      expect(first.status).toBe(1)
      const runId = (JSON.parse(first.stdout) as { readonly runId: string }).runId
      const decisions = engineDecisions(cwd, runId)
      const turns = turnsOpened(cwd, runId)

      // A second `smithers` over the same `.flows`, which composes its own
      // executor exactly as every local verb does.
      const second = launch(cwd, ["up", "failing", "--json"])
      expect(second.status).toBe(1)
      expect((JSON.parse(second.stdout) as { readonly runId: string }).runId).not.toBe(runId)

      expect(engineDecisions(cwd, runId)).toEqual(decisions)
      expect(decisions).not.toContain("stolen-and-activated")
      expect(turnsOpened(cwd, runId)).toBe(turns)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  /**
   * `run --resume` against a run that has already settled.
   *
   * `Control.resume` answers `{"_tag":"Terminal","runId":...,"status":...}`
   * and there is no settlement event left to wait for, so the verb reported
   * nothing and exited 0 for a run its own document called `failed`.
   */
  it("exits 1 from `run --resume` against a run that already settled failed", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json"])
      expect(launched.status).toBe(1)
      const runId = (JSON.parse(launched.stdout) as { readonly runId: string }).runId

      const resumed = launch(cwd, ["run", "--resume", runId, "--json"])

      expect(resumed.status).toBe(1)
      expect(JSON.parse(resumed.stdout)).toMatchObject({ _tag: "Terminal", runId, status: "failed" })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  /**
   * The `--json` stdout contract for the verb the smoke caught breaking it.
   *
   * `smthrs up hello -d --json` wrote 1773 bytes to stdout and none to
   * stderr: a runtime `WARN` block first and the receipt last, so a pipeline
   * parsing the document read a syntax error. `bin.ts` provides
   * `Logger.LogToStderr` for exactly that; this holds the detached shape to it.
   */
  it("writes one JSON document and nothing else to stdout when detached", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "-d", "--json"])

      expect(launched.status).toBe(0)
      expect(launched.stdout.trimEnd().split("\n")).toHaveLength(1)
      const receipt = JSON.parse(launched.stdout) as { readonly detached?: unknown; readonly runId?: unknown }
      expect(receipt.detached).toBe(true)
      expect(receipt.runId).toMatch(/^run-/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("exits 1 from `run` too, which is the same attached launch", () => {
    const cwd = stageUnservableSeat()
    try {
      const planned = launch(cwd, ["plan", "failing", "--json"])
      expect(planned.status).toBe(0)
      const approval = JSON.stringify(
        (JSON.parse(planned.stdout) as { readonly approval: unknown }).approval
      )
      expect(launch(cwd, ["approve", approval, "--scope", "run", "--json"]).status).toBe(0)

      const launched = launch(cwd, ["run", approval, "--json"])

      expect(launched.status).toBe(1)
      expect(launched.stdout.trimEnd().split("\n")).toHaveLength(1)
      expect((JSON.parse(launched.stdout) as { readonly runId?: unknown }).runId).toMatch(/^run-/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * The project `smthrs init` scaffolds, launched exactly as it was written.
 *
 * The release rehearsal ran the two commands the scaffold's own
 * doc comment promises: `smthrs init hello`, then `smthrs up hello` in
 * that directory. It got exit 1 with `Run run-1 was accepted but the
 * executor did not take it`, a `control.db` row still `accepted` under
 * `ownerId {pid: 0}`, an `engine.db` with no row at all, and
 * `smthrs status run-1` answering forever. Only `smthrs cancel` ended it.
 *
 * Nothing here stubs the seat: the scaffold is generated by the real binary
 * and launched by the real binary over real SQLite files.
 */
describe("the smthrs init scaffold, launched as written", processBudget, () => {
  /** The provider credentials a scaffold reads, and the refusal reads back. */
  const seatVariables = [
    ...Providers.starterSeats.map(([variable]) => variable),
    "SMITHERS_OPENAI_AUTH"
  ]

  /**
   * This process's environment with every provider credential removed.
   *
   * The maintainer's shell exports some of these, so a case that inherited the
   * environment would prove nothing on one machine and something else on the
   * next.
   */
  const withoutSeats = (): Record<string, string> => {
    const environment: Record<string, string> = {}
    for (const [name, value] of Object.entries(process.env)) {
      if (value === undefined || seatVariables.includes(name)) continue
      environment[name] = value
    }
    return environment
  }

  /** An empty repository: what an operator runs `smthrs init` in. */
  const stageEmptyProject = (): string => {
    const cwd = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
    mkdirSync(join(cwd, ".git"))
    return cwd
  }

  const smithers = (
    cwd: string,
    args: ReadonlyArray<string>,
    environment: Record<string, string>
  ) =>
    spawnSync(process.execPath, ["--no-warnings", "--import", scriptedHost, executable, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 600_000,
      env: environment
    })

  /** Every run row `engine.db` holds, which for an unlaunched run is none. */
  const engineRunIds = (cwd: string): ReadonlyArray<string> => {
    const file = join(cwd, ".flows", "engine.db")
    if (!existsSync(file)) return []
    const handle = new DatabaseSync(file, { readOnly: true })
    try {
      return (handle.prepare("SELECT run_id FROM flows_runs").all() as unknown as ReadonlyArray<
        { readonly run_id: string }
      >).map((row) => row.run_id)
    } finally {
      handle.close()
    }
  }

  it("passes doctor immediately after init with a fresh Smithers home", () => {
    const cwd = stageEmptyProject()
    const home = mkdtempSync(join(tmpdir(), "smithers-doctor-home-"))
    try {
      const environment = { ...withoutSeats(), SMITHERS_HOME: home }
      expect(smithers(cwd, ["init", "hello", "--json"], environment).status).toBe(0)
      const result = smithers(cwd, ["doctor", "--json"], environment)
      const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; level: string; detail: string }> }
      expect(report.checks.filter((check) => check.level === "fail")).toEqual([])
      expect(result.status).toBe(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("reports a missing smithers-jj-export as a failed registry check", () => {
    const cwd = stageEmptyProject()
    const home = mkdtempSync(join(tmpdir(), "smithers-doctor-home-"))
    try {
      const environment = { ...withoutSeats(), SMITHERS_HOME: home }
      expect(smithers(cwd, ["init", "hello", "--json"], environment).status).toBe(0)
      const missing = join(home, "no-such-smithers-jj-export")
      const result = smithers(cwd, ["doctor", "--json"], {
        ...environment,
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: missing
      })
      expect(result.status).toBe(1)
      const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; level: string; detail: string }> }
      const registry = report.checks.find((check) => check.name === "registry")!
      expect(registry.level).toBe("fail")
      expect(registry.detail).toContain(`SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=${missing}`)
      expect(registry.detail).toContain("cargo build --locked --release -p smithers-ffi --bin smithers-jj-export")
      // The rest of the report still runs.
      expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "node" })]))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  // A registry that cannot discover flows dies while the control host's stores
  // are still opening. The failure must reach the operator as the discovery
  // error, not as the interruption of the stores it cut short (#1924).
  it.each([["flow", "list"], ["runs", "list"]])(
    "`%s %s` names a missing smithers-jj-export",
    (...verb) => {
      const cwd = stageEmptyProject()
      const home = mkdtempSync(join(tmpdir(), "smithers-helper-home-"))
      try {
        const environment = { ...withoutSeats(), SMITHERS_HOME: home }
        expect(smithers(cwd, ["init", "hello", "--json"], environment).status).toBe(0)
        // Observing verbs open the host only over an existing store.
        mkdirSync(join(cwd, ".flows"), { recursive: true })
        new DatabaseSync(join(cwd, ".flows", "control.db")).close()
        const missing = join(home, "no-such-smithers-jj-export")
        const result = smithers(cwd, [...verb, "--format", "json"], {
          ...environment,
          SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: missing
        })
        expect(result.status).toBe(1)
        const output = result.stdout + result.stderr
        expect(output).toContain("DiscoveryError")
        expect(output).toContain(`SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=${missing}`)
        expect(output).not.toContain("All fibers interrupted")
      } finally {
        rmSync(cwd, { recursive: true, force: true })
        rmSync(home, { recursive: true, force: true })
      }
    }
  )

  it("writes a seat the host can resolve, chosen from the environment doctor reads", () => {
    const cwd = stageEmptyProject()
    try {
      const environment = { ...withoutSeats(), OPENAI_API_KEY: "sk-not-used-by-init" }

      expect(smithers(cwd, ["init", "hello", "--json"], environment).status).toBe(0)

      const flow = readFileSync(join(cwd, "flows", "hello", "flow.mdx"), "utf8")
      expect(flow).toContain("\nmodel: openai:gpt-6-sol\n")
      // The scaffold says which key chose the seat and where to see the rest,
      // as a YAML comment: the markdown body is the agent's instructions.
      expect(flow).toContain("OPENAI_API_KEY")
      expect(flow).toContain("smthrs doctor")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("refuses the launch by naming the missing key and rolls back its admission", () => {
    const cwd = stageEmptyProject()
    try {
      const environment = withoutSeats()
      const initialized = smithers(cwd, ["init", "hello", "--json"], environment)
      expect(initialized.status).toBe(0)
      expect(readFileSync(join(cwd, "flows", "hello", "flow.mdx"), "utf8"))
        .toContain("\nmodel: anthropic:claude-sonnet-4-5\n")

      const launched = smithers(cwd, ["up", "hello", "--json"], environment)

      expect(launched.status).toBe(1)
      expect(launched.stderr).toContain(
        "Set ANTHROPIC_API_KEY to run the anthropic:claude-sonnet-4-5 seat"
      )
      // The `--json` contract holds under the refusal: the refusal is a
      // diagnostic and belongs on stderr, so stdout carries no half-written
      // document for a pipeline to choke on.
      expect(launched.stdout).toBe("")

      // Admission commits before the executor is consulted (df753aff66), so
      // a refused launch keeps its run and receipt and settles the run as
      // failed: an ended row, not an ownerless one waiting to be reclaimed.
      const listed = smithers(cwd, ["ps", "--json"], environment)
      expect(listed.status).toBe(0)
      const runs = (JSON.parse(listed.stdout) as {
        readonly items: ReadonlyArray<{ readonly runId: string; readonly status: string }>
      }).items
      expect(runs).toEqual([expect.objectContaining({ flowId: "hello", status: "failed" })])
      // No engine row was ever created: the executor refused before the engine
      // was handed anything, so there is nothing for a later sweep to reclaim.
      expect(engineRunIds(cwd)).toEqual([])

      // `--older-than 0s` is refused, because "delete everything" wearing the
      // spelling of a retention policy is the flag's most destructive value.
      // A sweep therefore has to name a real window and wait it out.
      const refused = smithers(cwd, ["gc", "--older-than", "0s", "--dry-run", "--json"], environment)
      expect(refused.status).toBe(2)
      expect(JSON.parse(refused.stdout).message).toContain("--older-than must be a duration")
      waitOut(1_100)
      const swept = smithers(cwd, ["gc", "--older-than", "1s", "--dry-run", "--json"], environment)
      expect(swept.status).toBe(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("is not claimed or re-driven by a later executor boot", () => {
    const cwd = stageEmptyProject()
    try {
      const environment = withoutSeats()
      expect(smithers(cwd, ["init", "hello", "--json"], environment).status).toBe(0)
      expect(smithers(cwd, ["up", "hello", "--json"], environment).status).toBe(1)
      const initial = JSON.parse(smithers(cwd, ["ps", "--json"], environment).stdout) as {
        readonly items: ReadonlyArray<{ readonly runId: string; readonly status: string }>
      }
      // The refused launch keeps its admission as a failed run (df753aff66).
      expect(initial.items).toEqual([expect.objectContaining({ status: "failed" })])
      const refused = initial.items[0]!.runId

      // A second `smithers` over the same `.flows` composes its own executor,
      // exactly as every local verb does, and sweeps for stale rows as it
      // boots.
      const second = smithers(cwd, ["up", "hello", "--json"], environment)
      expect(second.status).toBe(1)

      expect(engineRunIds(cwd)).toEqual([])
      const runs = (JSON.parse(smithers(cwd, ["ps", "--json"], environment).stdout) as {
        readonly items: ReadonlyArray<{ readonly runId: string; readonly status: string }>
      }).items
      // The boot left the first failed run failed, and the second launch was
      // refused as its own run under a new key.
      expect(runs.map((run) => run.status)).toEqual(["failed", "failed"])
      expect(runs.filter((run) => run.runId === refused)).toEqual([expect.objectContaining({ status: "failed" })])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * The same two commands against a funded seat.
 *
 * This is the claim `smthrs init`'s own doc comment makes: "`smthrs up
 * <name>` works in the directory `init` just created". The only way to
 * hold it is to run the scaffolded prompt on a real provider. It costs a real
 * agent run of three to four minutes, so it runs only where the ChatGPT seat
 * the CLI suite already stages is actually signed in: export
 * `SMITHERS_OPENAI_AUTH=chatgpt` after `codex login` to take it.
 */
const chatgptSeat = process.env["SMITHERS_OPENAI_AUTH"] === "chatgpt" &&
  existsSync(CodexAuth.locate(process.env))

describe.skipIf(!chatgptSeat)("the smthrs init scaffold on a funded seat", { timeout: 900_000 }, () => {
  it("runs to completed, from `init` to a terminal row in both databases", () => {
    const cwd = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
    // A real repository, not a bare `.git` directory: the engine snapshots the
    // workspace through `jj`, which refuses a directory that looks like a git
    // repository and is not one.
    expect(spawnSync("git", ["init", "--quiet"], { cwd, encoding: "utf8" }).status).toBe(0)
    try {
      const environment = { ...process.env } as Record<string, string>
      const initialized = spawnSync(process.execPath, [
        "--no-warnings",
        "--import",
        scriptedHost,
        executable,
        "init",
        "hello",
        "--json"
      ], {
        cwd,
        encoding: "utf8",
        timeout: 600_000,
        env: environment
      })
      expect(initialized.status).toBe(0)
      expect((JSON.parse(initialized.stdout) as { readonly seat: string }).seat).toBe("openai:gpt-6-sol")

      const launched = spawnSync(process.execPath, [
        "--no-warnings",
        "--import",
        scriptedHost,
        executable,
        "up",
        "hello",
        "--json"
      ], {
        cwd,
        encoding: "utf8",
        timeout: 800_000,
        env: environment
      })

      expect(launched.status).toBe(0)
      const runId = (JSON.parse(launched.stdout) as { readonly runId: string }).runId
      for (const database of ["control.db", "engine.db"]) {
        const handle = new DatabaseSync(join(cwd, ".flows", database), { readOnly: true })
        try {
          const row = handle.prepare(
            "SELECT status, finished_at_ms FROM flows_runs WHERE run_id = ?"
          ).get(runId) as unknown as { status: string; finished_at_ms: number | null }
          expect(row.status, database).toBe("completed")
          expect(row.finished_at_ms, database).not.toBeNull()
        } finally {
          handle.close()
        }
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * What `smthrs signal` tells an operator when the run is parked on something
 * else.
 *
 * The release validation ran `smthrs signal run-3 '{"name":"go", ...}'` against a
 * run parked on a 150 second timer. It exited 1 with `go: ` on stderr: the
 * refusal declared a `name` field, which shadows `Error.prototype.name`, and
 * declared no message, so `bin.ts` `report` printed the operator's own word
 * followed by nothing (defect D3).
 *
 * The park is written onto the two databases rather than driven, because
 * parking a real run needs a model turn and this host has no provider. The
 * rows are the ones a timer park leaves: `suspended` with `waiting_reason`
 * `timer` and a deadline still ahead, on both the engine row and the control
 * summary.
 */
describe("smthrs signal against a run parked on something else", processBudget, () => {
  const parkOnTimer = (cwd: string, runId: string): void => {
    const wakeAtMs = Date.now() + 150_000
    const engine = new DatabaseSync(join(cwd, ".flows", "engine.db"))
    try {
      engine.prepare(
        `UPDATE flows_runs SET status = 'suspended', waiting_reason = 'timer', waiting_wake_at_ms = ?,
           finished_at_ms = NULL, owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL,
           heartbeat_at_ms = NULL, claim_host_id = NULL, claim_pid = NULL, claim_nonce = NULL,
           claimed_at_ms = NULL, state_json = json_remove(state_json, '$.result')
         WHERE run_id = ?`
      ).run(wakeAtMs, runId)
    } finally {
      engine.close()
    }
    const control = new DatabaseSync(join(cwd, ".flows", "control.db"))
    try {
      // The control run's status lives in the summary document, which is what
      // `SqlControlRuntime.getRun` parses, and the two spellings differ: the
      // column carries the run store's `suspended`, the document carries the
      // control status `parked` that store status maps to (SqlControlRuntime's
      // status table). Writing `suspended` into the document produced a
      // summary the control runtime refuses to decode.
      control.prepare(
        `UPDATE flows_runs SET status = 'suspended', waiting_reason = 'timer', waiting_wake_at_ms = ?,
           finished_at_ms = NULL, owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL,
           heartbeat_at_ms = NULL, state_json = json_set(state_json, '$.status', 'parked')
         WHERE run_id = ?`
      ).run(wakeAtMs, runId)
    } finally {
      control.close()
    }
  }

  it("names the refusal and says what is open, instead of echoing the signal's name", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json"])
      expect(launched.status).toBe(1)
      const runId = (JSON.parse(launched.stdout) as { readonly runId: string }).runId
      parkOnTimer(cwd, runId)

      const signalled = launch(cwd, ["runs", "signal", runId, JSON.stringify({ name: "go", payload: {} }), "--json"])

      expect(signalled.status).toBe(1)
      const error = JSON.parse(signalled.stdout)
      expect(error.code).toBe("NoMatchingWait")
      expect(error.message).toBe(
        `no wait point named "go" is open on run ${runId}. ` +
          `Read \`smthrs runs show ${runId}\` to see what that run is waiting for.`
      )
      expect(signalled.stderr).toBe("")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
