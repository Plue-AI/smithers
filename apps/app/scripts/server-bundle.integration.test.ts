import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// This is a real release assembly, not a fixture that mocks compilers or tools.
// Opt in on the reference builder with Zig installed: the assembler
// cross-builds the Linux arm64 guest helper (scripts/README.md).
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
// The check runner already requires real microVMs. A requested qualification
// must fail for missing install input instead of silently skipping its boundary.
const required = process.env.SMITHERS_REQUIRE_SERVER_BUNDLE_TESTS === "1" || process.env.SMITHERS_REQUIRE_MICROVM_TESTS === "1"
test.skipIf(!required)("required bundled-server qualification has an assembled install", () => {
  expect(bundle).toBeDefined()
  expect(existsSync(join(bundle!, "bin/smithers-server"))).toBe(true)
})
const boundary = bundle === undefined ? test.skip : test
boundary("bundled server refuses missing msb despite hostile runtime overrides", () => {
  const temporary = mkdtempSync(join(tmpdir(), "smithers-server-boundary-"))
  try {
    const copy = join(temporary, "bundle")
    cpSync(bundle!, copy, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
    rmSync(join(copy, "bin/msb"))
    const home = join(temporary, "home")
    mkdirSync(home)
    const result = spawnSync(join(copy, "bin", "smithers-server"), [], {
      env: {
        HOME: home, PATH: "/opt/homebrew/bin:/hostile/bin:/usr/bin:/bin",
        SMITHERS_BACKEND_MODE: "plue", SMITHERS_WORKSPACE_ISOLATION: "process",
        SMITHERS_MICROSANDBOX_BIN: "/bin/sh", SMITHERS_BACKEND_BINARY: "/bin/sh",
        SMITHERS_POSTGRES_BUNDLE_DIR: "/hostile/postgres",
        SMITHERS_FLOW_HOST_MANIFEST: "/hostile/flow-hosts.json",
        SMITHERS_PLATFORM_MODEL_KEYS_FILE: "/hostile/keys.json",
        SMITHERS_OWNED_BACKEND_ORIGIN: "http://hostile.invalid:9000",
        SMITHERS_SERVER_ADDR: "0.0.0.0:9000", SMITHERS_SSH_ADDR: "0.0.0.0:9001",
        SMITHERS_PUBLIC_URL: "https://hostile.invalid",
        SMITHERS_EGRESS_RELAY_PORT: "9002", SMITHERS_MICROVM_MEMORY_MIB: "1"
      }, encoding: "utf8", timeout: 30_000
    })
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Bundled microVM runtime is unavailable")
    expect(result.stdout).not.toContain('"setup_urls"')
    expect(result.stdout).not.toContain("SMITHERS_LOCAL_ORIGIN=")
    // Observe the actual process boundary, including descendants reparented
    // after launcher exit. Only this disposable bundle can match the prefix.
    const processes = spawnSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
    expect(processes.status).toBe(0)
    expect(processes.stdout).not.toContain(copy)
    expect(existsSync(join(home, "Library/Application Support/Smithers/postgres"))).toBe(false)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}, 180_000)
