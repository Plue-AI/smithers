/**
 * Codex registration at the public Smithers CLI and installed Codex CLI boundaries.
 * Real-client cases run when `codex --version` succeeds on this host.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import * as Agents from "../src/Agents.ts"

const entry = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const directories: string[] = []
const temporaryHome = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-codex-mcp-"))
  directories.push(directory)
  return directory
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

const codex = Agents.find("codex")!
const installedCodex = spawnSync("codex", ["--version"], {
  env: { PATH: process.env.PATH },
  encoding: "utf8",
  timeout: 10_000
}).status === 0
const isolatedEnvironment = (home: string, codexHome = join(home, ".codex")): NodeJS.ProcessEnv => ({
  HOME: home,
  CODEX_HOME: codexHome,
  PATH: process.env.PATH
})

const fakeCodex = (home: string, source: string): string => {
  const bin = join(home, "bin")
  mkdirSync(bin)
  const command = join(bin, "codex")
  writeFileSync(command, `#!/bin/sh\n${source}\n`)
  chmodSync(command, 0o755)
  return bin
}

describe("Codex MCP registration", () => {
  it.skipIf(!installedCodex)("makes the public CLI registration visible to the installed Codex client", () => {
    const home = temporaryHome()
    const codexHome = join(home, "separate-codex-home")
    mkdirSync(codexHome)
    const config = join(codexHome, "config.toml")
    writeFileSync(config, "model = \"operator-model\"\n[mcp_servers.other]\ncommand = \"/usr/bin/true\"\n")
    const environment = isolatedEnvironment(home, codexHome)
    const stale = spawnSync("codex", ["mcp", "add", "smithers", "--", "/usr/bin/true"], {
      cwd: home,
      env: environment,
      encoding: "utf8",
      timeout: 30_000
    })
    expect(stale.status, stale.stderr).toBe(0)

    const registered = spawnSync(
      process.execPath,
      ["--no-warnings", entry, "mcp", "add", "--agent", "codex", "--json"],
      {
        cwd: home,
        env: environment,
        encoding: "utf8",
        timeout: 180_000
      }
    )
    expect(registered.error, registered.stderr).toBeUndefined()
    expect(registered.status, registered.stderr).toBe(0)
    const receipt = JSON.parse(registered.stdout) as Array<{ agent: string; path: string; status: string }>
    expect(receipt).toEqual([{ agent: "codex", path: config, status: "written" }])
    expect(existsSync(join(codexHome, "mcp.json"))).toBe(false)

    const listed = spawnSync("codex", ["mcp", "list", "--json"], {
      cwd: home,
      env: environment,
      encoding: "utf8",
      timeout: 30_000
    })
    expect(listed.error, listed.stderr).toBeUndefined()
    expect(listed.status, listed.stderr).toBe(0)
    const servers = JSON.parse(listed.stdout) as Array<{
      name: string
      enabled: boolean
      transport: { type: string; command: string; args: string[] }
    }>
    expect(servers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "smithers",
        enabled: true,
        transport: expect.objectContaining({ type: "stdio", command: process.execPath, args: [entry, "--mcp"] })
      }),
      expect.objectContaining({ name: "other" })
    ]))
    expect(readFileSync(config, "utf8")).toContain("model = \"operator-model\"")
  }, 240_000)

  it.skipIf(!installedCodex)("keeps a valid Codex configuration byte-for-byte unchanged on repeat registration", () => {
    const home = temporaryHome()
    const first = Agents.addMcp(codex, home)
    expect(first.status, first.reason).toBe("written")
    const original = readFileSync(first.path)

    const second = Agents.addMcp(codex, home)
    expect(second).toMatchObject({ path: first.path, status: "unchanged" })
    expect(readFileSync(first.path)).toEqual(original)
  })

  it.skipIf(!installedCodex)("refuses malformed Codex TOML without changing its bytes", () => {
    const home = temporaryHome()
    const codexHome = join(home, ".codex")
    mkdirSync(codexHome)
    const config = join(codexHome, "config.toml")
    const original = Buffer.from("model = \"unterminated\n# operator data\n")
    writeFileSync(config, original)

    const result = Agents.addMcp(codex, home)
    expect(result).toMatchObject({ path: config, status: "failed" })
    expect(result.reason).toBeTruthy()
    expect(readFileSync(config)).toEqual(original)
    expect(existsSync(join(codexHome, "mcp.json"))).toBe(false)
  })

  it.skipIf(!installedCodex)("uses CODEX_HOME when given in the invocation environment", () => {
    const home = temporaryHome()
    const codexHome = join(home, "chosen-codex-home")
    mkdirSync(codexHome)

    const result = Agents.addMcp(codex, undefined, isolatedEnvironment(home, codexHome))
    expect(result.status, result.reason).toBe("written")
    expect(result.path).toBe(join(codexHome, "config.toml"))
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false)
  })

  it.skipIf(!installedCodex)("keeps an explicit home separate from an ambient CODEX_HOME", () => {
    const home = temporaryHome()
    const ambient = temporaryHome()
    const previous = process.env.CODEX_HOME
    process.env.CODEX_HOME = ambient
    try {
      const result = Agents.addMcp(codex, home)
      expect(result.status, result.reason).toBe("written")
      expect(result.path).toBe(join(home, ".codex", "config.toml"))
      expect(existsSync(join(ambient, "config.toml"))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previous
    }
  })

  it("reports Codex command failures instead of a successful registration", () => {
    const home = temporaryHome()
    const result = Agents.addMcp(codex, home, { HOME: home, PATH: join(home, "no-binaries") })
    expect(result.status).toBe("failed")
    expect(result.reason).toBeTruthy()
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false)
  })

  it.each([
    ["invalid list output", "printf 'not-json\\n'"],
    ["non-array list output", "printf '{}\\n'"],
    ["failed add", "if [ \"$2\" = \"list\" ]; then printf '[]\\n'; else echo 'add refused' >&2; exit 9; fi"],
    ["unverified add", "printf '[]\\n'"],
    ["disabled server", "printf '[{\"name\":\"smithers\",\"enabled\":false}]\\n'"],
    ["wrong transport", "printf '[{\"name\":\"smithers\",\"enabled\":true,\"transport\":{\"type\":\"http\"}}]\\n'"]
  ])("refuses %s from the Codex command", (_name, script) => {
    const home = temporaryHome()
    const bin = fakeCodex(home, script)

    const result = Agents.addMcp(codex, home, { HOME: home, PATH: bin })
    expect(result.status).toBe("failed")
    expect(result.reason).toBeTruthy()
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false)
  })
})
