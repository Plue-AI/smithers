import { afterAll, beforeAll, expect, test } from "bun:test"
import { requiresMacOS } from "./RequiresMacOS"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = mkdtempSync(join(tmpdir(), "bundle-cli-"))
const binary = join(root, "smthrs")

// Compilation is fixture setup; each rejection keeps its own five-second deadline.
beforeAll(() => {
  expect(Bun.spawnSync(["bun", "build", "--compile", join(import.meta.dir, "bundle-cli.ts"), "--outfile", binary]).exitCode).toBe(0)
}, 30_000)
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

for (const args of [["unknown"], ["host", "stop", "extra"], ["host", "status", "extra"], ["host", "start", "--bundle"]]) {
  test(`compiled bundle CLI refuses ${args.join(" ")} before service effects`, () => {
    const result = Bun.spawnSync([binary, ...args], { env: { HOME: root, PATH: "/usr/bin:/bin" } })
    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain("Use smthrs host")
    expect(existsSync(join(root, "Library/LaunchAgents/sh.smithers.host.plist"))).toBe(false)
  })
}

// Off macOS, host start refuses at the launchd platform check first
// (packages/smithers/test/HostService.test.ts covers that refusal).
requiresMacOS("compiled bundle CLI refuses invalid bundles before service effects", () => {
  const bundle = join(root, "bundle")
  mkdirSync(bundle)
  writeFileSync(join(bundle, "manifest.json"), "{}")
  const result = Bun.spawnSync([binary, "host", "start", "--bundle", bundle], { env: { HOME: root, PATH: "/usr/bin:/bin" } })
  expect(result.exitCode).toBe(1)
  expect(new TextDecoder().decode(result.stderr)).toContain("Invalid bundle manifest")
  expect(existsSync(join(root, "Library/LaunchAgents/sh.smithers.host.plist"))).toBe(false)
})
