import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("compiled bundle CLI refuses unsupported commands and invalid bundles before service effects", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-cli-"))
  try {
    const binary = join(root, "smthrs")
    expect(Bun.spawnSync(["bun", "build", "--compile", join(import.meta.dir, "bundle-cli.ts"), "--outfile", binary]).exitCode).toBe(0)
    for (const args of [["unknown"], ["host", "stop", "extra"], ["host", "status", "extra"], ["host", "start", "--bundle"]]) {
      const result = Bun.spawnSync([binary, ...args], { env: { HOME: root, PATH: "/usr/bin:/bin" } })
      expect(result.exitCode).toBe(1)
      expect(new TextDecoder().decode(result.stderr)).toContain("Use smthrs host")
    }
    const bundle = join(root, "bundle")
    mkdirSync(bundle)
    writeFileSync(join(bundle, "manifest.json"), "{}")
    const result = Bun.spawnSync([binary, "host", "start", "--bundle", bundle], { env: { HOME: root, PATH: "/usr/bin:/bin" } })
    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain("Invalid bundle manifest")
    expect(existsSync(join(root, "Library/LaunchAgents/sh.smithers.host.plist"))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
