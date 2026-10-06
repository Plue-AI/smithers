/*
 * Starting an agent CLI on this machine (#3730, mvp.md M-38). The host runs
 * Codex or Claude Code headless in its working directory, then finds the
 * session the CLI wrote: the earliest one whose working directory is the
 * launch's and which began at or after the launch. The conversation reads that
 * session through /api/external/sessions. Launches run one at a time, so two
 * launches in one directory never trade sessions.
 */
import { lstat, readdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { readChunk, regularPath } from "./ExternalSessions"
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
const projectDirectories = async (root: string): Promise<string[]> =>
  (await readdir(root).catch(() => [] as string[])).map(name => join(root, name))

/** The starts of the sessions `agent` wrote since `since`, under every sessions root. */
export async function sessionStartsSince(agent: LaunchAgent, roots: ReadonlyArray<string>, since: number, now = Date.now()): Promise<SessionStart[]> {
  const directories = agent === "codex" ? roots.flatMap(root => dayDirectories(root, since, now))
    : (await Promise.all(roots.map(projectDirectories))).flat()
  const starts: SessionStart[] = []
  for (const directory of directories) {
    const root = roots.find(root => !relative(resolve(root), resolve(directory)).startsWith(".."))
    if (root === undefined || !(await regularPath(directory, root).catch(() => undefined))?.isDirectory()) continue
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      if (!name.endsWith(".jsonl") || (agent === "codex" && !name.startsWith("rollout-"))) continue
      const path = join(directory, name)
      const info = await regularPath(path, root).catch(() => undefined)
      if (!info?.isFile() || info.mtimeMs < since - START_SKEW_MS) continue
      const chunk = await readChunk(path, root, 0, info)
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
  readonly kill: () => void
  /** The last bytes the CLI wrote to stderr: why it stopped, when it stops early. */
  readonly stderr: () => string
}

export type Spawn = (argv: ReadonlyArray<string>, options: { readonly cwd: string; readonly env: Record<string, string | undefined>; readonly stdin: string }) => LaunchedChild

const STDERR_TAIL = 2_000

const bunSpawn: Spawn = (argv, options) => {
  const child = Bun.spawn([...argv], { cwd: options.cwd, env: options.env, stdin: "pipe", stdout: "ignore", stderr: "pipe" })
  child.stdin.write(options.stdin)
  child.stdin.end()
  let tail = ""
  void (async () => {
    const reader = child.stderr.getReader()
    const decoder = new TextDecoder()
    for (let read = await reader.read(); !read.done; read = await reader.read()) tail = (tail + decoder.decode(read.value, { stream: true })).slice(-STDERR_TAIL)
  })().catch(() => {})
  return { exited: child.exited, kill: () => child.kill(), stderr: () => tail }
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
  /** Every directory the agent files sessions in, as the session reader reads them. */
  readonly roots: () => Promise<readonly string[]>
  /** Added to this process's environment for the CLI. */
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
}

/** Why a launch bound no session: the CLI exited first, wrote nothing in time, or the host is stopping. */
export type LaunchFailure = "exited" | "timeout" | "stopping" | "unsafe_home"

export type LaunchResult =
  | { readonly agent: LaunchAgent; readonly session: string }
  | { readonly error: string; readonly reason: LaunchFailure }

const AGENT_NAMES: Record<LaunchAgent, string> = { codex: "Codex", "claude-code": "Claude Code" }

/** Starts agent CLIs one at a time; `dispose` stops every CLI it started. */
export function agentLauncher(options: AgentLauncherOptions) {
  const spawn = options.spawn ?? bunSpawn
  const now = options.now ?? Date.now
  const pollMs = options.pollMs ?? 200
  const timeoutMs = options.timeoutMs ?? 20_000
  const claimed = new Set<string>()
  const children = new Set<LaunchedChild>()
  let queue: Promise<unknown> = Promise.resolve()
  let disposed = false

  const run = async (agent: LaunchAgent, cli: LaunchableCli, prompt: string): Promise<LaunchResult> => {
    const name = AGENT_NAMES[agent]
    if (disposed) return { error: `${name} cannot start: this host is stopping.`, reason: "stopping" }
    const cwd = await realpath(options.cwd)
    const launch: Launch = { cwd, launchedAt: now() }
    const home = await realpath(options.home ?? homedir())
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
    const child = spawn([...cli.command, ...launchArguments(agent, cwd)], { cwd, env, stdin: prompt })
    children.add(child)
    let exit: number | undefined
    void child.exited.then(code => { exit = code; children.delete(child) }, () => { exit = -1; children.delete(child) })
    const deadline = launch.launchedAt + timeoutMs
    for (;;) {
      // An exit seen before the read means the read saw everything the CLI wrote.
      const exited = exit
      const session = launchedSession(await sessionStartsSince(agent, roots, launch.launchedAt, now()), launch, claimed)
      if (session !== undefined) {
        claimed.add(session)
        return { agent, session }
      }
      if (exited !== undefined) {
        return { error: `${name} exited ${exited === 0 ? "" : `with ${exited} `}before it wrote a session.`, reason: "exited" }
      }
      if (disposed || now() >= deadline) {
        child.kill()
        return disposed ? { error: `${name} stopped: this host is stopping.`, reason: "stopping" }
          : { error: `${name} wrote no session in ${Math.round(timeoutMs / 1000)} s.`, reason: "timeout" }
      }
      await Bun.sleep(pollMs)
    }
  }

  return {
    /** The agents this host can start, in a fixed order. */
    agents: (["codex", "claude-code"] as const).filter(agent => options.agents[agent] !== undefined),
    /** Undefined when this host cannot start `agent`. */
    launch: (agent: LaunchAgent, prompt: string): Promise<LaunchResult> | undefined => {
      const cli = options.agents[agent]
      if (cli === undefined) return undefined
      const result = queue.then(() => run(agent, cli, prompt))
      queue = result.catch(() => undefined)
      return result
    },
    dispose: (): void => {
      disposed = true
      for (const child of children) child.kill()
      children.clear()
    }
  }
}
export type AgentLauncher = ReturnType<typeof agentLauncher>
