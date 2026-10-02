import { Cli } from "incur"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeCli } from "../src/Cli.ts"
import { browserLogin } from "../src/internal/backend/Auth.ts"
import { Client } from "../src/internal/backend/Client.ts"
import { commandPath, groups, handlers } from "../src/internal/backend/Commands.ts"
import { definitions } from "../src/internal/backend/Definitions.ts"
import { Session } from "../src/internal/backend/Session.ts"
import { makeConfig } from "../src/NodeControl.ts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})
const fixture = async (handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void) => {
  const home = await mkdtemp(join(tmpdir(), "one-cli-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const server = createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    res.setHeader("content-type", "application/json")
    handler(req, res, raw ? JSON.parse(raw) : undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address() as { port: number }
  const origin = `http://127.0.0.1:${address.port}`
  const environment = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    SMITHERS_API_ORIGIN: origin,
    SMITHERS_AUTH_FILE: join(home, "auth.json"),
    SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
  }
  await writeFile(
    environment.SMITHERS_AUTH_FILE,
    JSON.stringify({ api_url: origin, host: "127.0.0.1", token: "test-session-secret" }),
    { mode: 0o600 }
  )
  return {
    home,
    origin,
    environment,
    run: async (args: string[], env: Record<string, string> = environment) => {
      let output = "", code = 0
      const cli = makeCli({
        environment: env,
        exit: (value) => {
          code = value
        }
      })
      // Incur reads skill-sync metadata from process.env, not the CLI host's env.
      const previousDataHome = process.env.XDG_DATA_HOME
      process.env.XDG_DATA_HOME = env.XDG_DATA_HOME
      try {
        await cli.serve([...args, "--json"], {
          env,
          stdout: (text) => {
            output += text
          },
          exit: (value) => {
            code = value
          }
        })
      } finally {
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = previousDataHome
      }
      expect(output).not.toContain("test-session-secret")
      return { output, code }
    }
  }
}

describe("one npm CLI backend contracts", () => {
  it("follows Link cursor issue pages and exposes continuation for one page", async () => {
    const calls: string[] = []
    const issues = [1, 2, 3].map((number) => ({ number, title: `Issue ${number}` }))
    const f = await fixture((req, res) => {
      expect(req.headers.authorization).toBe("token test-session-secret")
      calls.push(req.url!)
      const url = new URL(req.url!, "http://localhost")
      const index = Number(url.searchParams.get("cursor") || "0")
      expect(url.pathname).toBe("/api/repos/owner/repo/issues")
      expect(url.searchParams.get("limit")).toBe("1")
      expect(url.searchParams.get("state")).toBe("open")
      res.setHeader(
        "Link",
        `</api/repos/owner/repo/issues?limit=1&state=open>; rel="first"${
          index < 2 ? `, </api/repos/owner/repo/issues?cursor=${index + 1}&limit=1&state=open>; rel="next"` : ""
        }`
      )
      res.end(JSON.stringify([issues[index]]))
    })
    const single = await f.run(["issue", "list", "--repo", "owner/repo", "--limit", "1"])
    expect(single.code, single.output).toBe(0)
    expect(JSON.parse(single.output)).toEqual({ issues: [issues[0]], next_cursor: "1" })
    expect(calls).toHaveLength(1)
    calls.length = 0
    const all = await f.run(["issue", "list", "--repo", "owner/repo", "--limit", "1", "--all"])
    expect(all.code, all.output).toBe(0)
    expect(JSON.parse(all.output)).toEqual(issues)
    expect(calls.map((url) => new URL(url, f.origin).searchParams.get("cursor"))).toEqual([null, "1", "2"])
  })
  it("unarchives through the backend route and prints the resulting receipt", async () => {
    let archived = true
    const f = await fixture((req, res) => {
      if (req.method === "POST" && req.url === "/api/repos/owner/repo/unarchive") {
        archived = false
        res.writeHead(204)
        res.end()
      } else if (req.method === "GET" && req.url === "/api/repos/owner/repo") {
        res.end(JSON.stringify({ archived }))
      } else {
        res.writeHead(404)
        res.end(JSON.stringify({ message: "route not found" }))
      }
    })
    const result = await f.run(["repo", "unarchive", "owner/repo"])
    expect(result.code, result.output).toBe(0)
    expect(JSON.parse(result.output)).toEqual({ status: "unarchived", repo: "owner/repo" })
    expect(JSON.parse((await f.run(["repo", "view", "owner/repo"])).output)).toEqual({ archived: false })
  })
  it.each([["--field", "Fields require an equals sign"], ["--header", "Headers require a colon"]])(
    "prints usable syntax guidance for malformed %s without sending a request",
    async (option, expected) => {
      let requests = 0
      const f = await fixture((_req, res) => {
        requests++
        res.end("{}")
      })
      const result = await f.run(["api", "/api/user", option, "synthetic-private-input"])
      expect(result.code).not.toBe(0)
      expect(result.output).toContain(expected)
      expect(result.output).not.toContain("[REDACTED]")
      expect(result.output).not.toContain("synthetic-private-input")
      expect(requests).toBe(0)
    }
  )
  it.each(["", "synthetic-config-token"])("prints boolean token override status for %j", async (token) => {
    const f = await fixture((_req, res) => res.end("{}"))
    const result = await f.run(["config", "show"], { ...f.environment, SMITHERS_TOKEN: token })
    expect(result.code, result.output).toBe(0)
    expect(JSON.parse(result.output).env_overrides.token_set).toBe(!!token)
    expect(result.output).not.toContain("synthetic-config-token")
    expect(result.output).not.toContain("[REDACTED]")
  })
  it("uses the saved login and follows cursor pagination for issues", async () => {
    const urls: string[] = []
    const f = await fixture((req, res) => {
      expect(req.headers.authorization).toBe("token test-session-secret")
      urls.push(req.url!)
      if (urls.length === 1) res.setHeader("X-Next-Cursor", "second")
      res.end(JSON.stringify([{ number: urls.length, title: "Issue" }]))
    })
    const result = await f.run(["issue", "list", "--repo", "owner/repo", "--all"])
    expect(result.code, result.output).toBe(0)
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain("/api/repos/owner/repo/issues?")
    expect(urls[1]).toContain("cursor=second")
    expect(result.output).toContain("\"number\": 2")
  })
  it("preserves labels and existing assignees when editing an issue", async () => {
    const calls: Array<[string, string, unknown]> = []
    const f = await fixture((req, res, body) => {
      calls.push([req.method!, req.url!, body])
      res.end(JSON.stringify({ number: 7, assignees: [{ login: "alice" }] }))
    })
    const result = await f.run([
      "issue",
      "edit",
      "7",
      "--repo",
      "owner/repo",
      "--label",
      "bug",
      "--assignee",
      "bob",
      "--body",
      ""
    ])
    expect(result.code, result.output).toBe(0)
    expect(calls).toEqual([
      ["POST", "/api/repos/owner/repo/issues/7/labels", { labels: ["bug"] }],
      ["GET", "/api/repos/owner/repo/issues/7", undefined],
      ["PATCH", "/api/repos/owner/repo/issues/7", { body: "", assignees: ["alice", "bob"] }]
    ])
  })
  it("keeps private wiki reads in the selected space", async () => {
    let url = ""
    const f = await fixture((req, res) => {
      url = req.url!
      res.end("[]")
    })
    const result = await f.run(["wiki", "list", "--repo", "owner/repo", "--visibility", "private", "--limit", "12"])
    expect(result.code, result.output).toBe(0)
    expect(new URL(url, f.origin).searchParams.get("visibility")).toBe("private")
    expect(new URL(url, f.origin).searchParams.get("per_page")).toBe("12")
  })
  it("rejects destructive input before any API request", async () => {
    let requests = 0
    const f = await fixture((_req, res) => {
      requests++
      res.end("{}")
    })
    const result = await f.run(["admin", "user", "delete", "alice"])
    expect(result.code).not.toBe(0)
    expect(requests).toBe(0)
  })
  it("binds an erase retry to the user id and rejects an invalid one", async () => {
    const bodies: unknown[] = []
    const f = await fixture((req, res, body) => {
      expect(req.method).toBe("POST")
      expect(req.url).toBe("/api/admin/users/alice/erase")
      bodies.push(body)
      res.end(JSON.stringify({ user_id: 7, already_erased: true }))
    })
    const erase = ["admin", "user", "erase", "alice", "--request-date", "2026-09-28", "--yes"]
    for (const extra of [[], ["--user-id", "7"]]) {
      const result = await f.run([...erase, ...extra])
      expect(result.code, result.output).toBe(0)
    }
    for (const bad of ["0", "-3", "seven"]) {
      const result = await f.run([...erase, "--user-id", bad])
      expect(result.code, bad).not.toBe(0)
    }
    expect(bodies).toEqual([{ request_date: "2026-09-28" }, { request_date: "2026-09-28", user_id: 7 }])
  })
  it("does not reuse another origin's saved login", async () => {
    let requests = 0
    const f = await fixture((_req, res) => {
      requests++
      res.end("{}")
    })
    await writeFile(
      f.environment.SMITHERS_AUTH_FILE,
      JSON.stringify({ api_url: "https://other.invalid", token: "test-session-secret" })
    )
    const result = await f.run(["issue", "list", "--repo", "owner/repo"])
    expect(result.code).not.toBe(0)
    expect(requests).toBe(0)
  })
})

describe("migrated command dispatch", () => {
  it("accounts for every Go command without replacing target cache operations", async () => {
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(definitions).sort())
    // Independent count rejects a command dropped from both handlers and definitions.
    // The original 211 commands include history land and workspace children
    // (b80b439db473); the reviewed forge-only removals below account for six.
    const retired = [
      "changeset create",
      "changeset get",
      "changeset land",
      "changeset list",
      "repo fork",
      "repo transfer"
    ]
    expect(Object.keys(definitions)).toHaveLength(211 - retired.length)
    for (const name of retired) {
      expect(Object.hasOwn(definitions, name)).toBe(false)
      expect(Object.hasOwn(handlers, name)).toBe(false)
    }
    expect(Object.keys(definitions).filter((name) => !handlers[name])).toEqual([])
    expect(commandPath("status")).toBe("change status")
    expect(commandPath("run view")).toBe("runs show")
    expect(commandPath("workflow run")).toBe("flow start")
    expect(commandPath("cache clear")).toBe("cache cloud clear")
    const f = await fixture((_req, res) => res.end("{}"))
    for (const command of [["cache", "clean"], ["cache", "cloud", "clear"], ["issue", "list"], ["workspace", "cp"]]) {
      const result = await f.run([...command, "--help"])
      expect(result.code, result.output).toBe(0)
    }
  })
  it.each([
    ["repo", "fork", "owner/repo", "--name", "fork"],
    ["repo", "transfer", "owner/repo", "--to", "other"],
    ["changeset", "create", "--title", "legacy", "--org", "owner"],
    ["changeset", "get", "1", "--org", "owner"],
    ["changeset", "land", "1", "--org", "owner"],
    ["changeset", "list", "--org", "owner"]
  ])("refuses retired %s %s without contacting the backend", async (...argv) => {
    const requests: string[] = []
    const f = await fixture((req, res) => {
      requests.push(req.url!)
      res.end("{}")
    })
    const result = await f.run(argv)
    expect(result.code).not.toBe(0)
    expect(requests).toEqual([])
  })

  it("summarizes every command and group instead of repeating its name", () => {
    const placeholders: string[] = [], summaries = new Map<string, string>()
    const visit = (commands: Map<string, any>, path: string[]) => {
      for (const [word, entry] of commands) {
        if ("_alias" in entry || "_fetch" in entry) continue
        const name = [...path, word].join(" "), description = String(entry.description ?? "").trim()
        // A generated placeholder repeats the command word or joins its path with "·".
        if (description === "" || description === word || description.includes("·")) placeholders.push(name)
        if ("_group" in entry) {
          summaries.set(name, description)
          visit(entry.commands, [...path, word])
        }
      }
    }
    visit(Cli.toCommands.get(makeCli({ environment: {} }) as never)!, [])
    expect(placeholders).toEqual([])
    // Every summary is used by a group the backend commands create.
    for (const [path, summary] of Object.entries(groups)) expect(summaries.get(path), path).toBe(summary)
  })
  it.each(
    [
      [["issue", "view", "4", "--repo", "owner/repo"], "GET", "/api/repos/owner/repo/issues/4", undefined],
      [["label", "list", "--repo", "owner/repo"], "GET", "/api/repos/owner/repo/labels", undefined],
      [["variable", "list", "--repo", "owner/repo"], "GET", "/api/repos/owner/repo/variables", undefined],
      [
        ["variable", "get", "REGION", "--repo", "owner/repo"],
        "GET",
        "/api/repos/owner/repo/variables/REGION",
        undefined
      ],
      [["secret", "list", "--repo", "owner/repo"], "GET", "/api/repos/owner/repo/secrets", undefined],
      [["runs", "list", "--repo", "owner/repo"], "GET", "/api/repos/owner/repo/runs", undefined],
      [["flow", "list", "--repo", "owner/repo"], "GET", "/api/repos/owner/repo/workflows", undefined],
      [["workspace", "list", "--repo", "owner/repo"], "GET", "/api/repos/owner/repo/workspaces", undefined],
      [
        ["land", "conflicts", "4", "--repo", "owner/repo"],
        "GET",
        "/api/repos/owner/repo/landings/4/conflicts",
        undefined
      ],
      [
        ["artifact", "list", "4", "--repo", "owner/repo"],
        "GET",
        "/api/repos/owner/repo/actions/runs/4/artifacts",
        undefined
      ],
      [["repo", "view", "--repo", "owner/repo"], "GET", "/api/repos/owner/repo", undefined],
      [["webhook", "list", "--repo", "owner/repo"], "GET", "/api/repos/owner/repo/hooks", undefined],
      [
        ["webhook", "deliveries", "4", "--repo", "owner/repo"],
        "GET",
        "/api/repos/owner/repo/hooks/4/deliveries",
        undefined
      ],
      [
        ["cache", "token", "list", "--repo", "owner/repo"],
        "GET",
        "/api/repos/owner/repo/build-cache/tokens",
        undefined
      ],
      [["issue", "close", "4", "--repo", "owner/repo"], "PATCH", "/api/repos/owner/repo/issues/4", {
        "state": "closed"
      }],
      [["issue", "reopen", "4", "--repo", "owner/repo"], "PATCH", "/api/repos/owner/repo/issues/4", {
        "state": "open"
      }],
      [["label", "delete", "4", "--repo", "owner/repo"], "DELETE", "/api/repos/owner/repo/labels/4", undefined],
      [["secret", "delete", "NAME", "--repo", "owner/repo"], "DELETE", "/api/repos/owner/repo/secrets/NAME", undefined],
      [
        ["variable", "delete", "NAME", "--repo", "owner/repo"],
        "DELETE",
        "/api/repos/owner/repo/variables/NAME",
        undefined
      ],
      [["wiki", "delete", "page", "--repo", "owner/repo"], "DELETE", "/api/repos/owner/repo/wiki/page", undefined],
      [["webhook", "delete", "4", "--repo", "owner/repo"], "DELETE", "/api/repos/owner/repo/hooks/4", undefined],
      [
        ["cache", "token", "revoke", "--id", "4", "--repo", "owner/repo"],
        "DELETE",
        "/api/repos/owner/repo/build-cache/tokens/4",
        undefined
      ],
      [
        ["wiki", "create", "--title", "Title", "--slug", "page", "--body", "Text", "--repo", "owner/repo"],
        "POST",
        "/api/repos/owner/repo/wiki",
        { "title": "Title", "slug": "page", "body": "Text" }
      ],
      [
        ["issue", "create", "--title", "Title", "--body", "Text", "--assignee", "alice", "--repo", "owner/repo"],
        "POST",
        "/api/repos/owner/repo/issues",
        { "title": "Title", "body": "Text", "assignees": ["alice"] }
      ],
      [
        ["issue", "comment", "4", "--body", "Text", "--repo", "owner/repo"],
        "POST",
        "/api/repos/owner/repo/issues/4/comments",
        { "body": "Text" }
      ],
      [
        ["land", "create", "--title", "Title", "--change-id", "abc", "--target", "main", "--repo", "owner/repo"],
        "POST",
        "/api/repos/owner/repo/landings",
        { "title": "Title", "body": "", "change_ids": ["abc"], "target_bookmark": "main" }
      ],
      [
        ["land", "edit", "4", "--title", "Title", "--target", "next", "--repo", "owner/repo"],
        "PATCH",
        "/api/repos/owner/repo/landings/4",
        { "title": "Title", "target_bookmark": "next" }
      ],
      [
        ["land", "comment", "4", "--body", "Text", "--commit", "abc", "--repo", "owner/repo"],
        "POST",
        "/api/repos/owner/repo/landings/4/comments",
        { "body": "Text", "commit_id": "abc" }
      ],
      [
        ["workspace", "fork", "w1", "--name", "fork", "--repo", "owner/repo"],
        "POST",
        "/api/repos/owner/repo/workspaces/w1/fork",
        { "name": "fork" }
      ],
      [
        ["cache", "token", "create", "--name", "dev", "--repo", "owner/repo"],
        "POST",
        "/api/repos/owner/repo/build-cache/tokens",
        { "name": "dev" }
      ],
      [["repo", "mirror-sync", "--repo", "owner/repo"], "POST", "/api/repos/owner/repo/mirror-sync", undefined],
      [["repo", "create", "demo", "--private", "--description", "Text"], "POST", "/api/user/repos", {
        "name": "demo",
        "private": true,
        "description": "Text"
      }],
      [["repo", "archive", "owner/repo"], "POST", "/api/repos/owner/repo/archive", undefined],
      [["repo", "unarchive", "owner/repo"], "POST", "/api/repos/owner/repo/unarchive", undefined],
      [["repo", "edit", "owner/repo", "--description", "Text"], "PATCH", "/api/repos/owner/repo", {
        "description": "Text"
      }],
      [["repo", "delete", "owner/repo", "--yes"], "DELETE", "/api/repos/owner/repo", undefined],
      [["org", "create", "example", "--description", "Text", "--visibility", "private"], "POST", "/api/orgs", {
        "username": "example",
        "description": "Text",
        "visibility": "private"
      }],
      [["org", "list"], "GET", "/api/user/orgs", undefined],
      [["org", "view", "example"], "GET", "/api/orgs/example", undefined],
      [["org", "member", "list", "example"], "GET", "/api/orgs/example/members", undefined],
      [["org", "team", "list", "example"], "GET", "/api/orgs/example/teams", undefined],
      [["org", "team", "view", "example", "dev"], "GET", "/api/orgs/example/teams/dev", undefined],
      [["org", "team", "member", "list", "example", "dev"], "GET", "/api/orgs/example/teams/dev/members", undefined],
      [["org", "team", "repo", "list", "example", "dev"], "GET", "/api/orgs/example/teams/dev/repos", undefined],
      [["ssh-key", "list"], "GET", "/api/user/keys", undefined],
      [["admin", "health"], "GET", "/api/admin/system/health", undefined],
      [["admin", "status"], "GET", "/api/admin/system/status", undefined],
      [["org", "edit", "example", "--description", "Text"], "PATCH", "/api/orgs/example", { "description": "Text" }],
      [["org", "member", "add", "example", "alice"], "POST", "/api/orgs/example/members", { "username": "alice" }],
      [["org", "member", "remove", "example", "alice"], "DELETE", "/api/orgs/example/members/alice", undefined],
      [["org", "team", "create", "example", "dev", "--permission", "write"], "POST", "/api/orgs/example/teams", {
        "name": "dev",
        "permission": "write",
        "description": ""
      }],
      [["org", "team", "edit", "example", "dev", "--description", "Text"], "PATCH", "/api/orgs/example/teams/dev", {
        "description": "Text"
      }],
      [["org", "team", "delete", "example", "dev"], "DELETE", "/api/orgs/example/teams/dev", undefined],
      [
        ["org", "team", "member", "add", "example", "dev", "alice"],
        "PUT",
        "/api/orgs/example/teams/dev/members/alice",
        undefined
      ],
      [
        ["org", "team", "member", "remove", "example", "dev", "alice"],
        "DELETE",
        "/api/orgs/example/teams/dev/members/alice",
        undefined
      ],
      [
        ["org", "team", "repo", "add", "example", "dev", "owner/repo"],
        "PUT",
        "/api/orgs/example/teams/dev/repos/owner/repo",
        undefined
      ],
      [
        ["org", "team", "repo", "remove", "example", "dev", "owner/repo"],
        "DELETE",
        "/api/orgs/example/teams/dev/repos/owner/repo",
        undefined
      ],
      [["ssh-key", "delete", "4"], "DELETE", "/api/user/keys/4", undefined],
      [["admin", "user", "create", "--username", "alice", "--email", "a@test.invalid"], "POST", "/api/admin/users", {
        "username": "alice",
        "email": "a@test.invalid"
      }],
      [["admin", "user", "disable", "alice"], "PATCH", "/api/admin/users/alice", { "suspended": true }],
      [["admin", "user", "enable", "alice"], "PATCH", "/api/admin/users/alice", { "suspended": false }],
      [["admin", "user", "delete", "alice", "--yes"], "DELETE", "/api/admin/users/alice", undefined],
      [["repo", "create", "demo", "--private"], "POST", "/api/user/repos", { name: "demo", private: true }],
      [
        ["wiki", "edit", "page", "--repo", "owner/repo", "--body", "text", "--expected-revision", "2"],
        "PATCH",
        "/api/repos/owner/repo/wiki/page",
        { body: "text", expected_revision: 2 }
      ],
      [
        ["label", "create", "bug", "--repo", "owner/repo", "--color", "ff0000"],
        "POST",
        "/api/repos/owner/repo/labels",
        { name: "bug", color: "ff0000", description: "" }
      ],
      [
        ["variable", "set", "REGION", "--repo", "owner/repo", "--body", "west"],
        "POST",
        "/api/repos/owner/repo/variables",
        { name: "REGION", value: "west" }
      ],
      [["runs", "show", "12", "--repo", "owner/repo"], "GET", "/api/repos/owner/repo/runs/12", undefined],
      [["runs", "rerun", "12", "--repo", "owner/repo"], "POST", "/api/repos/owner/repo/runs/12/rerun", undefined],
      [["runs", "cancel", "12", "--repo", "owner/repo"], "POST", "/api/repos/owner/repo/runs/12/cancel", undefined],
      [
        ["flow", "dispatch", "5", "--repo", "owner/repo", "--ref", "main", "--input", "name=demo"],
        "POST",
        "/api/repos/owner/repo/workflows/5/dispatches",
        { ref: "main", inputs: { name: "demo" } }
      ],
      [["notification", "read", "7"], "PATCH", "/api/notifications/7", { read: true }],
      [["notification", "read", "--all"], "PUT", "/api/notifications/mark-read", undefined],
      [
        ["land", "review", "3", "--repo", "owner/repo", "--approve", "--commit", "abc"],
        "POST",
        "/api/repos/owner/repo/landings/3/reviews",
        { type: "approve", body: "", commit_id: "abc" }
      ],
      [
        ["land", "land", "3", "--repo", "owner/repo", "--commit", "abc"],
        "PUT",
        "/api/repos/owner/repo/landings/3/land",
        { commit_id: "abc" }
      ],
      [
        ["workspace", "create", "--repo", "owner/repo", "--name", "dev", "--cpus", "4"],
        "POST",
        "/api/repos/owner/repo/workspaces",
        { name: "dev", resources: { vcpu: 4 } }
      ],
      [
        ["workspace", "delete", "w1", "--repo", "owner/repo", "--yes"],
        "DELETE",
        "/api/repos/owner/repo/workspaces/w1",
        undefined
      ]
    ] as const
  )("routes %j through the backend with its original payload", async (argv, method, path, body) => {
    const calls: unknown[] = []
    const f = await fixture((req, res, payload) => {
      calls.push([req.method, req.url, payload])
      res.end("{}")
    })
    const result = await f.run([...argv])
    expect(result.code, result.output).toBe(0)
    expect(calls).toEqual([[method, path, body]])
  })
  it("streams workspace status with the backend endpoint and retains event cursors", async () => {
    const seen: string[] = []
    const f = await fixture((req, res) => {
      seen.push(req.url!)
      if (req.url!.endsWith("/stream")) {
        res.setHeader("content-type", "text/event-stream")
        res.write("id: 1\r\ndata: {\"status\":\"running\"}\r\n\r")
        res.end("\nid: 2\ndata: {\"status\":\"deleted\"}")
      } else res.end("{\"id\":\"w1\",\"status\":\"running\"}")
    })
    const result = await f.run(["workspace", "watch", "w1", "--repo", "owner/repo"])
    expect(result.code, result.output).toBe(0)
    expect(seen).toEqual(["/api/repos/owner/repo/workspaces/w1", "/api/repos/owner/repo/workspaces/w1/stream"])
    expect(JSON.parse(result.output).events).toEqual([
      { id: "1", type: "status", data: { status: "running" } },
      { id: "2", type: "status", data: { status: "deleted" } }
    ])
  })
  it("watches until completion and exits unsuccessfully when the backend run failed", async () => {
    let reads = 0
    const f = await fixture((req, res) => {
      if (req.url!.endsWith("/logs")) {
        res.setHeader("content-type", "text/event-stream")
        res.end("event: done\ndata: {\"status\":\"failure\"}\n\n")
      } else res.end(JSON.stringify({ id: 4, status: ++reads === 1 ? "running" : "failure" }))
    })
    const result = await f.run(["runs", "watch", "4", "--repo", "owner/repo"])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.output).status).toBe("failure")
    expect(reads).toBe(2)
  })
  it("redacts echoed session values from backend failures", async () => {
    const f = await fixture((_req, res) => {
      res.statusCode = 403
      res.end("{\"message\":\"refused test-session-secret\"}")
    })
    const result = await f.run(["issue", "view", "4", "--repo", "owner/repo"])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("refused [REDACTED]")
  })
  it("uses one login for repository and control-plane HTTP/WebSocket configuration", async () => {
    const f = await fixture((_req, res) => res.end("{}"))
    expect(await makeConfig(["--remote", f.origin], f.environment, f.home).login?.()).toBe("test-session-secret")
    expect(await makeConfig(["--remote", "https://other.invalid"], f.environment, f.home).login?.()).toBeUndefined()
    const result = await f.run(["auth", "token"])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("token_set")
    expect(result.output).not.toContain("test-session-secret")
  })
  it("persists and clears a protected login without a keyring", async () => {
    const f = await fixture((_req, res) => res.end("{}")), session = new Session(f.environment)
    await session.save(f.origin, "replacement-secret", { username: "owner" })
    expect((await session.require()).token).toBe("replacement-secret")
    await session.clear()
    expect(await session.resolve()).toBeUndefined()
  })
  it("rejects browser callback state and then accepts the matching fragment exchange", async () => {
    const f = await fixture((_req, res) => res.end("{}"))
    let attempts!: Promise<void>
    const result = browserLogin(new Client({ environment: f.environment }), f.origin, false, "", (url) => {
      attempts = (async () => {
        const params = new URL(url).searchParams, callback = `http://127.0.0.1:${params.get("callback_port")}/callback`
        const post = (state: string) =>
          fetch(callback, {
            method: "POST",
            headers: { "content-type": "application/json", origin: new URL(callback).origin },
            body: JSON.stringify({ callback_state: state, token: "browser-secret" })
          })
        expect((await post("wrong")).status).toBe(403)
        const page = await fetch(callback + "?token=ignored")
        expect(await page.text()).toContain("location.hash")
        expect((await post(params.get("callback_state")!)).status).toBe(200)
      })()
    }, 2000)
    expect((await result).token).toBe("browser-secret")
    await attempts
  })
  it("waits for workspace completion and reports terminal provisioning failure", async () => {
    let polls = 0
    const f = await fixture((req, res) =>
      res.end(
        JSON.stringify(
          req.method === "POST"
            ? { id: "w1", status: "pending" }
            : ++polls === 1
            ? { id: "w1", status: "creating" }
            : { id: "w1", status: "failed", failure_code: "image_unavailable" }
        )
      )
    )
    const result = await f.run(
      ["workspace", "create", "--repo", "owner/repo", "--wait"],
      { ...f.environment, SMITHERS_WORKSPACE_CREATE_POLL_INTERVAL_MS: "1" } as typeof f.environment
    )
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("image_unavailable")
    expect(polls).toBe(2)
  })
  it("fails closed when stack review or CI cannot be read", async () => {
    const methods: string[] = []
    const f = await fixture((req, res, body) => {
      if (req.method === "GET") {
        res.end(
          JSON.stringify({
            id: 1,
            changes: [{
              change_id: "abcd",
              pr_number: 3,
              ci_status: "passing",
              review_status: "approved",
              pr_state: "open"
            }]
          })
        )
        return
      }
      const request = body as { method: string; path: string }
      methods.push(request.method)
      if (request.path.endsWith("/check-runs")) {
        res.statusCode = 503
        res.end("{\"message\":\"GitHub unavailable\"}")
        return
      }
      res.end(JSON.stringify({ state: "open", head: { sha: "abc" } }))
    })
    const result = await f.run(["stack", "land", "--repo", "owner/repo"])
    expect(result.code).not.toBe(0)
    expect(methods).toEqual(["GET", "GET"])
  })
})

describe("clone argument compatibility", () => {
  it("preserves positional destinations and clone flags after --", async () => {
    const f = await fixture((_req, res) => res.end("{}"))
    const exec = vi.spyOn(Client.prototype, "exec").mockResolvedValue("")
    let output = "", code = 0
    try {
      await makeCli({
        environment: f.environment,
        exit: (value) => {
          code = value
        }
      }).serve(["repo", "clone", "https://github.test/owner/repo.git", "copy", "--json", "--", "--depth=1"], {
        stdout: (value) => {
          output += value
        },
        exit: (value) => {
          code = value
        }
      })
      expect(code, output).toBe(0)
      expect(exec).toHaveBeenCalledWith("jj", [
        "git",
        "clone",
        "https://github.test/owner/repo.git",
        "copy",
        "--depth=1"
      ], {})
    } finally {
      exec.mockRestore()
    }
  })
})
