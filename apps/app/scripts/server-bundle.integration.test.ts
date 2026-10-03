import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync
} from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { Cause, Effect, Exit, Scope, Stream } from "effect"
import * as ScopedProcess from "../../../packages/smithers/flows/platform-node/src/ScopedProcess"

// Deliberately a CLI, not a bun:test suite: ordinary script unit-test discovery
// must never clone, build, start PostgreSQL, or boot a VM.
const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin"
const offlineProfile = "(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote unix-socket))"
const origin = "http://127.0.0.1:4000"

type Environment = Record<string, string>
type CommandResult = { stdout: string; stderr: string; exitCode: number }

const toolchainEnvironment = (): Environment => Object.fromEntries(
  Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && !name.startsWith("SMITHERS_") && !name.startsWith("MSB_")
  )
) as Environment

export interface BundleCommandOptions {
  cwd?: string; env?: Environment; timeout?: number; allowFailure?: boolean;
  record?: boolean; observe?: (pid: number) => Promise<void>; cleanupGraceMs?: number
}

/** Stream receipts before waiting: a timeout must retain the tool's last output. */
export const runBundleCommand = async (
  argv: string[], logPath: string, options: BundleCommandOptions = {}
): Promise<CommandResult> => {
  const record = (text: string): void => {
    if (options.record !== false) appendFileSync(logPath, text)
  }
  record(`$ ${argv.join(" ")}\n`)
  let originalError: unknown
  let monitoring = true
  const program = Effect.gen(function*() {
    // The shared supervisor owns the tree, including grandchildren holding
    // inherited pipes. It keeps signaling inside the existing Exec boundary.
    const child = yield* ScopedProcess.spawn({
      command: argv[0]!, args: argv.slice(1), cwd: options.cwd,
      env: options.env ?? process.env, stdin: "ignore", killSignal: "SIGTERM",
      forceKillAfter: options.cleanupGraceMs ?? 2_000
    })
    record(`pid=${child.targetPid}\n`)
    yield* Effect.addFinalizer(() => child.kill({
      killSignal: "SIGTERM", forceKillAfter: options.cleanupGraceMs ?? 2_000
    }).pipe(Effect.catchCause((cause) => Effect.sync(() =>
      record(`cleanup: ${String(Cause.squash(cause))}\n`)
    ))))
    const consume = (stream: typeof child.stdout) => {
      const decoder = new TextDecoder()
      const chunks: string[] = []
      return Stream.runForEach(stream, (chunk) => Effect.sync(() => {
        const text = decoder.decode(chunk, { stream: true })
        chunks.push(text)
        record(text)
      })).pipe(Effect.andThen(Effect.sync(() => {
        const tail = decoder.decode()
        record(tail)
        return chunks.join("") + tail
      })))
    }
    const monitor = options.observe ? Effect.promise(async (signal) => {
      while (monitoring && !signal.aborted) {
        await options.observe!(child.targetPid)
        await Bun.sleep(150)
      }
    }) : Effect.void
    const run = Effect.all([
      ScopedProcess.status(child).pipe(Effect.tap(() => Effect.sync(() => { monitoring = false }))),
      consume(child.stdout), consume(child.stderr), monitor
    ], { concurrency: "unbounded" }).pipe(Effect.timeoutOrElse({
      duration: options.timeout ?? 120_000,
      orElse: () => Effect.fail(new Error(`Command timed out after ${options.timeout ?? 120_000} ms: ${argv.join(" ")}`))
    }))
    // Capture the tool/timeout failure before scope finalizers run. Cleanup
    // diagnostics can never replace this cause, even if containment refuses.
    const result = yield* Effect.exit(run)
    if (Exit.isFailure(result)) {
      originalError = Cause.squash(result.cause)
      record(`\nerror: ${String(originalError)}\n`)
    } else {
      const [status, , stderr] = result.value
      const exitCode = status.code ?? 128
      record(`\nexit=${exitCode}${status.signal ? ` signal=${status.signal}` : ""}\n`)
      if (!options.allowFailure && exitCode !== 0) {
        originalError = new Error(`${argv[0]} failed with exit ${exitCode}; see ${logPath}\n${stderr}`)
      }
    }
    return result
  })
  try {
    const result = await Effect.runPromise(Effect.scoped(program))
    if (originalError !== undefined) throw originalError
    if (Exit.isFailure(result)) throw Cause.squash(result.cause)
    const [status, stdout, stderr] = result.value
    const exitCode = status.code ?? 128
    return { stdout, stderr, exitCode }
  } catch (error) {
    if (originalError !== undefined && originalError !== error) {
      record(`cleanup: ${String(error)}\n`)
      throw originalError
    }
    record(`\nerror: ${String(error)}\n`)
    throw error
  } finally {
    monitoring = false
  }
}

// A jj workspace may point at a shared repository rather than contain .git.
const gitBackingStore = (root: string): string => {
  const marker = join(root, ".jj", "repo")
  const repository = lstatSync(marker).isDirectory()
    ? marker
    : resolve(dirname(marker), readFileSync(marker, "utf8").trim())
  const store = join(repository, "store")
  return realpathSync(resolve(store, readFileSync(join(store, "git_target"), "utf8").trim()))
}

/** Advertise one committed revision without writing refs in the shared repository. */
export const createBundleCloneFixture = (backingStore: string, revision: string, fixture: string): void => {
  assert.match(revision, /^[a-f0-9]{40}$/i, "clone fixture requires a full committed revision")
  const objects = realpathSync(join(backingStore, "objects"))
  assert.doesNotMatch(objects, /[\r\n]/, "alternate object path must occupy one line")
  mkdirSync(fixture)
  mkdirSync(join(fixture, "objects/info"), { recursive: true })
  mkdirSync(join(fixture, "refs/heads"), { recursive: true })
  writeFileSync(join(fixture, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = true\n")
  writeFileSync(join(fixture, "HEAD"), "ref: refs/heads/reference-build\n")
  writeFileSync(join(fixture, "refs/heads/reference-build"), `${revision}\n`)
  writeFileSync(join(fixture, "objects/info/alternates"), `${objects}\n`)
}

export const createBundleIntegrationRunRoot = (root: string): string => {
  // A clone nested below apps/app would inherit that app's node_modules for
  // dependencies absent from the clone root, breaking physical runtime checks.
  const scratch = join(root, ".artifacts/server-bundle-integration")
  mkdirSync(scratch, { recursive: true })
  return mkdtempSync(join(scratch, "run-"))
}

export const cloneBundleFixture = (
  fixture: string, source: string, logPath: string, options: BundleCommandOptions = {}
): Promise<CommandResult> => {
  // C-INS-05 Setup requires the clean source snapshot at X; ancestor history
  // is unnecessary and would spend the clone deadline importing old commits.
  return runBundleCommand([
    "jj", "git", "clone", "--colocate", "--depth", "1", fixture, source
  ], logPath, { ...options, timeout: 5 * 60_000 })
}

// C-INS-05 Fail when: a developer-home path appears in the manifest.
export const verifyBundleHomeIsolation = (bundle: string): void => {
  const manifest = JSON.stringify(JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")))
  assert.doesNotMatch(manifest, /\/(?:Users|home)\//, "developer home path in bundle manifest")
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      assert.doesNotMatch(path.slice(bundle.length), /\/(?:Users|home)\//, "developer home hierarchy in bundle")
      if (entry.isSymbolicLink()) assert.ok(realpathSync(path).startsWith(realpathSync(bundle) + sep), `bundle symlink escapes prefix: ${path}`)
      else if (entry.isDirectory()) visit(path)
    }
  }
  visit(bundle)
}

export const verifyObservedProcess = (present: boolean, previouslyObserved: boolean, harness: boolean): void => {
  assert.ok(present || harness && previouslyObserved, "no process evidence")
}

export const verifyCodeMappings = (exitCode: number, mappings: readonly string[], allowed: (path: string) => boolean): void => {
  assert.equal(exitCode, 0, "code mapping inspection failed")
  assert.ok(mappings.length > 0, "no executable mapping")
  for (const path of mappings) assert.ok(allowed(path), `loaded code outside the bundle or OS: ${path}`)
}

export const verifyBundleSpecPayload = async (
  bundle: string, sourceRoot: string, nodeLicenseSource: string, logPath: string,
  options: BundleCommandOptions = {}
): Promise<void> => {
  // T-INS-01 Scope In restores 5b77095672:build-native.ts:240–245 and the guest helper.
  // Source bytes are the oracle; the assembler's file list and hashes are not.
  for (const [payload, original] of [
    ["licenses/node-LICENSE", nodeLicenseSource],
    ["licenses/jj-LICENSE", join(sourceRoot, "distribution/licenses/jj-LICENSE")],
    ["licenses/git-COPYING", join(sourceRoot, "distribution/licenses/git-COPYING")],
    ["share/microsandbox/smithers-guest.py", join(sourceRoot, "packages/backend/microsandbox/guest/smithers-guest.py")]
  ]) {
    const expected = readFileSync(original!)
    assert.ok(expected.length > 0, `empty source payload: ${original}`)
    assert.deepEqual(readFileSync(join(bundle, payload!)), expected, `shipped payload differs from source: ${payload}`)
    appendFileSync(logPath, `source bytes match: ${payload}\n`)
  }
  // T-INS-01's linux-arm64 helper: ELF ABI EI_CLASS=2, EI_DATA=1,
  // EV_CURRENT=1 and EM_AARCH64=183, independent of the producer's checksum.
  const helper = readFileSync(join(bundle, "bin/linux-arm64/smithers-jj-export"))
  assert.ok(helper.length >= 64, "Linux helper requires a complete ELF64 header")
  assert.deepEqual([...helper.subarray(0, 7)], [0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], "Linux helper must be little-endian ELF64")
  assert.equal(helper.readUInt16LE(18), 183, "Linux helper must target AArch64")
  assert.equal(helper.readUInt32LE(20), 1, "Linux helper requires current ELF version")
  assert.equal(helper.readUInt16LE(52), 64, "Linux helper requires ELF64 header size")
  appendFileSync(logPath, "Linux helper: ELF64 little-endian AArch64\n")

  const temporary = mkdtempSync(join(dirname(logPath), "spec-payload-"))
  const smoke = join(temporary, "repository")
  const home = join(temporary, "home")
  const tmp = join(temporary, "tmp")
  for (const path of [smoke, home, tmp]) mkdirSync(path)
  const env = {
    HOME: home, TMPDIR: tmp, PATH: systemPath,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: temporary,
    GIT_EXEC_PATH: join(bundle, "libexec/git-core"), GIT_TEMPLATE_DIR: join(bundle, "share/git-core/templates")
  }
  const command = (argv: string[]) => runBundleCommand(argv, logPath, {
    ...options, cwd: smoke, env, allowFailure: false, timeout: options.timeout ?? 30_000
  })
  try {
    const node = await command([join(bundle, "bin/node"), "--version"])
    const version = /^v26\.(\d+)\.\d+$/.exec(node.stdout.trim())
    assert.ok(version && Number(version[1]) >= 4, "packaged Node must be Node 26.4 or later within Node 26")
    // T-INS-01 Scope In names the exact jj pin restored from
    // 5b77095672:apps/app/scripts/build-native.ts:23–24,182–195.
    const jj = join(bundle, "bin/jj")
    assert.equal((await command([jj, "--version"])).stdout.trim(), "jj 0.44.0-47589ada70c12b3e829b5c98ab32503abad49eac", "packaged jj differs from the historical pin")
    const git = join(bundle, "bin/git")
    await command([git, "init", "--quiet"])
    await command([git, "config", "user.name", "Bundle spec check"])
    await command([git, "config", "user.email", "bundle-spec@smithers.invalid"])
    writeFileSync(join(smoke, "README"), "relocated bundled Git and jj\n")
    await command([git, "add", "README"])
    await command([git, "commit", "--quiet", "-m", "bundle spec check"])
    const commit = (await command([git, "rev-parse", "HEAD"])).stdout.trim()
    assert.match(commit, /^[0-9a-f]{40}$/)
    await command([jj, "git", "init", "--colocate"])
    assert.equal((await command([jj, "log", "--no-graph", "-r", "@-", "-T", "commit_id"])).stdout.trim(), commit, "packaged jj must read the packaged Git commit")
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export const verifyBundleWebAssets = async (serverOrigin: string): Promise<void> => {
  // T-INS-01 Scope In restores the actual web bundle, not just API readiness.
  const page = await fetch(serverOrigin + "/", { signal: AbortSignal.timeout(15_000) })
  assert.equal(page.status, 200, "bundled index must be served")
  const html = await page.text()
  let scripts = 0
  for (const tag of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const script = tag[1]!.toLowerCase() === "script"
    if (!script && !/\brel\s*=\s*["']stylesheet["']/i.test(tag[0])) continue
    const value = new RegExp(`\\b${script ? "src" : "href"}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag[0])?.[1]
    if (!value) continue
    const url = new URL(value, serverOrigin)
    if (url.origin !== new URL(serverOrigin).origin) continue
    if (script) scripts++
    const asset = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    assert.equal(asset.status, 200, `bundled asset unavailable: ${url.pathname}`)
    assert.match(asset.headers.get("content-type") ?? "", script ? /(?:java|ecma)script/i : /text\/css/i, `bundled asset has wrong content type: ${url.pathname}`)
    assert.ok((await asset.arrayBuffer()).byteLength > 0, `bundled asset is empty: ${url.pathname}`)
  }
  assert.ok(scripts > 0, "bundled index must reference a local script")
}

const goProbe = `package main
import (
  "context"
  "fmt"
  "os"
  "os/signal"
  "syscall"
  "time"
  "github.com/smithersai/smithers/packages/backend/microsandbox"
  workspace "github.com/smithersai/smithers/packages/backend/workspace"
)
func run() (failure error) {
  interrupted, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
  defer stopSignals()
  ctx, cancel := context.WithTimeout(interrupted, 10*time.Minute)
  defer cancel()
  runtime, err := microsandbox.New(ctx, microsandbox.Config{
    Binary: os.Args[1], Root: os.Args[2], CPUs: 2, MemoryMiB: 2048,
    DiskMiB: 8192, MaxRunningVMs: 1,
  })
  if err != nil { return err }
  defer runtime.Close()
  op := workspace.WithOperation(ctx, workspace.Operation{
    TenantID: "bundle-check", PrincipalID: "bundle-check", OperationID: "C-INS-05",
  })
  const id = "bundle-first-boot"
  // Register cleanup before creation: a failed boot can still leave a VM.
  defer func() {
    cleanup, stop := context.WithTimeout(context.Background(), 2*time.Minute)
    defer stop()
    cleanup = workspace.WithOperation(cleanup, workspace.Operation{
      TenantID: "bundle-check", PrincipalID: "bundle-check", OperationID: "C-INS-05-cleanup",
    })
    if err := runtime.DeleteWorkspace(cleanup, id); err != nil && failure == nil { failure = err }
  }()
  if _, err := runtime.CreateWorkspace(op, workspace.WorkspaceSpec{ID: id}); err != nil { return err }
  result, err := runtime.ExecuteCommand(op, id, workspace.Command{Args: []string{"/bin/sh", "-c", "echo ok"}})
  if err != nil { return err }
  if result.ExitCode != 0 || result.Stdout != "ok\\n" || result.Stderr != "" {
    return fmt.Errorf("guest command: exit %d stdout %q stderr %q", result.ExitCode, result.Stdout, result.Stderr)
  }
  fmt.Print(result.Stdout)
  return nil
}
func main() { if err := run(); err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) } }
`

// C-INS-05 step 3 and T-INS-01 Scope In: literal layout, independent of
// production traversal/resolvers. Symlinks hash their link text, regular files
// hash bytes; every entry is checked, including PostgreSQL resources.
export const verifyIndependentManifest = (bundle: string): void => {
  const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"))
  assert.equal(manifest.version, 1)
  assert.equal(manifest.platform, "darwin-arm64")
  assert.match(manifest.revision, /^[0-9a-f]{40,64}$/)
  assert.ok(manifest.files && typeof manifest.files === "object" && !Array.isArray(manifest.files))
  const entries = readdirSync(bundle, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name).slice(bundle.length + 1))
    .filter((path) => path !== "manifest.json").sort()
  assert.deepEqual(Object.keys(manifest.files).sort(), entries, "manifest inventory differs from disk")
  for (const path of entries) {
    assert.ok(!path.split("/").some((part) => part === ".." || part === "." || part === ""), "unsafe manifest path")
    const full = join(bundle, path)
    const info = lstatSync(full)
    assert.ok(info.isFile() || info.isSymbolicLink(), "unsupported payload")
    const bytes = info.isSymbolicLink() ? readlinkSync(full) : readFileSync(full)
    const entry = manifest.files[path]
    assert.ok(typeof entry.stage === "string" && entry.stage.trim(), `missing stage: ${path}`)
    assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"), `hash mismatch: ${path}`)
  }
  for (const path of [
    "bin/smithers-server", "bin/smithers-backend", "bin/smithers-coding-host",
    "bin/smithers-model-host", "bin/node", "bin/git", "bin/jj", "bin/msb",
    "bin/libsmithers_ffi.dylib", "bin/smithers-jj-export", "bin/flow-hosts.json",
    "bin/linux-arm64/smithers-jj-export", "lib/libkrunfw.5.dylib",
    "postgres/bundle.json", "postgres/runtime/bin/postgres", "postgres/runtime/bin/initdb",
    "postgres/runtime/bin/pg_isready", "postgres/runtime/bin/psql",
    "postgres/runtime/bin/pg_dump", "postgres/runtime/bin/pg_restore",
    "postgres/runtime/share/postgresql/postgres.bki",
    "postgres/runtime/share/postgresql/postgresql.conf.sample",
    "views/mainview/index.html", "share/microsandbox/base-image.oci.tar",
    "share/microsandbox/base-image.json", "share/microsandbox/smithers-guest.py",
    "licenses/node-LICENSE", "licenses/jj-LICENSE", "licenses/git-COPYING"
  ]) assert.ok(entries.includes(path), `required payload missing: ${path}`)
  for (const prefix of ["libexec/git-core/", "share/git-core/templates/", "postgres/runtime/lib/", "views/mainview/assets/"])
    assert.ok(entries.some((path) => path.startsWith(prefix)), `required payload directory missing: ${prefix}`)
  verifyBundleHomeIsolation(bundle)
}

export const verifyProcessMappingSample = (
  root: boolean, presentAfterInspection: boolean, exitCode: number,
  mappings: readonly string[], allowed: (path: string) => boolean
): void => {
  // A child that vanished between lsof calls cannot supply live maps. A live
  // process (including the probe) and the launcher root always fail closed.
  for (const path of mappings) assert.ok(allowed(path), `loaded code outside the bundle or OS: ${path}`)
  if (!root && !presentAfterInspection && (exitCode !== 0 || mappings.length === 0)) return
  verifyCodeMappings(exitCode, mappings, allowed)
}

export const runServerBundleIntegration = async (): Promise<void> => {
  // T-INS-01 and C-INS-05 Setup prescribe Apple Silicon, macOS 15+, a
  // fresh checkout at commit X, and an empty launch state directory.
  assert.equal(process.platform, "darwin", "C-INS-05 requires macOS")
  assert.equal(process.arch, "arm64", "C-INS-05 requires Apple Silicon")
  const revision = process.env.SMITHERS_BUILD_SHA?.trim() ?? ""
  assert.match(revision, /^[a-f0-9]{40}$/i, "set SMITHERS_BUILD_SHA to the full committed revision under test")
  const root = resolve(import.meta.dir, "../../..")
  const runRoot = createBundleIntegrationRunRoot(root)
  const evidence = join(root, ".artifacts/checks/C-INS-05", new Date().toISOString().replaceAll(":", "-"))
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, "commit.txt"), `${revision}\n`)
  writeFileSync(join(evidence, "run-root.txt"), `${runRoot}\n`)
  try {
    const buildEnv = toolchainEnvironment()
    const source = join(runRoot, "source")
    const relocated = join(runRoot, "relocated")
    const state = join(runRoot, "state")
    const home = join(runRoot, "home")
    mkdirSync(home)
    mkdirSync(state)
    const launchEnv: Environment = {
      HOME: home, PATH: systemPath, TMPDIR: join(runRoot, "tmp"),
      SMITHERS_LOCAL_STATE_DIR: state, NO_COLOR: "1"
    }
    mkdirSync(launchEnv.TMPDIR!)

    const command = (argv: string[], log: string, options: BundleCommandOptions = {}): Promise<CommandResult> =>
      runBundleCommand(argv, join(evidence, log), { cwd: root, env: buildEnv, ...options })

    const os = await command(["/usr/bin/sw_vers"], "sw_vers.txt")
    assert.match(os.stdout, /ProductVersion:\s*(?:1[5-9]|[2-9]\d)\./, "macOS 15 or newer is required")
    console.log(`C-INS-05 evidence: ${evidence}`)
    const requireDisk = async (stage: string): Promise<void> => {
      const result = await command(["/bin/df", "-Pk", runRoot], "disk-space.txt")
      const columns = result.stdout.trim().split("\n").at(-1)!.trim().split(/\s+/)
      const availableBytes = Number(columns[3]) * 1024
      assert.ok(Number.isFinite(availableBytes) && availableBytes >= 8 * 1024 ** 3,
        `${stage} requires at least 8 GiB free; found ${(availableBytes / 1024 ** 3).toFixed(1)} GiB`)
    }
    await requireDisk("fresh clone")
    const fixture = join(runRoot, "clone-fixture.git")
    createBundleCloneFixture(gitBackingStore(root), revision, fixture)
    await cloneBundleFixture(fixture, source, join(evidence, "clone.log"), { cwd: root, env: buildEnv })
    await command(["jj", "new", revision], "clone.log", { cwd: source })
    const clonedRevision = await command([
      "jj", "--ignore-working-copy", "log", "-r", "@-", "--no-graph", "-T", "commit_id"
    ], "clone.log", { cwd: source })
    assert.equal(clonedRevision.stdout.trim(), revision)
    for (const path of ["node_modules", "apps/app/bin", "apps/app/postgres", "apps/app/.server-bundle"]) {
      assert.equal(existsSync(join(source, path)), false, `fresh checkout contains ${path}`)
    }
    await command(["pnpm", "install", "--frozen-lockfile", "--offline"], "install.log", {
      cwd: source, timeout: 20 * 60_000
    })
    console.log("C-INS-05: building the fresh checkout")
    await requireDisk("bundle build")
    await command(["pnpm", "exec", "smthrs", "build", "//apps/app:serverBundle", "--verbose", "--full-output"], "build.log", {
      // Leave ten minutes beyond the declared 240m target so its own bounded
      // failure, compiler output, and cleanup receipt reach build.log.
      cwd: source, env: { ...buildEnv, SMITHERS_BUILD_SHA: revision }, timeout: 250 * 60_000
    })
    await command(["jj", "status"], "source-status.txt", { cwd: source })
    const changes = await command(["jj", "diff", "--name-only", "-r", `${revision}..@`], "source-status.txt", { cwd: source })
    // C-INS-05 Pass step 2 permits only ignored bundle output.
    assert.equal(changes.stdout.trim(), "", "bundle build modified tracked source")
    const built = join(source, "apps/app/.server-bundle")
    verifyIndependentManifest(built)
    cpSync(built, relocated, { recursive: true, verbatimSymlinks: true })
    verifyIndependentManifest(relocated)
    const buildNode = Bun.which("node", { PATH: buildEnv.PATH })
    assert.ok(buildNode, "build-time Node runtime is unavailable")
    await verifyBundleSpecPayload(relocated, source, join(dirname(dirname(realpathSync(buildNode))), "LICENSE"), join(evidence, "spec-payload.txt"))
    const inspectArtifacts = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        assert.doesNotMatch(entry.name, /electrobun|chromium.*framework|(?:^|[-_.])cef(?:$|[-_.])|NativeRendererServer/i)
        if (entry.isDirectory()) inspectArtifacts(join(directory, entry.name))
      }
    }
    inspectArtifacts(relocated)
    verifyBundleHomeIsolation(relocated)
    // Keep build evidence, but make the original prefix unavailable: relocation
    // must not accidentally fall back to files still sitting at the build path.
    renameSync(built, join(runRoot, "original-build-output"))
    cpSync(join(relocated, "manifest.json"), join(evidence, "manifest.json"))
    writeFileSync(join(evidence, "manifest-verification.txt"), "Every bundle file verified before and after relocation.\n")

    // This binary calls the production workspace adapter, not a fake msb or an
    // alternative direct-create implementation. Its own executable is a harness.
    const probeSource = join(runRoot, "microvm-probe.go")
    const probe = join(runRoot, "microvm-probe")
    writeFileSync(probeSource, goProbe)
    await command(["go", "build", "-o", probe, probeSource], "probe-build.log", {
      cwd: source, timeout: 10 * 60_000,
      env: { ...buildEnv, GOCACHE: buildEnv.GOCACHE ?? join(runRoot, "go-build") }
    })

    const observedPids = new Set<number>()
    const allowedCodePath = (path: string): boolean => {
      const canonical = realpathSync(path)
      return [relocated, "/System", "/usr/lib", "/usr/libexec", "/usr/bin", "/usr/sbin", "/bin", "/sbin"]
        .some((prefix) => canonical === prefix || canonical.startsWith(prefix + sep))
    }
    const inspectTree = async (pid: number, harness?: string): Promise<void> => {
      // macOS's setuid /bin/ps cannot execute inside the tool boundary. The
      // existing OS lsof inspector supplies parent identities as well as maps.
      const listing = await command(["/usr/sbin/lsof", "-nP", "-R", "-d", "txt", "-F", "pRc"], "processes.txt", { record: false })
      const rows: Array<{ pid: number; parent: number; command: string }> = []
      for (const line of listing.stdout.split("\n")) {
        if (line.startsWith("p")) rows.push({ pid: Number(line.slice(1)), parent: 0, command: "" })
        else if (line.startsWith("R") && rows.length) rows.at(-1)!.parent = Number(line.slice(1))
        else if (line.startsWith("c") && rows.length) rows.at(-1)!.command = line.slice(1)
      }
      // A completed probe can disappear while the OS inspector is running.
      // Its earlier live samples remain in the receipt.
      if (!rows.some((row) => row.pid === pid)) {
        verifyObservedProcess(false, observedPids.has(pid), harness !== undefined)
        return
      }
      const tree = new Set([pid])
      for (let previous = -1; previous !== tree.size;) {
        previous = tree.size
        for (const row of rows) if (tree.has(row.parent)) tree.add(row.pid)
      }
      appendFileSync(join(evidence, "processes.txt"), rows.filter((row) => tree.has(row.pid))
        .map((row) => `${row.pid} ${row.parent} ${row.command}\n`).join(""))
      for (const member of tree) {
        observedPids.add(member)
        const maps = await command(["/usr/sbin/lsof", "-nP", "-p", String(member), "-F", "ftn"], "dylibs.txt", { allowFailure: true })
        // C-INS-05 requires positive mapping evidence for every observed member.
        let descriptor = ""
        const code: string[] = []
        for (const line of maps.stdout.split("\n")) {
          if (line.startsWith("f")) descriptor = line.slice(1)
          if (line.startsWith("n") && descriptor === "txt") code.push(line.slice(1))
        }
        let present = true
        if (maps.exitCode !== 0 || code.length === 0) {
          const fresh = await command(["/usr/sbin/lsof", "-nP", "-R", "-d", "txt", "-F", "p"], "processes.txt", { record: false })
          present = fresh.stdout.split("\n").includes(`p${member}`)
          if (!present && member !== pid) appendFileSync(join(evidence, "processes.txt"), `${member} exited before mapping inspection\n`)
        }
        verifyProcessMappingSample(member === pid, present, maps.exitCode, code, (path) => path === harness || allowedCodePath(path))
      }
    }

    let launcher: ScopedProcess.Handle | undefined
    let launcherScope: Scope.Scope | undefined
    let launcherStatus: Promise<ScopedProcess.Status> | undefined
    let launcherOutput: Promise<unknown> | undefined
    const start = async (): Promise<void> => {
      const started = performance.now()
      launcherScope = Effect.runSync(Scope.make())
      launcher = await Effect.runPromise(ScopedProcess.spawn({
        command: join(relocated, "bin/smithers-server"),
        cwd: relocated, env: launchEnv, stdin: "ignore", forceKillAfter: 20_000
      }).pipe(Effect.provideService(Scope.Scope, launcherScope)))
      const child = launcher
      launcherStatus = Effect.runPromise(ScopedProcess.status(launcher))
      const capture = (stream: typeof child.stdout) => Effect.runPromise(Stream.runForEach(
        stream.pipe(Stream.decodeText()), (text) => Effect.sync(() => appendFileSync(join(evidence, "launcher.log"), text))
      ))
      launcherOutput = Promise.all([
        capture(launcher.stdout), capture(launcher.stderr)
      ])
      // C-INS-05 Pass step 5 fixes the HTTP readiness bound at 30 seconds.
      let ready = false
      // Inspection can be slower than HTTP startup on a busy host. Poll the
      // server concurrently, keeping its actual readiness deadline unchanged.
      const inspection = inspectTree(launcher.targetPid).then(() => undefined, (error: unknown) => error)
      while (performance.now() - started < 30_000) {
        assert.equal(await Effect.runPromise(launcher.isRunning), true, "launcher exited before readiness")
        try {
          const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(500) })
          const body = await response.text()
          const elapsed = performance.now() - started
          if (response.status === 200 && elapsed <= 30_000) {
            appendFileSync(join(evidence, "readiness.txt"), `${elapsed} ms\n${body}\n`)
            ready = true
            break
          }
        } catch { /* not listening yet */ }
        await Bun.sleep(100)
      }
      assert.ok(ready, "relocated launcher did not become ready within 30 seconds")
      assert.ifError(await inspection)
      await inspectTree(launcher.targetPid)
    }
    const stop = async (): Promise<void> => {
      if (!launcher) return
      await Effect.runPromise(launcher.kill({ killSignal: "SIGTERM", forceKillAfter: 20_000 }))
      const status = await launcherStatus
      await launcherOutput
      assert.equal(status?.code, 0, "launcher SIGTERM was not clean")
      await Effect.runPromise(Scope.close(launcherScope!, Exit.succeed(undefined)))
      launcher = undefined
      launcherScope = undefined
    }
    const api = async (path: string, method = "GET", body?: unknown, token?: string, bootstrap?: string): Promise<Record<string, any>> => {
      const response = await fetch(origin + path, {
        method, signal: AbortSignal.timeout(15_000),
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `token ${token}` } : {}),
          ...(bootstrap ? { "X-Smithers-Bootstrap-Token": bootstrap } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      const text = await response.text()
      assert.equal(response.status, 200, `${method} ${path}: ${response.status} ${text}`)
      return JSON.parse(text)
    }
    try {
      // Fail rather than accidentally probing an unrelated existing installation.
      try {
        await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(500) })
        assert.fail("port 4000 is already occupied; C-INS-05 requires an isolated launcher")
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error
      }
      await start()
      await verifyBundleWebAssets(origin)
      const secrets = JSON.parse(readFileSync(join(state, "config/secrets.json"), "utf8"))
      const owner = { username: "bundlecheck", email: "bundlecheck@example.test", password: "bundle integration owner password" }
      const created = await api("/api/auth/local/bootstrap", "POST", owner, undefined, secrets.values.SMITHERS_AUTH_BOOTSTRAP_TOKEN)
      assert.equal(created.user.username, owner.username)
      const token = await api("/api/auth/local/token", "POST", { ...owner, name: "C-INS-05" })
      assert.ok(token.token)
      await api("/api/user", "PATCH", { display_name: "C-INS-05 persisted owner" }, token.token)
      const before = await api("/api/user", "GET", undefined, token.token)
      assert.equal(before.display_name, "C-INS-05 persisted owner")
      await stop()
      await start()
      const after = await api("/api/user", "GET", undefined, token.token)
      // C-INS-05 Pass step 7 requires the same persisted API row after restart.
      assert.equal(after.id, before.id)
      assert.equal(after.display_name, before.display_name)
      writeFileSync(join(evidence, "persistence.json"), JSON.stringify({ before, after }, null, 2) + "\n")
      const pgState = join(state, "postgres")
      const pgPid = readFileSync(join(pgState, "data/postmaster.pid"), "utf8").split("\n")
      assert.equal(realpathSync(pgPid[1]!.trim()), realpathSync(join(pgState, "data")))
      const port = pgPid[3]!.trim()
      assert.match(port, /^\d+$/)
      const postgresRoot = join(relocated, "postgres")
      const pgBundle = JSON.parse(readFileSync(join(postgresRoot, "bundle.json"), "utf8"))
      assert.equal(pgBundle.version, 1)
      assert.equal(typeof pgBundle.bin, "string")
      const pgBin = realpathSync(resolve(postgresRoot, pgBundle.bin))
      assert.ok(pgBin.startsWith(realpathSync(postgresRoot) + sep), "PostgreSQL bin escapes the relocated bundle")
      const version = await command([
        join(pgBin, "psql"), "-h", "127.0.0.1", "-p", port, "-U", "smithers", "-d", "postgres", "-At",
        "-v", "ON_ERROR_STOP=1", "-c", "SHOW server_version;"
      ], "postgres-version.txt", { env: { ...launchEnv, PGPASSWORD: readFileSync(join(pgState, "password"), "utf8").trim() } })
      // T-INS-01 pins PostgreSQL 18; C-INS-05 Pass step 7 checks its major.
      assert.match(version.stdout.trim(), /^18(?:\.|$)/)
      await stop()

      const msb = join(relocated, "bin/msb")
      // This check boots one 8-GiB VM and builds no environment layers. Use
      // the supported capacity policy for the reference host, rather than the
      // production 40-GiB floor reserved for a factory's layer preparation.
      writeFileSync(join(evidence, "capacity-policy.json"), JSON.stringify({
        minimumFreeGiB: 8, reason: "one VM, no environment layer preparation"
      }, null, 2) + "\n")
      const doctor = await command([join(relocated, "bin/smithers-backend"), "microvm", "doctor"], "doctor.txt", {
        env: { ...launchEnv, SMITHERS_DATA_ROOT: state, SMITHERS_MICROSANDBOX_BIN: msb, SMITHERS_MICROVM_MIN_FREE_GIB: "8" }
      })
      // C-INS-05 Pass step 6 requires doctor ready and an offline guest echo.
      assert.match(doctor.stdout, /host ready, local backend/)
      assert.doesNotMatch(doctor.stdout, /^FAIL/m)
      const vmHome = join(runRoot, "offline-vm-home")
      mkdirSync(vmHome)
      const vmEnv = { ...launchEnv, HOME: vmHome, MSB_BACKEND: "local" }
      const blocked = await command([
        "/usr/bin/sandbox-exec", "-p", offlineProfile, "/usr/bin/curl", "--connect-timeout", "3", "--max-time", "5",
        "--silent", "--show-error", "https://registry-1.docker.io/v2/"
      ], "registry-block.txt", { env: vmEnv, allowFailure: true })
      assert.notEqual(blocked.exitCode, 0, "network sandbox did not block the image registry")
      console.log("C-INS-05: booting production workspace runtime with registry access blocked")
      await requireDisk("first VM boot")
      const boot = await command([
        "/usr/bin/sandbox-exec", "-p", offlineProfile, probe, msb, join(runRoot, "microvm-state")
      ], "offline-boot.txt", { env: vmEnv, timeout: 15 * 60_000, cleanupGraceMs: 150_000, observe: (pid) => inspectTree(pid, probe) })
      assert.equal(boot.stdout, "ok\n")
      writeFileSync(join(evidence, "result.json"), JSON.stringify({ check: "C-INS-05", revision, passed: true, observedPids: [...observedPids] }, null, 2) + "\n")
      console.log(`C-INS-05 passed: ${evidence}`)
    } finally {
      if (launcherScope) {
        // Cleanup is scoped to the child launched here. Never kill by name.
        try { await stop() } catch (error) {
          appendFileSync(join(evidence, "launcher.log"), `cleanup: ${String(error)}\n`)
        }
        if (launcherScope) {
          await Effect.runPromise(Scope.close(launcherScope, Exit.succeed(undefined))).catch((cleanup) =>
            appendFileSync(join(evidence, "launcher.log"), `cleanup: ${String(cleanup)}\n`))
          await launcherOutput?.catch((cleanup) => appendFileSync(join(evidence, "launcher.log"), `output: ${String(cleanup)}\n`))
        }
      }
    }
  } catch (error) {
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ check: "C-INS-05", revision, passed: false, error: String(error) }, null, 2) + "\n")
    throw error
  } finally {
    try {
      const postgresLog = join(runRoot, "state/postgres/postgres.log")
      if (existsSync(postgresLog)) cpSync(postgresLog, join(evidence, "postgres.log"))
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  }
}

if (import.meta.main && process.argv.includes("--run")) await runServerBundleIntegration()
