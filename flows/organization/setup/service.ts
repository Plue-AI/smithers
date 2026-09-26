/**
 * `install-service` / `uninstall-service`: the host as a per-user launchd
 * agent on macOS, so it runs at login and restarts when it dies.
 *
 * Two agents in `~/Library/LaunchAgents`:
 *
 * - `sh.smithers.org` runs `serve` for one state directory, with the Node
 *   `setup/node.ts` finds (at least `.node-version`, where Node is installed),
 *   `jj` and `git` on `PATH`, the organization root as its working
 *   directory, and its output in `<state>/logs/host.log`. It restarts after
 *   a crash, no sooner than {@link throttleSeconds} apart.
 * - `sh.smithers.org.clean` runs `clean` hourly (`hygiene.ts`): log size
 *   caps, the receipts policy, and finished runs' machines.
 *
 * Installing is idempotent: an unchanged, loaded agent is left running; a
 * changed one is reloaded. Uninstalling unloads both and removes the files.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { parseArgs } from "node:util"
import * as NodeResolve from "./node.ts"
import { absolute, checkoutRoot, type Command, type Io, nonEmpty, stateDirOf, withEnvFile } from "./settings.ts"

/** The host agent's launchd label. */
export const label = "sh.smithers.org"
/** The hourly hygiene agent's launchd label. */
export const cleanLabel = "sh.smithers.org.clean"
/** Least seconds between two starts of a crashing host. */
export const throttleSeconds = 30
/** Seconds between two hygiene passes. */
export const cleanIntervalSeconds = 3_600

/** The directory under a state directory the agents write their output to. */
export const logsDir = (stateDir: string) => join(stateDir, "logs")

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

/** Everything the two agents are generated from. */
export interface ServiceOptions {
  /** The Node executable that runs the CLI. */
  readonly node: string
  /** The public checkout holding `flows/organization/cli.ts`. */
  readonly checkout: string
  readonly stateDir: string
  /** The host's working directory: the organization root. */
  readonly workingDirectory: string
  /** `PATH` for both agents. */
  readonly path: string
  readonly home: string
}

const environment = (options: ServiceOptions) => ({
  PATH: options.path,
  HOME: options.home,
  SMITHERS_ORG_STATE_DIR: options.stateDir
})

const cli = (options: ServiceOptions) => join(options.checkout, "flows/organization/cli.ts")

/** The host agent's property list. */
export const hostPlist = (options: ServiceOptions): string =>
  plist({
    Label: label,
    ProgramArguments: [options.node, cli(options), "serve", "--state-dir", options.stateDir],
    WorkingDirectory: options.workingDirectory,
    EnvironmentVariables: environment(options),
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: throttleSeconds,
    ExitTimeOut: 30,
    ProcessType: "Standard",
    StandardOutPath: join(logsDir(options.stateDir), "host.log"),
    StandardErrorPath: join(logsDir(options.stateDir), "host.log")
  })

/** The hygiene agent's property list. */
export const cleanPlist = (options: ServiceOptions): string =>
  plist({
    Label: cleanLabel,
    ProgramArguments: [options.node, cli(options), "clean", "--state-dir", options.stateDir],
    WorkingDirectory: options.workingDirectory,
    EnvironmentVariables: environment(options),
    StartInterval: cleanIntervalSeconds,
    RunAtLoad: false,
    ProcessType: "Background",
    LowPriorityIO: true,
    StandardOutPath: join(logsDir(options.stateDir), "clean.log"),
    StandardErrorPath: join(logsDir(options.stateDir), "clean.log")
  })

/** The first `name` executable on `path`, or `undefined`. */
export const which = (name: string, path: string): string | undefined => {
  for (const directory of path.split(delimiter)) {
    if (directory === "") continue
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * The agents' `PATH`: this Node's directory, then `jj`'s and `git`'s as the
 * installing shell finds them, then the system directories. Fails naming a
 * tool it cannot find.
 */
export const servicePath = (node: string, path: string): string => {
  const directories = [dirname(node)]
  for (const tool of ["jj", "git"]) {
    const found = which(tool, path)
    if (found === undefined) {
      throw new Error(`${tool} is not on PATH; install it or add it to PATH, then install-service again`)
    }
    directories.push(dirname(found))
  }
  directories.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin")
  return [...new Set(directories)].join(delimiter)
}

/** A `launchctl` invocation's result. */
export interface Launchctl {
  (args: ReadonlyArray<string>): { readonly status: number | null; readonly stdout: string; readonly stderr: string }
}

const realLaunchctl: Launchctl = (args) => {
  const result = spawnSync("launchctl", [...args], { encoding: "utf8" })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" }
}

/** Where the agents' files live and how launchd is reached. */
export interface Launchd {
  readonly agentsDir: string
  /** `gui/<uid>`. */
  readonly domain: string
  readonly launchctl: Launchctl
}

export const launchd = (): Launchd => ({
  agentsDir: join(homedir(), "Library", "LaunchAgents"),
  domain: `gui/${process.getuid?.() ?? 0}`,
  launchctl: realLaunchctl
})

const loaded = (system: Launchd, name: string) => system.launchctl(["print", `${system.domain}/${name}`]).status === 0

const plistFile = (system: Launchd, name: string) => join(system.agentsDir, `${name}.plist`)

/** What happened to one agent. */
export type Outcome = "installed" | "reloaded" | "unchanged" | "removed" | "absent"

/** Writes and loads one agent; an unchanged, loaded one is left alone. */
const installOne = (system: Launchd, name: string, content: string): Outcome => {
  const file = plistFile(system, name)
  const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined
  const isLoaded = loaded(system, name)
  if (previous === content && isLoaded) return "unchanged"
  mkdirSync(system.agentsDir, { recursive: true })
  writeFileSync(`${file}.tmp`, content, { mode: 0o644 })
  renameSync(`${file}.tmp`, file)
  if (isLoaded) system.launchctl(["bootout", `${system.domain}/${name}`])
  const loadedNow = system.launchctl(["bootstrap", system.domain, file])
  if (loadedNow.status !== 0) {
    throw new Error(
      `launchctl bootstrap ${system.domain} ${file} failed: ${loadedNow.stderr.trim() || loadedNow.stdout.trim()}`
    )
  }
  return isLoaded ? "reloaded" : "installed"
}

/** Unloads and removes one agent. */
const uninstallOne = (system: Launchd, name: string): Outcome => {
  const file = plistFile(system, name)
  const isLoaded = loaded(system, name)
  if (isLoaded) {
    const out = system.launchctl(["bootout", `${system.domain}/${name}`])
    if (out.status !== 0 && loaded(system, name)) {
      throw new Error(`launchctl bootout ${system.domain}/${name} failed: ${out.stderr.trim() || out.stdout.trim()}`)
    }
  }
  const existed = existsSync(file)
  rmSync(file, { force: true })
  return isLoaded || existed ? "removed" : "absent"
}

/** Writes both agents and loads them. */
export const install = (options: ServiceOptions, system: Launchd): ReadonlyArray<readonly [string, Outcome]> => {
  mkdirSync(logsDir(options.stateDir), { recursive: true, mode: 0o700 })
  return [
    [label, installOne(system, label, hostPlist(options))],
    [cleanLabel, installOne(system, cleanLabel, cleanPlist(options))]
  ]
}

/** Unloads both agents and removes their files. */
export const uninstall = (system: Launchd): ReadonlyArray<readonly [string, Outcome]> => [
  [label, uninstallOne(system, label)],
  [cleanLabel, uninstallOne(system, cleanLabel)]
]

/** The options this process would install: its Node, this checkout, and the state directory's `.env`. */
export const optionsOf = (
  flags: { readonly "state-dir"?: string | undefined },
  io: Io,
  on: NodeResolve.System = NodeResolve.system
): ServiceOptions => {
  const stateDir = absolute(io.cwd, nonEmpty(flags["state-dir"]) ?? stateDirOf(io.env))
  const env = withEnvFile(io.env, join(stateDir, ".env"))
  if (!existsSync(join(stateDir, ".env"))) throw new Error(`${join(stateDir, ".env")} is missing; run init first`)
  const wanted = readFileSync(join(checkoutRoot, ".node-version"), "utf8").trim()
  const home = io.env.HOME ?? homedir()
  const resolved = NodeResolve.resolve(env, home, wanted, on)
  if (resolved._tag === "Missing") throw new Error(`no Node >= ${wanted}; ${resolved.fix}`)
  const root = nonEmpty(env.SMITHERS_ORG_ROOT)
  return {
    node: resolved.node.path,
    checkout: checkoutRoot.replace(/\/$/, ""),
    stateDir,
    workingDirectory: root === undefined ? stateDir : absolute(io.cwd, root),
    path: servicePath(resolved.node.path, io.env.PATH ?? ""),
    home
  }
}

const report = (io: Io, outcomes: ReadonlyArray<readonly [string, Outcome]>) => {
  for (const [name, outcome] of outcomes) io.out(`${outcome} ${name}`)
}

const refuseOffMac = (io: Io, platform: NodeJS.Platform): boolean => {
  if (platform === "darwin") return false
  io.err("install-service writes a launchd agent and runs on macOS only")
  return true
}

/** The commands, over a launchd a test can replace. */
export const commands = (
  system: () => Launchd = launchd,
  platform: NodeJS.Platform = process.platform,
  node: NodeResolve.System = NodeResolve.system
) => {
  const installCommand: Command = {
    name: "install-service",
    usage: "install-service [--state-dir <dir>]",
    run: async (argv, io) => {
      const { values } = parseArgs({ args: [...argv], options: { "state-dir": { type: "string" } } })
      if (refuseOffMac(io, platform)) return 1
      const options = optionsOf(values, io, node)
      report(io, install(options, system()))
      io.out(`logs ${logsDir(options.stateDir)}`)
      return 0
    }
  }
  const uninstallCommand: Command = {
    name: "uninstall-service",
    usage: "uninstall-service",
    run: async (argv, io) => {
      parseArgs({ args: [...argv], options: {} })
      if (refuseOffMac(io, platform)) return 1
      report(io, uninstall(system()))
      return 0
    }
  }
  return [installCommand, uninstallCommand] as const
}

export const [installService, uninstallService] = commands()
