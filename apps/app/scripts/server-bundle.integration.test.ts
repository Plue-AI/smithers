import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// This is a real release assembly, not a fixture that mocks compilers or tools.
// Opt in on the reference builder with its Linux arm64 release helper at
// apps/app/.native-inputs/linux-arm64/smithers-jj-export (scripts/README.md).
test.skipIf(process.env.SMITHERS_SERVER_BUNDLE_INTEGRATION !== "1")("production target assembles a digest-matched relocatable server bundle", async () => {
  const root = resolve(import.meta.dir, "../../..")
  let firstDigest = ""
  for (let build = 0; build < 2; build++) {
    const child = Bun.spawn(["pnpm", "exec", "smthrs", "build", "//apps/app:serverBundle"], { cwd: root, stdout: "inherit", stderr: "inherit" })
    expect(await child.exited).toBe(0)
    const digest = createHash("sha256").update(readFileSync(join(root, "apps/app/.native-archive/smithers-server.tar.gz"))).digest("hex")
    if (build === 0) firstDigest = digest
    else expect(digest).toBe(firstDigest)
  }
  const destination = mkdtempSync(join(tmpdir(), "smithers-relocated-"))
  try {
    const relocated = destination
    const unpack = Bun.spawnSync(["/usr/bin/tar", "-xzf", join(root, "apps/app/.native-archive/smithers-server.tar.gz"), "-C", destination])
    expect(unpack.exitCode).toBe(0)
    // PostgreSQL keeps its build-time prefix under postgres/root; bundle.json names its bin, as the launcher reads it.
    const postgres = JSON.parse(readFileSync(join(relocated, "postgres/bundle.json"), "utf8"))
    expect(postgres.version).toBe(1)
    expect(postgres.bin).toMatch(/^root\/.+\/bin$/)
    expect(postgres.bin.split("/")).not.toContain("..")
    const distribution = JSON.parse(readFileSync(join(root, "apps/app/.native-archive/manifest.json"), "utf8"))
    for (const entry of distribution.files) {
      expect(entry.sha256).toBe(createHash("sha256").update(readFileSync(join(root, "apps/app/.native-archive", entry.path))).digest("hex"))
    }
    const readme = readFileSync(join(relocated, "README.md"), "utf8")
    expect(readme).toBe("# Smithers server bundle\n" + readFileSync(join(root, "apps/app/scripts/README.md"), "utf8").split("## Stage-1 service\n")[1]!.split("\n## ")[0])
    const commands = [...readme.matchAll(/^\.\/(bin\/\S+)/gm)]
    expect(commands.length).toBe(3)
    for (const command of commands) expect(existsSync(join(relocated, command[1]!))).toBe(true)
    const paths = ["README.md", "bin/smthrs", "bin/smithers-server", "bin/smithers-backend", "bin/msb", "bin/node", "bin/git", "bin/jj", "bin/smithers-coding-host", "bin/smithers-model-host", "bin/linux-arm64/smithers-jj-export", `postgres/${postgres.bin}/postgres`, "lib/libkrunfw.5.dylib", "views/mainview/index.html", "share/microsandbox/smithers-guest.py", "share/microsandbox/base-image.oci.tar", "share/microsandbox/base-image.json"]
    const manifest = JSON.parse(readFileSync(join(relocated, "manifest.json"), "utf8"))
    const files = Object.fromEntries(manifest.files.map((entry: { path: string; sha256: string }) => [entry.path, entry]))
    expect(manifest.platform).toBe("darwin-arm64")
    for (const path of paths) {
      expect(existsSync(join(relocated, path))).toBe(true)
      expect(files[path].sha256).toBe(createHash("sha256").update(readFileSync(join(relocated, path))).digest("hex"))
    }
    expect(readFileSync(join(relocated, "share/microsandbox/smithers-guest.py"))).toEqual(readFileSync(join(root, "packages/backend/microsandbox/guest/smithers-guest.py")))
    const msb = Bun.spawnSync([join(relocated, "bin/msb"), "--version"], { stdout: "pipe", stderr: "pipe" })
    expect(msb.exitCode).toBe(0)
    expect(new TextDecoder().decode(msb.stdout).trim()).toBe("msb 0.6.16")
    const linkage = Bun.spawnSync(["/usr/bin/otool", "-L", join(relocated, "bin/node")], { stdout: "pipe", stderr: "pipe" })
    expect(linkage.exitCode).toBe(0)
    for (const line of new TextDecoder().decode(linkage.stdout).trim().split("\n").slice(1)) expect(line.trim()).toMatch(/^\/(System\/Library|usr\/lib)\//)
    const check = Bun.spawnSync(["bun", "apps/app/scripts/server-bundle-manifest.ts", relocated], { cwd: root, stdout: "pipe", stderr: "pipe" })
    expect(check.exitCode).toBe(0)
  } finally { rmSync(destination, { recursive: true, force: true }) }
}, 7_200_000)

// Use the assembled install, never a fake backend or runtime.
const bundle = process.env.SMITHERS_TEST_SERVER_BUNDLE
const boundary = bundle === undefined ? test.skip : test
boundary("bundled server refuses missing msb despite hostile runtime overrides", () => {
  const temporary = mkdtempSync(join(tmpdir(), "smithers-server-boundary-"))
  try {
    const copy = join(temporary, "bundle")
    cpSync(bundle!, copy, { recursive: true, verbatimSymlinks: true })
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
