/**
 * The rc.0 command surface, pinned.
 *
 * The command registry is a closed list in both directions: it names every
 * verb that ships and every verb that was removed. A
 * verb that appears in neither, or in both, is a contract change, and this
 * suite is where it has to be made deliberately.
 */
import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import { cli } from "../src/Command.ts"
import * as Unsupported from "../src/Unsupported.ts"
import * as Verb from "../src/Verb.ts"

const subcommandNames = cli.subcommands.flatMap((group) => group.commands.map((command) => command.name))
const listed = cli.subcommands.flatMap((group) =>
  group.commands.filter((command) => !command.unlisted).map((command) => command.name)
)

describe("the shipped surface", () => {
  it("is exactly the release policy", () => {
    expect(Verb.shipped.map((verb) => verb.name)).toEqual([
      "plan",
      "run",
      "up",
      "approve",
      "deny",
      "cancel",
      "signal",
      "steer",
      "ls",
      "ps",
      "status",
      "logs",
      "output",
      "down",
      "serve",
      "init",
      "suggest",
      "doctor",
      "migrate",
      "gc",
      "memory",
      "claude",
      "mcp",
      "update",
      "bug",
      "completions"
    ])
  })

  it("names the five verbs that can start or resume a run", () => {
    expect(Verb.shipped.filter((verb) => verb.startsRuns).map((verb) => verb.name)).toEqual([
      "run",
      "up",
      "approve",
      "deny",
      "serve"
    ])
  })

  it("selects a verb by canonical name, by alias, and by the two-word alias", () => {
    expect(Verb.select(["ls"])?.name).toBe("ls")
    expect(Verb.select(["resume", "run-1"])?.name).toBe("run")
    expect(Verb.select(["gateway"])?.name).toBe("serve")
    expect(Verb.select(["workflow", "list"])?.name).toBe("ls")
    expect(Verb.select(["why", "run-1"])?.name).toBe("status")
    expect(Verb.select([])).toBeUndefined()
    // Only the first word, or the first two together, can name the verb, so a
    // flow or run id spelled like one cannot shadow it.
    expect(Verb.select(["up", "ls"])?.name).toBe("up")
  })

  it("reads a launch off the command line and a read off it", () => {
    for (
      const words of [["up", "demo"], ["run", "{}"], ["resume", "run-1"], ["approve", "{}"], ["deny", "{}"], [
        "serve"
      ], ["gateway"]]
    ) {
      expect(Verb.startsRuns(words), words.join(" ")).toBe(true)
    }
    for (
      const words of [
        ["ls"],
        ["workflow", "list"],
        ["ps"],
        ["status", "run-1"],
        ["logs", "run-1"],
        ["output", "run-1"],
        [
          "plan",
          "demo"
        ],
        ["cancel", "run-1"],
        ["down"],
        ["signal", "run-1", "{}"],
        ["steer", "run-1"],
        ["gc"],
        ["doctor"],
        ["memory"],
        [
          "update"
        ],
        ["bug", "text"],
        ["init"],
        ["claude"],
        ["mcp", "add"]
      ]
    ) {
      expect(Verb.startsRuns(words), words.join(" ")).toBe(false)
    }
  })

  it("treats a word it does not know as a launch, and an empty line as one", () => {
    // The unsafe direction is calling a launch a read: that host would admit a
    // run it has no judge for. Calling a read a launch only brings the
    // refusal back, which anyone running the verb sees at once.
    expect(Verb.startsRuns(["lss"])).toBe(true)
    expect(Verb.startsRuns([])).toBe(true)
  })

  it("registers every shipped verb in the compatibility or canonical tree", async () => {
    let manifest = ""
    await makeCli({ environment: {} }).serve(["--llms-full", "--format", "json"], {
      env: {},
      stdout: (text) => {
        manifest += text
      },
      exit: () => {}
    })
    const canonical = (JSON.parse(manifest).commands as Array<{ name: string }>).map((command) =>
      command.name.split(" ")[0]
    )
    // `completions` is `effect/unstable/cli`'s own `--completions <shell>`
    // global flag, not a subcommand of ours.
    expect(Verb.subcommands.map((verb) => verb.name)).toEqual(
      Verb.shipped.filter((verb) => verb.name !== "completions").map((verb) => verb.name)
    )
    for (const verb of Verb.subcommands) expect([...subcommandNames, ...canonical]).toContain(verb.name)
  })

  it("shows only retained Effect handlers in compatibility help", () => {
    // Aliases and every removed verb are registered but unlisted, so the help
    // surface is the contract's list and nothing else.
    const canonicalOnly = new Set(["serve", "init", "suggest", "memory", "mcp"])
    expect(listed.slice().sort()).toEqual(
      Verb.subcommands.map((verb) => verb.name).filter((name) => !canonicalOnly.has(name)).sort()
    )
  })

  it("keeps exactly the six surviving aliases", () => {
    expect(Verb.shipped.flatMap((verb) => verb.aliases)).toEqual([
      "resume",
      "workflow list",
      "inspect",
      "why",
      "events",
      "gateway"
    ])
  })

  it("names the reserved system flow for every verb the control catalog reserves", () => {
    expect(Verb.find("plan")?.flowId).toBe("system/plan")
    expect(Verb.find("serve")?.flowId).toBe("system/serve")
    // `gc` reserves one too: the catalog projects it as a procedure and the
    // CLI ships the handler (`Gc.sweep`), so it is a verb with a body rather
    // than the bodiless plan the release policy forbids.
    expect(Verb.find("gc")?.flowId).toBe("system/gc")
    // `memory` is a shipped verb with no reserved flow at all.
    expect(Verb.find("memory")?.flowId).toBeUndefined()
    expect(Verb.find("nonexistent")).toBeUndefined()
  })
})

describe("the removed surface", () => {
  it("is exactly the release policy", () => {
    expect(Unsupported.removedVerbs.map((verb) => verb.name)).toEqual([
      "replay",
      "rewind",
      "fork",
      "timetravel",
      "snapshots",
      "restore",
      "snapshot-hook",
      "revert",
      "retry-task",
      "tree",
      "timeline",
      "diff",
      "worktrees",
      "hijack",
      "pause",
      "gateway",
      "ui",
      "gui",
      "monitor",
      "supervise",
      "supervisor",
      "top",
      "optimize",
      "scores",
      "chat",
      "chat-create",
      "what",
      "ask",
      "agents",
      "usage",
      "claude-shell",
      "hermes",
      "listeners",
      "observability",
      "alerts",
      "herdr",
      "openapi",
      "token",
      "cron",
      "make-workflow",
      "starters",
      "share",
      "add",
      "remove",
      "eject",
      "upgrade",
      "packs",
      "workflow",
      "human",
      "ask-human",
      "node",
      "tail",
      "release",
      "list-runs",
      "list",
      "workflows",
      "stop",
      "kill",
      "start",
      "exec",
      "log",
      "help"
    ])
  })

  it("registers every removed verb, hidden, and never as a shipped one", () => {
    const shipped = new Set(Verb.shipped.map((verb) => verb.name))
    for (const verb of Unsupported.removedVerbs) {
      // Under its own spelling, with no substitution. The removed-command contract names the
      // 0.x did-you-mean key `workflows`, so that is the word an operator
      // migrating a script types, and it is the word that has to answer.
      expect(subcommandNames).toContain(verb.name)
      expect(listed).not.toContain(verb.name)
      expect(shipped.has(verb.name)).toBe(false)
    }
  })

  it("also answers the singular `workflow`, which carries `workflow list`", () => {
    // The group exists to keep the surviving `ls` alias reachable. It is
    // hidden and refuses on its own, so both spellings exit 1.
    expect(subcommandNames).toContain("workflow")
    expect(listed).not.toContain("workflow")
  })

  it("keeps `gateway` as a hidden group whose bare form is the `serve` alias", () => {
    // The removed-command contract: bare `gateway` stays an alias of `serve` and only
    // `gateway status|stop` are removed. An `alias` cannot carry
    // subcommands, so the two refusals need a group of their own.
    const gateway = Unsupported.removedVerbs.find((verb) => verb.name === "gateway")!

    expect(gateway.subcommands).toEqual(["status", "stop"])
    expect(subcommandNames).toContain("gateway")
    expect(listed).not.toContain("gateway")
    expect(Unsupported.verbError(gateway, "status").message).toContain("smthrs gateway status was removed")
    expect(Unsupported.verbError(gateway, "stop").message).toContain(`${Unsupported.migrationUrl}#gateway`)
  })

  it("gives the singular `workflow` the packs reason, not the `workflows` listing reason", () => {
    const singular = Unsupported.removedVerbs.find((verb) => verb.name === "workflow")!
    const plural = Unsupported.removedVerbs.find((verb) => verb.name === "workflows")!

    expect(singular.subcommands).toEqual(["run", "path", "create", "inspect", "skills", "doctor"])
    expect(singular.reason).toContain("JSX pack tooling is gone")
    expect(plural.reason).toBe("use `smthrs flow list`")
  })

  it("gives every removal a reason and a migration link", () => {
    for (const verb of Unsupported.removedVerbs) {
      const message = Unsupported.verbError(verb).message
      expect(message).toContain(`smthrs ${verb.name} was removed in 1.0.0-rc.0`)
      expect(message).toContain(verb.reason)
      expect(message).toContain(`${Unsupported.migrationUrl}#${verb.name}`)
    }
  })

  it("names the sub-verb in a group's message and anchors on the group", () => {
    const worktrees = Unsupported.removedVerbs.find((verb) => verb.name === "worktrees")!

    expect(worktrees.subcommands).toEqual(["list", "prune"])
    expect(Unsupported.verbError(worktrees, "prune").message).toContain("smthrs worktrees prune was removed")
    expect(Unsupported.verbError(worktrees, "prune").message).toContain("#worktrees")
  })

  it("keeps `ls` and `status` out of the removed set: they are real rc.0 verbs", () => {
    const removed = new Set(Unsupported.removedVerbs.map((verb) => verb.name))

    expect(removed.has("ls")).toBe(false)
    expect(removed.has("status")).toBe(false)
  })

  it("names no verb the canonical tree ships, so no consumer needs an exclusion list", async () => {
    // `graph`, `eval`, `review`, `test`, `runs`, and `show` were once listed
    // here and are canonical commands again. While they were both, the router,
    // this suite, the help assertion, and the site generator each carried the
    // same six names by hand. The manifest is the authority: a spelling the
    // CLI answers is not a removal.
    const environment = { ...process.env, NO_COLOR: "1" } as Record<string, string>
    let manifest = ""
    await makeCli({ environment }).serve(["--llms-full", "--format", "json"], {
      env: environment,
      stdout: (text) => {
        manifest += text
      },
      exit: () => {}
    })
    const commands = JSON.parse(manifest).commands as ReadonlyArray<{ readonly name: string }>
    const canonical = new Set(commands.map((command) => command.name.split(" ")[0]))

    expect(canonical.size).toBeGreaterThan(0)
    expect(Unsupported.removedVerbs.map((verb) => verb.name).filter((name) => canonical.has(name))).toEqual([])
  })
})
