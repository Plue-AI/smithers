import { randomBytes, randomUUID, createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { ExecutionReceipt, ModeConfig } from "../../e2e/real/coverage/matrix"
import { PROVIDER_MODEL } from "../../e2e/real/support/model-provider-behaviors"
import { launchModelProvider, type ModelProvider } from "../../e2e/real/support/model-provider-process"
import { githubBases, modelBase, setupLine } from "../run-local-no-github"
import { executeCommand } from "./command-execution"
import { walkSetup, type InstallBrowser } from "./install-setup"

export interface LocalOwnSession {
  readonly modeConfig: ModeConfig
  readonly runtimeEnvironment: Readonly<Record<string, string>>
  readonly close: () => Promise<void>
}

const output = (command: string, args: readonly string[] = []): string | undefined => {
  try {
    const run = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "ignore" })
    return run.exitCode === 0 ? new TextDecoder().decode(run.stdout).trim() : undefined
  } catch { return undefined }
}

export const postgres18Bin = (): string => {
  const configured = process.env.SMITHERS_POSTGRES_TEST_BIN?.trim()
  const candidates = [
    configured,
    output("pg_config", ["--bindir"]),
    "/opt/homebrew/opt/postgresql@18/bin",
    "/usr/lib/postgresql/18/bin"
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, "postgres")) && output(join(candidate, "postgres"), ["--version"])?.startsWith("postgres (PostgreSQL) 18.")) return candidate
  }
  throw new Error("local-own requires PostgreSQL 18 bin (set SMITHERS_POSTGRES_TEST_BIN)")
}

/** Node 26.4 or a later Node 26, the release line the packaged host runs. */
const isSupportedNode = (version: string): boolean => {
  const release = /^v26\.(\d+)\./.exec(version.trim())
  return release !== null && Number(release[1]) >= 4
}

const node26Binary = (): string => {
  const configured = process.env.SMITHERS_NODE_BINARY?.trim()
  const nvmRoot = join(homedir(), ".nvm", "versions", "node")
  const nvmCandidates = existsSync(nvmRoot)
    ? readdirSync(nvmRoot).filter(isSupportedNode).sort((left, right) => right.localeCompare(left, "en", { numeric: true })).map((name) => join(nvmRoot, name, "bin", "node"))
    : []
  const candidates = [configured, Bun.which("node"), ...nvmCandidates, "/opt/homebrew/opt/node@26/bin/node"]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate) && isSupportedNode(output(candidate, ["--version"]) ?? "")) return realpathSync(candidate)
  }
  throw new Error("local-own requires Node 26.4 or a later Node 26 (set SMITHERS_NODE_BINARY)")
}

const availablePort = (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (typeof address !== "object" || address === null) return reject(new Error("no loopback port"))
    server.close((error) => error ? reject(error) : resolvePort(address.port))
  })
})

const waitFor = async (url: string, child: ReturnType<typeof Bun.spawn>): Promise<void> => {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`local process exited ${child.exitCode} before ${url} was ready`)
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok) return } catch { /* retry */ }
    await Bun.sleep(250)
  }
  throw new Error(`local process did not serve ${url}`)
}

/** Copies a child's stdout to ours line by line, handing each line to `line` first. */
const relayLines = (stream: ReadableStream<Uint8Array>, line: (text: string) => void): void => {
  void (async () => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    let rest = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest += decoder.decode(value, { stream: true })
      let at: number
      while ((at = rest.indexOf("\n")) >= 0) {
        const text = rest.slice(0, at)
        rest = rest.slice(at + 1)
        line(text)
        process.stdout.write(`${text}\n`)
      }
    }
  })().catch((error: unknown) => { console.error(error) })
}

/** Runs only the test binary's serving entry, with no test deadline. */
const testBackendArgs = ["-test.run=^TestServeTrustedProcessBackend$", "-test.count=1", "-test.timeout=0"] as const

const stop = async (child: ReturnType<typeof Bun.spawn> | undefined): Promise<void> => {
  if (child === undefined || child.exitCode !== null) return
  child.kill("SIGTERM")
  if (!(await Promise.race([child.exited.then(() => true), Bun.sleep(15_000).then(() => false)]))) child.kill("SIGKILL")
  await child.exited
}

/**
 * The repository GitHub holds for the install: the fake's `<owner>/demo`, a
 * bare repository the fake serves over smart HTTP. A Makefile gives the
 * machine image its detected build and test checks (mvp.md J1 step 4).
 */
const seedGitHubRepository = (gitRoot: string, owner: string): void => {
  const seed = join(gitRoot, "seed")
  const bare = join(gitRoot, owner, "demo.git")
  mkdirSync(seed, { recursive: true })
  mkdirSync(dirname(bare), { recursive: true })
  const git = (args: readonly string[]) => execFileSync("git", args, {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "pipe"
  })
  git(["init", "-q", "-b", "main", seed])
  writeFileSync(join(seed, "README.md"), "# demo\n\nThe mode matrix's install repository.\n")
  writeFileSync(join(seed, "JOURNEY.md"), "Add a greeting to JOURNEY.md\n")
  writeFileSync(join(seed, "Makefile"), "build:\n\ttest -s JOURNEY.md\n\ntest:\n\tgrep -q . JOURNEY.md\n")
  git(["-C", seed, "add", "."])
  git(["-C", seed, "-c", "user.name=Owner", "-c", "user.email=owner@example.test", "commit", "-q", "-m", "Initial commit"])
  git(["clone", "-q", "--bare", seed, bare])
  rmSync(seed, { recursive: true, force: true })
}

/** Starts the GitHub fake for `owner` and answers its origin. */
const startGitHubFake = async (binary: string, gitRoot: string, owner: string): Promise<{ readonly child: ReturnType<typeof Bun.spawn>; readonly url: string }> => {
  const child = Bun.spawn([binary, "--addr", "127.0.0.1:0", "--git-root", gitRoot, "--owner", owner], { stdin: "ignore", stdout: "pipe", stderr: "inherit" })
  let ready!: (url: string) => void
  const announced = new Promise<string>((resolveURL) => { ready = resolveURL })
  relayLines(child.stdout, (line) => { if (line.startsWith("ready ")) ready(line.slice("ready ".length)) })
  const url = await Promise.race([
    announced,
    child.exited.then((code) => { throw new Error(`githubfake exited ${code} before it was ready`) }),
    Bun.sleep(30_000).then(() => { throw new Error("githubfake did not announce its address") })
  ])
  return { child, url }
}

export const startLocalOwn = async (rootDir: string, revision: string, outputDir: string): Promise<LocalOwnSession> => {
  if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error("local-own requires an exact revision")
  const postgresBin = postgres18Bin()
  const nodeBinary = node26Binary()
  const root = mkdtempSync(join(tmpdir(), "smithers-local-own-"))
  const appDir = resolve(rootDir, "apps/app")
  const backendBinary = join(root, "smithers-test-backend")
  const fakeBinary = join(root, "githubfake")
  const hostDir = join(root, "hosts")
  const manifest = join(hostDir, "flow-hosts.json")
  const dataRoot = join(root, "state")
  const gitRoot = join(root, "github")
  // The stack keeps scratch repositories at $TMPDIR/smithers-mythical/repo-<id>.git and an install's first repository
  // is 1, so installs on one host must not share TMPDIR (compose/rehearsal_integration_test.go does the same).
  const scratch = join(root, "tmp")
  mkdirSync(hostDir)
  mkdirSync(dataRoot)
  mkdirSync(scratch)
  let backend: ReturnType<typeof Bun.spawn> | undefined
  let vite: ReturnType<typeof Bun.spawn> | undefined
  let fake: ReturnType<typeof Bun.spawn> | undefined
  let models: ModelProvider | undefined
  const run = async (label: string, args: readonly string[]): Promise<void> => {
    const result = await executeCommand(args, rootDir)
    if (result.exitCode !== 0) throw new Error(`${label} failed: ${(result.stderr || result.stdout).slice(-2_000)}`)
  }
  const close = async (): Promise<void> => {
    await stop(vite)
    await stop(backend)
    await stop(fake)
    await models?.close()
    rmSync(root, { recursive: true, force: true })
  }
  try {
    let ffiLibrary = process.env.SMITHERS_FFI_LIBRARY_PATH?.trim()
    if (!ffiLibrary) {
      const cargoTarget = join(root, "cargo-target")
      const child = Bun.spawn(["cargo", "build", "--locked", "--release", "--package", "smithers-ffi"], {
        cwd: rootDir, env: { ...process.env, CARGO_TARGET_DIR: cargoTarget, CARGO_BUILD_JOBS: "2" },
        stdin: "ignore", stdout: "inherit", stderr: "inherit"
      })
      if (await child.exited !== 0) throw new Error("build local smithers-ffi failed")
      ffiLibrary = join(cargoTarget, "release", process.platform === "darwin" ? "libsmithers_ffi.dylib" : "libsmithers_ffi.so")
    }
    // The shipped backend refuses trusted-process workspaces and local-own has
    // no approved microVM bundle, so it runs the test backend: the
    // production composition with trusted-process workspaces, compiled only
    // into the apps/backend test binary (apps/backend/test_backend_test.go).
    await run("build local test backend", ["go", "test", "-c", "-trimpath", "-ldflags", `-X github.com/smithersai/smithers/packages/backend/internal/compose.BuildSHA=${revision}`, "-o", backendBinary, "./apps/backend"])
    await run("build GitHub fake", ["go", "build", "-o", fakeBinary, "./packages/backend/cmd/githubfake"])
    await run("build coding host", ["node", "flows/coding/build.mjs", join(hostDir, "smithers-coding-host")])
    await run("build model host", ["node", "apps/model-host/build.mjs", join(hostDir, "smithers-model-host")])
    await run("write Flow host manifest", ["node", "distribution/flow-host-manifest.mjs", manifest, join(hostDir, "smithers-coding-host")])

    // GitHub and every model provider are the install's loopback fakes, as in the no-GitHub walk.
    const owner = `matrix${randomUUID().replaceAll("-", "").slice(0, 12)}`
    const repository = `${owner}/demo`
    seedGitHubRepository(gitRoot, owner)
    const github = await startGitHubFake(fakeBinary, gitRoot, owner)
    fake = github.child
    const modelKey = randomBytes(24).toString("hex")
    models = await launchModelProvider({ key: modelKey })

    const backendPort = await availablePort()
    const webPort = await availablePort()
    const backendOrigin = `http://127.0.0.1:${backendPort}`
    const origin = `http://127.0.0.1:${webPort}`
    const backendEnv = {
      ...process.env,
      PORT: String(backendPort),
      SMITHERS_DATA_ROOT: dataRoot,
      SMITHERS_NATIVE_POSTGRES_BIN: postgresBin,
      SMITHERS_FLOW_HOST_MANIFEST: manifest,
      SMITHERS_MODEL_HOST_BUNDLE: join(hostDir, "smithers-model-host"),
      SMITHERS_NODE_BINARY: nodeBinary,
      SMITHERS_FFI_LIBRARY_PATH: ffiLibrary,
      SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: join(dirname(ffiLibrary), "smithers-jj-export"),
      SMITHERS_PUBLIC_URL: origin,
      SMITHERS_TEST_BACKEND_SERVE: "1",
      TMPDIR: scratch,
      ...githubBases(github.url),
      ...modelBase(models.origin)
    }
    let setupURL: string | undefined
    const startBackend = async (): Promise<void> => {
      const child = Bun.spawn([backendBinary, ...testBackendArgs], { cwd: rootDir, env: backendEnv, stdin: "ignore", stdout: "pipe", stderr: "inherit" })
      backend = child
      relayLines(child.stdout, (line) => { setupURL = setupLine(line) ?? setupURL })
      await waitFor(`${backendOrigin}/readyz`, child)
    }
    await startBackend()
    const deadline = Date.now() + 30_000
    while (setupURL === undefined && Date.now() < deadline) await Bun.sleep(100)
    if (setupURL === undefined) throw new Error("local-own backend printed no setup link")
    const owned: InstallBrowser = await walkSetup({
      backend: backendOrigin, origin, setupURL, fakeURL: github.url, owner, modelKey,
      codingModel: PROVIDER_MODEL.answers
    })
    const sessionCookie = owned.cookie("smithers_session")!
    const repositoryPath = `/api/repos/${repository}`
    const created = JSON.parse((await owned.expect("GET", repositoryPath, 200)).text) as { readonly full_name?: string }
    if (created.full_name !== repository) throw new Error(`setup mirrored ${created.full_name}, not ${repository}`)

    const secrets = join(dataRoot, "config", "secrets.json")
    const beforeVolume = createHash("sha256").update(readFileSync(secrets)).digest("hex")
    await stop(backend)
    backend = undefined
    await startBackend()
    const restored = JSON.parse((await owned.expect("GET", repositoryPath, 200)).text) as { readonly full_name?: string }
    if (restored.full_name !== repository) throw new Error("local-own restart lost its repository")
    const afterVolume = createHash("sha256").update(readFileSync(secrets)).digest("hex")
    if (beforeVolume !== afterVolume) throw new Error("local-own restart changed owner secrets")
    vite = Bun.spawn([nodeBinary, join(appDir, "node_modules", "vite", "bin", "vite.js"), "--configLoader", "runner", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
      cwd: appDir, env: { ...process.env, SMITHERS_DEV_BACKEND_ORIGIN: backendOrigin }, stdin: "ignore", stdout: "inherit", stderr: "inherit"
    })
    await waitFor(`${origin}/api/bootstrap`, vite)
    const receiptPath = join(outputDir, "local-own.execution.json")
    const receipt: ExecutionReceipt = {
      mode: "local-own", revision, origin, endpoint: origin, ready: true, startedRoles: ["local-ui", "app", "postgres"],
      freshLaunch: true, restarted: true, dataPreserved: true,
      persistenceProof: {
        database: { before: String(created.full_name), after: String(restored.full_name) },
        dataVolume: { before: beforeVolume, after: afterVolume }
      },
      observedAt: new Date().toISOString()
    }
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    const authEnvironment = "SMITHERS_LOCAL_OWNER_SESSION"
    return {
      modeConfig: { mode: "local-own", origin, endpoint: origin, auth: { kind: "owner-session", environment: authEnvironment }, executionReceipt: receiptPath },
      runtimeEnvironment: { [authEnvironment]: JSON.stringify({ username: owner, sessionCookie }), SMITHERS_LOCAL_INSTALL_REPOSITORY: repository },
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}
