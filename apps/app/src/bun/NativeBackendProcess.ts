import { createHash } from "node:crypto"
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path"

export type NativeBackendMode = "own" | "plue"

interface Child {
  readonly exited: Promise<number>
  kill(signal: "SIGTERM" | "SIGKILL"): void
}

export interface NativeBackend {
  readonly mode: NativeBackendMode
  readonly origin: string | undefined
  /** Trusted main-process handoff for first-owner setup; never sent over HTTP. */
  readonly bootstrapToken: string | undefined
  readonly failure: Promise<Error | undefined> | undefined
  readonly stop: () => Promise<void>
}

export interface NativeBackendOptions {
  readonly stateDir: string
  /** The built SPA the owned backend serves at its public origin. */
  readonly webRoot?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Executable location injection for bundle fixtures only. */
  readonly executablePath?: string
  readonly setupHandoff?: "socket"
  readonly spawn?: (
    argv: ReadonlyArray<string>,
    options: {
      readonly env: Record<string, string>
      readonly stdout: "inherit"
      readonly stderr: "inherit"
    }
  ) => Child
  readonly fetch?: (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>
  readonly sleep?: (milliseconds: number) => Promise<void>
  /** Startup time allowed without progress (STARTUP_IDLE_MS). */
  readonly startupTimeoutMs?: number
}

/**
 * The only launcher variables the owned backend inherits: this machine's
 * session and network policy. Everything else it runs on is set below, so a
 * shell's provider keys, cloud tokens and SMITHERS_* overrides never reach it.
 */
const LAUNCHER_PASSTHROUGH = [
  "HOME", "USER", "LOGNAME", "TMPDIR", "TZ", "LANG", "LC_ALL", "LC_CTYPE",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR"
] as const

/**
 * How long a stop waits for the backend after SIGTERM before it kills it.
 * The backend stops its owned PostgreSQL within 10 s of the signal
 * (native.databaseStopGrace), and PostgreSQL runs in its own process group,
 * so a kill before then leaves it running. launchd kills this launcher 30 s
 * after its own SIGTERM (ExitTimeOut, HostService.ts).
 */
const BACKEND_STOP_GRACE_MS = 25_000

/**
 * How long startup may go without progress: the first step covers the
 * bundle checks and a first boot's initdb, the last the app's startup after
 * the migrations.
 */
const STARTUP_IDLE_MS = 60_000

/** A Dock launch can arrive without PATH; the backend still needs the system tools. */
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter)

/**
 * The backend's starting page (native.startingPage) answers /readyz 503
 * `{"status":"starting","phase","applied","total"}` while its PostgreSQL
 * starts and migrates; this is that step, or undefined for any other answer.
 */
const startingStep = async (response: Response): Promise<string | undefined> => {
  if (response.status !== 503) return undefined
  try {
    const body: unknown = await response.json()
    return isRecord(body) && body.status === "starting"
      ? JSON.stringify([body.phase, body.applied, body.total])
      : undefined
  } catch {
    return undefined
  }
}

const readinessProbe = async (
  fetchImpl: (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>,
  sleep: (milliseconds: number) => Promise<void>,
  origin: string,
  timeoutMs: number
): Promise<{ readonly ok: boolean; readonly step: string | undefined } | undefined> => {
  const controller = new AbortController()
  try {
    return await Promise.race([
      fetchImpl(`${origin}/readyz`, {
        redirect: "manual",
        signal: controller.signal
      }).then(async (response) => ({ ok: response.ok, step: response.ok ? undefined : await startingStep(response) }))
        .catch(() => undefined),
      sleep(timeoutMs).then(() => undefined)
    ])
  } finally {
    controller.abort()
  }
}

const postgresBinDirectory = (root: string): string => {
  const manifestPath = resolve(root, "bundle.json")
  let bin = "bin"
  if (existsSync(manifestPath)) {
    let manifest: unknown
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    } catch {
      throw new Error(`Owned PostgreSQL bundle manifest is invalid: ${manifestPath}`)
    }
    if (
      typeof manifest !== "object" || manifest === null ||
      !("version" in manifest) || manifest.version !== 1 ||
      !("bin" in manifest) || typeof manifest.bin !== "string" || manifest.bin === "" ||
      isAbsolute(manifest.bin)
    ) {
      throw new Error(`Owned PostgreSQL bundle manifest is invalid: ${manifestPath}`)
    }
    bin = manifest.bin
  }
  const candidate = resolve(root, bin)
  const child = relative(resolve(root), candidate)
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Owned PostgreSQL bundle bin path escapes its package: ${candidate}`)
  }
  try {
    const resolvedRoot = realpathSync(root)
    const resolvedBin = realpathSync(candidate)
    const resolvedChild = relative(resolvedRoot, resolvedBin)
    if (resolvedChild === "" || resolvedChild === ".." || resolvedChild.startsWith(`..${sep}`) || isAbsolute(resolvedChild)) {
      throw new Error()
    }
    return resolvedBin
  } catch {
    throw new Error(`Owned PostgreSQL bundle bin directory is unavailable: ${candidate}`)
  }
}

interface FlowHostEntry {
  readonly executable: string
  readonly sha256: string
  readonly flows: ReadonlyArray<string>
}

interface FlowHostBundle {
  readonly manifest: string
  readonly coding: FlowHostEntry & { readonly path: string }
  readonly jjExport: { readonly path: string }
  readonly node: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const packagedPath = (root: string, relativePath: string, label: string): string => {
  if (relativePath === "" || isAbsolute(relativePath)) {
    throw new Error(`${label} path is invalid.`)
  }
  const candidate = resolve(root, relativePath)
  const child = relative(root, candidate)
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`${label} path escapes its package.`)
  }
  try {
    const resolvedRoot = realpathSync(root)
    const resolved = realpathSync(candidate)
    const resolvedChild = relative(resolvedRoot, resolved)
    if (
      resolvedChild === "" || resolvedChild === ".." ||
      resolvedChild.startsWith(`..${sep}`) || isAbsolute(resolvedChild)
    ) throw new Error()
    return resolved
  } catch {
    throw new Error(`${label} is unavailable: ${candidate}`)
  }
}

const codingFlowHost = (root: string, value: unknown): FlowHostEntry & { readonly path: string } => {
  if (
    !isRecord(value) || typeof value.executable !== "string" ||
    typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Array.isArray(value.flows) || value.flows.some((flow) => typeof flow !== "string")
  ) throw new Error("Packaged coding Flow host manifest is invalid.")
  const flows = value.flows as ReadonlyArray<string>
  if (!flows.includes("coding/dispatch")) {
    throw new Error("Packaged coding Flow host catalog is incomplete.")
  }
  const path = packagedPath(root, value.executable, "Packaged coding Flow host")
  try {
    accessSync(path, constants.X_OK)
  } catch {
    throw new Error(`Packaged coding Flow host is not executable: ${path}`)
  }
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex")
  if (actual !== value.sha256) throw new Error("Packaged coding Flow host checksum failed.")
  return { executable: value.executable, sha256: value.sha256, flows, path }
}

const linuxJJExport = (root: string, value: unknown): { readonly path: string } => {
  if (!isRecord(value) || value.executable !== "linux-arm64/smithers-jj-export" ||
    typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error("Packaged Linux arm64 jj-export manifest is invalid.")
  }
  const path = packagedPath(root, value.executable, "Packaged Linux arm64 jj-export")
  try {
    accessSync(path, constants.X_OK)
  } catch {
    throw new Error(`Packaged Linux arm64 jj-export is not executable: ${path}`)
  }
  if (createHash("sha256").update(readFileSync(path)).digest("hex") !== value.sha256) {
    throw new Error("Packaged Linux arm64 jj-export checksum failed.")
  }
  return { path }
}

const flowHostBundle = (manifestPath: string): FlowHostBundle => {
  const manifest = resolve(manifestPath)
  let decoded: unknown
  try {
    decoded = JSON.parse(readFileSync(manifest, "utf8"))
  } catch {
    throw new Error(`Packaged Flow host manifest is invalid: ${manifest}`)
  }
  if (!isRecord(decoded) || decoded.version !== 1 || !isRecord(decoded.hosts)) {
    throw new Error(`Packaged Flow host manifest is invalid: ${manifest}`)
  }
  const root = dirname(manifest)
  return {
    manifest,
    coding: codingFlowHost(root, decoded.hosts.coding),
    jjExport: linuxJJExport(root, decoded.hosts.jjExport),
    node: packagedPath(root, "node", "Packaged Flow host runtime")
  }
}

const checksummedExecutable = (path: string, label: string): string => {
  try {
    accessSync(path, constants.X_OK)
  } catch {
    throw new Error(`${label} is not executable: ${path}`)
  }
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex")
  const expected = `${digest}  ${path.split(sep).at(-1)}\n`
  try {
    if (readFileSync(`${path}.sha256`, "utf8") !== expected) throw new Error("checksum mismatch")
  } catch {
    throw new Error(`${label} checksum failed.`)
  }
  return path
}

export const startNativeBackend = async (
  options: NativeBackendOptions
): Promise<NativeBackend> => {
  const env = options.env ?? Bun.env
  const mode = "own"
  const executable = realpathSync(options.executablePath ?? process.execPath)
  const binaryRoot = dirname(executable)
  const bundleRoot = dirname(binaryRoot)
  const backend = packagedPath(bundleRoot, "bin/smithers-backend", "Owned backend")
  const postgres = postgresBinDirectory(packagedPath(bundleRoot, "postgres", "Owned PostgreSQL bundle"))
  const hosts = flowHostBundle(packagedPath(bundleRoot, "bin/flow-hosts.json", "Packaged Flow host manifest"))
  const msb = packagedPath(bundleRoot, "bin/msb", "Bundled microVM runtime")
  const modelHost = checksummedExecutable(packagedPath(bundleRoot, "bin/smithers-model-host", "Packaged model host"), "Packaged model host")
  const jj = packagedPath(bundleRoot, "bin/jj", "Packaged jj")
  const git = packagedPath(bundleRoot, "bin/git", "Packaged Git")
  const gitRoot = resolve(binaryRoot, "..")
  const gitExecPath = resolve(gitRoot, "libexec", "git-core")
  const gitTemplateDir = resolve(gitRoot, "share", "git-core", "templates")
  const executables = [
    backend,
    msb,
    hosts.node,
    hosts.coding.path,
    modelHost,
    hosts.jjExport.path,
    resolve(binaryRoot, "smithers-jj-export"),
    jj,
    git,
    resolve(gitExecPath, "git-remote-http"),
    ...["postgres", "initdb", "pg_isready", "psql", "pg_dump", "pg_restore"]
      .map((name) => resolve(postgres, name))
  ]
  for (const path of executables) {
    try {
      accessSync(path, constants.X_OK)
    } catch {
      throw new Error(`Owned backend executable is unavailable: ${path}`)
    }
  }
  try {
    if (!statSync(gitTemplateDir).isDirectory()) throw new Error("not a directory")
  } catch {
    throw new Error(`Owned backend Git templates are unavailable: ${gitTemplateDir}`)
  }
  const ffi = resolve(
    binaryRoot,
    process.platform === "darwin"
      ? "libsmithers_ffi.dylib"
      : process.platform === "linux"
      ? "libsmithers_ffi.so"
      : "smithers_ffi.dll"
  )
  try {
    accessSync(ffi, constants.R_OK)
  } catch {
    throw new Error(`Owned backend FFI library is unavailable: ${ffi}`)
  }

  const origin = "http://127.0.0.1:4000"
  const environment: Record<string, string> = Object.fromEntries(
    LAUNCHER_PASSTHROUGH.flatMap((name) => {
      const value = env[name]
      return value === undefined || value === "" ? [] : [[name, value]]
    })
  )
  // The backend verifies every path below against the installed bundle it
  // runs from (spec section 17.3); nothing it does not verify is passed.
  environment.PATH = `${binaryRoot}${delimiter}${SYSTEM_PATH}`
  environment.SMITHERS_WEB_ROOT = options.webRoot ?? packagedPath(bundleRoot, "views/mainview", "Packaged web app")
  // The backend's git is plumbing over owned repositories; the user's git config never applies.
  environment.GIT_CONFIG_NOSYSTEM = "1"
  environment.GIT_CONFIG_GLOBAL = "/dev/null"
  environment.SMITHERS_AUTH_MODE = "selfhost"
  environment.SMITHERS_NATIVE_POSTGRES_BIN = postgres
  environment.SMITHERS_NATIVE_POSTGRES_MAJOR = "18"
  environment.SMITHERS_NATIVE_STATE_DIR = options.stateDir
  environment.SMITHERS_DATA_ROOT = options.stateDir
  environment.SMITHERS_SERVER_ADDR = new URL(origin).host
  environment.SMITHERS_FLOW_HOST_MANIFEST = hosts.manifest
  environment.SMITHERS_WORKSPACE_ISOLATION = "microvm"
  environment.SMITHERS_EGRESS_RELAY_PORT = "4001"
  environment.SMITHERS_SSH_ADDR = "127.0.0.1:2222"
  environment.SMITHERS_MODEL_HOST_BUNDLE = modelHost
  environment.SMITHERS_NODE_BINARY = resolve(binaryRoot, "node")
  environment.GIT_EXEC_PATH = gitExecPath
  environment.GIT_TEMPLATE_DIR = gitTemplateDir
  environment.SMITHERS_FFI_LIBRARY_PATH = ffi

  // Names only: the triage line for a backend that differs between terminal and Dock launches.
  console.error(`owned backend env: ${Object.keys(environment).sort().join(" ")}`)
  const spawn = options.spawn ?? ((argv, childOptions) => Bun.spawn([...argv], childOptions))
  const child = spawn(options.setupHandoff === "socket" ? [backend, "--setup-handoff=socket"] : [backend], {
    env: environment,
    stdout: "inherit",
    stderr: "inherit"
  })
  let exitCode: number | undefined
  void child.exited.then((code) => {
    exitCode = code
  })

  let stopped: Promise<void> | undefined
  let stopping = false
  const failure = child.exited.then((code) =>
    stopping ? undefined : new Error(`Owned backend exited unexpectedly with code ${code}.`)
  )
  const sleep = options.sleep ?? Bun.sleep
  const stop = (): Promise<void> => stopped ??= (async () => {
    stopping = true
    if (exitCode !== undefined) return
    child.kill("SIGTERM")
    const graceful = await Promise.race([
      child.exited.then(() => true),
      sleep(BACKEND_STOP_GRACE_MS).then(() => false)
    ])
    if (!graceful) {
      child.kill("SIGKILL")
      await child.exited
    }
  })()

  const fetchImpl = options.fetch ?? globalThis.fetch
  // The deadline bounds time without progress: each new step the starting
  // page reports (the database, then each migration) restarts it, so a first
  // boot on a loaded Mac (116 migrations took 29.5 s at load 67) completes,
  // while a backend that stops answering still fails.
  const idleMs = options.startupTimeoutMs ?? STARTUP_IDLE_MS
  let deadline = Date.now() + idleMs
  let step: string | undefined
  try {
    while (Date.now() < deadline) {
      if (exitCode !== undefined) {
        throw new Error(`Owned backend exited before readiness with code ${exitCode}.`)
      }
      const remaining = Math.max(1, deadline - Date.now())
      const response = await readinessProbe(fetchImpl, sleep, origin, Math.min(1_000, remaining))
      if (exitCode !== undefined) {
        throw new Error(`Owned backend exited before readiness with code ${exitCode}.`)
      }
      if (response?.ok) return { mode, origin, bootstrapToken: undefined, failure, stop }
      if (response?.step !== undefined && response.step !== step) {
        step = response.step
        deadline = Date.now() + idleMs
      }
      await sleep(Math.min(50, remaining))
    }
    throw new Error("Owned backend did not become ready before its startup deadline.")
  } catch (error) {
    await stop()
    throw error
  }
}
