import { fixtureProtocolId } from "../../e2e/real/support/values"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { ExecutionReceipt, ModeConfig } from "../../e2e/real/coverage/matrix"
import { executeCommand } from "./docker-web-selfhost"

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

const postgres18Bin = (): string => {
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

const request = async (origin: string, path: string, init?: RequestInit): Promise<Record<string, unknown>> => {
  const response = await fetch(new URL(path, origin), init)
  const body = await response.text()
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${body}`)
  return JSON.parse(body) as Record<string, unknown>
}

/** Runs only the test binary's serving entry, with no test deadline. */
const testBackendArgs = ["-test.run=^TestServeTrustedProcessBackend$", "-test.count=1", "-test.timeout=0"] as const

const stop = async (child: ReturnType<typeof Bun.spawn> | undefined): Promise<void> => {
  if (child === undefined || child.exitCode !== null) return
  child.kill("SIGTERM")
  if (!(await Promise.race([child.exited.then(() => true), Bun.sleep(15_000).then(() => false)]))) child.kill("SIGKILL")
  await child.exited
}

export const startLocalOwn = async (rootDir: string, revision: string, outputDir: string): Promise<LocalOwnSession> => {
  if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error("local-own requires an exact revision")
  const postgresBin = postgres18Bin()
  const nodeBinary = node26Binary()
  const root = mkdtempSync(join(tmpdir(), "smithers-local-own-"))
  const appDir = resolve(rootDir, "apps/app")
  const backendBinary = join(root, "smithers-test-backend")
  const hostDir = join(root, "hosts")
  const manifest = join(hostDir, "flow-hosts.json")
  const dataRoot = join(root, "state")
  mkdirSync(hostDir)
  mkdirSync(dataRoot)
  let backend: ReturnType<typeof Bun.spawn> | undefined
  let vite: ReturnType<typeof Bun.spawn> | undefined
  const run = async (label: string, args: readonly string[]): Promise<void> => {
    const result = await executeCommand(args, rootDir)
    if (result.exitCode !== 0) throw new Error(`${label} failed: ${(result.stderr || result.stdout).slice(-2_000)}`)
  }
  const close = async (): Promise<void> => {
    await stop(vite)
    await stop(backend)
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
    await run("build coding host", ["node", "flows/coding/build.mjs", join(hostDir, "smithers-coding-host")])
    await run("build model host", ["node", "apps/model-host/build.mjs", join(hostDir, "smithers-model-host")])
    await run("write Flow host manifest", ["node", "distribution/flow-host-manifest.mjs", manifest, join(hostDir, "smithers-coding-host")])
    const backendPort = await availablePort()
    const webPort = await availablePort()
    const backendOrigin = `http://127.0.0.1:${backendPort}`
    const origin = `http://127.0.0.1:${webPort}`
    const bootstrapToken = randomUUID()
    const username = `matrix${randomUUID().replaceAll("-", "").slice(0, 12)}`
    const password = `${randomUUID()}-Aa1!`
    const gatewayApiKey = fixtureProtocolId(`matrix-flow-${randomUUID()}`)
    const backendEnv = {
      ...process.env,
      PORT: String(backendPort),
      SMITHERS_DATA_ROOT: dataRoot,
      SMITHERS_NATIVE_POSTGRES_BIN: postgresBin,
      SMITHERS_FLOW_HOST_MANIFEST: manifest,
      SMITHERS_MODEL_HOST_BUNDLE: join(hostDir, "smithers-model-host"),
      SMITHERS_NODE_BINARY: nodeBinary,
      AI_GATEWAY_API_KEY: gatewayApiKey,
      SMITHERS_FFI_LIBRARY_PATH: ffiLibrary,
      SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: join(dirname(ffiLibrary), "smithers-jj-export"),
      SMITHERS_PUBLIC_URL: origin,
      SMITHERS_TEST_BACKEND_SERVE: "1"
    }
    const startBackend = async (): Promise<void> => {
      backend = Bun.spawn([backendBinary, ...testBackendArgs], { cwd: rootDir, env: backendEnv, stdin: "ignore", stdout: "inherit", stderr: "inherit" })
      await waitFor(`${backendOrigin}/readyz`, backend)
    }
    await startBackend()
    // Test-only database fixtures mirror compose/members_integration_test.go.
    // The native install owns this state directory and its PostgreSQL process.
    const files = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)])
    const pidFile = files(dataRoot).find(path => path.endsWith("/postmaster.pid"))
    if (!pidFile) throw new Error("local-own PostgreSQL pid file unavailable")
    const pgPort = readFileSync(pidFile, "utf8").split("\n")[3]!
    const pgPassword = readFileSync(join(dirname(dirname(pidFile)), "password"), "utf8")
    const token = `smithers_${randomBytes(20).toString("hex")}`
    const sessionCookie = randomBytes(32).toString("hex")
    const repository = fixtureProtocolId(`matrix-${randomUUID().slice(0, 8)}`)
    const hash = (value: string) => createHash("sha256").update(value).digest("hex")
    const seed = Bun.spawnSync([join(postgresBin, "psql"), "-h", "127.0.0.1", "-p", pgPort,
      "-U", "smithers", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
      env: { ...process.env, PGPASSWORD: pgPassword }, stdout: "pipe", stderr: "pipe",
      stdin: new TextEncoder().encode(`BEGIN;
        INSERT INTO users(username,lower_username,display_name) VALUES ('${username}','${username}','Owner');
        INSERT INTO self_host_owners(user_id) SELECT id FROM users WHERE username='${username}';
        INSERT INTO install_settings(key,value) VALUES
          ('github.repository',jsonb_build_object('owner_login','${username}','repository_name','${repository}','repository_id',101)),
          ('owner.access',jsonb_build_object('owner_login','${username}','repository_name','${repository}','repository_id',101,'last_access_check_at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')));
        INSERT INTO access_tokens(user_id,name,token_hash,token_last_eight,scopes,expires_at)
          SELECT id,'local-matrix','${hash(token)}','${token.slice(-8)}','all',now()+interval '1 hour'
          FROM users WHERE username='${username}';
        INSERT INTO auth_sessions(session_key,user_id,username,expires_at)
          SELECT '${hash(sessionCookie)}',id,username,now()+interval '1 hour' FROM users WHERE username='${username}';
        COMMIT;`)
    })
    if (seed.exitCode !== 0) throw new Error(`local-own owner seed failed: ${new TextDecoder().decode(seed.stderr)}`)
    await request(backendOrigin, "/api/user/repos", {
      method: "POST", headers: { "content-type": "application/json", authorization: `token ${token}` },
      body: JSON.stringify({ name: repository, private: true, auto_init: true })
    })
    const secrets = join(dataRoot, "config", "secrets.json")
    const beforeVolume = createHash("sha256").update(readFileSync(secrets)).digest("hex")
    await stop(backend)
    backend = undefined
    await startBackend()
    const restored = await request(backendOrigin, `/api/repos/${username}/${repository}`, { headers: { authorization: `token ${token}` } })
    if (restored.full_name !== `${username}/${repository}`) throw new Error("local-own restart lost its repository")
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
        database: { before: `${username}/${repository}`, after: String(restored.full_name) },
        dataVolume: { before: beforeVolume, after: afterVolume }
      },
      observedAt: new Date().toISOString()
    }
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    const authEnvironment = "SMITHERS_LOCAL_OWNER_SESSION"
    return {
      modeConfig: { mode: "local-own", origin, endpoint: origin, auth: { kind: "owner-session", environment: authEnvironment }, executionReceipt: receiptPath },
      runtimeEnvironment: { [authEnvironment]: JSON.stringify({ username, password, bootstrapToken, sessionCookie }), SMITHERS_LOCAL_GIT_ORIGIN: backendOrigin }, close
    }
  } catch (error) {
    await close()
    throw error
  }
}
