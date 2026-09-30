/**
 * Persistent execution locations shared by command consumers, including the TUI.
 * Profiles contain locations, never tool credentials. Tools keep their own login
 * and sessions in the selected machine's home.
 * @since 1.0.0
 */

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { constants, homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import * as CliError from "./CliError.ts"
import { Client } from "./internal/backend/Client.ts"
import { quote, sshArgs } from "./internal/backend/SSH.ts"
import { workspaceSSH } from "./internal/backend/Workspaces.ts"

/**
 * The caller's process configuration.
 *
 * @category models
 * @since 1.0.0
 */
export type Source = Readonly<Record<string, string | undefined>>
/**
 * An existing execution location; contains no tool credentials.
 *
 * @category models
 * @since 1.0.0
 */
export interface Profile {
  readonly name: string
  readonly transport: "local" | "ssh" | "workspace"
  readonly destination?: string | undefined
  readonly directory: string
  readonly home?: string | undefined
}
/**
 * Terminal, cancellation, and forwarding controls for one invocation.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly terminal?: boolean | undefined
  readonly signal?: AbortSignal | undefined
  readonly forward?: { readonly localPort: number; readonly remotePort: number } | undefined
}
/**
 * The process and isolated transport environment to execute.
 *
 * @category models
 * @since 1.0.0
 */
export interface Plan {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string | undefined
  readonly environment: Source
}

const usage = (message: string) => new CliError.UsageError({ message })
const validName = (name: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)
const validPath = (path: string): boolean => isAbsolute(path) && !/[\0\r\n]/.test(path)
const validate = (value: unknown): Profile => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw usage("Invalid execution environment")
  const p = value as Record<string, unknown>
  if (Object.keys(p).some((key) => !["name", "transport", "destination", "directory", "home"].includes(key))) {
    throw usage("Execution environments contain only location settings")
  }
  if (typeof p.name !== "string" || !validName(p.name)) throw usage("Invalid environment name")
  if (typeof p.transport !== "string" || !["local", "ssh", "workspace"].includes(p.transport)) {
    throw usage("Invalid environment transport")
  }
  if (typeof p.directory !== "string" || !validPath(p.directory)) {
    throw usage("Environment directory must be an absolute path")
  }
  if (p.home !== undefined && (typeof p.home !== "string" || !validPath(p.home))) {
    throw usage("Environment home must be an absolute path")
  }
  if (p.transport === "local") {
    if (p.destination !== undefined) throw usage("A local environment has no destination")
  } else if (
    typeof p.destination !== "string" || (
      p.transport === "workspace"
        ? !/^[\w.-]+\/[\w.-]+\/[\w-]+$/.test(p.destination)
        : !/^[A-Za-z0-9][A-Za-z0-9._+@[\]:-]*$/.test(p.destination)
    )
  ) throw usage("Invalid environment destination")
  return p as unknown as Profile
}

/**
 * The location registry for this caller.
 *
 * @category constructors
 * @since 1.0.0
 */
export const registryPath = (source: Source): string =>
  join(source.XDG_CONFIG_HOME || join(source.HOME || homedir(), ".config"), "smithers", "environments.json")

/**
 * Read validated execution locations without creating a registry.
 *
 * @category constructors
 * @since 1.0.0
 */
export const list = async (source: Source): Promise<ReadonlyArray<Profile>> => {
  let text: string
  try {
    text = await readFile(registryPath(source), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw usage("The execution environment registry is not valid JSON")
  }
  const data = value as { version?: unknown; environments?: unknown } | null
  if (data?.version !== 1 || !Array.isArray(data.environments)) throw usage("Invalid execution environment registry")
  const profiles = data.environments.map(validate)
  if (new Set(profiles.map((p) => p.name)).size !== profiles.length) {
    throw usage("Duplicate environment names in registry")
  }
  return profiles
}

/**
 * Resolve a saved execution location by name.
 *
 * @category constructors
 * @since 1.0.0
 */
export const get = async (name: string, source: Source): Promise<Profile> => {
  const found = (await list(source)).find((p) => p.name === name)
  if (found === undefined) throw usage(`Unknown execution environment: ${name}`)
  return found
}

const update = async (
  source: Source,
  change: (profiles: ReadonlyArray<Profile>) => ReadonlyArray<Profile>
): Promise<void> => {
  const path = registryPath(source), directory = join(path, ".."), lock = `${path}.lock`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await mkdir(lock, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw usage(`The environment registry is being changed; retry, or remove ${lock} after its writer exits`)
    }
    throw error
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const environments = change(await list(source))
    await writeFile(temporary, `${JSON.stringify({ version: 1, environments }, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
    await rm(lock, { recursive: true, force: true })
  }
}

/**
 * Save a new location without replacing an existing name.
 *
 * @category constructors
 * @since 1.0.0
 */
export const add = async (profile: Profile, source: Source): Promise<Profile> => {
  const checked = validate(profile)
  await update(source, (profiles) => {
    if (profiles.some((p) => p.name === checked.name)) {
      throw usage(`Execution environment already exists: ${checked.name}`)
    }
    return [...profiles, checked]
  })
  return checked
}

/**
 * Forget a location without deleting its files or compute.
 *
 * @category constructors
 * @since 1.0.0
 */
export const remove = async (name: string, source: Source): Promise<void> => {
  await update(source, (profiles) => {
    if (!profiles.some((p) => p.name === name)) throw usage(`Unknown execution environment: ${name}`)
    return profiles.filter((p) => p.name !== name)
  })
}

const transportKeys = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TERM",
  "LANG",
  "LC_ALL",
  "SSH_AUTH_SOCK",
  "TMPDIR",
  "SYSTEMROOT"
]
const aborted = (): Error => Object.assign(new Error("Execution interrupted"), { name: "AbortError" })
const port = (n: number): boolean => Number.isInteger(n) && n > 0 && n <= 65535

/**
 * Assemble a command without opening a shell on the caller's machine. SSH uses
 * the caller's known_hosts, or the Cloud API's authenticated advertised keys.
 * @category constructors
 * @since 1.0.0
 */
export const plan = async (
  profile: Profile,
  argv: ReadonlyArray<string>,
  source: Source,
  options: Options = {}
): Promise<Plan> => {
  validate(profile)
  if (options.signal?.aborted) throw aborted()
  if (
    argv.some((arg) => arg.includes("\0")) || (options.forward === undefined && (!argv[0] || argv[0].startsWith("-")))
  ) {
    throw usage("An executable and valid arguments are required")
  }
  if (options.forward !== undefined && (!port(options.forward.localPort) || !port(options.forward.remotePort))) {
    throw usage("Forwarded ports must be between 1 and 65535")
  }
  if (options.forward !== undefined && profile.transport !== "ssh") {
    throw usage("Port forwarding requires an SSH environment")
  }
  if (profile.transport === "local") {
    return {
      command: argv[0]!,
      args: argv.slice(1),
      cwd: profile.directory,
      environment: { ...source, ...(profile.home === undefined ? {} : { HOME: profile.home }) }
    }
  }
  let prefix: Array<string>
  if (profile.transport === "workspace") {
    const [owner, repo, id] = profile.destination!.split("/")
    const client = new Client({ environment: source, signal: options.signal }, false)
    const endpoint = await workspaceSSH(client, id!, { repo: `${owner}/${repo}`, user: "developer" })
    prefix = await sshArgs(client, endpoint, options.terminal)
  } else {
    prefix = [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      ...(options.terminal ? ["-tt"] : ["-T"]),
      profile.destination!
    ]
  }
  const destination = prefix.pop()!
  const args = [
    ...prefix,
    "-o",
    "ForwardAgent=no",
    "-o",
    `ClearAllForwardings=${options.forward === undefined ? "yes" : "no"}`
  ]
  if (options.forward !== undefined) {
    args.push(
      "-o",
      "ExitOnForwardFailure=yes",
      "-N",
      "-L",
      `127.0.0.1:${options.forward.localPort}:127.0.0.1:${options.forward.remotePort}`,
      destination
    )
  } else {
    const home = profile.home === undefined ? "" : `export HOME=${quote(profile.home)}; `
    const command = `${home}export PATH="$HOME/.local/bin:$HOME/bin:$PATH"; cd ${quote(profile.directory)} && exec ${
      argv.map(quote).join(" ")
    }`
    args.push(destination, command)
  }
  if (options.signal?.aborted) throw aborted()
  return {
    command: "ssh",
    args,
    environment: Object.fromEntries(
      transportKeys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]])
    )
  }
}

/**
 * Execute with inherited terminal I/O. Cancellation stops the local process
 * group; a remote command has SSH's connection lifecycle, not a durable receipt.
 * @category constructors
 * @since 1.0.0
 */
export const run = async (
  profile: Profile,
  argv: ReadonlyArray<string>,
  source: Source,
  options: Options = {}
): Promise<number> => {
  const target = await plan(profile, argv, source, options)
  return new Promise<number>((resolve, reject) => {
    const grouped = !options.terminal && process.platform !== "win32"
    const child = spawn(target.command, [...target.args], {
      cwd: target.cwd,
      env: target.environment,
      stdio: "inherit",
      detached: grouped
    })
    let interrupted = false, timer: ReturnType<typeof setTimeout> | undefined
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (grouped && child.pid !== undefined) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch { /* Already exited. */ }
    }
    const interrupt = () => {
      interrupted = true
      kill("SIGTERM")
      timer = setTimeout(() => kill("SIGKILL"), 500)
      timer.unref()
    }
    const cleanup = () => {
      options.signal?.removeEventListener("abort", interrupt)
      if (timer !== undefined) clearTimeout(timer)
    }
    child.once("error", (error) => {
      cleanup()
      reject(error)
    })
    child.once("exit", (code, signal) => {
      // A resistant descendant can outlive its parent. Kill the group before
      // dropping the timer, even when the parent has already exited.
      if (interrupted && grouped) kill("SIGKILL")
      cleanup()
      resolve(interrupted ? 130 : code ?? (128 + constants.signals[signal!]))
    })
    options.signal?.addEventListener("abort", interrupt, { once: true })
    if (options.signal?.aborted) interrupt()
  })
}
