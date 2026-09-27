import { createHash, randomBytes } from "node:crypto"
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
  readonly webRoot: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Replaces the persisted or generated first-owner token; tests only. */
  readonly bootstrapToken?: string
  readonly fromDir?: string
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
  readonly startupTimeoutMs?: number
}

const setting = (
  env: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined => {
  const value = env[name]?.trim()
  return value === "" ? undefined : value
}

export const nativeBackendMode = (
  env: Readonly<Record<string, string | undefined>>
): NativeBackendMode => {
  const mode = setting(env, "SMITHERS_BACKEND_MODE") ?? "own"
  if (mode === "own" || mode === "plue") return mode
  throw new Error("SMITHERS_BACKEND_MODE must be own or plue.")
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

/** A Dock launch can arrive without PATH; the backend still needs the system tools. */
const SYSTEM_PATH = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter)

const localOrigin = (value: string): string => {
  let origin: URL
  try {
    origin = new URL(value)
  } catch {
    throw new Error("The owned backend origin must be an absolute loopback HTTP origin.")
  }
  if (
    origin.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.origin !== value.replace(/\/$/, "")
  ) {
    throw new Error("The owned backend origin must be an absolute loopback HTTP origin.")
  }
  return origin.origin
}

const readinessProbe = async (
  fetchImpl: (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>,
  sleep: (milliseconds: number) => Promise<void>,
  origin: string,
  timeoutMs: number
): Promise<Response | undefined> => {
  const controller = new AbortController()
  try {
    return await Promise.race([
      fetchImpl(`${origin}/readyz`, {
        redirect: "manual",
        signal: controller.signal
      }).catch(() => undefined),
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
  readonly librarian: FlowHostEntry & { readonly path: string }
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

const flowHost = (
  root: string,
  value: unknown,
  catalog: "coding" | "librarian",
  requiredFlows: ReadonlyArray<string>
): FlowHostEntry & { readonly path: string } => {
  if (
    !isRecord(value) || typeof value.executable !== "string" ||
    typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Array.isArray(value.flows) || value.flows.some((flow) => typeof flow !== "string")
  ) throw new Error(`Packaged ${catalog} Flow host manifest is invalid.`)
  const flows = value.flows as ReadonlyArray<string>
  if (requiredFlows.some((flow) => !flows.includes(flow))) {
    throw new Error(`Packaged ${catalog} Flow host catalog is incomplete.`)
  }
  const path = packagedPath(root, value.executable, `Packaged ${catalog} Flow host`)
  try {
    accessSync(path, constants.X_OK)
  } catch {
    throw new Error(`Packaged ${catalog} Flow host is not executable: ${path}`)
  }
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex")
  if (actual !== value.sha256) throw new Error(`Packaged ${catalog} Flow host checksum failed.`)
  return { executable: value.executable, sha256: value.sha256, flows, path }
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
    coding: flowHost(root, decoded.hosts.coding, "coding", ["coding/dispatch"]),
    librarian: flowHost(root, decoded.hosts.librarian, "librarian", []),
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

const nativeBootstrapToken = (stateDir: string): string => {
  const path = resolve(stateDir, "config", "secrets.json")
  if (!existsSync(path)) return randomBytes(32).toString("hex")
  const info = statSync(path)
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error(`Owned backend secrets are not a private regular file: ${path}`)
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw new Error(`Owned backend secrets are invalid: ${path}`)
  }
  const token = isRecord(decoded) && decoded.version === 1 && isRecord(decoded.values)
    ? decoded.values.SMITHERS_AUTH_BOOTSTRAP_TOKEN
    : undefined
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error(`Owned backend secrets contain no bootstrap token: ${path}`)
  }
  return token
}

export const startNativeBackend = async (
  options: NativeBackendOptions
): Promise<NativeBackend> => {
  const env = options.env ?? Bun.env
  const mode = nativeBackendMode(env)
  if (mode === "plue") {
    return { mode, origin: undefined, bootstrapToken: undefined, failure: undefined, stop: async () => {} }
  }

  const fromDir = options.fromDir ?? import.meta.dir
  const backend = setting(env, "SMITHERS_BACKEND_BINARY") ??
    resolve(fromDir, "..", "bin", "smithers-backend")
  const postgresRoot = setting(env, "SMITHERS_POSTGRES_BUNDLE_DIR") ??
    resolve(fromDir, "..", "postgres")
  const postgres = postgresBinDirectory(postgresRoot)
  const binaryRoot = dirname(backend)
  const hosts = flowHostBundle(
    setting(env, "SMITHERS_FLOW_HOST_MANIFEST") ?? resolve(binaryRoot, "flow-hosts.json")
  )
  const modelHost = checksummedExecutable(resolve(binaryRoot, "smithers-model-host"), "Packaged model host")
  const jj = resolve(binaryRoot, "jj")
  const git = resolve(binaryRoot, "git")
  const gitRoot = resolve(binaryRoot, "..")
  const gitExecPath = resolve(gitRoot, "libexec", "git-core")
  const gitTemplateDir = resolve(gitRoot, "share", "git-core", "templates")
  const executables = [
    backend,
    hosts.node,
    hosts.coding.path,
    hosts.librarian.path,
    modelHost,
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

  const origin = localOrigin(
    setting(env, "SMITHERS_OWNED_BACKEND_ORIGIN") ?? "http://127.0.0.1:4000"
  )
  const bootstrapToken = options.bootstrapToken ?? nativeBootstrapToken(options.stateDir)
  const launcherPath = setting(env, "PATH") ?? SYSTEM_PATH
  const environment: Record<string, string> = Object.fromEntries(
    LAUNCHER_PASSTHROUGH.flatMap((name) => {
      const value = env[name]
      return value === undefined || value === "" ? [] : [[name, value]]
    })
  )
  environment.PATH = `${binaryRoot}${delimiter}${launcherPath}`
  environment.SMITHERS_WEB_ROOT = options.webRoot
  // The backend's git is plumbing over owned repositories; the user's git config never applies.
  environment.GIT_CONFIG_NOSYSTEM = "1"
  environment.GIT_CONFIG_GLOBAL = "/dev/null"
  environment.SMITHERS_AUTH_MODE = "selfhost"
  environment.SMITHERS_AUTH_BOOTSTRAP_TOKEN = bootstrapToken
  environment.SMITHERS_NATIVE_POSTGRES_BIN = postgres
  environment.SMITHERS_NATIVE_POSTGRES_MAJOR = "18"
  environment.SMITHERS_NATIVE_STATE_DIR = options.stateDir
  environment.SMITHERS_DATA_ROOT = options.stateDir
  environment.SMITHERS_SERVER_ADDR = new URL(origin).host
  environment.SMITHERS_PUBLIC_URL = origin
  environment.SMITHERS_FLOW_HOST_MANIFEST = hosts.manifest
  environment.SMITHERS_WORKSPACE_CODING_HOST_BINARY = hosts.coding.path
  environment.SMITHERS_WORKSPACE_CODING_HOST_SHA256 = hosts.coding.sha256
  environment.SMITHERS_WORKSPACE_LIBRARIAN_HOST_BINARY = hosts.librarian.path
  environment.SMITHERS_WORKSPACE_LIBRARIAN_HOST_SHA256 = hosts.librarian.sha256
  environment.SMITHERS_MODEL_HOST_BUNDLE = modelHost
  environment.SMITHERS_NODE_BINARY = resolve(binaryRoot, "node")
  environment.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY = resolve(
    binaryRoot,
    "smithers-jj-export"
  )
  environment.SMITHERS_CODING_LOCAL_OWNER = "1"
  environment.SMITHERS_JJ_PATH = jj
  environment.GIT_EXEC_PATH = gitExecPath
  environment.GIT_TEMPLATE_DIR = gitTemplateDir
  environment.SMITHERS_FFI_LIBRARY_PATH = ffi

  // Names only: the triage line for a backend that differs between terminal and Dock launches.
  console.error(`owned backend env: ${Object.keys(environment).sort().join(" ")}`)
  const spawn = options.spawn ?? ((argv, childOptions) => Bun.spawn([...argv], childOptions))
  const child = spawn([backend], {
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
      sleep(10_000).then(() => false)
    ])
    if (!graceful) {
      child.kill("SIGKILL")
      await child.exited
    }
  })()

  const fetchImpl = options.fetch ?? globalThis.fetch
  const deadline = Date.now() + (options.startupTimeoutMs ?? 30_000)
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
      if (response?.ok) return { mode, origin, bootstrapToken, failure, stop }
      await sleep(Math.min(50, remaining))
    }
    throw new Error("Owned backend did not become ready before its startup deadline.")
  } catch (error) {
    await stop()
    throw error
  }
}
