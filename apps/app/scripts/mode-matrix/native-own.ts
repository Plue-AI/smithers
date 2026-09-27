import { fixtureProtocolId } from "../../e2e/real/support/values"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { PackagedApp } from "../../e2e/packaged/PackagedApp"
import { existingNativeWindowTargetId } from "./native-window"
import type { ExecutionReceipt, ModeConfig } from "../../e2e/real/coverage/matrix"

export interface NativeOwnSession {
  readonly modeConfig: ModeConfig
  readonly runtimeEnvironment: Readonly<Record<string, string>>
  readonly close: () => Promise<void>
}

const availablePort = (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (typeof address !== "object" || address === null) return reject(new Error("no native backend port"))
    server.close((error) => error ? reject(error) : resolvePort(address.port))
  })
})

const request = async (origin: string, path: string, init?: RequestInit): Promise<Record<string, unknown>> => {
  const response = await fetch(new URL(path, origin), init)
  const body = await response.text()
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${body}`)
  return JSON.parse(body) as Record<string, unknown>
}

const waitForBackend = async (origin: string): Promise<void> => {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try { if ((await fetch(new URL("/readyz", origin), { signal: AbortSignal.timeout(2_000) })).ok) return }
    catch { /* the supervisor is still starting */ }
    await Bun.sleep(250)
  }
  throw new Error("packaged native backend did not become ready")
}

export const startNativeOwn = async (
  revision: string,
  outputDir: string,
  executable: string,
  cdpEndpoint: string
): Promise<NativeOwnSession> => {
  if (process.platform !== "darwin") throw new Error("native-own requires the macOS packaged app")
  if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error("native-own requires an exact revision")
  const packagePath = resolve(executable)
  if (!packagePath.includes(".app/Contents/MacOS/launcher") || !existsSync(packagePath)) {
    throw new Error("native-own requires the packaged Smithers.app launcher")
  }
  const cdp = new URL(cdpEndpoint)
  if (cdp.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(cdp.hostname)) {
    throw new Error("native-own requires a loopback CEF CDP endpoint")
  }
  const root = mkdtempSync(join(tmpdir(), "smithers-matrix-native-"))
  const home = join(root, "home")
  mkdirSync(home)
  const origin = `http://127.0.0.1:${await availablePort()}`
  let app: PackagedApp | undefined
  const close = async (): Promise<void> => {
    try {
      await app?.captureDiagnostics("matrix-final").catch(() => undefined)
    } finally {
      try { await app?.cleanup() } finally { rmSync(root, { recursive: true, force: true }) }
    }
  }
  try {
    app = await PackagedApp.launch({
      executable: packagePath,
      stateDirectory: home,
      artifactsDirectory: join(outputDir, "native-own-diagnostics"),
      runtime: "product",
      startupTimeoutMs: 180_000,
      env: { SMITHERS_BACKEND_MODE: "own", SMITHERS_OWNED_BACKEND_ORIGIN: origin }
    })
    await app.ready()
    await waitForBackend(origin)
    const bootstrap = await request(origin, "/api/bootstrap")
    // The owned backend is a web origin with the owner's credentials; the shell adds `native.shell` on its own relay, not here.
    if (bootstrap.buildSha !== revision || bootstrap.host !== "cloud" || bootstrap.authFlow !== "credentials") {
      throw new Error(`native-own bootstrap revision or host mismatch: ${JSON.stringify(bootstrap)}`)
    }
    const dataRoot = join(home, "Library", "Application Support", "Smithers")
    const secrets = join(dataRoot, "config", "secrets.json")
    const pgVersion = join(dataRoot, "postgres", "data", "PG_VERSION")
    if (readFileSync(pgVersion, "utf8").trim() !== "18") throw new Error("native-own did not start PostgreSQL 18")
    const secretDocument = JSON.parse(readFileSync(secrets, "utf8")) as {
      readonly values?: Readonly<Record<string, string>>
    }
    const bootstrapToken = secretDocument.values?.SMITHERS_AUTH_BOOTSTRAP_TOKEN
    if (!bootstrapToken) throw new Error("native-own did not persist an owner bootstrap token")
    const username = `matrix${randomUUID().replaceAll("-", "").slice(0, 12)}`
    const password = `${randomUUID()}-Aa1!`
    await request(origin, "/api/auth/local/bootstrap", {
      method: "POST", headers: { "content-type": "application/json", "x-smithers-bootstrap-token": bootstrapToken },
      body: JSON.stringify({ username, email: `${username}@example.test`, password })
    })
    const token = (await request(origin, "/api/auth/local/token", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password, name: "native-matrix" })
    })).token
    if (typeof token !== "string" || !token) throw new Error("native-own did not issue an owner token")
    const repository = fixtureProtocolId(`matrix-${randomUUID().slice(0, 8)}`)
    await request(origin, "/api/user/repos", {
      method: "POST", headers: { "content-type": "application/json", authorization: `token ${token}` },
      body: JSON.stringify({ name: repository, private: true, auto_init: true })
    })
    const beforeVolume = createHash("sha256").update(readFileSync(secrets)).digest("hex")
    await app.relaunch()
    await waitForBackend(origin)
    const restored = await request(origin, `/api/repos/${username}/${repository}`, { headers: { authorization: `token ${token}` } })
    const afterVolume = createHash("sha256").update(readFileSync(secrets)).digest("hex")
    if (restored.full_name !== `${username}/${repository}` || beforeVolume !== afterVolume) {
      throw new Error("native-own restart did not preserve the repository and owner secrets")
    }
    const state = await app.state()
    if (!state.app.packaged || state.window?.renderer !== "cef" || !state.window.url) {
      throw new Error("native-own requires a packaged CEF window")
    }
    const targetId = await existingNativeWindowTargetId(cdpEndpoint, state.window.url)
    const receiptPath = join(outputDir, "native-own.execution.json")
    const receipt: ExecutionReceipt = {
      mode: "native-own", revision, origin, endpoint: origin, ready: true,
      startedRoles: ["native-ui", "supervisor", "app", "postgres"],
      freshLaunch: true, restarted: true, dataPreserved: true,
      persistenceProof: {
        database: { before: `${username}/${repository}`, after: String(restored.full_name) },
        dataVolume: { before: beforeVolume, after: afterVolume }
      },
      observedAt: new Date().toISOString()
    }
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    const authEnvironment = "SMITHERS_NATIVE_OWNER_SESSION"
    const driverEnvironment = "SMITHERS_NATIVE_OWN_DRIVER"
    const modeConfig: ModeConfig = {
      mode: "native-own", origin, endpoint: origin,
      auth: { kind: "owner-session", environment: authEnvironment },
      executionReceipt: receiptPath,
      surfaceDriver: { kind: "electrobun-cdp", environment: driverEnvironment }
    }
    return {
      modeConfig,
      runtimeEnvironment: {
        [authEnvironment]: JSON.stringify({ username, password, bootstrapToken }),
        [driverEnvironment]: JSON.stringify({ executable: packagePath, cdpEndpoint, environment: { SMITHERS_BACKEND_MODE: "own" } }),
        SMITHERS_NATIVE_MATRIX_PRELAUNCHED: "native-own",
        SMITHERS_REAL_NATIVE_CDP_ENDPOINT: cdpEndpoint,
        SMITHERS_REAL_NATIVE_WINDOW_URL: state.window.url,
        SMITHERS_REAL_NATIVE_TARGET_ID: targetId
      },
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}
