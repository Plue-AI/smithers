import { EventEmitter } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { MythicalItemStateSchema } from "../../rpc/src/Mythical.ts"
import { issueGroupOf } from "../../rpc/src/StackIssues.ts"
import { itemStateLabel, settled } from "../../rpc/src/StackView.ts"
import { main } from "../src/cli/Entry.ts"
import { groupOf, itemLine, outOfLanes, render, stateLabel } from "../src/internal/backend/History.ts"

const dirs: Array<string> = []
afterEach(async () => {
  for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true })
})

const ID = "0b8e5c3e-8a55-4d4e-9d7f-2f3c6c1f5a10"
const now = Date.parse("2026-09-29T12:00:00Z")
const item = (state: string, extra: Record<string, unknown> = {}) => ({
  id: ID,
  issue: { number: 12, title: "Fix login", url: "https://github.com/owner/repo/issues/12" },
  state,
  attempt: 1,
  runs: {},
  dependsOn: [],
  updatedAt: "2026-09-29T11:00:00Z",
  ...extra
})
const stack = (items: Array<unknown>, extra: Record<string, unknown> = {}) => ({
  repository: "owner/repo",
  state: "active",
  generation: 3,
  mainBehind: false,
  changes: [],
  items,
  lanes: [{ index: 0, state: "busy", itemId: ID }, { index: 1, state: "idle" }],
  limits: { maxParallel: 2 },
  ...extra
})

describe("history words match the app's History card", () => {
  const states = [...MythicalItemStateSchema.options[0].options, "something-new"]
  it.each(states)("labels, groups and settles %s as @smthrs/rpc does", (state) => {
    // The app reads the parsed state (an unknown one is "unknown"); the CLI reads the wire's.
    const wire = item(state) as never, parsed = item(MythicalItemStateSchema.parse(state)) as never
    expect(stateLabel(wire)).toBe(state === "something-new" ? state : itemStateLabel(parsed))
    expect(groupOf(wire)).toBe(issueGroupOf(parsed))
    expect(outOfLanes(wire)).toBe(settled(parsed))
  })
  it("names a conflict while retrying one", () => {
    const value = item("retrying", { integration: { conflict: { paths: ["a.ts", "b.ts"] } } }) as never
    expect(stateLabel(value)).toBe(itemStateLabel(value))
    expect(itemLine(value)).toBe("#12 Fix login · conflict · a.ts, b.ts")
  })
})

describe("history rendering", () => {
  it("prints an issue's state, check receipt, reason and pull request on one line", () => {
    expect(itemLine(item("proposed", {
      checks: { state: "passed", failed: [] },
      pullRequest: { number: 5, url: "https://github.com/owner/repo/pull/5", state: "open" }
    }))).toBe("#12 Fix login · PR open · checks passed · https://github.com/owner/repo/pull/5")
    expect(
      itemLine(item("blocked", { checks: { state: "failed", failed: ["ci/test", "lint"] }, reason: "out of attempts" }))
    )
      .toBe("#12 Fix login · blocked · checks failed: ci/test, lint · out of attempts")
  })
  it("names a chat item by its stack change, else its id", () => {
    const chat = { ...item("running"), issue: undefined }
    expect(itemLine(chat, [{ itemId: ID, title: "Add dark mode" }])).toBe("Add dark mode · implementing")
    expect(itemLine(chat)).toBe("0b8e5c3e · implementing")
  })
  it("strips terminal control sequences from untrusted issue text", () => {
    const hostile = item("queued", {
      issue: { number: 7, title: "\u001b]0;pwned\u0007Title\u001b[31m", url: "https://x.test/7" }
    })
    expect(itemLine(hostile)).toBe("#7 Title · queued")
  })
  it("groups Needs you oldest first, Working by lane then queue, and Done from the last day", () => {
    const text = render(
      stack([
        item("queued", { id: "q", issue: { number: 1, title: "Queued", url: "https://x.test/1" } }),
        item("running", { id: "r1", lane: 1, issue: { number: 2, title: "Lane one", url: "https://x.test/2" } }),
        item("verifying", { id: "r0", lane: 0, issue: { number: 3, title: "Lane zero", url: "https://x.test/3" } }),
        item("blocked", {
          id: "b",
          updatedAt: "2026-09-29T10:00:00Z",
          issue: { number: 4, title: "Old block", url: "https://x.test/4" }
        }),
        item("proposed", { id: "p", issue: { number: 5, title: "Open PR", url: "https://x.test/5" } }),
        item("landed", { id: "l", issue: { number: 6, title: "Landed today", url: "https://x.test/6" } }),
        item("landed", {
          id: "old",
          updatedAt: "2026-09-20T00:00:00Z",
          issue: { number: 8, title: "Landed last week", url: "https://x.test/8" }
        }),
        item("skipped", { id: "s", issue: { number: 9, title: "Skipped", url: "https://x.test/9" } })
      ], { mainBehind: true }),
      now
    )
    expect(text).toBe([
      "active · 1/2 lanes · main behind",
      "◆ Needs you 2",
      "  #4 Old block · blocked",
      "  #5 Open PR · PR open",
      "◐ Working 3",
      "  #3 Lane zero · checking",
      "  #2 Lane one · implementing",
      "  #1 Queued · queued",
      "● Done 1",
      "  #6 Landed today · landed"
    ].join("\n"))
  })
  it("orders Done newest first, keeps an unreadable stamp, and lists laneless work after lanes", () => {
    const text = render(
      stack([
        item("queued", { id: "q2", issue: { number: 1, title: "Queued", url: "https://x.test/1" } }),
        item("retrying", { id: "r", issue: { number: 2, title: "Laneless", url: "https://x.test/2" } }),
        item("running", { id: "l", lane: 0, issue: { number: 3, title: "Lane", url: "https://x.test/3" } }),
        item("landed", {
          id: "a",
          updatedAt: "2026-09-29T08:00:00Z",
          issue: { number: 4, title: "Earlier", url: "https://x.test/4" }
        }),
        item("declined", { id: "b", updatedAt: "", issue: { number: 5, title: "No stamp", url: "https://x.test/5" } }),
        item("cancelled", { id: "c", issue: { number: 6, title: "Later", url: "https://x.test/6" } })
      ], { lanes: [], limits: { maxParallel: 1 } }),
      now
    )
    expect(text).toBe([
      "active · 0/1 lanes",
      "◐ Working 3",
      "  #3 Lane · implementing",
      "  #2 Laneless · retrying",
      "  #1 Queued · queued",
      "● Done 3",
      "  #6 Later · cancelled",
      "  #4 Earlier · landed",
      "  #5 No stamp · declined"
    ].join("\n"))
  })
  it("prints only the head of an empty or frozen history", () => {
    expect(render(stack([], { state: "frozen", reason: "main moved outside the stack" }), now))
      .toBe("frozen · main moved outside the stack · 1/2 lanes")
  })
})

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void
const serve = async (handler: Handler) => {
  const home = await mkdtemp(join(tmpdir(), "smithers-history-"))
  dirs.push(home)
  const requests: Array<{ method: string; url: string; body: string }> = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => body += chunk)
    req.on("end", () => {
      requests.push({ method: req.method!, url: req.url!, body })
      handler(req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a local HTTP port")
  const origin = `http://127.0.0.1:${address.port}`
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    SMITHERS_API_ORIGIN: origin,
    SMITHERS_AUTH_FILE: join(home, "auth.json"),
    SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
    SMITHERS_AUDIENCE: "human"
  }
  await writeFile(
    env.SMITHERS_AUTH_FILE,
    JSON.stringify({ api_url: origin, host: "127.0.0.1", token: "history-secret" }),
    {
      mode: 0o600
    }
  )
  return {
    requests,
    close: () => {
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
    run: async (args: Array<string>, started?: (signals: EventEmitter) => void) => {
      let output = "", error = "", code = 0
      const signals = new EventEmitter()
      started?.(signals)
      await main({
        argv: [...args, "--repo", "owner/repo", "--audience", "human"],
        env: { ...env },
        stdout: { isTTY: true, columns: 100, write: (text) => void (output += text) },
        stderr: { isTTY: false, columns: 100, write: (text) => void (error += text) },
        on: (signal, listener) => void signals.on(signal, listener),
        removeListener: (signal, listener) => void signals.removeListener(signal, listener),
        setExitCode: (value) => {
          code = value
        }
      })
      expect(output + error).not.toContain("history-secret")
      return { output, error, code }
    }
  }
}
const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(value))
}

describe("the factory from the terminal, over a local HTTP server", () => {
  it("files an issue, then watches the factory take it to an open pull request with its check receipt", async () => {
    const snapshots = [
      stack([]),
      stack([item("running", { lane: 0 })]),
      stack([item("verifying", { lane: 0, checks: { state: "pending", failed: [] } })]),
      stack([item("proposed", {
        checks: { state: "passed", failed: [] },
        runs: { verify: "run-verify-1" },
        pullRequest: { number: 5, url: "https://github.com/owner/repo/pull/5", state: "open" }
      })])
    ]
    let read = 0
    let events: ServerResponse | undefined
    const f = await serve((req, res) => {
      if (req.method === "POST" && req.url === "/api/repos/owner/repo/issues") return json(res, { number: 12 }, 201)
      if (req.url === "/api/repos/owner/repo/mythical/events") {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(": connected\n\n")
        events = res
        return
      }
      if (req.url === "/api/repos/owner/repo/mythical") {
        json(res, snapshots[Math.min(read++, snapshots.length - 1)])
        // Each read is followed by the stack's next move and its hint.
        // Two hints in one write: the second waits as pending for the next wait.
        const hint = `event: mythical\ndata: {"generation":${read},"kind":"item"}\n\n`
        setTimeout(() => events?.write(hint + hint), 20)
        return
      }
      json(res, { message: "unexpected" }, 404)
    })
    try {
      const created = await f.run(["issue", "create", "Fix login"])
      expect(created.code, created.error).toBe(0)
      const started = Date.now()
      const watched = await f.run(["history", "watch", "12"])
      expect(watched.code, watched.output + watched.error).toBe(0)
      // Hints, not the 10 s poll, drove every read.
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(watched.error.trim().split("\n")).toEqual([
        "#12 · not in the history yet",
        "#12 Fix login · implementing",
        "#12 Fix login · checking · checks pending",
        "#12 Fix login · PR open · checks passed · https://github.com/owner/repo/pull/5"
      ])
      expect(watched.output).toContain("#12 Fix login · PR open · checks passed")
      expect(f.requests.filter((r) => r.url === "/api/repos/owner/repo/mythical")).toHaveLength(4)
      expect(JSON.parse(f.requests[0]!.body)).toMatchObject({ title: "Fix login" })
    } finally {
      await f.close()
    }
  })

  it("exits non-zero when the watched issue stops, and keeps reading when the hint stream is unavailable", async () => {
    const f = await serve((req, res) => {
      if (req.url?.endsWith("/mythical/events")) return json(res, { message: "event streaming is not configured" }, 500)
      json(
        res,
        stack([item("blocked", { reason: "out of attempts", checks: { state: "failed", failed: ["ci/test"] } })])
      )
    })
    try {
      const watched = await f.run(["history", "watch", "#12"])
      expect(watched.code).toBe(1)
      expect(watched.error).toContain("#12 Fix login · blocked · checks failed: ci/test · out of attempts")
    } finally {
      await f.close()
    }
  })

  it("stops watching on an interrupt", async () => {
    const f = await serve((req, res) => {
      if (req.url?.endsWith("/mythical/events")) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        return void res.write(": connected\n\n")
      }
      json(res, stack([item("running", { lane: 0 })]))
    })
    try {
      const watched = await f.run(
        ["history", "watch", ID],
        (signals) => setTimeout(() => signals.emit("SIGINT", "SIGINT"), 300)
      )
      expect(watched.code).not.toBe(0)
      expect(watched.error).toContain("#12 Fix login · implementing")
      expect(f.requests.filter((r) => r.url === "/api/repos/owner/repo/mythical").length).toBeLessThanOrEqual(2)
    } finally {
      await f.close()
    }
  })

  it("shows the history and keeps the server's snapshot under --json", async () => {
    const snapshot = stack([item("proposed", { pullRequest: { number: 5, url: "https://x.test/5", state: "open" } })])
    const f = await serve((_req, res) => json(res, snapshot))
    try {
      const shown = await f.run(["history", "show"])
      expect(shown.code, shown.error).toBe(0)
      expect(shown.output).toContain("active · 1/2 lanes\n◆ Needs you 1\n  #12 Fix login · PR open · https://x.test/5")
      const raw = await f.run(["history", "show", "--json"])
      expect(JSON.parse(raw.output)).toEqual(snapshot)
      expect(f.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "GET /api/repos/owner/repo/mythical",
        "GET /api/repos/owner/repo/mythical"
      ])
    } finally {
      await f.close()
    }
  })

  it("retries by issue number or item id through the retry route", async () => {
    const f = await serve((req, res) => {
      if (req.method === "POST") return json(res, item("queued"), 202)
      json(res, stack([item("blocked")]))
    })
    try {
      const byIssue = await f.run(["history", "retry", "#12"])
      expect(byIssue.code, byIssue.error).toBe(0)
      expect(byIssue.output).toContain("#12 Fix login · queued")
      const byId = await f.run(["history", "retry", ID.toUpperCase()])
      expect(byId.code, byId.error).toBe(0)
      expect(f.requests.map((r) => `${r.method} ${r.url} ${r.body}`)).toEqual([
        "GET /api/repos/owner/repo/mythical ",
        `POST /api/repos/owner/repo/mythical/items/${ID}/retry {}`,
        `POST /api/repos/owner/repo/mythical/items/${ID}/retry {}`
      ])
    } finally {
      await f.close()
    }
  })

  it("refuses an issue that is not in the history, a malformed target and the server's refusal", async () => {
    const f = await serve((req, res) => {
      if (req.method === "POST") {
        return json(res, {
          message: "only a blocked, rejected or declined item, or a TODO held on its review, is retried"
        }, 409)
      }
      json(res, stack([item("running")]))
    })
    try {
      const missing = await f.run(["history", "retry", "99"])
      expect(missing.code).not.toBe(0)
      expect(missing.output + missing.error).toContain("#99 is not in the history")
      for (const bad of ["0", "12a", "#", "1.5"]) {
        const refused = await f.run(["history", "retry", bad])
        expect(refused.code, bad).toBe(2)
      }
      const conflict = await f.run(["history", "retry", "12"])
      expect(conflict.code).not.toBe(0)
      expect(conflict.output + conflict.error).toContain("only a blocked, rejected or declined item")
      expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1)
    } finally {
      await f.close()
    }
  })

  it("admits open issues, creates the history, and sets the lane count", async () => {
    const f = await serve((_req, res) => json(res, stack([]), 202))
    try {
      for (const args of [["history", "backfill"], ["history", "bootstrap"], ["history", "parallel", "3"]]) {
        const result = await f.run(args)
        expect(result.code, result.error).toBe(0)
        expect(result.output).toContain("active · 1/2 lanes")
      }
      for (const lanes of ["0", "9", "2.5"]) expect((await f.run(["history", "parallel", lanes])).code).toBe(2)
      expect(f.requests.map((r) => `${r.method} ${r.url} ${r.body}`)).toEqual([
        "POST /api/repos/owner/repo/mythical/backfill {}",
        "POST /api/repos/owner/repo/mythical/bootstrap {}",
        `PUT /api/repos/owner/repo/mythical/config {"maxParallel":3}`
      ])
    } finally {
      await f.close()
    }
  })
})
