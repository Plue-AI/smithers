/** The advertised factory issue retry through the production entry and actual HTTP/session boundaries. */
import { expect, it } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
const notes = (
  directory: string
): Array<{ type: string; text?: string; outcome?: { _tag: string; answer?: string } }> => {
  let records: Array<{ type: string; text?: string; outcome?: { _tag: string; answer?: string } }> = []
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.name.endsWith(".jsonl")) {
        records = records.concat(readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)))
      }
    }
  }
  try {
    walk(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return records
}

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
    status = 503
    await send()
    await tui.until(
      (screen) => screen.replace(/[┃\s]/g, "").includes("/todoagainretriesit"),
      10_000,
      "uncertain TODO failure"
    )
    expect(tui.screen().replace(/[┃\s]/g, "")).toContain("Details:/conversation")
    expect(tui.screen()).toContain("Ask Smithers")
    expect(tui.screen()).toMatch(/↑\S+ ↓\S+/)
    expect(readFileSync(join(sessions, "tui.log"), "utf8")).toContain("HTTP 503")
    for (const raw of ["HTTP 403", "HTTP 503", "/api/repos/", "private backend diagnostic"]) {
      expect(tui.screen()).not.toContain(raw)
    }
    status = 200
    await send()
    await tui.until((screen) => screen.includes("TODO #40 queued"), 10_000, "TODO recovery")
    expect(requests).toHaveLength(3)
    expect(requests[0]!.request).not.toBe(requests[1]!.request)
    expect(requests[1]!.request).toBe(requests[2]!.request)
    expect(requests.map((request) => request.title)).toEqual(["Same TODO", "Same TODO", "Same TODO"])
  } finally {
    await tui?.stop()
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)

it("the Retry row action stays responsive through real Cloud responses", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-factory-retry-"))
  const sessions = join(root, "sessions")
  const replay = join(root, "pong.jsonl")
  writeFileSync(replay, readFileSync(join(app, "test", "fixtures", "pong.jsonl"), "utf8").repeat(6))
  let state = "blocked"
  let holdLookup = true
  let holdPost = true
  let refusePost = false
  let releaseLookup: (() => void) | undefined
  let releasePost: (() => void) | undefined
  const seen: Array<{ method: string; path: string; auth: string | null; body: unknown }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (
        path !== "/api/repos/o/r/mythical" && path !== "/api/repos/o/r/mythical/items/slot%3A2431/retry"
      ) return new Response("{}", { status: 404 })
      seen.push({
        method: request.method,
        path,
        auth: request.headers.get("authorization"),
        body: request.method === "POST" ? await request.json() : null
      })
      if (request.method === "GET") {
        // The first read displays the row; acting on it persists before the retry lookup.
        if (seen.length > 1) {
          expect(notes(sessions)).toContainEqual(
            expect.objectContaining({ type: "note", text: "Retry #2431 requested" })
          )
        }
        if (holdLookup && seen.length > 1) {
          await new Promise<void>((resolve) => {
            releaseLookup = resolve
          })
        }
        return Response.json({
          repository: "o/r",
          state: "active",
          generation: 1,
          mainBehind: false,
          changes: [],
          items: [item("slot:2431", 2431, state), item("running-item", 2412, "running")],
          lanes: [],
          limits: { maxParallel: 3 }
        })
      }
      if (holdPost) {
        await new Promise<void>((resolve) => {
          releasePost = resolve
        })
      }
      if (refusePost) return new Response("Forbidden", { status: 403 })
      state = "retrying"
      return Response.json(item("slot:2431", 2431, state))
    }
  })
  let tui: Tui | undefined
  const send = async (line: string) => {
    await tui!.type(line)
    await tui!.press(key.enter)
  }
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
        SMITHERS_TUI_REPLAY_SPEED: "100",
        SMITHERS_API_ORIGIN: `http://127.0.0.1:${server.port}`,
        SMITHERS_TOKEN: "tok_factory_retry_fixture",
        SMITHERS_REPO: "o/r"
      }
    })
    await tui.until((screen) => /↑\S+ ↓\S+/.test(screen), 25_000, "production first draw")
    await send("/smithers")
    await tui.until((screen) => screen.includes("#2431 Issue 2431 · blocked"), 10_000, "retryable factory row")
    await tui.press(key.down + key.down)
    await tui.until((screen) => screen.includes("a Retry"), 5_000, "selected row Retry action")
    expect(seen).toHaveLength(1)
    expect(notes(sessions).some((record) => record.type === "note" && record.text === "Retry #2431 requested"))
      .toBe(false)
    await tui.press("a")
    await tui.until(
      (screen) => screen.includes("Retry #2431 requested") && releaseLookup !== undefined,
      10_000,
      "lookup pending acknowledgement"
    )
    expect(seen).toHaveLength(2)
    await tui.press("a")
    await tui.until(
      () => notes(sessions).filter((record) => record.text === "Retry #2431 requested").length === 1,
      5_000,
      "duplicate row action"
    )
    expect(seen).toHaveLength(2)
    expect(notes(sessions).some((record) => record.type === "user" || record.type === "outcome")).toBe(false)
    await tui.press(key.escape)
    await tui.until((screen) => !screen.includes("esc Chat"), 5_000, "chat focus while retry lookup waits")
    await send("Chat while lookup waits")
    await tui.until(
      (screen) => screen.includes("pong") && !screen.includes("esc Interrupt"),
      15_000,
      "usable Chat during lookup"
    )
    await send("/retry #2431")
    await send("/conversation") // A local barrier; the repeated request must not start a second lookup.
    await tui.until((screen) => screen.includes("exchanges"), 5_000, "duplicate input processed")
    expect(seen).toHaveLength(2)
    holdLookup = false
    releaseLookup!()
    await tui.until(() => releasePost !== undefined, 10_000, "POST pending")
    expect(seen[2]).toEqual({
      method: "POST",
      path: "/api/repos/o/r/mythical/items/slot%3A2431/retry",
      auth: "token tok_factory_retry_fixture",
      body: {}
    })
    expect(notes(sessions).filter((record) => record.type === "note" && record.text === "Retry #2431 requested"))
      .toHaveLength(1)
    expect(notes(sessions).some((record) => record.text === "#2431 retrying")).toBe(false)
    await send("Chat while retry waits")
    await tui.until(
      (screen) =>
        screen.includes("Chat while retry waits") && !screen.includes("esc Interrupt") &&
        notes(sessions).filter((record) => record.type === "outcome" && record.outcome?.answer === "pong").length ===
          2,
      15_000,
      "usable Chat during POST"
    )
    expect(notes(sessions).filter((record) => record.type === "user").map((record) => record.text)).toContain(
      "Chat while retry waits"
    )
    holdPost = false
    releasePost!()
    await tui.until((screen) => screen.includes("#2431 retrying"), 10_000, "actual retry response")
    expect(notes(sessions)).toContainEqual(expect.objectContaining({ type: "note", text: "#2431 retrying" }))
    await send("/smithers")
    await tui.until((screen) => screen.includes("#2431 Issue 2431 · retrying"), 10_000, "factory readback")
    await tui.press(key.escape)
    await tui.until((screen) => !screen.includes("esc Chat"), 5_000, "composer focus after factory readback")
    const posts = () => seen.filter((request) => request.method === "POST")
    await send("/retry #abc")
    await tui.until((screen) => screen.includes("Usage: /retry <issue>"), 5_000, "invalid issue refusal")
    await send("/retry #2412")
    await tui.until(
      (screen) => screen.includes("#2412 not retried: #2412 is implementing"),
      10_000,
      "nonretryable issue refusal"
    )
    await send("/retry #9")
    await tui.until(
      (screen) => screen.includes("#9 not retried: #9 is not in the factory"),
      10_000,
      "unknown issue refusal"
    )
    expect(posts()).toHaveLength(1)
    await send("/retry unknown-worker")
    await tui.until(
      (screen) => screen.includes("Unknown command /retry") && screen.includes("/retry unknown-worker"),
      5_000,
      "removed worker retry stays removed"
    )
    await tui.press("\x15")
    state = "blocked"
    refusePost = true
    await send("/retry #2431")
    await tui.until(
      (screen) => screen.includes("#2431 not retried: That command could not run."),
      10_000,
      "permission refusal"
    )
    expect(posts()).toHaveLength(2)
    const log = readFileSync(join(sessions, "tui.log"), "utf8")
    expect(log).toContain("HTTP 403")
    expect(tui.screen()).not.toContain("HTTP 403")
    expect(tui.screen()).not.toContain("/api/repos/o/r/mythical/items/")
    refusePost = false
    await send("/retry #2431")
    await tui.until(
      () => posts().length === 3 && notes(sessions).filter((record) => record.text === "#2431 retrying").length === 2,
      10_000,
      "retry after refusal"
    )
    expect(
      posts().every((request) =>
        request.path === "/api/repos/o/r/mythical/items/slot%3A2431/retry" &&
        request.auth === "token tok_factory_retry_fixture"
      )
    ).toBe(true)
    if (process.env.SMITHERS_TUI_FACTORY_RETRY_RECEIPT !== undefined) {
      writeFileSync(
        process.env.SMITHERS_TUI_FACTORY_RETRY_RECEIPT,
        JSON.stringify(
          {
            boundary: "production src/main.tsx in tmux; local controlled HTTP and replay model, no deployed credential",
            requests: seen.map((request) => ({
              ...request,
              auth: request.auth === null ? null : "fixture token present"
            })),
            sessionRecords: notes(sessions),
            diagnosticLog: readFileSync(join(sessions, "tui.log"), "utf8"),
            finalScreen: tui.screen()
          },
          null,
          2
        ) + "\n"
      )
    }
  } finally {
    releaseLookup?.()
    releasePost?.()
    await tui?.stop()
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

it(
  "a late retry result stays in the conversation that persisted the request and restores from its journal",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tui-factory-retry-session-"))
    const sessions = join(root, "sessions")
    let releasePost: (() => void) | undefined
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const path = new URL(request.url).pathname
        if (path === "/api/repos/o/r/mythical") {
          return Response.json({
            repository: "o/r",
            state: "active",
            generation: 1,
            mainBehind: false,
            changes: [],
            items: [item("slot:2431", 2431, "blocked")],
            lanes: [],
            limits: { maxParallel: 3 }
          })
        }
        if (path !== "/api/repos/o/r/mythical/items/slot%3A2431/retry") return new Response("{}", { status: 404 })
        await new Promise<void>((resolve) => {
          releasePost = resolve
        })
        return Response.json(item("slot:2431", 2431, "retrying"))
      }
    })
    let tui: Tui | undefined
    const send = async (line: string) => {
      await tui!.type(line)
      await tui!.press(key.enter)
    }
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
          SMITHERS_TUI_REPLAY: join(app, "test", "fixtures", "pong.jsonl"),
          SMITHERS_TUI_REPLAY_SPEED: "100",
          SMITHERS_API_ORIGIN: `http://127.0.0.1:${server.port}`,
          SMITHERS_TOKEN: "tok_factory_retry_fixture",
          SMITHERS_REPO: "o/r"
        }
      })
      await tui.until((screen) => /↑\S+ ↓\S+/.test(screen), 25_000, "production first draw")
      await send("/name factory retry receipt")
      await tui.until((screen) => screen.includes("factory retry receipt"), 5_000, "named original session")
      await send("/retry #2431")
      await tui.until(
        (screen) => screen.includes("Retry #2431 requested") && releasePost !== undefined,
        10_000,
        "POST pending"
      )
      await send("/new")
      await tui.until(
        (screen) => screen.includes("New conversation started") && !screen.includes("Retry #2431 requested"),
        5_000,
        "new session"
      )
      await send("new conversation remains usable")
      await tui.until(
        (screen) => screen.includes("pong") && !screen.includes("esc Interrupt"),
        15_000,
        "new conversation answered"
      )
      releasePost!()
      await tui.until(
        () => notes(sessions).some((record) => record.text === "#2431 retrying"),
        10_000,
        "old journal completion"
      )
      expect(tui.screen()).not.toContain("#2431 retrying")
      const folder = readdirSync(sessions, { withFileTypes: true }).find((entry) => entry.isDirectory())!
      const records = readdirSync(join(sessions, folder.name)).filter((name) => name.endsWith(".jsonl")).map((name) =>
        readFileSync(join(sessions, folder.name, name), "utf8").split("\n").filter(Boolean).map((line) =>
          JSON.parse(line)
        )
      )
      const original = records.find((rows) =>
        rows.some((row) => row.type === "name" && row.name === "factory retry receipt")
      )!
      const current = records.find((rows) =>
        rows.some((row) => row.type === "user" && row.text === "new conversation remains usable")
      )!
      expect(original).toContainEqual(expect.objectContaining({ type: "note", text: "Retry #2431 requested" }))
      expect(original).toContainEqual(expect.objectContaining({ type: "note", text: "#2431 retrying" }))
      expect(current.some((row) => row.type === "note" && /#2431/.test(row.text))).toBe(false)
      await send("/resume")
      await tui.until((screen) => screen.includes("factory retry receipt"), 5_000, "session picker")
      await tui.type("factory retry receipt")
      await tui.press(key.enter)
      await tui.until(
        (screen) => screen.includes("Retry #2431 requested") && screen.includes("#2431 retrying"),
        10_000,
        "journal restores requested and actual result"
      )
    } finally {
      releasePost?.()
      await tui?.stop()
      server.stop(true)
      rmSync(root, { recursive: true, force: true })
    }
  },
  90_000
)
