import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeCli } from "../src/Cli.ts"
import { browserLogin } from "../src/internal/backend/Auth.ts"
import { Client } from "../src/internal/backend/Client.ts"
import { commandPath, handlers } from "../src/internal/backend/Commands.ts"
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
    run: async (args: string[], env = environment) => {
      let output = "", code = 0
      const cli = makeCli({
        environment: env,
        exit: (value) => {
          code = value
        }
      })
      await cli.serve([...args, "--json"], {
        env,
        stdout: (text) => {
          output += text
        },
        exit: (value) => {
          code = value
        }
      })
      expect(output).not.toContain("test-session-secret")
      return { output, code }
    }
  }
}

describe("one npm CLI backend contracts", () => {
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
    expect(Object.keys(definitions)).toHaveLength(209)
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
      [["repo", "unarchive", "owner/repo"], "DELETE", "/api/repos/owner/repo/archive", undefined],
      [["repo", "transfer", "owner/repo", "--to", "alice"], "POST", "/api/repos/owner/repo/transfer", {
        "new_owner": "alice"
      }],
      [["repo", "fork", "owner/repo", "--name", "fork"], "POST", "/api/repos/owner/repo/forks", { "name": "fork" }],
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
      [["beta", "whitelist", "list"], "GET", "/api/admin/alpha/whitelist", undefined],
      [["extension", "linear", "list"], "GET", "/api/integrations/linear", undefined],
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
      [["beta", "waitlist", "join", "--email", "a@test.invalid"], "POST", "/api/alpha/waitlist", {
        "email": "a@test.invalid",
        "note": "",
        "source": "cli"
      }],
      [["beta", "waitlist", "approve", "--email", "a@test.invalid"], "POST", "/api/admin/alpha/waitlist/approve", {
        "email": "a@test.invalid"
      }],
      [
        ["beta", "whitelist", "add", "--type", "email", "--value", "a@test.invalid"],
        "POST",
        "/api/admin/alpha/whitelist",
        { "identity_type": "email", "identity_value": "a@test.invalid" }
      ],
      [
        ["beta", "whitelist", "remove", "--type", "email", "--value", "a@test.invalid"],
        "DELETE",
        "/api/admin/alpha/whitelist/email/a%40test.invalid",
        undefined
      ],
      [["extension", "linear", "remove", "4"], "DELETE", "/api/integrations/linear/4", undefined],
      [["extension", "linear", "sync", "4"], "POST", "/api/integrations/linear/4/sync", undefined],
      [["repo", "create", "demo", "--private"], "POST", "/api/user/repos", { name: "demo", private: true }],
      [["repo", "fork", "owner/repo", "--name", "fork"], "POST", "/api/repos/owner/repo/forks", { name: "fork" }],
      [["repo", "transfer", "owner/repo", "--to", "other"], "POST", "/api/repos/owner/repo/transfer", {
        new_owner: "other"
      }],
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
        { name: "dev", resources: { cpus: 4 } }
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
            headers: { "content-type": "application/json" },
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
      ])
    } finally {
      exec.mockRestore()
    }
  })
})
