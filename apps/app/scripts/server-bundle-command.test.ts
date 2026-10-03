import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join, relative, resolve } from "node:path"
import * as ProcessSandbox from "../../../packages/smithers/flows/platform-node/src/ProcessSandbox"
import { cloneBundleFixture, createBundleCloneFixture, createBundleIntegrationRunRoot, runBundleCommand, verifyBundleSpecPayload, verifyBundleWebAssets, verifyBundleHomeIsolation, verifyCodeMappings, verifyObservedProcess, verifyIndependentManifest, verifyProcessMappingSample } from "./server-bundle.integration.test"

const root = resolve(import.meta.dir, "../../..")
const scratch = join(root, ".artifacts/server-bundle-integration")
// Let the oracle's 30s command deadlines and 2s scoped cleanup finish before
// Bun's outer deadline: two version commands, or all ten smoke commands.
const versionOracleDeadline = 2 * 32_000 + 10_000
const smokeOracleDeadline = 10 * 32_000 + 10_000

const payloadFixture = () => {
  mkdirSync(scratch, { recursive: true })
  const directory = mkdtempSync(join(scratch, "spec-payload-"))
  const bundle = join(directory, "bundle")
  const source = join(directory, "source")
  const put = (path: string, bytes: string | Uint8Array): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
  }
  for (const [name, bytes] of [["jj-LICENSE", "jj license bytes\n"], ["git-COPYING", "Git license bytes\n"]]) {
    put(join(source, "distribution/licenses", name!), bytes!)
    put(join(bundle, "licenses", name!), bytes!)
  }
  const nodeLicense = join(directory, "build-node/LICENSE")
  put(nodeLicense, "Node license bytes\n")
  put(join(bundle, "licenses/node-LICENSE"), "Node license bytes\n")
  put(join(source, "packages/backend/microsandbox/guest/smithers-guest.py"), "guest helper bytes\n")
  put(join(bundle, "share/microsandbox/smithers-guest.py"), "guest helper bytes\n")
  const elf = Buffer.alloc(64)
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  elf.writeUInt16LE(2, 16)
  elf.writeUInt16LE(183, 18)
  elf.writeUInt32LE(1, 20)
  elf.writeUInt16LE(64, 52)
  put(join(bundle, "bin/linux-arm64/smithers-jj-export"), elf)
  const executable = (name: string, body: string): void => {
    put(join(bundle, "bin", name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bundle, "bin", name), 0o755)
  }
  // Unit process doubles isolate oracle failures without compiling native jj,
  // downloading Node or booting a VM. The real integration uses actual binaries.
  executable("node", 'printf "v26.4.0\\n"')
  executable("jj", 'if [ "$1" = "--version" ]; then printf "jj 0.44.0-47589ada70c12b3e829b5c98ab32503abad49eac\\n"; elif [ "$1" = "git" ]; then test -f committed; else printf "0123456789abcdef0123456789abcdef01234567"; fi')
  mkdirSync(join(bundle, "libexec/git-core"), { recursive: true })
  mkdirSync(join(bundle, "share/git-core/templates"), { recursive: true })
  executable("git", 'test "$PATH" = "/usr/bin:/bin:/usr/sbin:/sbin" || exit 11\ntest -d "$HOME" && test -d "$TMPDIR" && test -d "$GIT_EXEC_PATH" && test -d "$GIT_TEMPLATE_DIR" || exit 12\ncase "$1" in init) mkdir .git;; commit) touch committed;; rev-parse) printf "0123456789abcdef0123456789abcdef01234567\\n";; esac')
  const manifest = (): void => {
    const files: Record<string, { sha256: string; stage: string }> = {}
    for (const entry of readdirSync(bundle, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || entry.name === "manifest.json") continue
      const path = join(entry.parentPath, entry.name)
      files[relative(bundle, path)] = { sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), stage: "fixture" }
    }
    put(join(bundle, "manifest.json"), JSON.stringify({ version: 1, platform: "darwin-arm64", revision: "0123456789abcdef0123456789abcdef01234567", files }))
  }
  manifest()
  let verification: Promise<void> | undefined
  return {
    directory, bundle, source, nodeLicense, put, executable, manifest,
    verify: () => verification = verifyBundleSpecPayload(bundle, source, nodeLicense, join(directory, "oracle.log")),
    cleanup: async () => {
      // Keep fixture files available until the bounded scoped process cleanup
      // settles, including when verification rejects on its command deadline.
      await verification?.catch(() => undefined)
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

test("spec payload verifies independent source bytes and reads its packaged Git commit through jj", async () => {
  const fixture = payloadFixture()
  try {
    await fixture.verify()
    const receipt = readFileSync(join(fixture.directory, "oracle.log"), "utf8")
    expect(receipt).toContain("source bytes match: licenses/node-LICENSE")
    expect(receipt).toContain("source bytes match: licenses/jj-LICENSE")
    expect(receipt).toContain("source bytes match: licenses/git-COPYING")
    expect(receipt).toContain("source bytes match: share/microsandbox/smithers-guest.py")
    expect(receipt).toContain("Linux helper: ELF64 little-endian AArch64")
    expect(receipt).toContain("git commit --quiet")
    expect(receipt).toContain("jj log --no-graph -r @- -T commit_id")
    expect(readdirSync(fixture.directory).some((name) => name.startsWith("spec-payload-"))).toBe(false)
  } finally { await fixture.cleanup() }
}, smokeOracleDeadline)

for (const failure of ["git command", "jj reads another commit"] as const) {
  test(`spec payload rejects ${failure} and removes its private workspace`, async () => {
    const fixture = payloadFixture()
    try {
      if (failure === "git command") fixture.executable("git", "exit 7")
      else fixture.executable("jj", 'if [ "$1" = "--version" ]; then printf "jj 0.44.0-47589ada70c12b3e829b5c98ab32503abad49eac\\n"; elif [ "$1" = "git" ]; then exit 0; else printf "wrong commit"; fi')
      fixture.manifest()
      await expect(fixture.verify()).rejects.toThrow()
      expect(readdirSync(fixture.directory).some((name) => name.startsWith("spec-payload-"))).toBe(false)
    } finally { await fixture.cleanup() }
  }, smokeOracleDeadline)
}

// HTTP fixtures exercise the emitted page/asset boundary without a browser build.
for (const mode of ["valid", "missing script", "missing stylesheet", "HTML fallback", "empty script", "no script"] as const) {
  test(`web payload ${mode === "valid" ? "serves" : "rejects"} ${mode}`, async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/") return new Response(`<html><head><link rel="stylesheet" href="/assets/app.css"></head><body>${mode === "no script" ? "" : '<script type="module" src="/assets/app.js"></script>'}</body></html>`, { headers: { "content-type": "text/html" } })
        if (path === "/assets/app.css") return new Response("body {}", { status: mode === "missing stylesheet" ? 404 : 200, headers: { "content-type": "text/css" } })
        if (path === "/assets/app.js") return new Response(mode === "empty script" ? "" : "console.log('loaded')", { status: mode === "missing script" ? 404 : 200, headers: { "content-type": mode === "HTML fallback" ? "text/html" : "application/javascript" } })
        return new Response("missing", { status: 404 })
      }
    })
    try {
      const check = verifyBundleWebAssets(server.url.origin)
      if (mode === "valid") await check
      else await expect(check).rejects.toThrow()
    } finally { server.stop(true) }
  }, 55_000)
}

// Oracle: T-INS-01 Scope In; 5b77095672:apps/app/scripts/build-native.ts:23–24,240–245.
for (const path of ["licenses/node-LICENSE", "licenses/jj-LICENSE", "licenses/git-COPYING", "share/microsandbox/smithers-guest.py"]) {
  test(`spec payload rejects omitted ${path} even when the producer manifest agrees`, async () => {
    const fixture = payloadFixture()
    try {
      rmSync(join(fixture.bundle, path))
      fixture.manifest()
      await expect(fixture.verify()).rejects.toThrow()
    } finally { await fixture.cleanup() }
  })
}

for (const [name, version] of [["jj", "jj 0.44.0-other"], ["node", "v26.3.99"], ["node", "v27.0.0"]]) {
  test(`spec payload rejects packaged ${name} version ${version}`, async () => {
    const fixture = payloadFixture()
    try {
      fixture.executable(name!, `printf '%s\\n' '${version}'`)
      fixture.manifest()
      await expect(fixture.verify()).rejects.toThrow()
    } finally { await fixture.cleanup() }
  }, versionOracleDeadline)
}

for (const corruption of ["helper bytes", "license bytes", "ELF magic", "32-bit", "big-endian", "x86-64", "short ELF"] as const) {
  test(`spec payload rejects ${corruption} with a matching producer checksum`, async () => {
    const fixture = payloadFixture()
    try {
      if (corruption === "helper bytes") fixture.put(join(fixture.bundle, "share/microsandbox/smithers-guest.py"), "wrong helper")
      else if (corruption === "license bytes") fixture.put(join(fixture.bundle, "licenses/jj-LICENSE"), "wrong license")
      else {
        const path = join(fixture.bundle, "bin/linux-arm64/smithers-jj-export")
        const bytes = readFileSync(path)
        if (corruption === "ELF magic") bytes[0] = 0
        if (corruption === "32-bit") bytes[4] = 1
        if (corruption === "big-endian") bytes[5] = 2
        if (corruption === "x86-64") bytes.writeUInt16LE(62, 18)
        fixture.put(path, corruption === "short ELF" ? bytes.subarray(0, 20) : bytes)
      }
      fixture.manifest()
      await expect(fixture.verify()).rejects.toThrow()
    } finally { await fixture.cleanup() }
  })
}

test("fresh checkout cannot resolve an absent root dependency from the enclosing app", async () => {
  const directory = createBundleIntegrationRunRoot(root)
  const declaration = join(directory, "source/.smithers/WORKSPACE.ts")
  mkdirSync(dirname(declaration), { recursive: true })
  writeFileSync(declaration, "export {}\n")
  try {
    const result = await runBundleCommand(["node", "--input-type=module", "-e", `
import { findPackageJSON } from "node:module"
import { pathToFileURL } from "node:url"
import { realpathSync } from "node:fs"
// The real app installs core, while the workspace root intentionally omits it
// under the build CLI's existing bootstrap contract.
const app = findPackageJSON("@smthrs/core", pathToFileURL(${JSON.stringify(join(root, "apps/app/PACKAGE.ts"))}))
let checkout
try {
  checkout = { found: realpathSync(findPackageJSON("@smthrs/core", pathToFileURL(${JSON.stringify(declaration)}))) }
} catch (error) {
  checkout = { code: error.code }
}
console.log(JSON.stringify({ app: realpathSync(app), checkout }))
`], join(directory, "resolution.log"), { cwd: directory, timeout: 10_000 })
    const receipt = JSON.parse(result.stdout)
    expect(receipt.app).toBe(realpathSync(join(root, "packages/smithers/flows/core/package.json")))
    expect(receipt.checkout).toEqual({ code: "ERR_MODULE_NOT_FOUND" })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 20_000)

test("clone fixture refuses abbreviated revisions before creating files", () => {
  mkdirSync(scratch, { recursive: true })
  const directory = mkdtempSync(join(scratch, "clone-invalid-"))
  const fixture = join(directory, "fixture.git")
  try {
    for (const revision of ["", "1234567890", "x".repeat(40), "a".repeat(41)]) {
      expect(() => createBundleCloneFixture(join(directory, "missing-store"), revision, fixture))
        .toThrow("clone fixture requires a full committed revision")
      expect(existsSync(fixture)).toBe(false)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("clone fixture exposes an unbookmarked selected revision without changing the original store", async () => {
  // C-INS-05 Setup requires a fresh clone at commit X. A jj-only commit need
  // not have a Git ref; the temporary fixture must advertise X independently.
  mkdirSync(scratch, { recursive: true })
  const directory = mkdtempSync(join(scratch, "clone-selected-"))
  const original = join(directory, "original")
  const backingStore = join(original, ".git")
  const fixture = join(directory, "fixture.git")
  const clone = join(directory, "clone")
  const command = (args: string[], cwd = directory) => runBundleCommand([
    "jj", "--config", 'user.name="Bundle fixture"', "--config", 'user.email="fixture@example.test"', ...args
  ], join(directory, "clone.log"), { cwd, timeout: 30_000 })
  const snapshot = (): Record<string, string> => Object.fromEntries(
    readdirSync(backingStore, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = join(entry.parentPath, entry.name)
        return [relative(backingStore, file), readFileSync(file).toString("base64")]
      })
  )
  try {
    await command(["git", "init", "--colocate", original])
    writeFileSync(join(original, "ancestor.txt"), "ancestor source\n")
    await command(["commit", "-m", "ancestor source revision"], original)
    const ancestor = (await command([
      "--ignore-working-copy", "log", "-r", "@-", "--no-graph", "-T", "commit_id"
    ], original)).stdout.trim()
    writeFileSync(join(original, "selected.txt"), "selected committed source\n")
    await command(["commit", "-m", "selected source revision"], original)
    const revision = (await command([
      "--ignore-working-copy", "log", "-r", "@-", "--no-graph", "-T", "commit_id"
    ], original)).stdout.trim()
    expect(revision).toMatch(/^[a-f0-9]{40}$/)
    writeFileSync(join(original, "selected.txt"), "later committed source\n")
    await command(["commit", "-m", "later source revision"], original)
    expect((await command(["bookmark", "list", "--all-remotes"], original)).stdout.trim()).toBe("")
    const before = snapshot()

    createBundleCloneFixture(backingStore, revision, fixture)
    expect(readFileSync(join(fixture, "HEAD"), "utf8")).toBe("ref: refs/heads/reference-build\n")
    expect(readFileSync(join(fixture, "refs/heads/reference-build"), "utf8")).toBe(`${revision}\n`)
    expect(readFileSync(join(fixture, "objects/info/alternates"), "utf8"))
      .toBe(`${realpathSync(join(backingStore, "objects"))}\n`)
    expect(readFileSync(join(fixture, "config"), "utf8")).toContain("bare = true")
    expect(() => createBundleCloneFixture(backingStore, revision, fixture)).toThrow()

    await cloneBundleFixture(fixture, clone, join(directory, "clone.log"), { cwd: directory })
    await command(["new", revision], clone)
    const cloned = await command([
      "--ignore-working-copy", "log", "-r", "@-", "--no-graph", "-T", "commit_id"
    ], clone)
    expect(cloned.stdout.trim()).toBe(revision)
    expect(readFileSync(join(clone, "selected.txt"), "utf8")).toBe("selected committed source\n")
    expect(readFileSync(join(clone, "ancestor.txt"), "utf8")).toBe("ancestor source\n")
    expect(readFileSync(join(clone, ".git/shallow"), "utf8").trim()).toBe(revision)
    const history = await runBundleCommand([
      "jj", "--ignore-working-copy", "log", "-r", ancestor, "--no-graph", "-T", "commit_id"
    ], join(directory, "clone.log"), { cwd: clone, allowFailure: true, timeout: 10_000 })
    expect(history.exitCode).not.toBe(0)
    expect(history.stderr).toContain(`Revision \`${ancestor}\` doesn't exist`)
    expect(snapshot()).toEqual(before)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)

test.skipIf(process.platform !== "darwin")("ordinary confinement permits actual process and dylib evidence with a deep private TMPDIR", async () => {
  // Load the build package with its own runtime contract; its ES2024 source
  // declarations are outside this app's ES2022 compilation boundary.
  const ExecSandbox = await import(join(root, "packages/smithers/build/targets/src/ExecSandbox.ts"))
  mkdirSync(scratch, { recursive: true })
  const directory = mkdtempSync(join(scratch, "target-"))
  const runner = join(directory, "runner.ts")
  const result = join(directory, "result.json")
  const tmp = join(directory, "source/.flows/sandbox/owned-preflight")
  const helper = join(root, "apps/app/scripts/server-bundle.integration.test.ts")
  writeFileSync(runner, `
import { writeFileSync } from "node:fs"
import { runBundleCommand } from ${JSON.stringify(helper)}
const rows = await runBundleCommand(["/usr/sbin/lsof", "-nP", "-R", "-d", "txt", "-F", "pRc"], ${JSON.stringify(join(directory, "processes.log"))}, { cwd: ${JSON.stringify(root)}, timeout: 10000 })
const maps = await runBundleCommand(["/usr/sbin/lsof", "-nP", "-p", String(process.pid), "-F", "ftn"], ${JSON.stringify(join(directory, "lsof.log"))}, { cwd: ${JSON.stringify(root)}, timeout: 10000 })
writeFileSync(${JSON.stringify(result)}, JSON.stringify({ rows: rows.stdout, maps: maps.stdout, pid: process.pid, executable: process.execPath, tmp: process.env.TMPDIR }))
`)
  const facts = ProcessSandbox.host()
  const plan = ExecSandbox.plan({ policy: undefined, reads: ["."], writes: [relative(root, directory)] }, {
    workspaceRoot: root, cwd: root, tmp
  }, facts)
  if (!plan || ExecSandbox.isUnenforceable(plan)) throw new Error("Expected ordinary confinement")
  const wrapped = ProcessSandbox.wrap(plan, [process.execPath, "--no-env-file", "--no-install", "--config=/dev/null", runner], {}, facts)
  for (const name of ["HOME", "TMPDIR", "XDG_CACHE_HOME"]) {
    const path = wrapped.env[name]
    if (path) mkdirSync(path, { recursive: true })
  }
  try {
    const child = Bun.spawn([...wrapped.argv], { cwd: root, env: { ...process.env, ...wrapped.env }, stdout: "pipe", stderr: "pipe" })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    const receipt = JSON.parse(readFileSync(result, "utf8"))
    expect(receipt.rows).toContain(`p${receipt.pid}\n`)
    expect(receipt.rows).toContain("R")
    expect(receipt.maps).toContain(receipt.executable)
    expect(receipt.tmp).toBe(tmp)
    expect(Buffer.byteLength(tmp)).toBeGreaterThan(103)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)

test("failed commands retain both streams and their exit diagnostic", async () => {
  mkdirSync(scratch, { recursive: true })
  const directory = mkdtempSync(join(scratch, "command-failure-"))
  const log = join(directory, "command.log")
  try {
    await expect(runBundleCommand([
      process.execPath, "-e", 'console.log("stdout receipt"); console.error("stderr receipt"); process.exit(7)'
    ], log, { cwd: root, timeout: 10_000 })).rejects.toThrow("failed")
    const receipt = readFileSync(log, "utf8")
    expect(receipt).toContain("stdout receipt\n")
    expect(receipt).toContain("stderr receipt\n")
    expect(receipt).toContain("exit=7")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 20_000)

for (const refuseObservation of [false, true]) {
test.skipIf(process.platform !== "darwin")(`confined timeout reaps an owned grandchild and preserves ${refuseObservation ? "the original failure when cleanup observation is refused" : "partial logs"}`, async () => {
  mkdirSync(scratch, { recursive: true })
  const directory = mkdtempSync(join(scratch, "ct-"))
  const log = join(directory, "command.log")
  const result = join(directory, "result.json")
  const pidFile = join(directory, "grandchild.pid")
  const fixture = join(directory, "leader.ts")
  const runner = join(directory, "runner.ts")
  const helper = join(root, "apps/app/scripts/server-bundle.integration.test.ts")
  writeFileSync(fixture, `
import { writeFileSync } from "node:fs"
const child = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM", () => {}); console.log("grandchild partial stdout"); console.error("grandchild partial stderr"); setInterval(() => {}, 1000)'], {
  stdin: "ignore", stdout: "inherit", stderr: "inherit"
})
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
console.log("leader partial stdout")
setInterval(() => {}, 1000)
`)
  writeFileSync(runner, `
import { writeFileSync } from "node:fs"
import { runBundleCommand } from ${JSON.stringify(helper)}
const started = performance.now()
try {
  await runBundleCommand([process.execPath, ${JSON.stringify(fixture)}], ${JSON.stringify(log)}, {
    cwd: ${JSON.stringify(root)}, timeout: 2000, cleanupGraceMs: 200
  })
  throw new Error("timeout was not reported")
} catch (error) {
  writeFileSync(${JSON.stringify(result)}, JSON.stringify({ error: String(error), elapsed: performance.now() - started }))
}
`)
  const facts = ProcessSandbox.host()
  const plan = ProcessSandbox.plan({
    strict: true, network: "none",
    // Installed modules resolve through workspace symlinks. Reads stay within
    // the workspace; writes and process control retain the strict policy.
    reads: ["."],
    externalReads: [dirname(process.execPath)],
    writes: [relative(root, directory)]
  }, { workspaceRoot: root, cwd: root, tmp: join(directory, "tmp") }, facts)
  expect(ProcessSandbox.isUnenforceable(plan)).toBe(false)
  if (ProcessSandbox.isUnenforceable(plan)) throw new Error(plan.message)
  const wrapped = ProcessSandbox.wrap(plan, [process.execPath, "--no-env-file", "--no-install", "--config=/dev/null", runner], {}, facts)
  const argv = [...wrapped.argv]
  if (refuseObservation) {
    // A real kernel refusal, not a mocked kill: the existing cleanup protocol
    // must retain its diagnostic without hiding the original command timeout.
    argv[2] += '\n(deny process-exec (literal "/bin/ps"))'
  }
  for (const name of ["HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
    const path = wrapped.env[name]
    if (path) mkdirSync(path, { recursive: true })
  }
  try {
    const child = Bun.spawn(argv, {
      cwd: root, env: { ...process.env, ...wrapped.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdout: "pipe", stderr: "pipe", stdin: "ignore"
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
    ])
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    const receipt = JSON.parse(readFileSync(result, "utf8"))
    expect(receipt.error).toContain("Command timed out after 2000 ms")
    expect(receipt.error).not.toContain("EPERM")
    expect(receipt.elapsed).toBeLessThan(10_000)
    const output = readFileSync(log, "utf8")
    expect(output).toContain("leader partial stdout\n")
    expect(output).toContain("grandchild partial stdout\n")
    expect(output).toContain("grandchild partial stderr\n")
    if (refuseObservation) {
      expect(output).toContain("cleanup:")
      expect(output).toContain("Descendant observation unavailable")
      expect(output).toContain("EPERM")
    }
    expect(existsSync(pidFile)).toBe(true)
    const grandchild = Number(readFileSync(pidFile, "utf8"))
    let state = ""
    for (let attempt = 0; attempt < 20; attempt++) {
      const probe = Bun.spawn(["/bin/ps", "-o", "stat=", "-p", String(grandchild)], { stdout: "pipe", stderr: "ignore" })
      state = (await new Response(probe.stdout).text()).trim()
      await probe.exited
      if (!state || state.startsWith("Z")) break
      await Bun.sleep(50)
    }
    // A terminated orphan can briefly await launchd's reap; it no longer owns
    // the inherited pipe or executes user code.
    expect(state === "" || state.startsWith("Z"), `grandchild ${grandchild}: ${state}; ${output}; ${JSON.stringify(receipt)}`).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
}

// C-INS-05 mapping evidence must fail closed, including the harness exception.
test("mapping inspection rejects missing evidence and foreign code", () => {
  expect(() => verifyCodeMappings(1, [], () => true)).toThrow("inspection failed")
  expect(() => verifyCodeMappings(0, [], () => true)).toThrow("no executable mapping")
  expect(() => verifyCodeMappings(0, ["/Users/operator/node"], () => false)).toThrow("outside")
  expect(() => verifyCodeMappings(0, ["/usr/lib/system.dylib"], () => true)).not.toThrow()
})
test("manifest rejects developer home paths independently of producer", () => {
  const directory = mkdtempSync(join(scratch, "home-isolation-"))
  try {
    writeFileSync(join(directory, "manifest.json"), '{"files":{"/Users/operator/node":{}}}')
    expect(() => verifyBundleHomeIsolation(directory)).toThrow("developer home")
    writeFileSync(join(directory, "manifest.json"), '{"files":{"\\u002fUsers\\u002foperator\\u002fnode":{}}}')
    expect(() => verifyBundleHomeIsolation(directory)).toThrow("developer home")
    writeFileSync(join(directory, "manifest.json"), '{"files":{"bin/node":{}}}')
    expect(() => verifyBundleHomeIsolation(directory)).not.toThrow()
    symlinkSync(join(directory, "manifest.json"), join(directory, "inside"))
    expect(() => verifyBundleHomeIsolation(directory)).not.toThrow()
    symlinkSync(process.execPath, join(directory, "outside"))
    expect(() => verifyBundleHomeIsolation(directory)).toThrow("escapes prefix")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("process evidence permits only an already observed completed harness", () => {
  for (const previouslyObserved of [false, true]) {
    expect(() => verifyObservedProcess(false, previouslyObserved, false)).toThrow("no process evidence")
  }
  expect(() => verifyObservedProcess(false, false, true)).toThrow("no process evidence")
  expect(() => verifyObservedProcess(false, true, true)).not.toThrow()
  expect(() => verifyObservedProcess(true, false, false)).not.toThrow()
})

// C-INS-05 step 3: independent inventory, bytes and literal required payloads.
test("independent manifest oracle refuses inventory, hashes and omitted web payload", () => {
  const fixture = payloadFixture()
  try {
    expect(() => verifyIndependentManifest(fixture.bundle)).toThrow("required payload")
    writeFileSync(join(fixture.bundle, "unlisted"), "payload")
    expect(() => verifyIndependentManifest(fixture.bundle)).toThrow("inventory")
    rmSync(join(fixture.bundle, "unlisted"))
    writeFileSync(join(fixture.bundle, "licenses/jj-LICENSE"), "changed")
    expect(() => verifyIndependentManifest(fixture.bundle)).toThrow("hash mismatch")
  } finally { rmSync(fixture.directory, { recursive: true, force: true }) }
})
test("exited child mapping race is accepted only after fresh absence evidence", () => {
  expect(() => verifyProcessMappingSample(false, false, 1, [], () => true)).not.toThrow()
  expect(() => verifyProcessMappingSample(false, true, 1, [], () => true)).toThrow()
  expect(() => verifyProcessMappingSample(true, false, 1, [], () => true)).toThrow()
  expect(() => verifyProcessMappingSample(false, true, 0, [], () => true)).toThrow()
  expect(() => verifyProcessMappingSample(false, true, 0, ["foreign"], () => false)).toThrow()
  expect(() => verifyProcessMappingSample(false, false, 1, ["foreign"], () => false)).toThrow("outside")
})

test("independent manifest oracle accepts complete payload and hashes PostgreSQL resources", () => {
  const fixture = payloadFixture()
  try {
    // T-INS-01 Scope In + C-INS-05 step3: literal required layout.
    for (const path of [
      "bin/smithers-server", "bin/smithers-backend", "bin/smithers-coding-host",
      "bin/smithers-model-host", "bin/msb", "bin/libsmithers_ffi.dylib",
      "bin/smithers-jj-export", "bin/flow-hosts.json", "lib/libkrunfw.5.dylib",
      "postgres/bundle.json", "postgres/runtime/bin/postgres", "postgres/runtime/bin/initdb",
      "postgres/runtime/bin/pg_isready", "postgres/runtime/bin/psql",
      "postgres/runtime/bin/pg_dump", "postgres/runtime/bin/pg_restore",
      "postgres/runtime/share/postgresql/postgres.bki",
      "postgres/runtime/share/postgresql/postgresql.conf.sample",
      "postgres/runtime/lib/postgresql/test.dylib", "views/mainview/index.html",
      "views/mainview/assets/main.js", "libexec/git-core/git-commit",
      "share/git-core/templates/HEAD", "share/microsandbox/base-image.oci.tar",
      "share/microsandbox/base-image.json"
    ]) fixture.put(join(fixture.bundle, path), "fixture bytes")
    fixture.manifest()
    expect(() => verifyIndependentManifest(fixture.bundle)).not.toThrow()
    const resource = join(fixture.bundle, "postgres/runtime/share/postgresql/postgres.bki")
    writeFileSync(resource, "corrupted catalog")
    expect(() => verifyIndependentManifest(fixture.bundle)).toThrow("hash mismatch")
    rmSync(resource)
    fixture.manifest() // A producer that omitted required resources still fails.
    expect(() => verifyIndependentManifest(fixture.bundle)).toThrow("required payload")
  } finally { rmSync(fixture.directory, { recursive: true, force: true }) }
})
