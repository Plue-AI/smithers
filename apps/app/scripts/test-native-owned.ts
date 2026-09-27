import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

if (process.platform !== "darwin") throw new Error("The installed native lifecycle test requires macOS.")

const executable = resolve(process.argv[2] ?? process.env.SMITHERS_E2E_EXECUTABLE ?? "")
if (!executable.includes(".app/Contents/MacOS/launcher") || !existsSync(executable)) {
  throw new Error("Pass the installed Smithers.app/Contents/MacOS/launcher executable.")
}
if ((statSync(executable).mode & 0o111) === 0) throw new Error("The installed launcher is not executable.")
const bundledRoot = resolve(executable, "..", "..", "Resources", "app")

const root = mkdtempSync(join(tmpdir(), "smithers-native-owned-"))
const children: Array<ReturnType<typeof Bun.spawn>> = []
const appPIDs: Array<number> = []
let missingBootstrapBackend: { readonly port?: number; stop(closeActiveConnections?: boolean): void } | undefined
let recoveredBackend: { readonly port?: number; stop(closeActiveConnections?: boolean): void } | undefined
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).flatMap(([name, value]) =>
    name.startsWith("SMITHERS_") || value === undefined ? [] : [[name, value]])
)

const availablePort = (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (typeof address !== "object" || address === null) {
      server.close()
      reject(new Error("No loopback port was allocated."))
      return
    }
    server.close((error) => error === undefined ? resolvePort(address.port) : reject(error))
  })
})

interface RunningApp {
  readonly child: ReturnType<typeof Bun.spawn>
  readonly exited: Promise<number>
  readonly logs: () => string
  readonly origin: string
  readonly state: string
  readonly appPID: Promise<number>
  bridgeState(): Promise<{ readonly app?: { readonly origin?: string; readonly packaged?: boolean } }>
  bridgeEval(script: string): Promise<unknown>
  stop(): Promise<void>
}

const launch = async (home: string, mode: "own" | "plue", origin: string, token?: string): Promise<RunningApp> => {
  mkdirSync(home, { recursive: true })
  const temporary = join(home, "tmp")
  mkdirSync(temporary, { recursive: true })
  let output = ""
  const bridgePort = await availablePort()
  const bridgeToken = randomBytes(32).toString("base64url")
  const child = Bun.spawn([executable], {
    cwd: resolve(executable, ".."),
    env: {
      ...cleanEnvironment,
      HOME: home,
      CFFIXED_USER_HOME: home,
      TMPDIR: temporary,
      SMITHERS_LOCAL_HEADLESS: "0",
      SMITHERS_CHAT_STUB: "0",
      SMITHERS_BACKEND_MODE: mode,
      SMITHERS_E2E_BRIDGE: "1",
      SMITHERS_E2E_BRIDGE_PORT: String(bridgePort),
      SMITHERS_E2E_BRIDGE_TOKEN: bridgeToken,
      ...(process.env.SMITHERS_NATIVE_E2E_VISIBLE === "1" ? { SMITHERS_NATIVE_E2E_VISIBLE: "1" } : {}),
      ...(mode === "own"
        ? { SMITHERS_OWNED_BACKEND_ORIGIN: origin }
        : {
          SMITHERS_API_ORIGIN: origin,
          SMITHERS_API_TOKEN: token ?? "",
          SMITHERS_BACKEND_BINARY: "/definitely/missing/backend",
          SMITHERS_POSTGRES_BUNDLE_DIR: "/definitely/missing/postgres"
        }),
      ELECTROBUN_CONSOLE: "1",
      NO_COLOR: "1"
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  })
  children.push(child)
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        output += decoder.decode(value, { stream: true })
      }
    } finally {
      reader.releaseLock()
    }
    output += decoder.decode()
  }
  const collectors = Promise.all([collect(child.stdout), collect(child.stderr)])
  const exited = child.exited
  const appPID = (async (): Promise<number> => {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${bridgePort}/health`, {
          headers: { authorization: `Bearer ${bridgeToken}` }
        })
        const health = await response.json() as { readonly ok?: boolean; readonly pid?: number }
        if (response.ok && health.ok === true && Number.isSafeInteger(health.pid) && health.pid! > 1) {
          appPIDs.push(health.pid!)
          return health.pid!
        }
      } catch { /* The installed app may still be extracting. */ }
      await Bun.sleep(100)
    }
    throw new Error(`Installed app bridge did not become ready.\n${output}`)
  })()
  const bridgeState = async (): Promise<{ readonly app?: { readonly origin?: string; readonly packaged?: boolean } }> => {
    const response = await fetch(`http://127.0.0.1:${bridgePort}/state`, {
      headers: { authorization: `Bearer ${bridgeToken}` }
    })
    if (!response.ok) throw new Error(`Installed app bridge returned ${response.status}.`)
    return response.json() as Promise<{ readonly app?: { readonly origin?: string; readonly packaged?: boolean } }>
  }
  const bridgeEval = async (script: string): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${bridgePort}/window/eval`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ script })
    })
    if (!response.ok) throw new Error(`Installed app renderer bridge returned ${response.status}: ${await response.text()}`)
    return (await response.json() as { readonly result?: unknown }).result
  }
  const stop = async (): Promise<void> => {
    // Electrobun's launcher can be a self-extractor. Its PID is not the Bun
    // main process and terminating it bypasses NativeApp's shutdown handler.
    const pid = await appPID
    if (processAlive(pid)) process.kill(pid, "SIGTERM")
    await waitStopped(pid)
    const launcherExited = await Promise.race([exited.then(() => true), Bun.sleep(5_000).then(() => false)])
    if (!launcherExited) child.kill("SIGTERM")
    const code = await exited
    await collectors
    if (launcherExited && code !== 0 && code !== 143) {
      throw new Error(`Installed launcher exited ${code} after app shutdown.
${output}`)
    }
  }
  return {
    child,
    exited,
    logs: () => output,
    origin,
    state: join(home, "Library", "Application Support", "Smithers"),
    appPID,
    bridgeState,
    bridgeEval,
    stop
  }
}

const waitReady = async (app: RunningApp): Promise<void> => {
  let exitCode: number | undefined
  void app.exited.then((code) => { exitCode = code })
  const deadline = Date.now() + 120_000
  let lastError: unknown
  while (Date.now() < deadline) {
    if (exitCode !== undefined && exitCode !== 0) throw new Error(`Installed launcher exited ${exitCode} before readiness.\n${app.logs()}`)
    try {
      const response = await fetch(`${app.origin}/readyz`)
      if (response.ok) return
      lastError = new Error(`readyz returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(100)
  }
  throw new Error(`Installed app did not become ready: ${String(lastError)}\n${app.logs()}`)
}

const checksum = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex")

const jsonRequest = async <T>(
  origin: string,
  path: string,
  init: RequestInit = {}
): Promise<T> => {
  const response = await fetch(`${origin}${path}`, init)
  const body = await response.text()
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${body}`)
  return JSON.parse(body) as T
}

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitStopped = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return
    await Bun.sleep(50)
  }
  throw new Error(`Bundled PostgreSQL process ${pid} survived native shutdown.`)
}

const assertNoVisibleWindows = (pid: number): void => {
  if (process.env.SMITHERS_NATIVE_E2E_VISIBLE === "1") return
  const script = `import CoreGraphics
import Foundation
let pid = Int(CommandLine.arguments.last!)!
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
print(windows.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid }.count)`
  const result = Bun.spawnSync(["/usr/bin/swift", "-e", script, String(pid)], { stdout: "pipe", stderr: "pipe" })
  const output = new TextDecoder().decode(result.stdout).trim()
  if (result.exitCode !== 0 || output !== "0") {
    throw new Error(`Installed native app has visible windows (pid=${pid}, count=${output}): ${new TextDecoder().decode(result.stderr)}`)
  }
  console.log(`NATIVE_VISIBLE_WINDOWS=0 pid=${pid}`)
}

try {
  const port = await availablePort()
  const origin = `http://127.0.0.1:${port}`
  const home = join(root, "owned-home")
  const first = await launch(home, "own", origin)
  assertNoVisibleWindows(await first.appPID)
  const ownState = await first.bridgeState()
  if (!ownState.app?.origin || ownState.app.origin === origin || new URL(ownState.app.origin).hostname !== "127.0.0.1") {
    throw new Error("Installed native app did not serve its packaged UI through a local API relay.")
  }
  await waitReady(first)
  const [index, bootstrap] = await Promise.all([
    fetch(`${origin}/`).then((response) => response.text()),
    fetch(`${origin}/api/bootstrap`).then(async (response) => {
      if (!response.ok) throw new Error(`/api/bootstrap returned ${response.status}`)
      return response.json() as Promise<{ readonly apiVersion?: number; readonly buildSha?: string }>
    })
  ])
  if (!index.includes('<div id="root"')) throw new Error("The installed backend did not serve the real web application.")
  if (bootstrap.apiVersion !== 1) throw new Error("The installed backend returned an invalid bootstrap document.")
  if (process.env.SMITHERS_BUILD_SHA && bootstrap.buildSha !== process.env.SMITHERS_BUILD_SHA) {
    throw new Error(`The installed backend reported buildSha ${bootstrap.buildSha}, expected ${process.env.SMITHERS_BUILD_SHA}.`)
  }
  const secrets = join(first.state, "config", "secrets.json")
  const pgVersion = join(first.state, "postgres", "data", "PG_VERSION")
  const postmasterPID = join(first.state, "postgres", "data", "postmaster.pid")
  if (readFileSync(pgVersion, "utf8").trim() !== "18") throw new Error("The installed app did not initialize PostgreSQL 18.")
  const secretDocument = JSON.parse(readFileSync(secrets, "utf8")) as {
    readonly version?: number
    readonly values?: Readonly<Record<string, string>>
  }
  const bootstrapToken = secretDocument.values?.SMITHERS_AUTH_BOOTSTRAP_TOKEN
  if (secretDocument.version !== 1 || bootstrapToken === undefined || bootstrapToken === "") {
    throw new Error("The installed app did not persist its trusted owner bootstrap token.")
  }
  const owner = "nativeowner"
  const password = "Issue 12 installed native password"
  await jsonRequest(first.origin, "/api/auth/local/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-smithers-bootstrap-token": bootstrapToken
    },
    body: JSON.stringify({ username: owner, email: `${owner}@example.test`, password })
  })
  const credential = await jsonRequest<{ readonly token?: string }>(first.origin, "/api/auth/local/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: owner, password, name: "native-acceptance" })
  })
  if (credential.token === undefined || credential.token === "") {
    throw new Error("The installed app did not issue an owner credential.")
  }
  const repository = await jsonRequest<{ readonly full_name?: string }>(first.origin, "/api/user/repos", {
    method: "POST",
    headers: {
      authorization: `token ${credential.token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ name: "native-owned", private: true, auto_init: true })
  })
  if (repository.full_name !== `${owner}/native-owned`) {
    throw new Error("The installed app did not create a repository through the shared backend.")
  }
  const initialSecrets = checksum(secrets)
  const pid = Number.parseInt(readFileSync(postmasterPID, "utf8").split("\n")[0] ?? "", 10)
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("The installed PostgreSQL owner PID is invalid.")
  await first.stop()
  await waitStopped(pid)
  if (existsSync(postmasterPID)) throw new Error("Bundled PostgreSQL left postmaster.pid after shutdown.")

  const second = await launch(home, "own", origin)
  assertNoVisibleWindows(await second.appPID)
  await waitReady(second)
  if (checksum(secrets) !== initialSecrets) throw new Error("Native restart replaced the persisted owner secrets.")
  if (readFileSync(pgVersion, "utf8").trim() !== "18") throw new Error("Native restart lost the PostgreSQL cluster.")
  const restoredRepository = await jsonRequest<{ readonly full_name?: string }>(second.origin, `/api/repos/${owner}/native-owned`, {
    headers: { authorization: `token ${credential.token}` }
  })
  if (restoredRepository.full_name !== `${owner}/native-owned`) {
    throw new Error("Native restart lost the repository or owner credential.")
  }
  await second.stop()
  if (existsSync(postmasterPID)) throw new Error("Bundled PostgreSQL left postmaster.pid after restart shutdown.")

  const plueHome = join(root, "plue-home")
  missingBootstrapBackend = process.env.SMITHERS_MODE_MATRIX_PLUE_URL ? undefined : Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => new Response("404", { status: 404 })
  })
  if (missingBootstrapBackend && missingBootstrapBackend.port === undefined) throw new Error("Missing-bootstrap test backend has no port.")
  const plueOrigin = process.env.SMITHERS_MODE_MATRIX_PLUE_URL ||
    `http://127.0.0.1:${missingBootstrapBackend!.port}`
  const plueToken = process.env.SMITHERS_MODE_MATRIX_PLUE_TOKEN
  if (Boolean(process.env.SMITHERS_MODE_MATRIX_PLUE_URL) !== Boolean(plueToken)) {
    throw new Error("Configured Plue target requires both a URL and token.")
  }
  if (plueToken) {
    const response = await fetch(new URL("/api/bootstrap", plueOrigin), { signal: AbortSignal.timeout(10_000) })
    if (!response.ok || (await response.json() as { host?: string }).host !== "cloud") {
      throw new Error("Configured Plue target did not advertise a ready cloud bootstrap.")
    }
    await jsonRequest(plueOrigin, "/api/user", { headers: { authorization: `token ${plueToken}` } })
  }
  const plue = await launch(plueHome, "plue", plueOrigin, plueToken)
  assertNoVisibleWindows(await plue.appPID)
  const plueState = await plue.bridgeState()
  const rendererOrigin = plueState.app?.origin
  if (!rendererOrigin || new URL(rendererOrigin).hostname !== "127.0.0.1" ||
    rendererOrigin === plueOrigin || plueState.app?.packaged !== true) {
    throw new Error("The installed native app did not serve its packaged Plue UI locally.")
  }
  const plueIndex = await fetch(`${rendererOrigin}/`).then((response) => response.text())
  if (!plueIndex.includes('<div id="root"')) {
    throw new Error("The installed native app did not serve the packaged Plue application.")
  }
  if (!plueToken) {
    const deadline = Date.now() + 30_000
    let heading: unknown
    while (Date.now() < deadline) {
      heading = await plue.bridgeEval("return document.querySelector('main')?.textContent ?? null").catch(() => null)
      if (typeof heading === "string" && heading.includes("Backend does not provide Smithers bootstrap.")) break
      await Bun.sleep(200)
    }
    if (typeof heading !== "string" || !heading.includes("Backend does not provide Smithers bootstrap.") || heading.includes("404")) {
      throw new Error(`Native missing bootstrap did not show its typed failure: ${String(heading)}`)
    }
    recoveredBackend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) =>
      new URL(request.url).pathname === "/api/bootstrap"
        ? Response.json({ apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
            capabilities: [], authFlow: "none", sandbox: null })
        : new Response("not found", { status: 404 })
    })
    if (recoveredBackend.port === undefined) throw new Error("Recovery backend has no port.")
    const recoveryOrigin = `http://127.0.0.1:${recoveredBackend.port}`
    await plue.bridgeEval(`const button = [...document.querySelectorAll('button')].find(button => button.textContent === 'Switch backend'); button?.click(); return Boolean(button)`)
    await plue.bridgeEval(`const form = document.querySelector('main form'); form.querySelector('[name="origin"]').value = ${JSON.stringify(recoveryOrigin)}; form.requestSubmit(); return true`).catch(() => undefined)
    let switched = false
    const switchDeadline = Date.now() + 15_000
    while (Date.now() < switchDeadline) {
      switched = await fetch(`${rendererOrigin}/api/bootstrap`).then(async (response) =>
        response.ok && (await response.json() as { version?: string }).version === "test", () => false)
      if (switched) break
      await Bun.sleep(100)
    }
    if (!switched) throw new Error("Native Switch backend did not retarget the local API relay.")
  }
  if (plueToken) {
    const response = await fetch(`${rendererOrigin}/api/bootstrap`)
    if (!response.ok || (await response.json() as { host?: string }).host !== "cloud") {
      throw new Error("The installed native app did not relay the configured Plue backend.")
    }
  }
  await plue.stop()
  if (existsSync(plue.state)) throw new Error("Native Plue mode created local backend or PostgreSQL state.")

  const pathPattern = (path: string): string => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const leaked = Bun.spawnSync([
    "pgrep", "-f",
    `(${pathPattern(root)}|${pathPattern(bundledRoot)})/.*(smithers-backend|postgres)`
  ], { stdout: "pipe", stderr: "pipe" })
  if (leaked.exitCode === 0) throw new Error(`Bundled backend or PostgreSQL processes leaked: ${new TextDecoder().decode(leaked.stdout).trim()}`)
  if (leaked.exitCode !== 1) throw new Error("Could not check bundled process cleanup with pgrep.")

  console.log(`NATIVE_ACCEPTANCE_OK executable=${executable} state=${first.state}`)
} finally {
  missingBootstrapBackend?.stop(true)
  recoveredBackend?.stop(true)
  for (const pid of appPIDs) {
    if (processAlive(pid)) process.kill(pid, "SIGKILL")
  }
  for (const child of children) {
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(1).then(() => false)])
    if (!exited) child.kill("SIGKILL")
  }
  rmSync(root, { recursive: true, force: true })
}
