import { EventEmitter } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  MythicalItemSchema,
  MythicalItemStateSchema,
  mythicalMachine,
  mythicalReceiptDuration
} from "../../rpc/src/Mythical.ts"
import { issueGroupOf } from "../../rpc/src/StackIssues.ts"
import { itemStateLabel, settled } from "../../rpc/src/StackView.ts"
import { main } from "../src/cli/Entry.ts"
import {
  checkDuration,
  groupOf,
  itemLine,
  machineLine,
  outOfLanes,
  receiptLine,
  render,
  stateLabel
} from "../src/internal/backend/History.ts"

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

  it("says a later typed failure, not an earlier attempt's conflict", () => {
    const value = item("retrying", {
      integration: { conflict: { paths: ["a.ts"] } },
      reason: "The model provider did not answer",
      failure: { kind: "model", fault: "dependency" }
    }) as never
    expect(stateLabel(value)).toBe(itemStateLabel(value))
    expect(itemLine(value)).toBe("#12 Fix login · retrying · The model provider did not answer")
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
  it("lists each check receipt, failed ones marked, and nothing without receipts", () => {
    expect(receiptLine(item("blocked", {
      checks: {
        state: "failed",
        failed: ["affected-test"],
        receipts: [
          { check: "affected-lint", tier: "fast", status: "passed", commit: "abcdef0123" },
          { check: "affected-test\u001b[2J", tier: "slow", status: "failed", fault: "infra", commit: "abcdef0123" }
        ]
      }
    }))).toBe("✓ affected-lint abcdef0 · ✗ affected-test abcdef0")
    expect(receiptLine(item("running"))).toBe("")
  })
  it("appends each receipt's duration and names the run that recorded them once, as the TUI does", () => {
    const timed = item("proposed", {
      checks: {
        state: "passed",
        failed: [],
        receipts: [
          {
            check: "affected-lint",
            tier: "fast",
            status: "passed",
            commit: "abcdef0123",
            runId: "run-1",
            durationMs: 850
          },
          {
            check: "affected-test",
            tier: "slow",
            status: "passed",
            commit: "abcdef0123",
            runId: "run-1",
            durationMs: 64_000
          },
          { check: "affected-docs", tier: "fast", status: "passed", commit: "abcdef0123", runId: "run-2\u001b[2J" }
        ]
      }
    })
    expect(receiptLine(timed))
      .toBe(
        "✓ affected-lint abcdef0 0s · ✓ affected-test abcdef0 1m 04s · ✓ affected-docs abcdef0 · run run-1 · run run-2"
      )
    expect(render(stack([timed]), now)).toBe([
      "active · 1/2 lanes",
      "◆ Needs you 1",
      "  #12 Fix login · PR open · checks passed",
      "    ✓ affected-lint abcdef0 0s · ✓ affected-test abcdef0 1m 04s · ✓ affected-docs abcdef0 · run run-1 · run run-2"
    ].join("\n"))
  })
  it("words a check's duration as @smthrs/rpc does", () => {
    for (const ms of [-5, 0, 999, 1_000, 59_999, 60_000, 64_000, 3_599_999, 3_600_000, 3_660_000, 7_500_000]) {
      const receipt = { check: "c", tier: "fast", status: "passed", commit: "c", durationMs: Math.max(0, ms) } as const
      expect(checkDuration(ms)).toBe(mythicalReceiptDuration(receipt))
    }
  })
  it("shows the machine an issue's lane runs on under it, as the app and TUI do", () => {
    const placed = item("running", {
      lane: 0,
      placement: {
        declared: { environment: ".smithers/environment.nix", tools: ["go"] },
        kind: "vm",
        vcpus: 2,
        memoryMiB: 4096,
        imageId: "img-1",
        image: "registry/env:abc"
      }
    })
    const container = item("running", { placement: { declared: {}, kind: "container", vcpus: 2, memoryMiB: 4096 } })
    const refused = item("blocked", {
      placement: { declared: { vcpus: 8 }, refusal: "machine_too_small", reason: "too big" }
    })
    for (const value of [placed, container, refused, item("running")]) {
      expect(machineLine(value)).toBe(mythicalMachine(MythicalItemSchema.parse(value).placement) ?? "")
    }
    expect(machineLine(placed)).toBe("vm · registry/env:abc")
    expect(machineLine(item("running", { placement: { declared: {}, kind: "vm", image: "reg/env:x\u001b[2J" } })))
      .toBe("vm · reg/env:x")
    expect(render(stack([placed, refused]), now)).toBe([
      "active · 1/2 lanes",
      "◆ Needs you 1",
      "  #12 Fix login · blocked",
      "◐ Working 1",
      "  #12 Fix login · implementing",
      "    vm · registry/env:abc"
    ].join("\n"))
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

/** Answers the item route as the backend does (by id or issue number, else 404), and the snapshot from the same rows. */
const items = (req: IncomingMessage, res: ServerResponse, rows: Array<ReturnType<typeof item>>): boolean => {
  if (req.method === "GET" && req.url === "/api/repos/owner/repo/mythical") {
    json(res, stack(rows))
    return true
  }
  const match = /^\/api\/repos\/owner\/repo\/mythical\/items\/([^/]+)$/.exec(req.url ?? "")
  if (req.method !== "GET" || match === null) return false
  const found = rows.find((row) => row.id === match[1] || String(row.issue?.number) === match[1])
  if (found === undefined) json(res, { message: "item not found" }, 404)
  else json(res, found)
  return true
}

describe("the factory from the terminal, over a local HTTP server", () => {
  it("files an issue, then watches the factory take it to an open pull request with its check receipt", async () => {
    const moves: Array<Array<ReturnType<typeof item>>> = [
      [],
      [item("running", { lane: 0 })],
      [item("verifying", { lane: 0, checks: { state: "pending", failed: [] } })],
      [item("proposed", {
        checks: {
          state: "passed",
          failed: [],
          receipts: [
            {
              check: "affected-lint",
              tier: "fast",
              status: "passed",
              commit: "1a2b3c4d5e".padEnd(40, "0"),
              runId: "run-verify-1",
              durationMs: 42_000
            },
            { check: "affected-test", tier: "slow", status: "passed", commit: "1a2b3c4d5e".padEnd(40, "0") }
          ]
        },
        runs: { verify: "run-verify-1" },
        pullRequest: { number: 5, url: "https://github.com/owner/repo/pull/5", state: "open" }
      })]
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
      const rows = moves[Math.min(read, moves.length - 1)]!
      // The snapshot a 404 is checked against is the one the item read just saw.
      if (req.url === "/api/repos/owner/repo/mythical") return json(res, stack(moves[Math.max(read - 1, 0)]!))
      if (items(req, res, rows)) {
        read++
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
        "#12 Fix login · PR open · checks passed · https://github.com/owner/repo/pull/5",
        "  ✓ affected-lint 1a2b3c4 42s · ✓ affected-test 1a2b3c4 · run run-verify-1"
      ])
      expect(watched.output).toContain("#12 Fix login · PR open · checks passed")
      expect(f.requests.filter((r) => r.url === "/api/repos/owner/repo/mythical/items/12")).toHaveLength(4)
      expect(JSON.parse(f.requests[0]!.body)).toMatchObject({ title: "Fix login" })
    } finally {
      await f.close()
    }
  })

  it("exits non-zero when the watched issue stops, and keeps reading when the hint stream is unavailable", async () => {
    const f = await serve((req, res) => {
      if (req.url?.endsWith("/mythical/events")) return json(res, { message: "event streaming is not configured" }, 500)
      items(req, res, [
        item("blocked", { reason: "out of attempts", checks: { state: "failed", failed: ["ci/test"] } })
      ])
    })
    try {
      const watched = await f.run(["history", "watch", "#12"])
      expect(watched.code).toBe(1)
      expect(watched.error).toContain("#12 Fix login · blocked · checks failed: ci/test · out of attempts")
    } finally {
      await f.close()
    }
  })

  it("fails instead of waiting when the repository is not there", async () => {
    const f = await serve((_req, res) => json(res, { message: "repository not found" }, 404))
    try {
      const started = Date.now()
      for (const args of [["history", "watch", "12"], ["history", "retry", "12"]]) {
        const result = await f.run(args)
        expect(result.code, args.join(" ")).not.toBe(0)
        expect(result.output + result.error).toContain("repository not found")
        expect(result.output + result.error).not.toContain("not in the history")
      }
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      await f.close()
    }
  })

  it("reads the item from the snapshot on a server without the item route", async () => {
    const f = await serve((req, res) => {
      if (req.url === "/api/repos/owner/repo/mythical") return json(res, stack([item("landed")]))
      json(res, { message: "not found" }, 404)
    })
    try {
      const watched = await f.run(["history", "watch", "12"])
      expect(watched.code, watched.error).toBe(0)
      expect(watched.error).toContain("#12 Fix login · landed")
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
      items(req, res, [item("running", { lane: 0 })])
    })
    try {
      const watched = await f.run(
        ["history", "watch", ID],
        (signals) => setTimeout(() => signals.emit("SIGINT", "SIGINT"), 300)
      )
      expect(watched.code).not.toBe(0)
      expect(watched.error).toContain("#12 Fix login · implementing")
      expect(f.requests.filter((r) => r.url === `/api/repos/owner/repo/mythical/items/${ID}`).length)
        .toBeLessThanOrEqual(2)
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
      items(req, res, [item("blocked")])
    })
    try {
      const byIssue = await f.run(["history", "retry", "#12"])
      expect(byIssue.code, byIssue.error).toBe(0)
      expect(byIssue.output).toContain("#12 Fix login · queued")
      const byId = await f.run(["history", "retry", ID.toUpperCase()])
      expect(byId.code, byId.error).toBe(0)
      expect(f.requests.map((r) => `${r.method} ${r.url} ${r.body}`)).toEqual([
        "GET /api/repos/owner/repo/mythical/items/12 ",
        `POST /api/repos/owner/repo/mythical/items/${ID}/retry {}`,
        `POST /api/repos/owner/repo/mythical/items/${ID}/retry {}`
      ])
    } finally {
      await f.close()
    }
  })

  it("shows a failed TODO's typed reason as the server states it, and retries it", async () => {
    const failure = { kind: "provisioning", fault: "infra" }
    const reason = "Smithers could not set up a lane after repeated tries"
    const blocked = item("blocked", { reason, failure })
    const model = item("retrying", {
      id: "22222222-2222-4222-8222-222222222222",
      issue: { number: 13, title: "Flaky model", url: "https://x.test/13" },
      reason: "The model provider did not answer",
      failure: { kind: "model", fault: "dependency" }
    })
    const f = await serve((req, res) => {
      if (req.method === "POST") return json(res, item("queued"), 202)
      items(req, res, [blocked, model])
    })
    try {
      const shown = await f.run(["history", "show"])
      expect(shown.code, shown.error).toBe(0)
      expect(shown.output).toContain("#12 Fix login · blocked · Smithers could not set up a lane after repeated tries")
      expect(shown.output).toContain("#13 Flaky model · retrying · The model provider did not answer")
      const raw = await f.run(["history", "show", "--json"])
      expect(JSON.parse(raw.output).items[0]).toMatchObject({ reason, failure })
      const retried = await f.run(["history", "retry", "12"])
      expect(retried.code, retried.error).toBe(0)
      expect(retried.output).toContain("#12 Fix login · queued")
      expect(f.requests.filter((r) => r.method === "POST").map((r) => r.url)).toEqual([
        `/api/repos/owner/repo/mythical/items/${ID}/retry`
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
      if (req.url?.endsWith("/items/13")) return json(res, { message: "internal" }, 500)
      items(req, res, [item("running")])
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
      const failed = await f.run(["history", "retry", "13"])
      expect(failed.code).not.toBe(0)
      expect(failed.output + failed.error).not.toContain("is not in the history")
      expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1)
    } finally {
      await f.close()
    }
  })

  it("files a TODO under a request id, and resends the given id so a retry files it once", async () => {
    const f = await serve((req, res) => {
      if (req.method === "POST" && req.url === "/api/repos/owner/repo/mythical/todos") {
        return json(
          res,
          item("queued", { issue: { number: 40, title: "Add dark mode", url: "https://x.test/40" } }),
          201
        )
      }
      json(res, { message: "only a maintainer the factory's policy names files a TODO" }, 403)
    })
    try {
      const filed = await f.run(["history", "todo", "Add dark mode", "--body", "Follow the system theme"])
      expect(filed.code, filed.error).toBe(0)
      expect(filed.output).toContain("#40 Add dark mode · queued")
      expect((await f.run(["history", "todo", "Add dark mode", "--request", "abc-1"])).code).toBe(0)
      expect((await f.run(["history", "todo", "Add dark mode", "--request", "abc-1"])).code).toBe(0)
      expect((await f.run(["history", "todo", "  "])).code).toBe(2)
      expect((await f.run(["history", "todo", "x", "--request", "bad id!"])).code).toBe(2)
      const sent = f.requests.map((r) => JSON.parse(r.body ?? "{}") as { title: string; body: string; request: string })
      expect(f.requests.every((r) => r.method === "POST" && r.url === "/api/repos/owner/repo/mythical/todos")).toBe(
        true
      )
      expect(sent).toHaveLength(3)
      expect(sent[0]).toMatchObject({ title: "Add dark mode", body: "Follow the system theme" })
      expect(sent[0]!.request).toMatch(/^[0-9a-f-]{36}$/)
      expect(sent[1]!.request).toBe("abc-1")
      expect(sent[2]!.request).toBe("abc-1")
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

describe("backend text in structured formats (#3052)", () => {
  const title = "\u001b]0;pwned\u0007Fix\u001b[31m login\u009b2J"
  it.each(["md", "yaml", "toon"])("strips terminal controls from backend strings under --format %s", async (format) => {
    const f = await serve((req, res) => {
      if (req.url?.startsWith("/api/repos/owner/repo/issues/")) {
        return json(res, { number: 12, title, body: "line one\nline two" })
      }
      json(res, stack([item("blocked", { issue: { number: 12, title, url: "https://x.test/12" } })]))
    })
    try {
      for (const args of [["issue", "view", "12"], ["history", "show"]]) {
        const result = await f.run([...args, "--format", format])
        expect(result.code, result.error).toBe(0)
        if (args[0] === "issue") expect(result.output).toContain("Fix login")
        expect(result.output).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
      }
    } finally {
      await f.close()
    }
  })
  it("keeps the server's exact text under --json, where control characters are escaped", async () => {
    const f = await serve((_req, res) => json(res, { number: 12, title }))
    try {
      const result = await f.run(["issue", "view", "12", "--json"])
      expect(JSON.parse(result.output).title).toBe(title)
      expect(result.output).not.toContain("\u001b")
    } finally {
      await f.close()
    }
  })
})
