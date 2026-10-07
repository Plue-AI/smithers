import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

// This is a real release assembly, not a fixture that mocks compilers or tools.
// Opt in on the reference builder with Zig installed: the assembler
// cross-builds the Linux arm64 guest helper (scripts/README.md).
test.skipIf(process.env.SMITHERS_SERVER_BUNDLE_INTEGRATION !== "1")("production target assembles a digest-matched relocatable server bundle", async () => {
  expect(process.platform).toBe("darwin")
  expect(process.arch).toBe("arm64")
  expect(process.getuid!()).not.toBe(0)
  const receipt = process.env.SMITHERS_SERVER_BUNDLE_RECEIPT
  if (receipt) rmSync(receipt, { force: true })
  const root = resolve(import.meta.dir, "../../..")
  let firstDigest = ""
  for (let build = 0; build < 2; build++) {
    const child = Bun.spawn(["pnpm", "exec", "smthrs", "build", "//apps/app:serverBundle", "--no-cache"], { cwd: root, stdout: "inherit", stderr: "inherit" })
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
    const paths = ["README.md", "bin/smthrs", "bin/smithers-server", "bin/smithers-backend", "bin/msb", "bin/node", "licenses/node-LICENSE", "bin/git", "bin/jj", "bin/smithers-coding-host", "bin/smithers-model-host", "bin/flow-hosts.json", "bin/libsmithers_ffi.dylib", "bin/smithers-jj-export", "bin/linux-arm64/smithers-jj-export", "bin/linux-arm64/jj", `postgres/${postgres.bin}/postgres`, "lib/libkrunfw.5.dylib", "views/mainview/index.html", "share/microsandbox/smithers-guest.py", "share/microsandbox/base-image.oci.tar", "share/microsandbox/base-image.json"]
    const manifest = JSON.parse(readFileSync(join(relocated, "manifest.json"), "utf8"))
    const files = Object.fromEntries(manifest.files.map((entry: { path: string; sha256: string }) => [entry.path, entry]))
    expect(manifest.platform).toBe("darwin-arm64")
    expect(manifest.revision).toBe(spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim())
    // Independently hash every relocated payload, including files outside the
    // minimum layout below. The production verifier is an additional check.
    for (const entry of manifest.files) {
      expect(entry.sha256).toBe(createHash("sha256").update(readFileSync(join(relocated, entry.path))).digest("hex"))
    }
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
    const versions: Record<string, string> = {}
    for (const [path, release] of [
      ["bin/node", /^v26\.(?:[4-9]|[1-9]\d+)\./],
      ["bin/git", /^git version /],
      ["bin/jj", /^jj 0\.44\.0-47589ada70c12b3e829b5c98ab32503abad49eac$/],
      [`postgres/${postgres.bin}/postgres`, /PostgreSQL\)?\s+18\./]
    ] as const) {
      const result = spawnSync(join(relocated, path), ["--version"], { encoding: "utf8" })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      versions[path] = result.stdout.trim()
      expect(versions[path]).toMatch(release)
    }
    if (receipt) writeFileSync(receipt, JSON.stringify({
      check: "C-INS-05", scope: "assembly and relocation", passed: true,
      revision: manifest.revision, uid: process.getuid!(), platform: process.platform,
      arch: process.arch, archiveSha256: firstDigest, builds: 2,
      relocatedFiles: manifest.files.length, versions, completedAt: new Date().toISOString()
    }, null, 2) + "\n")
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
// Qualifies the installed runtime's offline base boot independently of the
// current guest helper. Only installed OS code runs in this disposable VM:
// no copied runner, repository, branch helper or root script is supplied.
// This is a base-boot receipt, not backend readiness or C-SEC-02 acceptance.
boundary("bundled runtime boots its pinned installed base image offline", () => {
  const receipt = process.env.SMITHERS_OFFLINE_BASE_RECEIPT
  if (receipt) rmSync(receipt, { force: true })
  const metadataPath = "share/microsandbox/base-image.json"
  const metadata = JSON.parse(readFileSync(join(bundle!, metadataPath), "utf8"))
  expect(metadata.version).toBe(1)
  expect(metadata.platform).toBe("linux-arm64")
  expect(metadata.image).toMatch(/^node@sha256:[0-9a-f]{64}$/)
  const manifest = JSON.parse(readFileSync(join(bundle!, "manifest.json"), "utf8"))
  for (const path of ["bin/msb", "lib/libkrunfw.5.dylib", metadataPath]) {
    const entry = manifest.files.find((file: { path: string }) => file.path === path)
    expect(entry).toBeDefined()
    expect(createHash("sha256").update(readFileSync(join(bundle!, path))).digest("hex")).toBe(entry.sha256)
  }
  const msb = join(bundle!, "bin/msb")
  const name = `ins02-offline-${randomUUID()}`
  const env = { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", MSB_BACKEND: "local", NO_COLOR: "1" }
  const receipts: Array<{ argv: string[]; status: number | null; elapsedMs: number }> = []
  const run = (args: string[]) => {
    const started = performance.now()
    const result = spawnSync(msb, args, { env, encoding: "utf8", timeout: 30_000 })
    receipts.push({ argv: [msb, ...args], status: result.status, elapsedMs: performance.now() - started })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    return result
  }
  try {
    const started = performance.now()
    run(["create", metadata.image, "--pull", "never", "--name", name, "--memory", "1G", "--cpus", "1", "--root-disk", "2G", "--no-net"])
    // /bin/true comes from the installed OS image, never from this checkout.
    run(["exec", "--stream", name, "--", "/bin/true"])
    expect(performance.now() - started).toBeLessThan(30_000)
    run(["status", name])
  } finally {
    run(["remove", "--force", name])
  }
  if (receipt) writeFileSync(receipt, JSON.stringify({ scope: "installed offline base boot only", passed: true,
    image: metadata.image, manifestRevision: manifest.revision,
    manifestSha256: createHash("sha256").update(readFileSync(join(bundle!, "manifest.json"))).digest("hex"),
    receipts, completedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 })
}, 150_000)
for (const fault of [
  { path: "bin/msb", refusal: "Bundled microVM runtime is unavailable" },
  { path: "lib/libkrunfw.5.dylib", refusal: "libkrunfw.5.dylib" }
]) boundary(`bundled server refuses missing ${fault.path} despite hostile runtime overrides`, () => {
  const temporary = mkdtempSync(join(tmpdir(), "smithers-server-boundary-"))
  try {
    const copy = join(temporary, "bundle")
    cpSync(bundle!, copy, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
    rmSync(join(copy, fault.path))
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
    expect(result.stderr).toContain(fault.refusal)
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

// Doctor and the launcher refuse during production runtime admission before
// opening listeners. Faults modify a private copy of the real Mach-O,
// never a shell stand-in, and no guest is booted from a modified artifact.
for (const fault of [
  { name: "an unqualified version", version: "0.6.15", refusal: "msb 0.6.15 is installed; this backend is qualified with msb 0.6.16", doctor: "FAIL msb", hypervisor: true },
  { name: "missing hypervisor authority", version: "0.6.16", refusal: "msb lacks com.apple.security.hypervisor entitlement", doctor: "FAIL msb", hypervisor: false }
]) boundary(`packaged doctor and server refuse a real msb with ${fault.name}`, () => {
  const temporary = mkdtempSync(join(homedir(), ".smithers-runtime-refusal-"))
  try {
    const copy = join(temporary, "bundle")
    cpSync(bundle!, copy, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
    const msb = join(copy, "bin/msb")
    const entitlements = join(temporary, "entitlements.plist")
    writeFileSync(entitlements, `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>com.apple.security.cs.disable-library-validation</key><true/>
      ${fault.hypervisor ? "<key>com.apple.security.hypervisor</key><true/>" : ""}
    </dict></plist>`)
    if (fault.version !== "0.6.16") {
      const binary = readFileSync(msb)
      const original = Buffer.from("0.6.16")
      let replacements = 0
      for (let offset = binary.indexOf(original); offset !== -1; offset = binary.indexOf(original, offset + original.length)) {
        binary.write("0.6.15", offset, "ascii")
        replacements++
      }
      expect(replacements).toBeGreaterThan(0)
      writeFileSync(msb, binary)
    }
    const signed = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", "--entitlements", entitlements, msb], { encoding: "utf8" })
    expect(signed.status).toBe(0)
    const version = spawnSync(msb, ["--version"], { encoding: "utf8", timeout: 5000 })
    expect(version.error).toBeUndefined()
    expect(version.status).toBe(0)
    expect(version.stdout.trim()).toBe(`msb ${fault.version}`)
    // Declare the fault bytes so the refusal must reach version/host
    // qualification; a hash mismatch would not prove either behavior.
    const manifestPath = join(copy, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    const entry = manifest.files.find((file: { path: string }) => file.path === "bin/msb")
    expect(entry).toBeDefined()
    entry.sha256 = createHash("sha256").update(readFileSync(msb)).digest("hex")
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const state = join(temporary, "state")
    mkdirSync(state, { mode: 0o700 })
    const result = spawnSync(join(copy, "bin/smithers-backend"), ["microvm", "doctor"], {
      env: { HOME: homedir(), PATH: "/usr/bin:/bin", SMITHERS_DATA_ROOT: state, SMITHERS_MICROSANDBOX_BIN: msb },
      encoding: "utf8", timeout: 30_000
    })
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stdout, result.stderr).toContain(fault.doctor)
    expect(result.stdout).toContain(fault.refusal)
    expect(result.stderr).toContain("microVM isolation is not ready")
    expect(result.stdout).not.toContain('"setup_urls"')
    expect(existsSync(join(state, "postgres"))).toBe(false)
    // Version admission precedes listeners and PostgreSQL; drive the person's
    // entrypoint without booting a guest from this modified artifact.
    const home = join(temporary, "home")
    mkdirSync(home, { mode: 0o700 })
    const started = performance.now()
    const launcher = spawnSync(join(copy, "bin/smithers-server"), [], {
      env: {
        HOME: home, PATH: "/usr/bin:/bin",
        SMITHERS_WORKSPACE_ISOLATION: "process",
        SMITHERS_MICROSANDBOX_BIN: "/bin/sh",
        SMITHERS_BACKEND_BINARY: "/bin/sh",
        SMITHERS_SERVER_ADDR: "0.0.0.0:9000",
        SMITHERS_SSH_ADDR: "0.0.0.0:9001",
        SMITHERS_EGRESS_RELAY_PORT: "9002"
      }, encoding: "utf8", timeout: 30_000
    })
    expect(launcher.error).toBeUndefined()
    expect(launcher.status).not.toBeNull()
    expect(launcher.status).not.toBe(0)
    expect(performance.now() - started).toBeLessThan(30_000)
    expect(launcher.stderr).toContain(fault.refusal)
    expect(launcher.stdout).not.toContain('"setup_urls"')
    expect(launcher.stdout).not.toContain("SMITHERS_LOCAL_ORIGIN=")
    expect(existsSync(join(home, "Library/Application Support/Smithers/postgres"))).toBe(false)
    const processes = spawnSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
    expect(processes.status).toBe(0)
    expect(processes.stdout).not.toContain(copy)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}, 180_000)
boundary("packaged setup mint pipe rotates before claim and is silent after claim", async () => {
  expect(process.platform).toBe("darwin")
  expect(process.arch).toBe("arm64")
  expect(process.getuid!()).not.toBe(0)
  const receipt = process.env.SMITHERS_SETUP_RELAY_RECEIPT
  if (receipt) rmSync(receipt, { force: true })
  // Refuse stale packages before starting any listener or private database.
  const symbols = spawnSync("/usr/bin/nm", ["-gU", join(bundle!, "bin/libsmithers_ffi.dylib")], { encoding: "utf8" })
  expect(symbols.status).toBe(0)
  expect(/\b_ld_open\b/.test(symbols.stdout), "bundle exports the live-document ABI").toBe(true)
  // The launcher gives the backend its stdout descriptor unchanged. Inspect
  // that descriptor in both real processes, then capture its complete bytes.
  // No wrapper replaces a manifest member, and no credential is printed by tests.
  const root = resolve(import.meta.dir, "../../..")
  const temporary = mkdtempSync(join(tmpdir(), "smithers-packaged-claim-"))
  const home = join(temporary, "home")
  mkdirSync(home, { mode: 0o700 })
  const port = 47400 + Math.floor(Math.random() * 2000)
  const origin = `http://127.0.0.1:${port}`
  const fixture = Bun.spawn(["go", "test", "./packages/backend/testkit", "-run", "^TestPackagedSetupGitHubFixture$", "-count=1", "-v"], {
    cwd: root, env: { ...process.env, SMITHERS_PACKAGED_FIXTURE_ROOT: temporary, SMITHERS_PACKAGED_FIXTURE_ORIGIN: origin },
    stdin: "pipe", stdout: "pipe", stderr: "pipe"
  })
  const fixtureOutput = new Response(fixture.stdout).text()
  const fixtureErrors = new Response(fixture.stderr).text()
  const captures: Array<{ stdout: string; stderr: string; pipe: string }> = []
  const secrets: string[] = []
  const setupTokens: string[] = []
  const readinessMs: number[] = []
  let persistedSessions: Record<string, string> | undefined
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    // A readiness file avoids waiting for the long-lived fixture to exit.
    const readiness = join(temporary, "fixture-ready.json")
    const deadline = Date.now() + 120_000
    while (!existsSync(readiness) && Date.now() < deadline) await Bun.sleep(50)
    expect(existsSync(readiness), "external GitHub fixture readiness").toBe(true)
    const external = JSON.parse(readFileSync(readiness, "utf8")) as { control: string; proxy: string; cert: string }
    const status = async () => {
      const response = await fetch(external.control + "/status")
      expect(response.status).toBe(200)
      return await response.json() as { owners: number; sessions: number; digest: string }
    }
    const persistence = async () => {
      const response = await fetch(external.control + "/persistence")
      expect(response.status).toBe(200)
      const result = await response.json() as { version: number; sessions: Record<string, string> }
      expect(result.version).toBeGreaterThanOrEqual(180000)
      expect(result.version).toBeLessThan(190000)
      return result.sessions
    }
    const stop = async () => {
      child!.kill("SIGTERM")
      const exited = await Promise.race([child!.exited, Bun.sleep(30_000).then(() => undefined)])
      if (exited === undefined) { child!.kill("SIGKILL"); await child!.exited }
      expect(exited, "launcher graceful shutdown").toBe(0)
      child = undefined
    }
    for (let start = 0; start < 3; start++) {
      const started = performance.now()
      child = Bun.spawn([join(bundle!, "bin/smithers-server"), "--bind", `127.0.0.1:${port}`, "--origin", origin], {
        env: { HOME: home, PATH: "/usr/bin:/bin", HTTPS_PROXY: external.proxy, HTTP_PROXY: external.proxy,
          NO_PROXY: "127.0.0.1,localhost", SSL_CERT_FILE: external.cert }, stdout: "pipe", stderr: "pipe"
      })
      const capture = { stdout: "", stderr: "", pipe: "" }
      captures.push(capture)
      const consume = async (stream: ReadableStream<Uint8Array>, key: "stdout" | "stderr") => {
        const decoder = new TextDecoder()
        const reader = stream.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            capture[key] += decoder.decode(value, { stream: true })
          }
          capture[key] += decoder.decode()
        } finally { reader.releaseLock() }
      }
      const drained = Promise.all([consume(child.stdout as ReadableStream<Uint8Array>, "stdout"), consume(child.stderr as ReadableStream<Uint8Array>, "stderr")])
      const startupDeadline = Date.now() + Math.max(0, 30_000 - (performance.now() - started))
      let exited = false
      void child.exited.then(() => { exited = true })
      let ready = false
      while (!exited && Date.now() < startupDeadline) {
        try { ready = (await fetch(origin + "/readyz", { signal: AbortSignal.timeout(1000) })).ok } catch {}
        if (ready && capture.stdout.includes(`SMITHERS_LOCAL_ORIGIN=${origin}\n`)) break
        ready = false
        await Bun.sleep(50)
      }
      expect(ready, "assembled backend readiness").toBe(true)
      readinessMs.push(performance.now() - started)
      expect(readinessMs.at(-1)!).toBeLessThan(30_000)
      if (start === 1) expect(await persistence()).toEqual(persistedSessions!)
      else expect(await persistence()).toEqual({})
      const processes = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" })
      expect(processes.status).toBe(0)
      const backend = processes.stdout.split("\n").map(line => line.trim().split(/\s+/)).find(parts => Number(parts[1]) === child!.pid && parts.slice(2).join(" ").endsWith("/smithers-backend"))
      expect(backend, "real packaged backend child").toBeDefined()
      const descriptor = (pid: number) => {
        const result = spawnSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "1", "-F", "Din"], { encoding: "utf8" })
        expect(result.status).toBe(0)
        return result.stdout.split("\n").filter(line => /^[Din]/.test(line)).join("\n")
      }
      capture.pipe = descriptor(child.pid)
      expect(capture.pipe.length).toBeGreaterThan(0)
      expect(descriptor(Number(backend![0]))).toBe(capture.pipe)
      const lines = capture.stdout.split(/(?<=\n)/).filter(line => line.includes('"setup_urls"'))
      if (start < 2) {
        expect(lines.length).toBe(1)
        expect(lines[0]!.endsWith("\n")).toBe(true)
        const mint = JSON.parse(lines[0]!) as { setup_urls: string[] }
        expect(Object.keys(mint)).toEqual(["setup_urls"])
        const token = new URL(mint.setup_urls[0]!).searchParams.get("token")!
        expect(typeof token).toBe("string")
        expect(token.length).toBeGreaterThan(0)
        expect(JSON.stringify(mint.setup_urls) === JSON.stringify([`http://localhost:4000/setup?token=${token}`, `${origin}/setup?token=${token}`])).toBe(true)
        const before = await status()
        expect(before.owners).toBe(0)
        expect(before.digest).toContain(createHash("sha256").update(token).digest("hex"))
        if (start === 0) {
          // The served exchange commits a real API row in bundled PG18.
          // Retain only its digest and compare its complete persisted value
          // after SIGTERM/restart, independently of token rotation.
          const exchange = await fetch(`${origin}/setup?token=${encodeURIComponent(token)}`, { redirect: "manual" })
          expect(exchange.status).toBe(303)
          const cookie = exchange.headers.getSetCookie().find(value => value.startsWith("smithers_setup_session="))
          expect(cookie).toBeDefined()
          const session = cookie!.split(";")[0]!.slice("smithers_setup_session=".length)
          secrets.push(session)
          persistedSessions = await persistence()
          expect(Object.keys(persistedSessions)).toEqual([`setup.session.${createHash("sha256").update(session).digest("hex")}`])
        }
        if (start === 1) {
          expect(token === setupTokens[0]).toBe(false)
          const stale = await fetch(`${origin}/setup?token=${encodeURIComponent(setupTokens[0]!)}`, { redirect: "manual" })
          expect(stale.status).toBe(401)
          const claimed = await fetch(external.control + "/claim", { method: "POST", body: JSON.stringify({ token }) })
          expect(claimed.status, "served OAuth owner claim").toBe(200)
          const result = await claimed.json() as { claimed: boolean; credentials: string[] }
          expect(result.claimed).toBe(true)
          expect(result.credentials.length).toBeGreaterThan(0)
          secrets.push(...result.credentials)
          expect(await status()).toEqual({ owners: 1, sessions: 0, digest: "" })
        }
        secrets.push(token)
        setupTokens.push(token)
      } else {
        expect(lines.length).toBe(0)
        expect(await status()).toEqual({ owners: 1, sessions: 0, digest: "" })
        const owner = await fetch(external.control + "/owner")
        expect(owner.status).toBe(200)
        expect(await owner.json()).toEqual({ install: 200, status: 403, provisional: true })
      }
      await stop()
      await drained
    }
    for (const [index, capture] of captures.entries()) {
      const allowed = capture.stdout.split(/(?<=\n)/).filter(line => line.includes('"setup_urls"'))
      expect(allowed.length).toBe(index < 2 ? 1 : 0)
      const ordinary = capture.stdout.split(/(?<=\n)/).filter(line => !line.includes('"setup_urls"')).join("") + capture.stderr
      for (const token of secrets) expect(ordinary.includes(token) || ordinary.includes(encodeURIComponent(token))).toBe(false)
    }
    const logDirectory = join(home, "Library/Application Support/Smithers/logs")
    const scanLogs = (directory: string): void => {
      if (!existsSync(directory)) return
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) scanLogs(path)
        else if (entry.isFile()) {
          const content = readFileSync(path, "utf8")
          for (const token of secrets) expect(content.includes(token) || content.includes(encodeURIComponent(token))).toBe(false)
        }
      }
    }
    scanLogs(logDirectory)
    if (receipt) writeFileSync(receipt, JSON.stringify({ check: "C-SEC-04", scope: "packaged three-start relay", passed: true,
      starts: 3, mintLines: [1, 1, 0], ownerCount: 1, setupSessions: 0,
      readinessMs, postgresMajor: 18, persistedSetupSessions: 1,
      manifestSha256: createHash("sha256").update(readFileSync(join(bundle!, "manifest.json"))).digest("hex"),
      completedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 })
  } catch (error) {
    const diagnostic = process.env.SMITHERS_SETUP_RELAY_DIAGNOSTIC
    if (diagnostic) {
      for (const capture of captures) {
        for (const line of capture.stdout.split("\n")) {
          try {
            const mint = JSON.parse(line) as { setup_urls?: string[] }
            for (const raw of mint.setup_urls ?? []) {
              const token = new URL(raw).searchParams.get("token")
              if (token) secrets.push(token)
            }
          } catch {}
        }
      }
      const redacted = captures.map(capture => {
        let stderr = capture.stderr
        for (const token of secrets) stderr = stderr.replaceAll(token, "<redacted>").replaceAll(encodeURIComponent(token), "<redacted>")
        return { stderr, observedMintLines: capture.stdout.split("\n").filter(line => line.includes('"setup_urls"')).length }
      })
      writeFileSync(diagnostic, JSON.stringify({ check: "C-SEC-04", passed: false, captures: redacted }, null, 2) + "\n", { mode: 0o600 })
    }
    throw error
  } finally {
    if (child) {
      // The launcher may fail before it installs its signal handlers. Stop
      // only backend children of this test's launcher, so private PG closes.
      const processes = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" })
      for (const line of processes.stdout.split("\n")) {
        const parts = line.trim().split(/\s+/)
        if (Number(parts[1]) === child.pid && parts.slice(2).join(" ").endsWith("/smithers-backend")) {
          try { process.kill(Number(parts[0]), "SIGTERM") } catch {}
        }
      }
      if (await Promise.race([child.exited, Bun.sleep(30_000).then(() => undefined)]) === undefined) { child.kill("SIGKILL"); await child.exited }
    }
    writeFileSync(join(temporary, "fixture-stop"), "done\n", { mode: 0o600 })
    fixture.stdin.end()
    await fixture.exited
    await fixtureOutput
    await fixtureErrors
    rmSync(temporary, { recursive: true, force: true })
  }
}, 600_000)
