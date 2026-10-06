import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { Result } from "effect"
import { claudeStart, codexStart, decodeClaude, decodeCodex, type Entry } from "@smthrs/harness/ExternalTranscript"
import { EXTERNAL_LAUNCH_PATH, EXTERNAL_SESSIONS_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import {
  agentLauncher, claudeSessionStart, codexSessionStart, launchArguments, launchEnvironment, launchedSession, sessionStartsSince, START_SKEW_MS,
  type LaunchAgent, type LaunchedChild, type SessionStart
} from "./AgentLaunch"
import { externalSessions } from "./ExternalSessions"
import { startLocalServer, type LocalServer } from "./server"

const FIXTURE_CLI: Record<LaunchAgent, string> = {
  codex: join(import.meta.dir, "../../e2e/fixtures/agent-launch/codex.ts"),
  "claude-code": join(import.meta.dir, "../../e2e/fixtures/agent-launch/claude.ts")
}
const SESSIONS: Record<LaunchAgent, string> = { codex: "sessions", "claude-code": "projects" }
const HOME_VARIABLE: Record<LaunchAgent, string> = { codex: "CODEX_HOME", "claude-code": "CLAUDE_CONFIG_DIR" }
const LAUNCH = { cwd: "/work/repo", launchedAt: 1_000_000 }
const start = (session: string, cwd: string, startedAt: number): SessionStart => ({ session, cwd, startedAt })

describe("which session a launch started", () => {
  test("the earliest session in the launch's directory that began at or after the launch", () => {
    const starts = [start("later", "/work/repo", 1_000_900), start("first", "/work/repo", 1_000_100), start("elsewhere", "/work/other", 1_000_050)]
    expect(launchedSession(starts, LAUNCH, new Set())).toBe("first")
  })

  test("a session that began before the launch is someone else's; within the clock skew it is this one", () => {
    expect(launchedSession([start("before", "/work/repo", LAUNCH.launchedAt - START_SKEW_MS - 1)], LAUNCH, new Set())).toBeUndefined()
    expect(launchedSession([start("skewed", "/work/repo", LAUNCH.launchedAt - START_SKEW_MS)], LAUNCH, new Set())).toBe("skewed")
  })

  test("a session an earlier launch claimed is never bound twice", () => {
    const starts = [start("a", "/work/repo", 1_000_100), start("b", "/work/repo", 1_000_200)]
    expect(launchedSession(starts, LAUNCH, new Set(["a"]))).toBe("b")
    expect(launchedSession(starts, LAUNCH, new Set(["a", "b"]))).toBeUndefined()
  })

  test("a tie in start time breaks on the session id, so the answer never depends on directory order", () => {
    const starts = [start("b", "/work/repo", 1_000_100), start("a", "/work/repo", 1_000_100)]
    expect(launchedSession(starts, LAUNCH, new Set())).toBe("a")
    expect(launchedSession([...starts].reverse(), LAUNCH, new Set())).toBe("a")
  })

  test("no session in the directory is no answer", () => {
    expect(launchedSession([], LAUNCH, new Set())).toBeUndefined()
    expect(launchedSession([start("x", "/work/repo/sub", 1_000_100)], LAUNCH, new Set())).toBeUndefined()
  })
})

describe("a session file's start", () => {
  test("a Codex rollout's session_meta names the session, its directory and its start", () => {
    const line = JSON.stringify({ timestamp: "2026-10-05T18:00:01.000Z", type: "session_meta", payload: { id: "s1", cwd: "/repo", timestamp: "2026-10-05T18:00:00.000Z" } })
    expect(codexSessionStart(line)).toEqual({ session: "s1", cwd: "/repo", startedAt: Date.parse("2026-10-05T18:00:00.000Z") })
    // Without its own timestamp the record's stands in.
    const bare = JSON.stringify({ timestamp: "2026-10-05T18:00:01.000Z", type: "session_meta", payload: { id: "s1", cwd: "/repo" } })
    expect(codexSessionStart(bare)?.startedAt).toBe(Date.parse("2026-10-05T18:00:01.000Z"))
  })

  test("any other Codex line is not a session start", () => {
    for (const line of [
      "", "not json", "null", "[]",
      JSON.stringify({ type: "event_msg", payload: { id: "s1", cwd: "/repo", timestamp: "2026-10-05T18:00:00.000Z" } }),
      JSON.stringify({ type: "session_meta", payload: { cwd: "/repo", timestamp: "2026-10-05T18:00:00.000Z" } }),
      JSON.stringify({ type: "session_meta", payload: { id: "s1", timestamp: "2026-10-05T18:00:00.000Z" } }),
      JSON.stringify({ type: "session_meta", payload: { id: "s1", cwd: "/repo", timestamp: "yesterday" } }),
      JSON.stringify({ type: "session_meta" })
    ]) expect(codexSessionStart(line)).toBeUndefined()
  })

  test("a Claude Code transcript starts at its first record naming a directory and a time, after mode records", () => {
    const lines = [
      JSON.stringify({ type: "mode", mode: "normal", sessionId: "c1" }),
      "not json",
      JSON.stringify({ type: "file-history-snapshot", snapshot: { timestamp: "2026-10-05T18:59:00.000Z" } }),
      JSON.stringify({ type: "user", cwd: "/repo", sessionId: "c1", timestamp: "2026-10-05T19:00:01.000Z" }),
      JSON.stringify({ type: "user", cwd: "/elsewhere", sessionId: "c1", timestamp: "2026-10-05T19:00:00.000Z" })
    ]
    expect(claudeSessionStart("c1", lines)).toEqual({ session: "c1", cwd: "/repo", startedAt: Date.parse("2026-10-05T19:00:01.000Z") })
  })

  test("a Claude Code transcript whose record names another session, a bad time or no directory starts nothing", () => {
    const at = { cwd: "/repo", timestamp: "2026-10-05T19:00:01.000Z" }
    expect(claudeSessionStart("c1", [JSON.stringify({ ...at, sessionId: "other" })])).toBeUndefined()
    expect(claudeSessionStart("c1", [JSON.stringify({ ...at, sessionId: "c1", timestamp: "soon" })])).toBeUndefined()
    expect(claudeSessionStart("c1", [JSON.stringify({ type: "mode", sessionId: "c1" })])).toBeUndefined()
    expect(claudeSessionStart("c1", [])).toBeUndefined()
  })

  test("safe own-home configuration survives; foreign and seat homes and injection secrets do not", () => {
    for (const agent of ["codex", "claude-code"] as const) {
      const key = agent === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"
      const fallback = agent === "codex" ? ".codex" : ".claude"
      for (const unsafe of ["/another-owner/.codex", "/owner/.smithers/accounts/codex-1", "/owner/../other/.claude"]) {
        expect(launchEnvironment(agent, "/owner", {}, { [key]: unsafe })[key]).toBe(`/owner/${fallback}`)
      }
      const configured = { [key]: "/owner/custom", PATH: "/tools", LANG: "en_US.UTF-8", TERM: "xterm-256color" }
      const inherited = Object.fromEntries(["GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "SSH_AUTH_SOCK", "AWS_SECRET_ACCESS_KEY", "NODE_OPTIONS", "BUN_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].map(key => [key, "secret-exploit"]))
      expect(launchEnvironment(agent, "/owner", inherited, configured)).toEqual({ HOME: "/owner", ...configured })
    }
  })

  test("each agent preserves configured permissions and keeps an exploit prompt out of argv", () => {
    expect(launchArguments("codex", "/work", "--help; rm -rf /")).toEqual(["exec", "--skip-git-repo-check", "-C", "/work", "-"])
    expect(launchArguments("claude-code", "/work", "--help; rm -rf /")).toEqual(["-p"])
  })
})

let scratch: string
beforeAll(async () => { scratch = await realpath(await mkdtemp(join(tmpdir(), "agent-launch-"))) })
afterAll(() => rm(scratch, { recursive: true, force: true }))

/** A launcher whose agents are the fixture CLIs, each with a home of its own under `name`. */
const fixtureLauncher = async (name: string, overrides: Partial<Parameters<typeof agentLauncher>[0]> = {}) => {
  const cwd = join(scratch, name, "work")
  await mkdir(cwd, { recursive: true })
  const home = (agent: LaunchAgent) => join(scratch, name, agent)
  const roots = async (agent: LaunchAgent) => [join(home(agent), SESSIONS[agent])]
  const cli = (agent: LaunchAgent) => ({ command: [process.execPath, FIXTURE_CLI[agent]], env: { [HOME_VARIABLE[agent]]: home(agent) }, roots: () => roots(agent) })
  return { cwd, home, roots, launcher: agentLauncher({ cwd, home: join(scratch, name), agents: { codex: cli("codex"), "claude-code": cli("claude-code") }, pollMs: 20, ...overrides }) }
}

/** The session's entries as the browser decodes them, read through the host's own session reader. */
const conversation = async (roots: (agent: LaunchAgent) => Promise<readonly string[]>, agent: LaunchAgent, session: string): Promise<ReadonlyArray<Entry>> => {
  const read = await externalSessions(roots)(agent, session, 0)
  if ("refusal" in read) throw new Error(read.refusal.message)
  const decoded: Result.Result<{ readonly entries: ReadonlyArray<Entry> }, { readonly message: string }> =
    agent === "codex" ? decodeCodex(codexStart, read.text) : decodeClaude(claudeStart, read.text)
  if (Result.isFailure(decoded)) throw new Error(decoded.failure.message)
  return decoded.success.entries
}
const words = (entries: ReadonlyArray<Entry>) =>
  entries.map(entry => entry.part.type === "prompt" || entry.part.type === "text" ? entry.part.text : entry.part.type)

describe("starting an agent", () => {
  for (const [agent, name] of [["codex", "Codex"], ["claude-code", "Claude Code"]] as const) {
    test(`${name}: the fixture CLI's session is found by directory and start time and reads as the conversation`, async () => {
      const { roots, launcher } = await fixtureLauncher(`one-${agent}`)
      try {
        const launched = await launcher.launch(agent, "Fix the flaky test")
        if (launched === undefined || !("session" in launched)) throw new Error(JSON.stringify(launched))
        expect(launched.agent).toBe(agent)
        expect(words(await conversation(roots, agent, launched.session)))
          .toEqual(["Fix the flaky test", "tool", `Fixture ${name} finished: Fix the flaky test`])
      } finally { launcher.dispose() }
    })
  }

  test("two launches in one directory bind two sessions, in launch order, across agents", async () => {
    const { roots, launcher } = await fixtureLauncher("two")
    try {
      const [first, second, third] = await Promise.all([
        launcher.launch("codex", "first"), launcher.launch("codex", "second"), launcher.launch("claude-code", "third")
      ])
      if (!first || !second || !third || !("session" in first) || !("session" in second) || !("session" in third)) throw new Error("expected three sessions")
      expect(new Set([first.session, second.session, third.session]).size).toBe(3)
      for (const [launched, prompt] of [[first, "first"], [second, "second"], [third, "third"]] as const) {
        expect((await conversation(roots, launched.agent, launched.session))[0]?.part).toEqual({ type: "prompt", text: prompt })
      }
    } finally { launcher.dispose() }
  })

  test("a session in another directory, or written before the launch, is not this launch's", async () => {
    const { home, roots } = await fixtureLauncher("foreign")
    const at = new Date()
    const pad = (value: number) => String(value).padStart(2, "0")
    const day = join(home("codex"), "sessions", String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()))
    await mkdir(day, { recursive: true })
    await writeFile(join(day, "rollout-x-elsewhere.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "elsewhere", cwd: "/somewhere/else", timestamp: at.toISOString() } })}\n`)
    await writeFile(join(day, "rollout-x-partial.jsonl"), JSON.stringify({ type: "session_meta" }))
    await writeFile(join(day, "notes.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "notes", cwd: "/x", timestamp: at.toISOString() } })}\n`)
    const project = join(home("claude-code"), "projects", "-somewhere-else")
    await mkdir(project, { recursive: true })
    await writeFile(join(project, "c-elsewhere.jsonl"), `${JSON.stringify({ type: "user", cwd: "/somewhere/else", sessionId: "c-elsewhere", timestamp: at.toISOString() })}\n`)
    expect(await sessionStartsSince("codex", await roots("codex"), at.getTime() - 10_000)).toEqual([{ session: "elsewhere", cwd: "/somewhere/else", startedAt: at.getTime() }])
    expect(await sessionStartsSince("claude-code", await roots("claude-code"), at.getTime() - 10_000)).toEqual([{ session: "c-elsewhere", cwd: "/somewhere/else", startedAt: at.getTime() }])
    // A file last written before the launch is never read.
    for (const agent of ["codex", "claude-code"] as const) {
      expect(await sessionStartsSince(agent, await roots(agent), at.getTime() + 60_000, at.getTime() + 60_000)).toEqual([])
    }
  })

  test("Codex files a session under the day of its own time zone, which may not be this host's", async () => {
    const { home, roots } = await fixtureLauncher("zones")
    const now = Date.now()
    for (const [offset, id] of [[-12, "west"], [14, "east"]] as const) {
      const there = new Date(now + offset * 60 * 60 * 1000)
      const pad = (value: number) => String(value).padStart(2, "0")
      const day = join(home("codex"), "sessions", String(there.getUTCFullYear()), pad(there.getUTCMonth() + 1), pad(there.getUTCDate()))
      await mkdir(day, { recursive: true })
      await writeFile(join(day, `rollout-${id}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id, cwd: "/repo", timestamp: new Date(now).toISOString() } })}\n`)
    }
    expect((await sessionStartsSince("codex", await roots("codex"), now - 1_000, now)).map(found => found.session).sort()).toEqual(["east", "west"])
  })

  test("a CLI failure never returns secret stderr", async () => {
    const { launcher } = await fixtureLauncher("exits", {
      spawn: () => ({ exited: Promise.resolve(2), kill: () => {}, stderr: () => "starting\nGITHUB_TOKEN=secret-exploit\n" })
    })
    expect(await launcher.launch("claude-code", "hello")).toEqual({ error: "Claude Code exited with 2 before it wrote a session.", reason: "exited" })
  })

  test("discovery follows only own-home root links and re-resolves them", async () => {
    for (const agent of ["codex", "claude-code"] as const) {
      const home = join(scratch, `root-home-${agent}`)
      const root = join(home, "sessions")
      const link = join(home, "linked-root")
      const now = Date.now()
      const date = new Date(now)
      const day = join(String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0"))
      const directory = join(root, agent === "codex" ? day : "project")
      await mkdir(directory, { recursive: true })
      const name = agent === "codex" ? "rollout-own.jsonl" : "own.jsonl"
      const payload = agent === "codex" ? { type: "session_meta", payload: { id: "own", cwd: "/repo", timestamp: date.toISOString() } }
        : { sessionId: "own", cwd: "/repo", timestamp: date.toISOString() }
      await writeFile(join(directory, name), `${JSON.stringify(payload)}\n`)
      await symlink(root, link)
      expect(await sessionStartsSince(agent, [link], now - 100, now, home)).toEqual([{ session: "own", cwd: "/repo", startedAt: now }])
      for (const target of [join(scratch, `foreign-${agent}`), join(home, ".smithers", "accounts", "codex-2", "sessions")]) {
        const targetDirectory = join(target, agent === "codex" ? day : "project")
        await mkdir(targetDirectory, { recursive: true })
        await writeFile(join(targetDirectory, name), `${JSON.stringify(payload)}\n`)
        await rm(link)
        await symlink(target, link)
        expect(await sessionStartsSince(agent, [link], now - 100, now, home)).toEqual([])
      }
    }
  })

  test("discovery refuses symlink files and directories carrying a forged launch (#3736)", async () => {
    for (const agent of ["codex", "claude-code"] as const) {
      const base = join(scratch, `links-${agent}`)
      const root = join(base, "root")
      const outside = join(base, "outside")
      const now = Date.now()
      const date = new Date(now)
      const day = join(String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0"))
      const directory = join(root, agent === "codex" ? day : "project")
      await mkdir(directory, { recursive: true })
      await mkdir(outside, { recursive: true })
      const name = agent === "codex" ? "rollout-forged.jsonl" : "forged.jsonl"
      const payload = agent === "codex" ? { type: "session_meta", payload: { id: "forged", cwd: "/repo", timestamp: date.toISOString() } }
        : { sessionId: "forged", cwd: "/repo", timestamp: date.toISOString() }
      await writeFile(join(outside, name), `${JSON.stringify(payload)}\n`)
      await symlink(join(outside, name), join(directory, name))
      expect(await sessionStartsSince(agent, [root], now - 100)).toEqual([])
      await rm(directory, { recursive: true })
      await symlink(outside, directory)
      expect(await sessionStartsSince(agent, [root], now - 100)).toEqual([])
      await symlink(root, join(base, "linked-root"))
      expect(await sessionStartsSince(agent, [join(base, "linked-root")], now - 100)).toEqual([])
    }
  })

  test("spawn receives stdin and only safe env with the running user's own home (#3736)", async () => {
    const saved = { ...process.env }
    const seen: Array<{ argv: ReadonlyArray<string>; options: unknown }> = []
    const home = join(scratch, "own-home")
    await mkdir(home, { recursive: true })
    try {
      Object.assign(process.env, { GITHUB_TOKEN: "host-secret", NODE_OPTIONS: "--require=/evil.js", HOME: "/other-owner", CODEX_HOME: "/other-owner/.smithers/accounts/codex-1" })
      const launcher = agentLauncher({ cwd: home, home, agents: { codex: { command: ["codex"], roots: async () => [], env: { GITHUB_TOKEN: "override-secret" } } },
        spawn: (argv, options) => { seen.push({ argv, options }); return { exited: Promise.resolve(1), kill: () => {}, stderr: () => "" } } })
      await launcher.launch("codex", "--help; secret prompt")
      expect(seen[0]?.argv).toEqual(["codex", "exec", "--skip-git-repo-check", "-C", home, "-"])
      expect(seen[0]?.options).toMatchObject({ stdin: "--help; secret prompt", env: { HOME: home, CODEX_HOME: join(home, ".codex") } })
      const env = (seen[0]?.options as { env: Record<string, string> }).env
      for (const key of ["GITHUB_TOKEN", "NODE_OPTIONS", "CLAUDE_CONFIG_DIR"]) expect(env[key]).toBeUndefined()
      await launcher.dispose()
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  })

  test("inherited HOME cannot redefine the running OS user's home (#3736)", async () => {
    const original = process.env.HOME
    const osHome = await realpath(userInfo().homedir)
    const agentHome = join(osHome, `.b8-launch-nonexistent-${crypto.randomUUID()}`)
    const seen: Record<string, string | undefined>[] = []
    process.env.HOME = "/another-owner/.smithers/accounts/codex-1"
    try {
      const launcher = agentLauncher({ cwd: scratch, agents: { codex: { command: ["codex"], env: { CODEX_HOME: agentHome }, roots: async () => [] } },
        spawn: (_argv, options) => { seen.push(options.env); return { exited: Promise.resolve(0), kill: () => {}, stderr: () => "" } } })
      expect(await launcher.launch("codex", "inherit someone else's HOME")).toMatchObject({ reason: "exited" })
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ HOME: osHome, CODEX_HOME: agentHome })
      await launcher.dispose()
    } finally { if (original === undefined) delete process.env.HOME; else process.env.HOME = original }
  })

  test("an agent home symlink cannot grant another account's authority", async () => {
    const home = join(scratch, "linked-home")
    const other = join(scratch, "another-owner")
    await mkdir(home, { recursive: true })
    await mkdir(other, { recursive: true })
    await symlink(other, join(home, ".codex"))
    let spawned = false
    const launcher = agentLauncher({ cwd: home, home, agents: { codex: { command: ["codex"], roots: async () => [] } },
      spawn: () => { spawned = true; throw new Error("must not spawn") } })
    expect(await launcher.launch("codex", "read someone else's credentials")).toEqual({ error: "Codex's home is unsafe.", reason: "unsafe_home" })
    expect(spawned).toBe(false)
  })

  test("a discovered session holds the active slot until exit and queued launches are bounded (#3736)", async () => {
    const base = join(scratch, "active-bound")
    const home = join(base, ".codex")
    const at = new Date()
    const day = join(home, "sessions", String(at.getUTCFullYear()), String(at.getUTCMonth() + 1).padStart(2, "0"), String(at.getUTCDate()).padStart(2, "0"))
    await mkdir(day, { recursive: true })
    const exits: Array<() => void> = []
    const launcher = agentLauncher({ cwd: base, home: base, maxPending: 2, pollMs: 5,
      agents: { codex: { command: ["codex"], env: { CODEX_HOME: home }, roots: async () => [join(home, "sessions")] } },
      spawn: () => {
        const id = `active-${exits.length}`
        let exit!: () => void
        const exited = new Promise<number>(resolve => { exit = () => resolve(0) })
        exits.push(exit)
        void writeFile(join(day, `rollout-${id}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id, cwd: base, timestamp: new Date().toISOString() } })}\n`)
        return { exited, kill: exit, stderr: () => "" }
      } })
    try {
      expect(await launcher.launch("codex", "first")).toMatchObject({ session: "active-0" })
      const second = launcher.launch("codex", "second")!
      await Bun.sleep(30)
      expect(exits.length).toBe(1)
      expect(await launcher.launch("codex", "flood")).toEqual({ error: "Too many agent launches are pending.", reason: "busy" })
      exits[0]!()
      expect(await second).toMatchObject({ session: "active-1" })
    } finally { await launcher.dispose() }
  })

  test("stopAll revokes queued requests, refuses races while draining, and permits a fresh launch", async () => {
    const base = join(scratch, "stop-generation")
    const home = join(base, ".codex")
    const now = new Date()
    const root = join(home, "sessions")
    const day = join(root, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"), String(now.getUTCDate()).padStart(2, "0"))
    await mkdir(day, { recursive: true })
    let spawned = 0
    const launcher = agentLauncher({ cwd: base, home: base, pollMs: 5,
      agents: { codex: { command: ["codex"], env: { CODEX_HOME: home }, roots: async () => [root] } },
      spawn: () => {
        const id = `generation-${spawned++}`
        let exit!: () => void
        const exited = new Promise<number>(resolve => { exit = () => resolve(143) })
        void writeFile(join(day, `rollout-${id}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id, cwd: base, timestamp: new Date().toISOString() } })}\n`)
        return { exited, kill: exit, stderr: () => "" }
      } })
    try {
      expect(await launcher.launch("codex", "old active")).toMatchObject({ session: "generation-0" })
      const queued = launcher.launch("codex", "old queued")!
      const stopping = launcher.stopAll()
      expect(await launcher.launch("codex", "race during sign-out")).toMatchObject({ reason: "cancelled" })
      await stopping
      expect(await queued).toMatchObject({ reason: "cancelled" })
      expect(spawned).toBe(1)
      expect(await launcher.launch("codex", "new owner")).toMatchObject({ session: "generation-1" })
    } finally { await launcher.dispose() }
  })

  test("identity revocation holds admission through transition completion and failure", async () => {
    const { launcher } = await fixtureLauncher("identity-gate")
    for (const fail of [false, true]) {
      const generation = launcher.admission()
      let release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      const transition = launcher.revoke(async () => { await held; if (fail) throw new Error("identity failed") })
      await launcher.stopAll()
      const during = launcher.admission()
      expect(await launcher.launch("codex", "during identity")).toMatchObject({ reason: "cancelled" })
      release()
      if (fail) await expect(transition).rejects.toThrow("identity failed")
      else await transition
      expect(await launcher.launch("codex", "old request", generation)).toMatchObject({ reason: "cancelled" })
      expect(await launcher.launch("codex", "body delayed through identity", during)).toMatchObject({ reason: "cancelled" })
    }
    expect(await launcher.launch("codex", "fresh")).toHaveProperty("session")
    await launcher.dispose()
  })

  test("SIGKILL waits for descendants after the leader exits before reopening admission", async () => {
    let exit!: () => void
    let groupAlive = true
    let killed!: () => void
    const kill = new Promise<void>(resolve => { killed = resolve })
    const { launcher } = await fixtureLauncher("group-drain", { pollMs: 5, terminateMs: 10,
      spawn: () => ({ exited: new Promise<number>(resolve => { exit = () => resolve(137) }),
        kill: signal => { if (signal === "SIGKILL") { exit(); killed() } }, alive: () => groupAlive, stderr: () => "" }) })
    const launch = launcher.launch("codex", "held")!
    await Bun.sleep(30)
    const stopping = launcher.stopAll()
    await kill
    let drained = false
    void stopping.then(() => { drained = true })
    await Bun.sleep(20)
    expect(drained).toBe(false)
    expect(await launcher.launch("codex", "before group disappearance")).toMatchObject({ reason: "cancelled" })
    groupAlive = false
    await stopping
    expect(await launch).toMatchObject({ reason: "cancelled" })
    await launcher.dispose()
  })

  test("a group surviving SIGKILL fails at the deadline and never reopens admission", async () => {
    let exit!: () => void
    const { launcher } = await fixtureLauncher("group-deadline", { timeoutMs: 20, pollMs: 5, terminateMs: 0,
      spawn: () => ({ exited: new Promise<number>(resolve => { exit = () => resolve(137) }),
        kill: signal => { if (signal === "SIGKILL") exit() }, alive: () => true, stderr: () => "" }) })
    await expect(launcher.launch("codex", "unstoppable group")!).rejects.toThrow("Agent process group did not stop before the deadline.")
    expect(await launcher.launch("codex", "after failed termination")).toMatchObject({ reason: "cancelled" })
    await expect(launcher.dispose()).rejects.toThrow("Agent process group did not stop before the deadline.")
  })

  test("termination escalates after a deadline and awaits actual exit (#3736)", async () => {
    const signals: string[] = []
    let exit!: () => void
    const exited = new Promise<number>(resolve => { exit = () => resolve(137) })
    const { launcher } = await fixtureLauncher("escalation", { timeoutMs: 20, terminateMs: 20, pollMs: 5,
      spawn: () => ({ exited, kill: signal => { signals.push(signal ?? "SIGTERM"); if (signal === "SIGKILL") exit() }, stderr: () => "" }) })
    expect(await launcher.launch("codex", "ignore SIGTERM")).toMatchObject({ reason: "timeout" })
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    await launcher.dispose()
  })

  test("stopping kills the real process group, including a SIGTERM-resistant descendant (#3736)", async () => {
    const base = join(scratch, "process-group")
    const home = join(base, ".codex")
    const script = join(base, "resistant.ts")
    const pids = join(base, "pids.json")
    await mkdir(base, { recursive: true })
    await writeFile(script, `
      import { mkdir, writeFile } from "node:fs/promises";
      import { join } from "node:path";
      process.on("SIGTERM", () => {});
      const descendant = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      await writeFile(${JSON.stringify(pids)}, JSON.stringify([process.pid, descendant.pid]));
      const now = new Date();
      const day = join(process.env.CODEX_HOME!, "sessions", String(now.getUTCFullYear()), String(now.getUTCMonth()+1).padStart(2,"0"), String(now.getUTCDate()).padStart(2,"0"));
      await mkdir(day, {recursive:true});
      await writeFile(join(day,"rollout-resistant.jsonl"), JSON.stringify({type:"session_meta",payload:{id:"resistant",cwd:process.cwd(),timestamp:now.toISOString()}})+"\\n");
      setInterval(()=>{},1000);
    `)
    const launcher = agentLauncher({ cwd: base, home: base, pollMs: 5, terminateMs: 40,
      agents: { codex: { command: [process.execPath, script], env: { CODEX_HOME: home }, roots: async () => [join(home, "sessions")] } } })
    try {
      expect(await launcher.launch("codex", "spawn resistant descendants")).toMatchObject({ session: "resistant" })
      const ids = await Bun.file(pids).json() as number[]
      const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
      expect(ids.every(alive)).toBe(true)
      await launcher.dispose()
      expect(ids.filter(alive)).toEqual([])
    } finally {
      const ids = await Bun.file(pids).json().catch(() => []) as number[]
      for (const pid of ids) { try { process.kill(pid, "SIGKILL") } catch {} }
      await launcher.dispose()
    }
  })

  test("a CLI that writes no session in time is stopped", async () => {
    let killed = 0
    let exit!: () => void
    const child: LaunchedChild = { exited: new Promise<number>(resolve => { exit = () => resolve(143) }), kill: () => { killed += 1; exit() }, stderr: () => "" }
    const { launcher } = await fixtureLauncher("hangs", { spawn: () => child, timeoutMs: 60 })
    expect(await launcher.launch("codex", "hello")).toEqual({ error: "Codex wrote no session in 0 s.", reason: "timeout" })
    expect(killed).toBe(1)
  })

  test("stopping the host stops every CLI it started and refuses new launches", async () => {
    let killed = 0
    const { launcher } = await fixtureLauncher("dispose", {
      spawn: () => {
        let exit!: () => void
        return { exited: new Promise<number>(resolve => { exit = () => resolve(143) }), kill: () => { killed += 1; exit() }, stderr: () => "" }
      }
    })
    const pending = launcher.launch("codex", "hello")
    await Bun.sleep(40)
    await launcher.dispose()
    expect(await pending).toEqual({ error: "Codex stopped: this host is stopping.", reason: "stopping" })
    expect(killed).toBeGreaterThanOrEqual(1)
    expect(await launcher.launch("codex", "again")).toEqual({ error: "Codex cannot start: this host is stopping.", reason: "stopping" })
  })

  test("the CLI runs in the launch directory with its own home; an agent the host was not given cannot start", async () => {
    const seen: Array<{ argv: ReadonlyArray<string>; cwd: string; home: string | undefined }> = []
    const cwd = join(scratch, "argv")
    await mkdir(cwd, { recursive: true })
    const launcher = agentLauncher({
      cwd, home: cwd,
      agents: { codex: { command: ["codex"], env: { CODEX_HOME: "/codex-home" }, roots: async () => [] } },
      spawn: (argv, options) => {
        seen.push({ argv, cwd: options.cwd, home: options.env.CODEX_HOME })
        return { exited: Promise.resolve(0), kill: () => {}, stderr: () => "" }
      }
    })
    expect(launcher.agents).toEqual(["codex"])
    expect(launcher.launch("claude-code", "hello")).toBeUndefined()
    expect(await launcher.launch("codex", "hello")).toEqual({ error: "Codex exited before it wrote a session.", reason: "exited" })
    expect(seen).toEqual([{ argv: ["codex", ...launchArguments("codex", cwd, "hello")], cwd, home: join(cwd, ".codex") }])
  })
})

describe(`POST ${EXTERNAL_LAUNCH_PATH}`, () => {
  let dist: string
  const servers: LocalServer[] = []
  const serve = async (options: { launcher?: ReturnType<typeof agentLauncher>; roots?: (agent: LaunchAgent) => Promise<readonly string[]>; cloud?: boolean } = {}) => {
    const server = await startLocalServer({ port: 0, distDir: dist, home: "/fake/home", log: () => {},
      ...(options.cloud ? { cloudMode: "hybrid" as const, cloudApi: "http://127.0.0.1:9" } : {}),
      ...(options.launcher ? { agentLauncher: options.launcher } : {}),
      ...(options.roots ? { externalSessions: externalSessions(options.roots), externalOwner: { login: "ben", name: "Ben Ito" } } : {}) })
    servers.push(server)
    return server
  }
  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), "smithers-dist-"))
    await writeFile(join(dist, "index.html"), "<!doctype html><div id=\"root\"></div>")
  })
  afterAll(async () => { await Promise.all(servers.map(server => server.stop())); await rm(dist, { recursive: true, force: true }) })
  const post = (server: LocalServer, body: unknown, session = true) => fetch(`${server.origin}${EXTERNAL_LAUNCH_PATH}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(session ? { [LOCAL_SESSION_HEADER]: server.sessionToken } : {}) }
  })
  const capabilities = async (server: LocalServer) =>
    ((await (await fetch(`${server.origin}/api/bootstrap`, { headers: { [LOCAL_SESSION_HEADER]: server.sessionToken } })).json()) as { capabilities: string[] }).capabilities

  test("a host with a launcher says which agents it starts, starts one and answers the session the conversation then reads", async () => {
    const { roots, launcher } = await fixtureLauncher("route")
    const server = await serve({ launcher, roots })
    expect(await capabilities(server)).toEqual(expect.arrayContaining(["launch.codex", "launch.claude-code"]))
    for (const agent of ["codex", "claude-code"] as const) {
      const response = await post(server, { agent, prompt: "  Add a retry  " })
      expect(response.status).toBe(200)
      const launched = await response.json() as { agent: string; session: string }
      expect(launched.agent).toBe(agent)
      const read = await fetch(`${server.origin}${EXTERNAL_SESSIONS_PATH}?agent=${agent}&session=${launched.session}&offset=0`, { headers: { [LOCAL_SESSION_HEADER]: server.sessionToken } })
      const body = await read.json() as { session_id: string; text: string }
      expect(body.session_id).toBe(launched.session)
      expect(body.text).toContain("Add a retry")
    }
  })

  test("refuses another agent, an empty prompt, a request without the local session and a failed start", async () => {
    const { launcher } = await fixtureLauncher("refusals", { spawn: () => ({ exited: Promise.resolve(1), kill: () => {}, stderr: () => "GITHUB_TOKEN=secret-exploit" }) })
    const server = await serve({ launcher })
    expect((await post(server, { agent: "aider", prompt: "hi" })).status).toBe(400)
    expect((await post(server, { agent: "codex", prompt: "   " })).status).toBe(400)
    expect((await post(server, { agent: "codex" })).status).toBe(400)
    expect((await post(server, { agent: "codex", prompt: "hi" }, false)).status).toBe(401)
    const failed = await post(server, { agent: "codex", prompt: "hi" })
    expect(failed.status).toBe(503)
    expect(await failed.json()).toMatchObject({ error: { code: "agent_unavailable", message: "Codex exited with 1 before it wrote a session.", reason: "exited" } })
  })

  test("DELETE drains active and queued launches and requires the local capability", async () => {
    let spawned = 0
    let killed = 0
    const { launcher } = await fixtureLauncher("route-stop", { pollMs: 5, spawn: () => {
      spawned++
      let exit!: () => void
      return { exited: new Promise<number>(resolve => { exit = () => resolve(143) }), kill: () => { killed++; exit() }, stderr: () => "" }
    } })
    const server = await serve({ launcher })
    const pending = post(server, { agent: "codex", prompt: "active" })
    for (let n = 0; n < 100 && spawned === 0; n++) await Bun.sleep(5)
    expect(spawned).toBe(1)
    const queued = post(server, { agent: "codex", prompt: "queued" })
    expect((await fetch(`${server.origin}${EXTERNAL_LAUNCH_PATH}`, { method: "DELETE" })).status).toBe(401)
    expect(killed).toBe(0)
    await Bun.sleep(20)
    const response = await fetch(`${server.origin}${EXTERNAL_LAUNCH_PATH}`, { method: "DELETE", headers: { [LOCAL_SESSION_HEADER]: server.sessionToken } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    for (const request of [pending, queued]) {
      const result = await request
      expect(result.status).toBe(503)
      expect(await result.json()).toMatchObject({ error: { code: "agent_unavailable", reason: "cancelled" } })
    }
    expect(killed).toBe(1)
    expect(spawned).toBe(1)
  })

  test("a POST held in its body stays cancelled after sign-out and both client sweeps; real fixture CLIs never spawn", async () => {
    const base = join(scratch, "late-body")
    await mkdir(base, { recursive: true })
    const marker = join(base, "spawned")
    const script = join(base, "fixture.ts")
    await writeFile(script, `await Bun.write(${JSON.stringify(marker)}, String(process.pid)); await import(${JSON.stringify(FIXTURE_CLI.codex)});`)
    const root = join(base, "codex", "sessions")
    const { launcher, roots } = await fixtureLauncher("late-body", {
      agents: { codex: { command: [process.execPath, script], env: { CODEX_HOME: join(base, "codex") }, roots: async () => [root] } }
    })
    let admitted!: () => void
    const admission = new Promise<void>(resolve => { admitted = resolve })
    const capture = launcher.admission
    launcher.admission = () => { const generation = capture(); admitted(); return generation }
    const server = await serve({ launcher, roots })
    let late!: ReturnType<typeof httpRequest>
    const response = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      late = httpRequest(`${server.origin}${EXTERNAL_LAUNCH_PATH}`, {
        method: "POST", headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: server.sessionToken }
      }, result => {
        let body = ""
        result.on("data", bytes => { body += String(bytes) })
        result.on("end", () => resolve({ status: result.statusCode!, body: JSON.parse(body) }))
      })
      late.on("error", reject)
      late.write('{"agent":"codex","prompt":"')
    })
    try {
      await admission
      await fetch(`${server.origin}/api/auth/sign-out`, { method: "POST", headers: { [LOCAL_SESSION_HEADER]: server.sessionToken } })
      for (let sweep = 0; sweep < 2; sweep++) {
        expect((await fetch(`${server.origin}${EXTERNAL_LAUNCH_PATH}`, { method: "DELETE", headers: { [LOCAL_SESSION_HEADER]: server.sessionToken } })).status).toBe(200)
      }
      late.end('old owner"}')
      expect(await response).toMatchObject({ status: 503, body: { error: { code: "agent_unavailable", reason: "cancelled" } } })
      expect(await Bun.file(marker).exists()).toBe(false)
      expect(await sessionStartsSince("codex", await roots("codex"), 0)).toEqual([])
      // The same real fixture would write a session if spawned; a fresh request still does.
      expect((await post(server, { agent: "codex", prompt: "fresh owner" })).status).toBe(200)
      expect(await Bun.file(marker).exists()).toBe(true)
      expect(await sessionStartsSince("codex", await roots("codex"), 0)).toHaveLength(1)
    } finally { late.destroy(); await launcher.dispose() }
  })

  test("a host without a launcher, or one with Smithers Cloud, has no launch door", async () => {
    const { launcher } = await fixtureLauncher("cloud")
    for (const server of [await serve(), await serve({ launcher, cloud: true })]) {
      expect((await capabilities(server)).filter(capability => capability.startsWith("launch."))).toEqual([])
      expect((await post(server, { agent: "codex", prompt: "hi" })).status).toBe(404)
    }
  })
})
