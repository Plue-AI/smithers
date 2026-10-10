/** Per-user launchd adapter restored from organization/setup/service.ts. */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { request } from "node:http"
import { isIP } from "node:net"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { Refused } from "../../CliError.ts"

export const label = "sh.smithers.host"
export const stateDirectory = (home = homedir()) => join(home, "Library", "Application Support", "Smithers")
type PlistValue = string | number | boolean | ReadonlyArray<string> | { readonly [key: string]: PlistValue }

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;")

const render = (value: PlistValue, indent: string): string => {
  if (typeof value === "string") return `${indent}<string>${escape(value)}</string>`
  if (typeof value === "number") return `${indent}<integer>${value}</integer>`
  if (typeof value === "boolean") return `${indent}<${value}/>`
  if (Array.isArray(value)) {
    return [`${indent}<array>`, ...value.map((item: string) => render(item, `${indent}  `)), `${indent}</array>`].join(
      "\n"
    )
  }
  const entries = Object.entries(value as { readonly [key: string]: PlistValue })
  return [
    `${indent}<dict>`,
    ...entries.flatMap(([key, item]) => [`${indent}  <key>${escape(key)}</key>`, render(item, `${indent}  `)]),
    `${indent}</dict>`
  ].join("\n")
}

/** An XML property list document. */
export const plist = (value: { readonly [key: string]: PlistValue }): string =>
  [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    render(value, ""),
    "</plist>",
    ""
  ].join("\n")

export interface ServiceOptions {
  readonly bundle: string
  readonly stateDir: string
  readonly home: string
  readonly bind?: string
  readonly origins?: ReadonlyArray<string>
}
export const hostPlist = (options: ServiceOptions, environment: NodeJS.ProcessEnv = process.env): string =>
  plist({
    Label: label,
    ProgramArguments: [
      join(options.bundle, "bin/smithers-server"),
      "--setup-handoff=socket",
      ...(options.bind === undefined ? [] : ["--bind", options.bind]),
      ...(options.origins ?? []).flatMap((origin) => ["--origin", origin])
    ],
    WorkingDirectory: options.stateDir,
    EnvironmentVariables: {
      // Keep the bundled launcher's owner-configured network policy across
      // login/restart. Never forward provider keys or SMITHERS runtime overrides.
      ...Object.fromEntries([
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
        "all_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR"
      ].flatMap((name) => environment[name] ? [[name, environment[name]!]] : [])),
      HOME: options.home,
      PATH: `${options.bundle}/bin:/usr/bin:/bin:/usr/sbin:/sbin`
    },
    RunAtLoad: true,
    KeepAlive: { PathState: { [join(options.stateDir, "start-refusal.json")]: false } },
    ThrottleInterval: 5,
    ExitTimeOut: 30,
    ProcessType: "Standard",
    StandardOutPath: join(options.stateDir, "logs/host.log"),
    StandardErrorPath: join(options.stateDir, "logs/host.log")
  })

export interface Launchctl {
  (args: ReadonlyArray<string>): { readonly status: number | null; readonly stdout: string; readonly stderr: string }
}
export interface Launchd {
  readonly agentsDir: string
  readonly domain: string
  readonly launchctl: Launchctl
}
export const launchd = (): Launchd => {
  if (process.platform !== "darwin" || !process.getuid || process.getuid() === 0) {
    throw new Refused({
      fault: "policy",
      code: "host_platform",
      message: "Host service requires an unprivileged macOS login session"
    })
  }
  return {
    agentsDir: join(homedir(), "Library/LaunchAgents"),
    domain: `gui/${process.getuid()}`,
    launchctl: (args) => {
      const result = spawnSync("/bin/launchctl", [...args], { encoding: "utf8" })
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? result.error?.message ?? ""
      }
    }
  }
}
export const loaded = (system: Launchd) => system.launchctl(["print", `${system.domain}/${label}`]).status === 0
export const plistFile = (system: Launchd) => join(system.agentsDir, `${label}.plist`)

/** Verify every bundle byte before changing launchd state. No PATH lookup or shell. */
export const verifyBundle = (input: string): { bundle: string; version: string } => {
  const bundle = realpathSync(resolve(input))
  const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"))
  if (manifest.version !== 1 || manifest.platform !== "darwin-arm64" || !/^[a-f0-9]{40,64}$/.test(manifest.revision)) {
    throw new Refused({ fault: "user", code: "invalid_bundle", message: "Invalid bundle manifest" })
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Refused({ fault: "user", code: "invalid_bundle", message: "Invalid bundle manifest files" })
  }
  const declared = new Set<string>()
  for (const entry of manifest.files) {
    const path = entry.path
    if (
      typeof path !== "string" || !path || isAbsolute(path) || path.split("/").some((part: string) =>
        part === ".." || part === "." || !part
      ) || declared.has(path)
    ) {
      throw new Refused({ fault: "user", code: "invalid_bundle", message: "Invalid bundle manifest path" })
    }
    declared.add(path)
    const file = join(bundle, path)
    if (
      typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !realpathSync(file).startsWith(bundle + "/")
    ) {
      throw new Refused({ fault: "user", code: "invalid_bundle", message: `Invalid bundle manifest entry: ${path}` })
    }
    const info = lstatSync(file)
    if (
      typeof entry.stage !== "string" || !entry.stage || entry.mode !== (info.mode & 0o777) ||
      (info.isSymbolicLink()
        ? entry.symlink !== readlinkSync(file) || isAbsolute(entry.symlink)
        : entry.symlink !== undefined) ||
      (!info.isFile() && !info.isSymbolicLink())
    ) throw new Refused({ fault: "user", code: "invalid_bundle", message: `Bundle metadata differs: ${path}` })
    if (createHash("sha256").update(readFileSync(file)).digest("hex") !== entry.sha256) {
      throw new Refused({ fault: "user", code: "invalid_bundle", message: `Bundle hash differs: ${path}` })
    }
  }
  const walk = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + entry.name
      if (entry.isDirectory()) walk(join(directory, entry.name), path + "/")
      else if (path !== "manifest.json" && !declared.has(path)) {
        throw new Refused({
          fault: "user",
          code: "invalid_bundle",
          message: `Bundle file absent from manifest: ${path}`
        })
      }
    }
  }
  walk(bundle)
  for (const path of ["bin/smithers-server", "bin/smithers-backend", "bin/msb"]) {
    if (!declared.has(path) || !(lstatSync(join(bundle, path)).mode & 0o111)) {
      throw new Refused({ fault: "user", code: "invalid_bundle", message: `Bundle executable missing: ${path}` })
    }
  }
  return { bundle, version: manifest.revision }
}
export const resolveBundle = (input?: string): string => {
  if (input) return resolve(input)
  const keg = "/opt/homebrew/opt/smithers/libexec"
  if (existsSync(join(keg, "manifest.json"))) return keg
  throw new Refused({
    fault: "dependency",
    code: "bundle_missing",
    message: `No server bundle; use --bundle <dir> or install the bundle at ${keg}`
  })
}

/** Wait for launchd removal and the owned launcher's backend/PostgreSQL shutdown. */
const waitStopped = async (system: Launchd, output: string): Promise<void> => {
  const pid = Number(output.match(/\bpid = (\d+)/)?.[1])
  const deadline = Date.now() + 30_000
  while (true) {
    let alive = false
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0)
        alive = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
    if (!alive && !loaded(system)) break
    if (Date.now() >= deadline) {
      throw new Refused({ fault: "infra", code: "host_stop_timeout", message: "Host service did not stop" })
    }
    await new Promise((done) => setTimeout(done, 100))
  }
}

/** Writes and loads one agent; unchanged loaded agents retain their backend token. */
export const install = async (
  options: ServiceOptions,
  system: Launchd
): Promise<"installed" | "reloaded" | "unchanged"> => {
  verifyBundle(options.bundle)
  const file = plistFile(system), content = hostPlist(options)
  const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined
  const job = system.launchctl(["print", `${system.domain}/${label}`])
  const isLoaded = job.status === 0
  if (previous === content && isLoaded) return "unchanged"
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(join(options.stateDir, "logs"), { recursive: true, mode: 0o700 })
  mkdirSync(system.agentsDir, { recursive: true })
  if (isLoaded) {
    const out = system.launchctl(["bootout", `${system.domain}/${label}`])
    if (out.status !== 0) {
      throw new Refused({
        fault: "infra",
        code: "host_stop_failed",
        message: "launchctl bootout failed; bundle unchanged"
      })
    }
    await waitStopped(system, job.stdout)
  }
  writeFileSync(`${file}.tmp`, content, { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
  const result = system.launchctl(["bootstrap", system.domain, file])
  if (result.status !== 0) {
    throw new Refused({
      fault: "infra",
      code: "host_start_failed",
      message: `launchctl bootstrap failed: ${result.stderr.trim()}`
    })
  }
  return isLoaded ? "reloaded" : "installed"
}
export const stop = async (system: Launchd): Promise<{ state: "stopped" }> => {
  const job = system.launchctl(["print", `${system.domain}/${label}`])
  if (job.status === 0) {
    const out = system.launchctl(["bootout", `${system.domain}/${label}`])
    if (out.status !== 0 && loaded(system)) {
      throw new Refused({ fault: "infra", code: "host_stop_failed", message: "launchctl bootout failed" })
    }
    await waitStopped(system, job.stdout)
  }
  rmSync(plistFile(system), { force: true })
  return { state: "stopped" }
}
export const installedBundle = (system: Launchd): string => {
  const text = readFileSync(plistFile(system), "utf8")
  const executable = text.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/)?.[1]
  if (!executable) {
    throw new Refused({
      fault: "dependency",
      code: "bundle_missing",
      message: "Installed host bundle path unavailable"
    })
  }
  return dirname(
    dirname(
      executable.replaceAll("&quot;", "\"").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&")
    )
  )
}

/** Maintenance runs only the verified installed backend, with an inert environment.
 * It must not borrow a repository executable, login token or shell hook.
 */
export const maintenance = (
  operation: "backup" | "upgrade" | "restore",
  directory?: string,
  system: Launchd = launchd(),
  run: typeof spawnSync = spawnSync
) => {
  if (operation === "restore" && loaded(system)) {
    throw new Refused({
      fault: "infra",
      code: "install_running",
      message: "Restore refuses a running install; run smthrs host stop first"
    })
  }
  if (operation === "restore" && !directory?.trim()) {
    throw new Refused({ fault: "user", code: "invalid_backup", message: "Backup directory is required" })
  }
  // stop removes the plist. Recovery must still find the current Homebrew keg.
  const bundle = verifyBundle(existsSync(plistFile(system)) ? installedBundle(system) : resolveBundle()).bundle
  const result = run(join(bundle, "bin/smithers-backend"), [
    "host-maintenance",
    operation,
    ...(directory === undefined ? [] : [resolve(directory)])
  ], {
    encoding: "utf8",
    maxBuffer: 65536,
    env: { HOME: homedir(), PATH: `${bundle}/bin:/usr/bin:/bin:/usr/sbin:/sbin` }
  })
  if (result.status !== 0) {
    const message = result.stderr?.trim() || "Host maintenance backend did not answer"
    const code = message.match(/^([a-z_]+):/)?.[1] ?? "host_maintenance_failed"
    throw new Refused({ fault: "infra", code, message })
  }
  return result.stdout.trimEnd()
}
/**
 * true when the host is ready; while it starts, the starting page's step
 * (503 `{"status":"starting","phase","applied","total"}`, the backend's
 * native.startingPage); otherwise false.
 */
export const ready = async (): Promise<boolean | string> => {
  try {
    const response = await fetch("http://127.0.0.1:4000/readyz", {
      signal: AbortSignal.timeout(1000),
      redirect: "error"
    })
    if (response.ok) return true
    if (response.status !== 503) return false
    const body: { status?: unknown; phase?: unknown; applied?: unknown; total?: unknown } = await response.json()
    return body?.status === "starting" ? JSON.stringify([body.phase, body.applied, body.total]) : false
  } catch {
    return false
  }
}
/**
 * Waits for readiness, allowing `timeout` without progress: each new
 * starting step restarts it, so a first boot's migrations on a loaded Mac
 * finish instead of failing `smthrs host start`.
 */
export const waitReady = async (probe: () => Promise<boolean | string> = ready, timeout = 60_000): Promise<void> => {
  let deadline = Date.now() + timeout
  let step: string | undefined
  do {
    const answer = await probe()
    if (answer === true) return
    if (typeof answer === "string" && answer !== step) {
      step = answer
      deadline = Date.now() + timeout
    }
    await new Promise((done) => setTimeout(done, 250))
  } while (Date.now() < deadline)
  throw new Refused({
    fault: "infra",
    code: "host_not_ready",
    message: "Host readiness failed at http://127.0.0.1:4000/readyz"
  })
}
/** The private backend socket is the sole authority; missing output never means claimed. */
export const setupURLs = (
  stateDir: string
): Promise<{ code: string; setup_urls?: string[]; message?: string; exitCode: number }> =>
  new Promise((done, reject) => {
    const socketPath = join(stateDir, "run/host.sock")
    const info = lstatSync(socketPath)
    if (!info.isSocket() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()) {
      reject(
        new Refused({
          fault: "policy",
          code: "setup_socket_permissions",
          message: "Host setup socket must be user-owned with mode 0600"
        })
      )
      return
    }
    const req = request({ socketPath, path: "/setup-urls", method: "GET", timeout: 5000 }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => {
        body += chunk
        if (body.length > 65536) {
          req.destroy(
            new Refused({ fault: "infra", code: "invalid_setup_response", message: "Invalid setup handoff response" })
          )
        }
      })
      res.on("error", reject)
      res.on("end", () => {
        try {
          const data = JSON.parse(body)
          if (res.statusCode === 401 && data.error === "setup_closed") {
            done({ code: "setup_closed", message: "Already set up.", exitCode: 3 })
            return
          }
          if (res.statusCode === 503 && data.error === "setup_mint_failed") {
            done({ code: "setup_mint_failed", message: "Setup URL mint failed; nothing emitted.", exitCode: 4 })
            return
          }
          if (
            res.statusCode !== 200 || Object.keys(data).join() !== "setup_urls" || !Array.isArray(data.setup_urls) ||
            !data.setup_urls.length || data.setup_urls.some((value: unknown) => {
              if (typeof value !== "string") return true
              const url = new URL(value)
              return !["http:", "https:"].includes(url.protocol) || url.pathname !== "/setup" ||
                !url.searchParams.get("token") || url.username || url.password || /[\r\n\x1b]/.test(value)
            })
          ) {
            throw new Refused({
              fault: "infra",
              code: "invalid_setup_response",
              message: "Invalid setup handoff response"
            })
          }
          done({ code: "setup_ready", setup_urls: data.setup_urls, exitCode: 0 })
        } catch {
          reject(
            new Refused({ fault: "infra", code: "invalid_setup_response", message: "Invalid setup handoff response" })
          )
        }
      })
    })
    req.on(
      "timeout",
      () =>
        req.destroy(
          new Refused({ fault: "infra", code: "setup_socket_timeout", message: "Host setup socket timed out" })
        )
    )
    req.on(
      "error",
      () =>
        reject(
          new Refused({ fault: "infra", code: "setup_socket_unavailable", message: "Host setup socket unavailable" })
        )
    )
    req.end()
  })
/** Durable backend refusal also survives a stopped or unloaded job. */
export const startRefusal = (stateDir: string): Refused | undefined => {
  const file = join(stateDir, "start-refusal.json")
  if (!existsSync(file)) return undefined
  const row = JSON.parse(readFileSync(file, "utf8"))
  if (row.code !== "host_capacity_zero" || typeof row.message !== "string") return undefined
  return new Refused({ fault: "infra", class: "capacity", code: row.code, message: `${row.code}: ${row.message}` })
}
export const start = async (
  input?: string,
  address: { readonly bind?: string; readonly origins?: ReadonlyArray<string> } = {}
) => {
  validateAddress(address)
  const system = launchd(), stateDir = stateDirectory()
  const bundle = realpathSync(resolveBundle(input))
  return startInstalled({ bundle, stateDir, home: homedir(), ...address }, system)
}
export const startInstalled = async (
  options: ServiceOptions,
  system: Launchd,
  probe: () => Promise<boolean | string> = ready,
  handoff: typeof setupURLs = setupURLs
) => {
  verifyBundle(options.bundle)
  const { stateDir, bind, origins } = options
  if (startRefusal(stateDir)) await stop(system)
  rmSync(join(stateDir, "start-refusal.json"), { force: true })
  await install(options, system)
  await waitReady(async () => {
    const refusal = startRefusal(stateDir)
    if (refusal) {
      await stop(system)
      throw refusal
    }
    const answer = await probe()
    const latest = startRefusal(stateDir)
    if (latest) {
      await stop(system)
      throw latest
    }
    return answer
  })
  const result = await handoff(stateDir)
  return bind && !origins?.length ? { ...result, warning: "LAN browsers need --origin" } : result
}
/** One terminal rendering for the registered CLI and the bundled host door. */
export const startText = (value: unknown): string => {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {}
  return Array.isArray(row.setup_urls)
    ? [...row.setup_urls, ...(row.warning ? [row.warning] : [])].join("\n")
    : String(row.message ?? "")
}

export const status = async (system: Launchd = launchd(), stateDir = stateDirectory()) => {
  const refusal = startRefusal(stateDir)
  if (refusal) throw refusal
  const bundle = installedBundle(system)
  const verified = verifyBundle(bundle)
  if (!loaded(system) || await ready() !== true) {
    throw new Refused({ fault: "infra", code: "host_unhealthy", message: `Host unhealthy: ${bundle}` })
  }
  doctor(bundle, stateDirectory())
  const install = await installTelemetry(undefined, process.env.SMITHERS_TOKEN?.trim())
  return {
    state: "ready",
    bundle,
    version: verified.version,
    launchd: "running",
    readiness: "ready",
    doctor: "ready",
    ...(install ? { install } : {})
  }
}

/** Read-only bundled diagnostics need the same state root as the running service; the backend runs only its own bundle's msb. */
export const doctor = (bundle: string, stateDir: string, run = spawnSync): void => {
  const result = run(join(bundle, "bin/smithers-backend"), ["microvm", "doctor"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { HOME: homedir(), PATH: `${bundle}/bin:/usr/bin:/bin`, SMITHERS_DATA_ROOT: stateDir }
  })
  if (result.status !== 0) {
    throw new Refused({
      fault: "infra",
      code: "microvm_doctor_failed",
      message: `Bundled microVM doctor failed: ${bundle}`
    })
  }
}

/** Validate local serving flags before changing launchd or opening a listener. */
export function validateAddress(address: { readonly bind?: string; readonly origins?: ReadonlyArray<string> }): void {
  if (address.bind !== undefined && address.bind !== "") {
    const bind = address.bind
    const host = isIP(bind) ? bind : bind.match(/^\[([^\]]+)\]:4000$/)?.[1] ?? bind.match(/^([^:]+):4000$/)?.[1] ?? bind
    if (host !== "localhost" && !isIP(host)) {
      throw new Refused({ fault: "user", code: "invalid_bind_address", message: "Invalid bind address" })
    }
  }
  if ((address.origins?.length ?? 0) > 10) {
    throw new Refused({ fault: "user", code: "invalid_public_origins", message: "Invalid public origins" })
  }
  const hosts = new Set<string>()
  for (const origin of address.origins ?? []) {
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      throw new Refused({ fault: "user", code: "invalid_public_origin", message: "Invalid public origin" })
    }
    if (
      !/^(http|https):$/.test(url.protocol) || !url.host || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || origin.includes("?") || origin.includes("#") || origin.endsWith("/") ||
      hosts.has(url.host)
    ) throw new Refused({ fault: "user", code: "invalid_public_origin", message: "Invalid public origin" })
    if (["localhost:4000", "127.0.0.1:4000", "[::1]:4000"].includes(url.host) && url.protocol !== "http:") {
      throw new Refused({
        fault: "user",
        code: "invalid_loopback_origin",
        message: "Loopback control origin must use HTTP"
      })
    }
    hosts.add(url.host)
  }
}

/** Optional install telemetry. Never copy setup URLs or credentials into status. */
export const installTelemetry = async (endpoint = "http://127.0.0.1:4000/api/install", credential?: string) => {
  try {
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
      ...(credential ? { headers: { Authorization: `Bearer ${credential}` } } : {})
    })
    if (!response.ok) return undefined
    const body = await response.json() as Record<string, unknown>
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
    const result: Record<string, unknown> = {}
    if (typeof body.capacity === "number" && Number.isFinite(body.capacity) && body.capacity >= 0) {
      result.capacity = body.capacity
    }
    if (body.this_mac && typeof body.this_mac === "object") {
      const mac = body.this_mac as Record<string, unknown>
      const values: Record<string, unknown> = {}
      for (const key of ["memory_gb", "perf_cores", "capacity"]) {
        const value = mac[key]
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) values[key] = value
      }
      // Capacity-zero guidance is part of the public install model (§8.2.1a).
      const limit = mac.limit as Record<string, unknown> | null | undefined
      if (
        mac.capacity === 0 && limit && ["memory", "cores", "disk"].includes(String(limit.term)) &&
        typeof limit.fix === "string" && limit.fix.trim()
      ) {
        values.limit = { term: limit.term, fix: limit.fix }
      }
      if (Object.keys(values).length) result.this_mac = values
    }
    if (body.github_app && typeof body.github_app === "object") {
      const app = body.github_app as Record<string, unknown>
      const values: Record<string, boolean> = {}
      for (const key of ["configured", "installed"]) if (typeof app[key] === "boolean") values[key] = app[key]
      if (Object.keys(values).length) result.github_app = values
    }
    return Object.keys(result).length ? result : undefined
  } catch {
    return undefined
  }
}
