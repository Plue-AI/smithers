import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Result } from "effect"
import { claudeStart, codexStart, decodeClaude, decodeCodex, type Entry } from "@smthrs/harness/ExternalTranscript"
import { EXTERNAL_LAUNCH_PATH, EXTERNAL_SESSIONS_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import {
  agentLauncher, claudeSessionStart, codexSessionStart, launchArguments, launchedSession, sessionStartsSince, START_SKEW_MS,
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

  test("a CLI that writes no session in time is stopped", async () => {
    let killed = 0
    const child: LaunchedChild = { exited: new Promise<number>(() => {}), kill: () => { killed += 1 }, stderr: () => "" }
    const { launcher } = await fixtureLauncher("hangs", { spawn: () => child, timeoutMs: 60 })
    expect(await launcher.launch("codex", "hello")).toEqual({ error: "Codex wrote no session in 0 s.", reason: "timeout" })
    expect(killed).toBe(1)
  })

  test("stopping the host stops every CLI it started and refuses new launches", async () => {
    let killed = 0
    const { launcher } = await fixtureLauncher("dispose", {
      spawn: () => ({ exited: new Promise<number>(() => {}), kill: () => { killed += 1 }, stderr: () => "" })
    })
    const pending = launcher.launch("codex", "hello")
    await Bun.sleep(40)
    launcher.dispose()
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

  test("a host without a launcher, or one with Smithers Cloud, has no launch door", async () => {
    const { launcher } = await fixtureLauncher("cloud")
    for (const server of [await serve(), await serve({ launcher, cloud: true })]) {
      expect((await capabilities(server)).filter(capability => capability.startsWith("launch."))).toEqual([])
      expect((await post(server, { agent: "codex", prompt: "hi" })).status).toBe(404)
    }
  })
})
