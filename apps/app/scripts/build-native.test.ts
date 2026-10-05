import { validateMicrosandboxBinary } from "./bundle-microsandbox"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const script = resolve(import.meta.dir, "build-native.ts")
// These tests compile Mach-O fixtures and launch the build in another process.
// Shared release-gate runners can spend more than Bun's default 5 s doing that.
const BUILD_CHECK_TIMEOUT = 30_000
const pnpmPin = (JSON.parse(readFileSync(resolve(import.meta.dir, "..", "..", "..", "package.json"), "utf8")) as {
  packageManager: string
}).packageManager
let root = ""

const compile = (argv: ReadonlyArray<string>): void => {
  const result = Bun.spawnSync(["cc", ...argv], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}

// A Mach-O "node" that reports a supported release, beside an executable
// pnpm that reports the pinned release, so the build reaches its Node checks.
const fakeNode = (name: string, foreignLibrary?: string, release = "v26.4.0"): string => {
  const bin = join(root, name, "bin")
  mkdirSync(bin, { recursive: true })
  const source = join(root, name, "node.c")
  writeFileSync(
    source,
    foreignLibrary === undefined
      ? `#include <stdio.h>\nint main(void) { puts("${release}"); return 0; }\n`
      : `#include <stdio.h>\nint foreign(void);\nint main(void) { puts("${release}"); return foreign(); }\n`
  )
  compile(["-o", join(bin, "node"), source, ...(foreignLibrary === undefined ? [] : [foreignLibrary])])
  const pnpm = join(bin, "pnpm")
  writeFileSync(pnpm, `#!/bin/sh\necho ${pnpmPin.slice("pnpm@".length)}\n`)
  chmodSync(pnpm, 0o755)
  return join(bin, "node")
}

const build = (node: string, extraEnv: Record<string, string> = {}): { exitCode: number; stderr: string } => {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("SMITHERS_")) env[name] = value
  }
  const result = Bun.spawnSync([process.execPath, script], {
    env: { ...env, SMITHERS_BUILD_SHA: "0".repeat(40), SMITHERS_NODE_BINARY: node, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe"
  })
  return { exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "smithers-build-native-"))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

test.skipIf(process.platform !== "darwin")("refuses a Node runtime that loads a library outside macOS", () => {
  const library = join(root, "lib", "libforeign")
  mkdirSync(join(root, "lib"), { recursive: true })
  writeFileSync(join(root, "lib", "foreign.c"), "int foreign(void) { return 0; }\n")
  compile(["-dynamiclib", "-install_name", library, "-o", library, join(root, "lib", "foreign.c")])

  const result = build(fakeNode("homebrew", library))

  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain(`loads ${library}`)
}, BUILD_CHECK_TIMEOUT)

test.skipIf(process.platform !== "darwin")("accepts a Node runtime that loads only macOS system libraries", () => {
  const result = build(fakeNode("official"))

  // The build passes the linkage gate and stops at the next check: the
  // fixture ships no Node license.
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).not.toContain(" loads ")
  expect(result.stderr).toContain("Node license is unavailable")
}, BUILD_CHECK_TIMEOUT)

for (const sha of ["", "abc123", "g".repeat(40)]) {
  test(`refuses invalid build revision ${sha}`, () => {
    const result = build(process.execPath, { SMITHERS_BUILD_SHA: sha })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("exact SMITHERS_BUILD_SHA")
  })
}
test("refuses Node outside the supported release", () => {
  const bin = join(root, "old-node")
  writeFileSync(bin, "#!/bin/sh\necho v26.3.0\n", { mode: 0o755 })
  const result = build(bin)
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain("Node 26.4 or a later Node 26")
})

test("refuses msb other than the qualified release", () => {
  const bin = join(root, "old-msb")
  writeFileSync(bin, "#!/bin/sh\necho msb 0.6.15\n", { mode: 0o755 })
  expect(() => validateMicrosandboxBinary(bin)).toThrow("Microsandbox must be 0.6.16")
})
for (const release of ["17.6", "18.4"]) {
  test(`PostgreSQL ${release} ${release.startsWith("18") ? "passes version gate" : "is refused"}`, () => {
    const node = fakeNode(`pg-${release}`)
    writeFileSync(resolve(node, "../../LICENSE"), "test Node license")
    const postgres = join(root, `postgres-${release}`)
    mkdirSync(join(postgres, "bin"), { recursive: true })
    for (const name of ["postgres", "initdb", "pg_isready", "psql", "pg_dump", "pg_restore"]) writeFileSync(join(postgres, "bin", name), `#!/bin/sh\necho postgres PostgreSQL ${release}\n`, { mode: 0o755 })
    // Without zig on PATH, PostgreSQL 18 stops at the guest helper's cross-build check,
    // before the assembler clears or builds anything.
    const result = build(node, { SMITHERS_POSTGRES_BUNDLE_DIR: postgres, PATH: "/usr/bin:/bin" })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(release.startsWith("18") ? "cross-builds the Linux arm64 guest helper with zig" : "must contain PostgreSQL 18")
  })
}

test("accepts qualified msb with system linkage", () => {
  expect(() => validateMicrosandboxBinary(fakeNode("msb-official", undefined, "msb 0.6.16"))).not.toThrow()
})
test("refuses qualified msb loading a non-system library", () => {
  const library = join(root, "lib", "libmsbforeign")
  mkdirSync(join(root, "lib"), { recursive: true })
  writeFileSync(join(root, "lib", "msbforeign.c"), "int foreign(void) { return 0; }\n")
  compile(["-dynamiclib", "-install_name", library, "-o", library, join(root, "lib", "msbforeign.c")])
  expect(() => validateMicrosandboxBinary(fakeNode("msb-foreign", library, "msb 0.6.16"))).toThrow("foreign libraries")
})
