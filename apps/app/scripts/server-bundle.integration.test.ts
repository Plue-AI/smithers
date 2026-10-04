import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Use the assembled install, never a fake backend or runtime.
const bundle = process.env.SMITHERS_TEST_SERVER_BUNDLE
const boundary = bundle === undefined ? test.skip : test
boundary("bundled server refuses missing msb despite hostile runtime overrides", () => {
  const temporary = mkdtempSync(join(tmpdir(), "smithers-server-boundary-"))
  try {
    const copy = join(temporary, "bundle")
    cpSync(bundle!, copy, { recursive: true })
    rmSync(join(copy, "bin", "msb"))
    const result = spawnSync(join(copy, "bin", "smithers-server"), [], {
      env: {
        HOME: process.env.HOME!, PATH: "/opt/homebrew/bin:/hostile/bin:/usr/bin:/bin",
        SMITHERS_BACKEND_MODE: "plue", SMITHERS_WORKSPACE_ISOLATION: "process",
        SMITHERS_MICROSANDBOX_BIN: "/bin/sh", SMITHERS_BACKEND_BINARY: "/bin/sh"
      }, encoding: "utf8", timeout: 30_000
    })
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Bundled microVM runtime is unavailable")
    expect(result.stdout).not.toContain('"setup_urls"')
    expect(result.stdout).not.toContain("SMITHERS_LOCAL_ORIGIN=")
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}, 60_000)
