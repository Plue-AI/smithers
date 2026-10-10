import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Host from "../src/internal/backend/HostService.ts"

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-host-"))
  roots.push(root)
  const bundle = join(root, "bundle & <dir>")
  mkdirSync(join(bundle, "bin"), { recursive: true })
  const files = ["bin/smithers-server", "bin/smithers-backend", "bin/msb"].map((path) => {
    // Unit-only bytes, never used as a launcher or a repository process.
    writeFileSync(join(bundle, path), path, { mode: 0o755 })
    return { path, sha256: createHash("sha256").update(path).digest("hex"), stage: "fixture", mode: 0o755 }
  })
  writeFileSync(
    join(bundle, "manifest.json"),
    JSON.stringify({ version: 1, platform: "darwin-arm64", revision: "a".repeat(40), files })
  )
  let running = false
  const calls: string[][] = []
  const system = {
    agentsDir: join(root, "LaunchAgents"),
    domain: "gui/501",
    launchctl: (args: ReadonlyArray<string>) => {
      calls.push([...args])
      if (args[0] === "print") return { status: running ? 0 : 113, stdout: "", stderr: "" }
      if (args[0] === "bootstrap") running = true
      if (args[0] === "bootout") running = false
      return { status: 0, stdout: "", stderr: "" }
    }
  } satisfies Host.Launchd
  return { root, bundle, files, system, calls, options: { bundle, stateDir: join(root, "state"), home: root } }
}

// Contract coverage only: launchd and maintenance providers require the Mac receipts.
describe("native maintenance output", () => {
  it.each(
    [
      ["backup", undefined, "/Users/owner/Library/Application Support/Smithers/backups/1.2.3-20261007T010203Z"],
      ["restore", "/snapshot with spaces", "2026-10-07T01:02:03Z"]
    ] as const
  )("returns the native %s receipt as text", (operation, directory, receipt) => {
    const f = fixture()
    mkdirSync(f.system.agentsDir, { recursive: true })
    writeFileSync(Host.plistFile(f.system), Host.hostPlist(f.options))
    const run = vi.fn(() => ({ status: 0, stdout: receipt + "\n", stderr: "" })) as unknown as typeof spawnSync
    expect(Host.maintenance(operation, directory, f.system, run)).toBe(receipt)
    expect(run).toHaveBeenCalledWith(join(f.bundle, "bin/smithers-backend"), [
      "host-maintenance",
      operation,
      ...(directory ? [directory] : [])
    ], {
      encoding: "utf8",
      maxBuffer: 65536,
      env: { HOME: homedir(), PATH: `${f.bundle}/bin:/usr/bin:/bin:/usr/sbin:/sbin` }
    })
  })
  it("preserves the recovery command on backend failure", () => {
    const f = fixture()
    mkdirSync(f.system.agentsDir, { recursive: true })
    writeFileSync(Host.plistFile(f.system), Host.hostPlist(f.options))
    const hint = "upgrade incomplete: migration failed; restore with smthrs host restore '/snapshot with spaces'"
    const run = vi.fn(() => ({ status: 1, stdout: "", stderr: hint + "\n" })) as unknown as typeof spawnSync
    expect(() => Host.maintenance("upgrade", undefined, f.system, run)).toThrow(hint)
  })
})
