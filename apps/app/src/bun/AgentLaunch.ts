/*
 * Starting an agent CLI on this machine (#3730, mvp.md M-38). The host runs
 * Codex or Claude Code headless in its working directory, then finds the
 * session the CLI wrote: the earliest one whose working directory is the
 * launch's and which began at or after the launch. It returns that
 * session identity for the preview. Launches run one at a time, so two
 * launches in one directory never trade sessions.
 */
import { lstat, readdir, realpath } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { spawn as spawnProcess } from "node:child_process"
import { readChunk, regularPath } from "./AgentLaunchFiles"
import { basename, dirname, join, relative, resolve, sep } from "node:path"

export type LaunchAgent = "codex" | "claude-code"

/** What a session file says about its own start. */
export interface SessionStart {
  readonly session: string
  readonly cwd: string
  readonly startedAt: number
}

/** Where and when the host started the CLI. */
export interface Launch {
  readonly cwd: string
  readonly launchedAt: number
}

/** How far a session's recorded start may precede the launch: the CLI's clock and this host's are read separately. */
export const START_SKEW_MS = 2_000

/** The session a launch started: the earliest in the launch's directory that began at or after it and that no earlier launch claimed. */
export const launchedSession = (
  starts: ReadonlyArray<SessionStart>,
  launch: Launch,
  claimed: ReadonlySet<string>
): string | undefined =>
  starts
    .filter(start => start.cwd === launch.cwd && start.startedAt >= launch.launchedAt - START_SKEW_MS && !claimed.has(start.session))
    .sort((left, right) => left.startedAt - right.startedAt || left.session.localeCompare(right.session))[0]?.session

type Json = { readonly [key: string]: unknown }
const record = (line: string): Json | undefined => {
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Json : undefined
  } catch { return undefined }
}

/** The session a Codex rollout's first line opens, or undefined for any other line. */
export const codexSessionStart = (line: string): SessionStart | undefined => {
  const value = record(line)
  const payload = value?.payload as Json | undefined
  if (value?.type !== "session_meta" || typeof payload !== "object" || payload === null) return undefined
  const startedAt = Date.parse(typeof payload.timestamp === "string" ? payload.timestamp : String(value.timestamp))
  if (typeof payload.id !== "string" || typeof payload.cwd !== "string" || Number.isNaN(startedAt)) return undefined
  return { session: payload.id, cwd: payload.cwd, startedAt }
}

/**
 * The session a Claude Code transcript opens: the first record naming its directory and time. Mode and snapshot
 * records come before it and name neither; the session is the file's own name, which that record must agree with.
 */
export const claudeSessionStart = (session: string, lines: ReadonlyArray<string>): SessionStart | undefined => {
  for (const line of lines) {
    const value = record(line)
    if (value === undefined || typeof value.cwd !== "string" || typeof value.timestamp !== "string") continue
    const startedAt = Date.parse(value.timestamp)
    if (value.sessionId !== session || Number.isNaN(startedAt)) return undefined
    return { session, cwd: value.cwd, startedAt }
  }
  return undefined
}

/**
 * Codex files a session under sessions/YYYY/MM/DD of the day it started, in the CLI's own time zone; a launch reads
 * only the days any time zone (UTC-12 to UTC+14) can name for its window.
 */
const ZONE_SPAN_MS = 14 * 60 * 60 * 1000
const dayDirectories = (root: string, since: number, now: number): string[] => [...new Set(
  [since - ZONE_SPAN_MS, since, since + ZONE_SPAN_MS, now - ZONE_SPAN_MS, now, now + ZONE_SPAN_MS].map(time => {
    const date = new Date(time)
    const pad = (value: number) => String(value).padStart(2, "0")
    return join(root, String(date.getUTCFullYear()), pad(date.getUTCMonth() + 1), pad(date.getUTCDate()))
  })
)]

/** Claude Code files a session in one directory per project under `projects`. */
const projectDirectories = async (root: string, home: string): Promise<string[]> => {
  if (!(await regularPath(root, root, home).catch(() => undefined))?.isDirectory()) return []
  return (await readdir(root).catch(() => [] as string[])).map(name => join(root, name))
}

/** The starts of the sessions `agent` wrote since `since`, under every sessions root. */
export async function sessionStartsSince(agent: LaunchAgent, roots: ReadonlyArray<string>, since: number, now = Date.now(), home = homedir()): Promise<SessionStart[]> {
  const directories = agent === "codex" ? roots.flatMap(root => dayDirectories(root, since, now))
    : (await Promise.all(roots.map(root => projectDirectories(root, home)))).flat()
  const starts: SessionStart[] = []
  for (const directory of directories) {
    const root = roots.find(root => {
      const below = relative(resolve(root), resolve(directory))
      return below !== ".." && !below.startsWith(`..${sep}`)
    })
    if (root === undefined || !(await regularPath(directory, root, home).catch(() => undefined))?.isDirectory()) continue
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      if (!name.endsWith(".jsonl") || (agent === "codex" && !name.startsWith("rollout-"))) continue
      const path = join(directory, name)
      const info = await regularPath(path, root, home).catch(() => undefined)
      if (!info?.isFile() || info.mtimeMs < since - START_SKEW_MS) continue
      const chunk = await readChunk(path, root, 0, info, home)
      if ("refusal" in chunk) continue
      const lines = chunk.text.split("\n").filter(Boolean)
      const start = agent === "codex" ? codexSessionStart(lines[0] ?? "") : claudeSessionStart(basename(name, ".jsonl"), lines)
      if (start !== undefined) starts.push(start)
    }
  }
  return starts
}

/** Headless arguments preserve the user's configured sandbox and approvals; the prompt arrives on stdin. */
export const launchArguments = (agent: LaunchAgent, cwd: string, _prompt?: string): string[] =>
  agent === "codex" ? ["exec", "--skip-git-repo-check", "-C", cwd, "-"]
    : ["-p"]

export interface LaunchedChild {
  readonly exited: Promise<number>
  readonly kill: (signal?: "SIGTERM" | "SIGKILL") => void
  /** Whether the owned process group still has members, including descendants. */
  readonly alive?: () => boolean
  /** The last bytes the CLI wrote to stderr: why it stopped, when it stops early. */
  readonly stderr: () => string
}

export type Spawn = (argv: ReadonlyArray<string>, options: { readonly cwd: string; readonly env: Record<string, string | undefined>; readonly stdin: string }) => LaunchedChild

const STDERR_TAIL = 2_000

const processSpawn: Spawn = (argv, options) => {
  // A new POSIX process group lets shutdown reach descendants too. No shell.
  const child = spawnProcess(argv[0]!, argv.slice(1), {
    cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "ignore", "pipe"]
  })
  let reaped = false
  let groupGone = false
  const exited = new Promise<number>(resolve => {
    child.once("exit", code => { reaped = true; resolve(code ?? -1) })
    child.once("error", () => resolve(-1))
  })
  child.stdin.on("error", () => {}) // An early exit may close stdin before the write.
  child.stdin.end(options.stdin)
  let tail = ""
  child.stderr.on("data", bytes => { tail = (tail + String(bytes)).slice(-STDERR_TAIL) })
  const group = child.pid
  const alive = () => {
    if (group === undefined || groupGone) return false
    try { process.kill(-group, 0); return true } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "EPERM") return true // Still exists; only ESRCH proves the group is gone.
      if (code !== "ESRCH") throw error
      if (reaped) groupGone = true
      return false
    }
  }
  return {
    exited,
    kill: (signal = "SIGTERM") => {
      if (group === undefined || (reaped && !alive())) return
      try { process.kill(-group, signal) } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // macOS may refuse a signal during teardown; the bounded group poll
        // still requires ESRCH before admission can reopen.
        if (code !== "ESRCH" && code !== "EPERM") throw error
        if (code === "ESRCH" && reaped) groupGone = true
      }
    },
    alive,
    stderr: () => tail
  }
}

/** Never inherit host credentials, runtime injection flags or another seat's home (#3736). */
export const launchEnvironment = (agent: LaunchAgent, home: string, inherited: Readonly<Record<string, string | undefined>>, configured: Readonly<Record<string, string>> = {}): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { HOME: home }
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "TMPDIR"]) {
    const value = configured[key] ?? inherited[key]
    if (value !== undefined) env[key] = value
  }
  const key = agent === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"
  const candidate = resolve(configured[key] ?? inherited[key] ?? join(home, agent === "codex" ? ".codex" : ".claude"))
  const below = relative(home, candidate)
  const otherSeat = candidate.split(sep).some((part, index, parts) => part === ".smithers" && parts[index + 1] === "accounts")
  env[key] = below === ".." || below.startsWith(`..${sep}`) || otherSeat ? join(home, agent === "codex" ? ".codex" : ".claude") : candidate
  return env
}

/** One agent this host can start. */
export interface LaunchableCli {
  /** The command before the CLI's arguments: `["codex"]`, or a fixture CLI in tests. */
  readonly command: ReadonlyArray<string>
  /** Session roots; discovery accepts only the bound own agent home. */
  readonly roots: () => Promise<readonly string[]>
  /** Host configuration filtered through the environment allowlist. */
  readonly env?: Readonly<Record<string, string>>
}

export interface AgentLauncherOptions {
  /** The directory every agent runs in. */
  readonly cwd: string
  /** OS user home; overridden only by isolated fixture hosts. */
  readonly home?: string
  readonly agents: Partial<Readonly<Record<LaunchAgent, LaunchableCli>>>
  readonly spawn?: Spawn
  readonly now?: () => number
  readonly pollMs?: number
  /** How long the CLI has to write its session before the launch fails. */
  readonly timeoutMs?: number
  /** TERM grace period before KILL, then await the child exit. */
  readonly terminateMs?: number
  /** Active plus queued launches; excess requests fail instead of accumulating. */
  readonly maxPending?: number
}

/** Why a launch bound no session: the CLI exited first, wrote nothing in time, or the host is stopping. */
export type LaunchFailure = "exited" | "timeout" | "stopping" | "unsafe_home" | "busy" | "cancelled"

export type LaunchResult =
  | { readonly agent: LaunchAgent; readonly session: string }
  | { readonly error: string; readonly reason: LaunchFailure }

const AGENT_NAMES: Record<LaunchAgent, string> = { codex: "Codex", "claude-code": "Claude Code" }

/**
 * Starts agent CLIs one at a time; `dispose` stops every CLI it started.
 * On macOS a descendant calling setsid() escapes process-group signals.
 * Full supervision is pending an engineering-lead ruling (#3736).
 */
export function agentLauncher(options: AgentLauncherOptions) {
  const spawn = options.spawn ?? processSpawn
  const now = options.now ?? Date.now
  const pollMs = options.pollMs ?? 200
  const timeoutMs = options.timeoutMs ?? 20_000
  const terminateMs = options.terminateMs ?? 2_000
  const maxPending = options.maxPending ?? 8
  if (!Number.isInteger(maxPending) || maxPending < 1 || !Number.isFinite(terminateMs) || terminateMs < 0) throw new Error("Invalid launcher limits")
  const claimed = new Set<string>()
  const children = new Set<LaunchedChild>()
  let queue: Promise<unknown> = Promise.resolve()
  let disposed = false
  let epoch = 0
  let revocations = 0
  let terminationFailed = false
  let pending = 0
  let stopping: Promise<void> | undefined
  const terminations = new WeakMap<LaunchedChild, Promise<void>>()
  const stopChild = (child: LaunchedChild): Promise<void> => {
    const existing = terminations.get(child)
    if (existing !== undefined) return existing
    const stopping = (async () => {
      let exited = false
      const exit = child.exited.then(() => { exited = true }, () => { exited = true })
      child.kill("SIGTERM")
      const deadline = Date.now() + terminateMs
      while ((!exited || child.alive?.() === true) && Date.now() < deadline) await Bun.sleep(Math.min(10, Math.max(1, deadline - Date.now())))
      if (!exited || child.alive?.() === true) child.kill("SIGKILL")
      await exit
      const killedDeadline = Date.now() + Math.max(terminateMs, 2_000)
      while (child.alive?.() === true) {
        if (Date.now() >= killedDeadline) {
          terminationFailed = true
          throw new Error("Agent process group did not stop before the deadline.")
        }
        await Bun.sleep(10)
      }
    })().then(() => { children.delete(child) }, error => {
      terminationFailed = true
      throw error
    })
    terminations.set(child, stopping)
    return stopping
  }
  const cancelled = (): LaunchResult => ({ error: "The launch was cancelled.", reason: "cancelled" })

  const stopAll = (): Promise<void> => {
    if (stopping !== undefined) return stopping
    epoch++
    const admitted = queue
    stopping = Promise.all([...children].map(stopChild)).then(() => admitted).then(() => {}).finally(() => { stopping = undefined })
    return stopping
  }

  const run = async (agent: LaunchAgent, cli: LaunchableCli, prompt: string, admitted: number, hold: (completion: Promise<void>) => void): Promise<LaunchResult> => {
    const name = AGENT_NAMES[agent]
    if (disposed) return { error: `${name} cannot start: this host is stopping.`, reason: "stopping" }
    if (admitted !== epoch || terminationFailed) return cancelled()
    const cwd = await realpath(options.cwd)
    const launch: Launch = { cwd, launchedAt: now() }
    const home = await realpath(options.home ?? userInfo().homedir)
    const env = launchEnvironment(agent, home, process.env, cli.env)
    const agentHome = env[agent === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]!
    // Validate the nearest existing ancestor as well as an existing home:
    // the CLI may create its default directory, but may never follow a link.
    let ancestor = agentHome
    while (ancestor !== home && !await lstat(ancestor).catch(() => undefined)) ancestor = dirname(ancestor)
    if (!(await regularPath(ancestor, home).catch(() => undefined))?.isDirectory()) {
      return { error: `${name}'s home is unsafe.`, reason: "unsafe_home" }
    }
    const roots = (await cli.roots()).filter(root => resolve(root) === join(agentHome, agent === "codex" ? "sessions" : "projects"))
    if (disposed || admitted !== epoch || terminationFailed) return disposed ? { error: `${name} cannot start: this host is stopping.`, reason: "stopping" } : cancelled()
    const child = spawn([...cli.command, ...launchArguments(agent, cwd)], { cwd, env, stdin: prompt })
    children.add(child)
    let exit: number | undefined
    const completion = child.exited.then(code => { exit = code }, () => { exit = -1 }).then(() => stopChild(child))
    hold(completion)

    const deadline = launch.launchedAt + timeoutMs
    for (;;) {
      // An exit seen before the read means the read saw everything the CLI wrote.
      const exited = exit
      const session = launchedSession(await sessionStartsSince(agent, roots, launch.launchedAt, now(), home), launch, claimed)
      if (disposed || admitted !== epoch) {
        await stopChild(child)
        return disposed ? { error: `${name} stopped: this host is stopping.`, reason: "stopping" } : cancelled()
      }
      if (session !== undefined) {
        claimed.add(session)
        return { agent, session }
      }
      if (exited !== undefined) {
        return { error: `${name} exited ${exited === 0 ? "" : `with ${exited} `}before it wrote a session.`, reason: "exited" }
      }
      if (now() >= deadline) {
        await stopChild(child)
        return disposed ? { error: `${name} stopped: this host is stopping.`, reason: "stopping" }
          : { error: `${name} wrote no session in ${Math.round(timeoutMs / 1000)} s.`, reason: "timeout" }
      }
      await Bun.sleep(pollMs)
    }
  }

  return {
    /** The agents this host can start, in a fixed order. */
    agents: (["codex", "claude-code"] as const).filter(agent => options.agents[agent] !== undefined),
    /** Capture before reading a launch request's body. */
    admission: () => stopping !== undefined || revocations > 0 || terminationFailed ? -1 : epoch,
    /** Hold admission closed through the entire identity transition. */
    revoke: async <T>(transition: () => Promise<T>): Promise<T> => {
      revocations++
      epoch++
      try { await stopAll(); return await transition() }
      finally { revocations-- }
    },
    /** Undefined when this host cannot start `agent`. */
    launch: (agent: LaunchAgent, prompt: string, generation = epoch): Promise<LaunchResult> | undefined => {
      const cli = options.agents[agent]
      if (cli === undefined) return undefined
      if (disposed) return Promise.resolve({ error: `${AGENT_NAMES[agent]} cannot start: this host is stopping.`, reason: "stopping" })
      if (stopping !== undefined || revocations > 0 || terminationFailed || generation !== epoch) return Promise.resolve(cancelled())
      if (pending >= maxPending) return Promise.resolve({ error: "Too many agent launches are pending.", reason: "busy" })
      pending++
      const admitted = epoch
      let report!: (result: LaunchResult) => void
      let reject!: (error: unknown) => void
      const result = new Promise<LaunchResult>((resolve, fail) => { report = resolve; reject = fail })
      queue = queue.then(async () => {
        let completion: Promise<void> = Promise.resolve()
        try {
          report(await run(agent, cli, prompt, admitted, held => { completion = held }))
          // A session is the response receipt, never permission to spawn another child.
          await completion
        } catch (error) { reject(error); await completion }
        finally { pending-- }
      }).catch(() => undefined)
      return result
    },
    /** Revoke queued requests and await every owned child without closing the host. */
    stopAll,
    dispose: (): Promise<void> => {
      disposed = true
      return stopAll()
    }
  }
}
export type AgentLauncher = ReturnType<typeof agentLauncher>
