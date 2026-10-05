/** Filing a factory TODO through the production entry and actual HTTP/session boundaries. */
import { expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
const item = (id: string, number: number, state: string) => ({
  id,
  state,
  attempt: 1,
  runs: {},
  dependsOn: [],
  updatedAt: "2026-09-30T20:00:00Z",
  issue: { number, title: `Issue ${number}`, url: `https://github.com/o/r/issues/${number}` }
})

it("TODO failures use safe status copy and retain diagnostics and request identity through real HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-factory-todo-"))
  const sessions = join(root, "sessions")
  const replay = join(root, "pong.jsonl")
  writeFileSync(replay, readFileSync(join(app, "test", "fixtures", "pong.jsonl"), "utf8"))
  let status = 403
  const requests: Array<{ request: string; title: string }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/api/repos/o/r/mythical/todos") {
        return new Response("{}", { status: 404 })
      }
      requests.push(await request.json() as { request: string; title: string })
      return status === 200
        ? Response.json(item("todo-40", 40, "queued"))
        : new Response("private backend diagnostic", { status })
    }
  })
  let tui: Tui | undefined
  try {
    tui = await Tui.start({
      cwd: root,
      cols: 130,
      rows: 35,
      command: `bun ${join(app, "src", "main.tsx")} ${root}`,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        PATH: process.env.PATH ?? "",
        SMITHERS_TUI_SESSION_DIR: sessions,
        SMITHERS_TUI_REPLAY: replay,
        SMITHERS_API_ORIGIN: `http://127.0.0.1:${server.port}`,
        SMITHERS_TOKEN: "tok_factory_todo_fixture",
        SMITHERS_REPO: "o/r"
      }
    })
    await tui.until((screen) => /↑\S+ ↓\S+/.test(screen), 25_000, "production first draw")
    const send = async () => {
      await tui!.type("/todo Same TODO")
      await tui!.press(key.enter)
    }
    await send()
    await tui.until(
      (screen) => screen.includes("TODO not filed: That command could not run."),
      10_000,
      "final TODO refusal"
    )
    expect(tui.screen()).not.toContain("again retries it")
    expect(readFileSync(join(sessions, "tui.log"), "utf8")).toContain("HTTP 403")
    await tui.resize(40, 12)
    for (status of [408, 409, 429, 503]) {
      await send()
      await tui.until(
        (screen) =>
          screen.replace(/[┃\s]/g, "").includes("/todoagainretriesit") &&
          readFileSync(join(sessions, "tui.log"), "utf8").includes(`HTTP ${status}`),
        10_000,
        `uncertain TODO HTTP ${status}`
      )
      expect(tui.screen().replace(/[┃\s]/g, "")).toContain("Details:/conversation")
      expect(tui.screen()).toContain("Ask Smithers")
      expect(tui.screen()).toMatch(/↑\S+ ↓\S+/)
      for (const raw of [`HTTP ${status}`, "HTTP 403", "/api/repos/", "private backend diagnostic"]) {
        expect(tui.screen()).not.toContain(raw)
      }
    }
    status = 200
    await send()
    await tui.until((screen) => screen.includes("TODO #40 queued"), 10_000, "TODO recovery")
    expect(requests).toHaveLength(6)
    expect(requests[0]!.request).not.toBe(requests[1]!.request)
    expect(requests.slice(1).map((request) => request.request)).toEqual(Array(5).fill(requests[1]!.request))
    expect(requests.map((request) => request.title)).toEqual(Array(6).fill("Same TODO"))
  } finally {
    await tui?.stop()
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
