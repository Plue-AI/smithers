/**
 * `smthrs mcp add`.
 *
 * The two things worth pinning: writing is additive and idempotent, so an
 * operator's own configuration survives, and the launch command registered is
 * this executable rather than a package runner — 0.x registered
 * `bunx smthrs --mcp`, which pointed every agent at the last published build
 * regardless of what the operator was running.
 */
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Agents from "../src/Agents.ts"

const staged: Array<string> = []

const home = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-agents-"))
  staged.push(directory)
  return directory
}

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

/**
 * A pid that is provably gone: a child this process has already reaped.
 *
 * Naming a pid that never ran would prove nothing, because the kernel is free
 * to hand that number to a live process at any moment.
 */
const departedPid = (): number => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { pid } = spawnSync(process.execPath, ["-e", ""])
    if (pid === undefined) continue
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid
    }
  }
  throw new Error("could not observe an exited pid")
}

describe("the known agents", () => {
  it("is Claude Code and Codex, and nothing that moved to the plugins repository", () => {
    expect(Agents.agents.map((agent) => agent.id)).toEqual(["claude", "codex"])
    expect(Agents.find("claude")?.mcpConfig).toEqual([".claude.json"])
    expect(Agents.find("hermes")).toBeUndefined()
  })

  it("registers this executable, not a package runner", () => {
    const launch = Agents.launchCommand("/usr/bin/node", "/opt/smithers/bin/smithers.mjs")

    expect(launch).toEqual({ command: "/usr/bin/node", args: ["/opt/smithers/bin/smithers.mjs", "--mcp"] })
    expect(Agents.launchCommand().args).toContain("--mcp")
  })
})

describe("registering the MCP server", () => {
  it("writes the entry and leaves the rest of the configuration alone", () => {
    const directory = home()
    writeFileSync(join(directory, ".claude.json"), JSON.stringify({ theme: "dark", mcpServers: { other: {} } }))

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired).toMatchObject({ agent: "claude", status: "written" })
    const document = JSON.parse(readFileSync(wired.path, "utf8")) as Record<string, any>
    expect(document.theme).toBe("dark")
    expect(document.mcpServers.other).toEqual({})
    expect(document.mcpServers.smithers.args).toContain("--mcp")
  })

  it("creates Claude's configuration when it has none", () => {
    const directory = home()

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired.status).toBe("written")
    expect(wired.path).toBe(join(directory, ".claude.json"))
    expect(existsSync(wired.path)).toBe(true)
  })

  it("is idempotent", () => {
    const directory = home()
    Agents.addMcp(Agents.find("claude")!, directory)

    expect(Agents.addMcp(Agents.find("claude")!, directory).status).toBe("unchanged")
  })

  it("replaces a stale entry that points somewhere else", () => {
    const directory = home()
    writeFileSync(
      join(directory, ".claude.json"),
      JSON.stringify({ mcpServers: { smithers: { command: "bunx", args: ["smthrs", "--mcp"] } } })
    )

    expect(Agents.addMcp(Agents.find("claude")!, directory).status).toBe("written")
  })

  it("preserves an unparseable configuration byte for byte and refuses to update it", () => {
    const directory = home()
    const path = join(directory, ".claude.json")
    const original = Buffer.from("{ not json\n\u0000operator data")
    writeFileSync(path, original)

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    // The old test pinned replacement with a Smithers-only document. That
    // made one syntax error destroy the operator's entire agent configuration.
    expect(wired.status).toBe("failed")
    expect(wired.reason).toContain(path)
    expect(wired.reason).toBe(`${path} is not valid JSON. Fix the file, then run this again.`)
    expect(readFileSync(path)).toEqual(original)
  })

  it("preserves and refuses a configuration whose root is an array", () => {
    const directory = home()
    const path = join(directory, ".claude.json")
    const original = "[1, {\"operator\": true}]\n"
    writeFileSync(path, original)

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired).toMatchObject({ status: "failed", path })
    expect(wired.reason).toMatch(/root.*object/i)
    expect(readFileSync(path, "utf8")).toBe(original)
  })

  it("preserves and refuses an array-valued mcpServers member", () => {
    const directory = home()
    const path = join(directory, ".claude.json")
    const original = "{\"theme\":\"dark\",\"mcpServers\":[{\"operator\":true}]}\n"
    writeFileSync(path, original)

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired).toMatchObject({ status: "failed", path })
    expect(wired.reason).toMatch(/mcpServers.*object/i)
    expect(readFileSync(path, "utf8")).toBe(original)
  })

  it("atomically updates a valid file without changing its mode", () => {
    const directory = home()
    const path = join(directory, ".claude.json")
    writeFileSync(path, "{\"theme\":\"dark\"}\n")
    chmodSync(path, 0o640)

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired.status).toBe("written")
    expect(statSync(path).mode & 0o777).toBe(0o640)
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ theme: "dark" })
    expect(readdirSync(directory).filter((entry) => entry.includes(".tmp"))).toEqual([])
  })

  it("leaves a configuration byte-for-byte unchanged while another writer owns it", () => {
    const directory = home()
    const path = join(directory, ".claude.json")
    const original = "{\"theme\":\"operator-edit\"}\n"
    writeFileSync(path, original)
    writeFileSync(`${path}.smithers.lock`, "another writer")

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired.status).toBe("failed")
    expect(wired.reason).toMatch(/another Smithers process/)
    expect(readFileSync(path, "utf8")).toBe(original)
    expect(readdirSync(directory).filter((entry) => entry.endsWith(".tmp"))).toEqual([])
  })

  it("recovers a lock left behind by a process that is gone", () => {
    const directory = home()
    const path = join(directory, ".claude.json")
    const lockPath = `${path}.smithers.lock`
    writeFileSync(path, "{}\n")
    writeFileSync(lockPath, `${departedPid()}:${Date.now()}:abandoned`, { mode: 0o600 })

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    // A crash inside the write used to leave a lock no later run could clear,
    // so every registration after it refused for as long as the file existed.
    expect(wired.status).toBe("written")
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.smithers).toBeDefined()
    expect(existsSync(lockPath)).toBe(false)
  })

  it("refuses while the recorded owner is still running, and names the lock file", () => {
    const directory = home()
    const path = join(directory, ".claude.json")
    const lockPath = `${path}.smithers.lock`
    const original = "{\"theme\":\"operator-edit\"}\n"
    writeFileSync(path, original)
    writeFileSync(lockPath, `${process.pid}:${Date.now()}:live`, { mode: 0o600 })

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired.status).toBe("failed")
    expect(wired.reason).toContain(lockPath)
    expect(wired.reason).toContain(String(process.pid))
    expect(readFileSync(path, "utf8")).toBe(original)
    expect(existsSync(lockPath)).toBe(true)

    // A lock holding nothing but the pid still names that whole pid: reading
    // it a digit short would ask about a process that never took this lock.
    writeFileSync(lockPath, String(process.pid), { mode: 0o600 })

    const bare = Agents.addMcp(Agents.find("claude")!, directory)

    expect(bare.status).toBe("failed")
    expect(bare.reason).toContain(`(pid ${process.pid})`)
    expect(readFileSync(path, "utf8")).toBe(original)
  })

  it("recovers an ownerless lock only once its creator cannot still be writing", () => {
    // What a 0.x lock looks like, and what a kill between creating the lock
    // and recording its owner would leave: a file with nobody to ask about.
    const directory = home()
    const path = join(directory, ".claude.json")
    const lockPath = `${path}.smithers.lock`
    writeFileSync(path, "{}\n")
    writeFileSync(lockPath, "", { mode: 0o600 })

    const fresh = Agents.addMcp(Agents.find("claude")!, directory)

    expect(fresh.status).toBe("failed")
    expect(fresh.reason).toContain(lockPath)
    expect(existsSync(lockPath)).toBe(true)

    const abandoned = new Date(Date.now() - 6 * 60_000)
    utimesSync(lockPath, abandoned, abandoned)

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired.status).toBe("written")
    expect(existsSync(lockPath)).toBe(false)
  })

  it("reports a configuration it cannot write", () => {
    const directory = home()
    // A directory where the file should be: the write fails, and the operator
    // gets the manual instructions instead of a silent success.
    mkdirSync(join(directory, ".claude.json"))

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired.status).toBe("failed")
    // The system code, never `EISDIR: illegal operation on a directory, ...`.
    expect(wired.reason).toBe(
      `${join(directory, ".claude.json")} could not be read (EISDIR). Fix the file, then run this again.`
    )
  })

  it("reports a configuration it cannot even open, and names why", () => {
    const directory = home()
    const path = join(directory, ".claude.json")
    // A path that exists and refuses to open. A self-referential symlink is the
    // deterministic way to say that: `open` answers ELOOP whoever is running,
    // where a mode-stripped file answers nothing at all to root. The point is
    // the arm that is NOT "the file is absent": absence is an empty document
    // this command may write, and every other refusal has to be reported with
    // its reason rather than treated as a fresh configuration and overwritten.
    symlinkSync(path, path)

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired).toMatchObject({ agent: "claude", path, status: "failed" })
    expect(wired.reason).toBe(`${path} could not be read (ELOOP). Fix the file, then run this again.`)
    // The code, never the raw system message.
    expect(wired.reason).not.toContain("too many symbolic links")
    expect(readdirSync(directory)).toEqual([".claude.json"])
  })

  it("prints instructions with the separator an agent CLI needs", () => {
    const instructions = Agents.manualInstructions(["claude"])

    // Without `--` the agent's own parser reads `--mcp` as one of its flags
    // and rejects the registration.
    expect(instructions).toContain("claude mcp add smithers -- ")
    expect(instructions).toContain("\"mcpServers\"")
    expect(instructions).toContain("https://smithers.sh/docs/guides/mcp-setup/")
    expect(Agents.manualInstructions()).toContain("codex mcp add smithers -- ")
    expect(Agents.manualInstructions(["codex"])).not.toContain("mcpServers")
  })
})
