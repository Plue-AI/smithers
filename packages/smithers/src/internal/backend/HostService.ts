/** Per-user launchd adapter restored from organization/setup/service.ts. */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

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


export interface ServiceOptions { readonly bundle: string; readonly stateDir: string; readonly home: string }
export const hostPlist = (options: ServiceOptions): string => plist({
  Label: label,
  ProgramArguments: [join(options.bundle, "bin/smithers-server"), "--setup-handoff=socket"],
  WorkingDirectory: options.stateDir,
  EnvironmentVariables: {
    HOME: options.home,
    PATH: `${options.bundle}/bin:/usr/bin:/bin:/usr/sbin:/sbin`
  },
  RunAtLoad: true, KeepAlive: true, ThrottleInterval: 5, ExitTimeOut: 30,
  ProcessType: "Standard",
  StandardOutPath: join(options.stateDir, "logs/host.log"),
  StandardErrorPath: join(options.stateDir, "logs/host.log")
})

export interface Launchctl {
  (args: ReadonlyArray<string>): { readonly status: number | null; readonly stdout: string; readonly stderr: string }
}
export interface Launchd { readonly agentsDir: string; readonly domain: string; readonly launchctl: Launchctl }
export const launchd = (): Launchd => {
  if (process.platform !== "darwin" || !process.getuid || process.getuid() === 0) {
    throw new Error("Host service requires an unprivileged macOS login session")
  }
  return {
    agentsDir: join(homedir(), "Library/LaunchAgents"), domain: `gui/${process.getuid()}`,
    launchctl: (args) => {
      const result = spawnSync("/bin/launchctl", [...args], { encoding: "utf8" })
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" }
    }
  }
}
export const loaded = (system: Launchd) => system.launchctl(["print", `${system.domain}/${label}`]).status === 0
export const plistFile = (system: Launchd) => join(system.agentsDir, `${label}.plist`)

/** Verify every bundle byte before changing launchd state. No PATH lookup or shell. */
export const verifyBundle = (input: string): { bundle: string; version: string } => {
  const bundle = realpathSync(resolve(input))
  const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"))
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("Invalid bundle manifest files")
  const declared = new Set<string>()
  for (const entry of manifest.files) {
    const path = entry.path
    if (typeof path !== "string" || !path || isAbsolute(path) || path.split("/").some((part: string) => part === ".." || part === "." || !part) || declared.has(path)) {
      throw new Error("Invalid bundle manifest path")
    }
    declared.add(path)
    const file = join(bundle, path)
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || !realpathSync(file).startsWith(bundle + "/")) {
      throw new Error(`Invalid bundle manifest entry: ${path}`)
    }
    if (createHash("sha256").update(readFileSync(file)).digest("hex") !== entry.sha256) {
      throw new Error(`Bundle hash differs: ${path}`)
    }
  }
  const walk = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + entry.name
      if (entry.isDirectory()) walk(join(directory, entry.name), path + "/")
      else if (path !== "manifest.json" && !declared.has(path)) throw new Error(`Bundle file absent from manifest: ${path}`)
    }
  }
  walk(bundle)
  for (const path of ["bin/smithers-server", "bin/smithers-backend", "bin/msb"]) {
    if (!declared.has(path) || !(lstatSync(join(bundle, path)).mode & 0o111)) throw new Error(`Bundle executable missing: ${path}`)
  }
  return { bundle, version: String(manifest.version ?? manifest.buildSha ?? "unknown") }
}
export const resolveBundle = (input?: string): string => {
  if (input) return resolve(input)
  const keg = "/opt/homebrew/opt/smithers/libexec"
  if (existsSync(join(keg, "manifest.json"))) return keg
  throw new Error(`No server bundle; use --bundle <dir> or install the bundle at ${keg}`)
}

/** Writes and loads one agent; unchanged loaded agents retain their backend token. */
export const install = (options: ServiceOptions, system: Launchd): "installed" | "reloaded" | "unchanged" => {
  verifyBundle(options.bundle)
  const file = plistFile(system), content = hostPlist(options)
  const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined
  const isLoaded = loaded(system)
  if (previous === content && isLoaded) return "unchanged"
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(join(options.stateDir, "logs"), { recursive: true, mode: 0o700 })
  mkdirSync(system.agentsDir, { recursive: true })
  if (isLoaded) {
    const out = system.launchctl(["bootout", `${system.domain}/${label}`])
    if (out.status !== 0) throw new Error("launchctl bootout failed; bundle unchanged")
  }
  writeFileSync(`${file}.tmp`, content, { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
  const result = system.launchctl(["bootstrap", system.domain, file])
  if (result.status !== 0) throw new Error(`launchctl bootstrap failed: ${result.stderr.trim()}`)
  return isLoaded ? "reloaded" : "installed"
}
export const stop = (system: Launchd): { state: "stopped" } => {
  if (loaded(system)) {
    const out = system.launchctl(["bootout", `${system.domain}/${label}`])
    if (out.status !== 0 && loaded(system)) throw new Error("launchctl bootout failed")
  }
  rmSync(plistFile(system), { force: true })
  return { state: "stopped" }
}
export const installedBundle = (system: Launchd): string => {
  const text = readFileSync(plistFile(system), "utf8")
  const executable = text.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/)?.[1]
  if (!executable) throw new Error("Installed host bundle path unavailable")
  return dirname(dirname(executable.replaceAll("&quot;", '\"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&")))
}
export const ready = async (): Promise<boolean> => {
  try { return (await fetch("http://127.0.0.1:4000/readyz", { signal: AbortSignal.timeout(1000), redirect: "error" })).ok }
  catch { return false }
}
export const waitReady = async (probe = ready, timeout = 60_000): Promise<void> => {
  const deadline = Date.now() + timeout
  do {
    if (await probe()) return
    await new Promise((done) => setTimeout(done, 250))
  } while (Date.now() < deadline)
  throw new Error("Host readiness failed at http://127.0.0.1:4000/readyz")
}
/** The private backend socket is the sole authority; missing output never means claimed. */
export const setupURLs = (stateDir: string): Promise<{ code: string; setup_urls?: string[]; message?: string; exitCode: number }> =>
  new Promise((done, reject) => {
    const socketPath = join(stateDir, "run/host.sock")
    const info = lstatSync(socketPath)
    if (!info.isSocket() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()) {
      reject(new Error("Host setup socket must be user-owned with mode 0600")); return
    }
    const req = request({ socketPath, path: "/setup-urls", method: "GET", timeout: 5000 }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => {
        body += chunk
        if (body.length > 65536) req.destroy(new Error("Invalid setup handoff response"))
      })
      res.on("error", reject)
      res.on("end", () => {
        try {
          const data = JSON.parse(body)
          if (res.statusCode === 401 && data.error === "setup_closed") {
            done({ code: "setup_closed", message: "Already set up.", exitCode: 3 }); return
          }
          if (res.statusCode === 503 && data.error === "setup_mint_failed") {
            done({ code: "setup_mint_failed", message: "Setup URL mint failed; nothing emitted.", exitCode: 4 }); return
          }
          if (res.statusCode !== 200 || Object.keys(data).join() !== "setup_urls" || !Array.isArray(data.setup_urls) || !data.setup_urls.length || data.setup_urls.some((value: unknown) => {
            if (typeof value !== "string") return true
            const url = new URL(value)
            return !["http:", "https:"].includes(url.protocol) || url.pathname !== "/setup" || !url.searchParams.get("token") || url.username || url.password || /[\r\n\x1b]/.test(value)
          })) throw new Error("Invalid setup handoff response")
          done({ code: "setup_ready", setup_urls: data.setup_urls, exitCode: 0 })
        } catch { reject(new Error("Invalid setup handoff response")) }
      })
    })
    req.on("timeout", () => req.destroy(new Error("Host setup socket timed out")))
    req.on("error", () => reject(new Error("Host setup socket unavailable")))
    req.end()
  })
export const start = async (input?: string) => {
  const system = launchd(), stateDir = stateDirectory()
  const bundle = realpathSync(resolveBundle(input))
  install({ bundle, stateDir, home: homedir() }, system)
  await waitReady()
  return setupURLs(stateDir)
}
export const status = async () => {
  const system = launchd(), bundle = installedBundle(system)
  const verified = verifyBundle(bundle)
  if (!loaded(system) || !await ready()) throw new Error(`Host unhealthy: ${bundle}`)
  const doctor = spawnSync(join(bundle, "bin/smithers-backend"), ["microvm", "doctor"], {
    encoding: "utf8", timeout: 30_000,
    env: { HOME: homedir(), PATH: `${bundle}/bin:/usr/bin:/bin`, SMITHERS_MICROSANDBOX_BIN: join(bundle, "bin/msb") }
  })
  if (doctor.status !== 0) throw new Error(`Bundled microVM doctor failed: ${bundle}`)
  return { state: "ready", bundle, version: verified.version, launchd: "running", readiness: "ready", doctor: "ready" }
}
