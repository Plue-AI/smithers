import { afterAll, beforeAll, expect, test } from "bun:test"
import { requiresMacOS } from "./RequiresMacOS"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as HostService from "../../../packages/smithers/src/internal/backend/HostService"

const root = mkdtempSync(join(tmpdir(), "bundle-cli-"))
const binary = join(root, "smthrs")

// Compilation is fixture setup; each rejection keeps its own five-second deadline.
beforeAll(() => {
  expect(Bun.spawnSync(["bun", "build", "--compile", join(import.meta.dir, "bundle-cli.ts"), "--outfile", binary]).exitCode).toBe(0)
}, 30_000)
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

for (const args of [["unknown"], ["host", "stop", "extra"], ["host", "status", "extra"], ["host", "start", "--bundle"], ["host", "start", "--bind"], ["host", "start", "--origin"], ["host", "start", "extra"], ["host", "start", "--unknown"]]) {
  test(`compiled bundle CLI refuses ${args.join(" ")} before service effects`, () => {
    const result = Bun.spawnSync([binary, ...args], { env: { HOME: root, PATH: "/usr/bin:/bin" } })
    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain("Use smthrs host")
    expect(existsSync(join(root, "Library/LaunchAgents/sh.smithers.host.plist"))).toBe(false)
  })
}

test("the bundle README shows the lines host start prints", () => {
  // The Stage-1 section of this README ships as the bundle's README.md
  // (server-bundle.integration.test.ts). It showed `{"setup_urls":[...]}`,
  // which is what `--json` prints. The command it tells the reader to run
  // prints the links, one per line; a real install on 2026-10-08 found the
  // difference.
  const readme = readFileSync(join(import.meta.dir, "README.md"), "utf8")
  const stage = readme.split("## Stage-1 service\n")[1]!.split("\n## ")[0]!
  expect(stage).toContain("./bin/smthrs host start --bundle .\n")
  const shown = /After readiness it prints[^\n]*\n\n```text\n([\s\S]*?)\n```/.exec(stage)?.[1]
  expect(shown).toBeDefined()
  const urls = shown!.split("\n")
  expect(urls).toEqual(["http://localhost:4000/setup?token=...", "http://127.0.0.1:4000/setup?token=..."])
  expect(HostService.startText({ setup_urls: urls })).toBe(shown!)
  expect(stage).not.toContain('"setup_urls"')
})

// Off macOS, host start refuses at the launchd platform check first
// (packages/smithers/test/HostService.test.ts covers that refusal).
requiresMacOS("compiled bundle CLI refuses invalid bundles before service effects", () => {
  const bundle = join(root, "bundle")
  mkdirSync(bundle)
  writeFileSync(join(bundle, "manifest.json"), "{}")
  const result = Bun.spawnSync([binary, "host", "start", "--bundle", bundle], { env: { HOME: root, PATH: "/usr/bin:/bin" } })
  expect(result.exitCode).toBe(1)
  expect(new TextDecoder().decode(result.stderr)).toContain("Invalid bundle manifest")
    for (const flags of [
      ["--bind", "127.0.0.1", "--origin", "https://smithers.example", "--origin", "https://team.example"],
      ["--origin=https://smithers.example", "--bind=127.0.0.1"],
      ["--json", "--bind", "0.0.0.0", "--origin", "http://10.0.0.59:4000"]
    ]) {
      const accepted = Bun.spawnSync([binary, "host", "start", ...flags, "--bundle", bundle], { env: { HOME: root, PATH: "/usr/bin:/bin" } })
      expect(accepted.exitCode).toBe(1)
      expect(new TextDecoder().decode(accepted.stderr)).toContain("Invalid bundle manifest")
    }
    for (const flags of [
      ["--bind", "not-an-address"],
      ["--origin", "https://smithers.example/path"],
      ["--origin", "https://smithers.example", "--origin", "https://smithers.example"]
    ]) {
      const refused = Bun.spawnSync([binary, "host", "start", "--bundle", bundle, ...flags], { env: { HOME: root, PATH: "/usr/bin:/bin" } })
      expect(refused.exitCode).toBe(1)
      expect(new TextDecoder().decode(refused.stderr)).toMatch(/Invalid (bind address|public origin)/)
    }
  expect(existsSync(join(root, "Library/LaunchAgents/sh.smithers.host.plist"))).toBe(false)
    const status = Bun.spawnSync([binary, "host", "status", "--json"], { env: { HOME: root, PATH: "/usr/bin:/bin" } })
    expect(status.exitCode).toBe(1)
    expect(new TextDecoder().decode(status.stderr)).not.toContain("Use smthrs host")
})

requiresMacOS("compiled bundle CLI forwards serving flags to the existing host boundary", () => {
  const missing = join(root, "missing-serving-bundle")
  const result = Bun.spawnSync([binary, "host", "start", "--bundle", missing, "--bind", "0.0.0.0", "--origin", "http://mini.lan:4000", "--origin", "https://proxy.example", "--json"], { env: { HOME: root, PATH: "/usr/bin:/bin" } })
  expect(result.exitCode).toBe(1)
  const stderr = new TextDecoder().decode(result.stderr)
  expect(stderr).toContain(missing)
  expect(stderr).not.toContain("Use smthrs host")
  expect(existsSync(join(root, "Library/LaunchAgents/sh.smithers.host.plist"))).toBe(false)
})

for (const [flag, value, message] of [["--bind", "bad", "Invalid bind address"], ["--origin", "ftp://mini.lan", "Invalid public origin"]]) {
  requiresMacOS(`compiled bundle CLI forwards invalid ${flag} before bundle or service effects`, () => {
    const result = Bun.spawnSync([binary, "host", "start", "--bundle", join(root, "missing"), flag!, value!], { env: { HOME: root, PATH: "/usr/bin:/bin" } })
    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain(message!)
    expect(existsSync(join(root, "Library/LaunchAgents/sh.smithers.host.plist"))).toBe(false)
  })
}
