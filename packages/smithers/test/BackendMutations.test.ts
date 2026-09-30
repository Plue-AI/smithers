import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { admin } from "../src/internal/backend/Admin.ts"
import { Client, object } from "../src/internal/backend/Client.ts"
import { local } from "../src/internal/backend/Local.ts"
import { misc } from "../src/internal/backend/Misc.ts"
import { repositories } from "../src/internal/backend/Repositories.ts"
import { resources } from "../src/internal/backend/Resources.ts"
import { runs } from "../src/internal/backend/Runs.ts"
const dirs: string[] = [], cwd = process.cwd()
afterEach(async () => {
  process.chdir(cwd)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const fixture = async () => {
  const home = await mkdtemp(join(tmpdir(), "one-cli-mutations-"))
  dirs.push(home)
  const c = new Client({
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: home,
      SMITHERS_API_ORIGIN: "https://api.example.test",
      SMITHERS_TOKEN: "session-secret",
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
      SMITHERS_GITHUB_APP_POLL_INTERVAL_MS: "1"
    },
    stderr: { write: () => {}, isTTY: false, columns: 80 }
  })
  const request = vi.spyOn(c, "request").mockResolvedValue({}), exec = vi.spyOn(c, "exec").mockResolvedValue("")
  return { c, request, exec, home }
}
const options = { repo: "owner/repo" }
describe("resource mutations", () => {
  it("reads secrets exclusively from stdin", async () => {
    const { c, request } = await fixture()
    vi.spyOn(c, "stdin").mockResolvedValue("private-value")
    await expect(resources["secret set"]!(c, { name: "KEY" }, options)).rejects.toThrow("stdin")
    await resources["secret set"]!(c, { name: "KEY" }, { ...options, "body-stdin": true })
    expect(request).toHaveBeenCalledWith("POST", "/api/repos/owner/repo/secrets", {
      name: "KEY",
      value: "private-value"
    })
  })
  it("marks a secret main-only on set or on its own", async () => {
    const { c, request } = await fixture()
    vi.spyOn(c, "stdin").mockResolvedValue("private-value")
    await resources["secret set"]!(c, { name: "KEY" }, { ...options, "body-stdin": true, "main-only": true })
    expect(request).toHaveBeenLastCalledWith("POST", "/api/repos/owner/repo/secrets", {
      name: "KEY",
      value: "private-value",
      main_only: true
    })
    await resources["secret scope"]!(c, { name: "DEPLOY KEY", scope: "main-only" }, options)
    expect(request).toHaveBeenLastCalledWith("PATCH", "/api/repos/owner/repo/secrets/DEPLOY%20KEY", { main_only: true })
    await resources["secret scope"]!(c, { name: "KEY", scope: "all" }, options)
    expect(request).toHaveBeenLastCalledWith("PATCH", "/api/repos/owner/repo/secrets/KEY", { main_only: false })
  })
  it("connects Linear with OAuth credentials, rejecting an API-key-shaped payload", async () => {
    const { c, request } = await fixture(), stdin = vi.spyOn(c, "stdin")
    await expect(resources["extension linear install"]!(c, {}, options)).rejects.toThrow("stdin")
    stdin.mockResolvedValue("{\"api_key\":\"key\"}")
    await expect(resources["extension linear install"]!(c, {}, { "credentials-stdin": true })).rejects.toThrow(
      "access_token"
    )
    stdin.mockResolvedValue("{\"access_token\":\"oauth\",\"refresh_token\":\"refresh\"}")
    await resources["extension linear install"]!(c, {}, {
      "credentials-stdin": true,
      "team-id": "team",
      "repo-owner": "owner",
      "repo-name": "repo"
    })
    expect(request).toHaveBeenLastCalledWith(
      "POST",
      "/api/integrations/linear",
      expect.objectContaining({
        access_token: "oauth",
        refresh_token: "refresh",
        linear_team_id: "team",
        repo_owner: "owner",
        repo_name: "repo"
      })
    )
  })
  it("sends webhook secret rotation and explicit empty event selection", async () => {
    const { c, request } = await fixture()
    vi.spyOn(c, "stdin").mockResolvedValue("")
    await resources["webhook update"]!(c, { id: 7 }, {
      ...options,
      url: "https://hook.test",
      events: [],
      active: false,
      "secret-stdin": true
    })
    expect(request).toHaveBeenCalledWith("PATCH", "/api/repos/owner/repo/hooks/7", {
      url: "https://hook.test",
      events: [],
      is_active: false,
      secret: ""
    })
    await resources["webhook create"]!(c, {}, { ...options, events: [] })
    expect(request).toHaveBeenLastCalledWith("POST", "/api/repos/owner/repo/hooks", { events: ["push"] })
    await resources["webhook deliveries"]!(c, { id: 7 }, { ...options, replay: 8 })
    expect(request).toHaveBeenLastCalledWith("POST", "/api/repos/owner/repo/hooks/7/deliveries/8/redeliver")
  })
  it("loads a webhook together with delivery receipts", async () => {
    const { c, request } = await fixture()
    request.mockResolvedValueOnce({ id: 7 }).mockResolvedValueOnce([{ id: 8 }])
    expect(await resources["webhook view"]!(c, { id: 7 }, options)).toEqual({
      hook: { id: 7 },
      deliveries: [{ id: 8 }]
    })
  })
  it.each([[], ["bad"], ["repo="], ["=change"]])("rejects invalid changeset membership %j", async (...member) => {
    const { c, request } = await fixture()
    expect(() => resources["changeset create"]!(c, {}, { org: "org", member: member.flat() })).toThrow()
    expect(request).not.toHaveBeenCalled()
  })
  it("preserves parent and multiple repository changes in a changeset", async () => {
    const { c, request } = await fixture()
    await resources["changeset create"]!(c, {}, {
      org: "org",
      member: ["repo=change,repo2=change2"],
      parent: "parent",
      target: "main"
    })
    expect(request).toHaveBeenCalledWith("POST", "/api/orgs/org/changesets", {
      description: "",
      target_bookmark: "main",
      parent_change_id: "parent",
      members: [{ repo: "repo", change_id: "change" }, { repo: "repo2", change_id: "change2" }]
    })
  })
  it("marks all notifications read only when requested", async () => {
    const { c, request } = await fixture()
    await expect(resources["notification read"]!(c, {}, {})).rejects.toThrow("ID")
    expect(await resources["notification read"]!(c, {}, { all: true })).toEqual({ status: "all_read" })
    expect(request).toHaveBeenCalledWith("PUT", "/api/notifications/mark-read")
  })
  it.each(["close", "reopen"])("adds a comment before issue %s", async (action) => {
    const { c, request } = await fixture()
    await resources[`issue ${action}`]!(c, { number: 7 }, { ...options, comment: "Reason" })
    expect(request.mock.calls[0]).toEqual(["POST", "/api/repos/owner/repo/issues/7/comments", { body: "Reason" }])
  })
  it("does not duplicate an assignee with another letter case", async () => {
    const { c, request } = await fixture()
    request.mockResolvedValue({ assignees: [{ login: "Owner" }] })
    await resources["issue edit"]!(c, { number: 7 }, { ...options, assignee: "owner" })
    expect(request).toHaveBeenLastCalledWith("PATCH", "/api/repos/owner/repo/issues/7", { assignees: ["Owner"] })
  })
  it("downloads an artifact without forwarding the login to storage", async () => {
    const { c, request, home } = await fixture()
    request.mockResolvedValue({ download_url: "https://storage.test/signed", name: "../../download.txt", size: 4 })
    const fetch = vi.fn().mockResolvedValue(new Response("data"))
    vi.stubGlobal("fetch", fetch)
    process.chdir(home)
    expect(await resources["artifact download"]!(c, { runId: 7, name: "artifact" }, options)).toMatchObject({
      path: join(process.cwd(), "download.txt"),
      size: 4
    })
    expect(await readFile(join(home, "download.txt"), "utf8")).toBe("data")
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty("headers")
  })
  it.each([{}, { download_url: "https://storage.test", name: ".." }])(
    "rejects incomplete artifact metadata %j",
    async (record) => {
      const { c, request } = await fixture()
      request.mockResolvedValue(record)
      await expect(resources["artifact download"]!(c, { runId: 7, name: "artifact" }, options)).rejects.toThrow()
    }
  )
  it("reports failed storage downloads", async () => {
    const { c, request, home } = await fixture()
    request.mockResolvedValue({ download_url: "https://storage.test" })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })))
    await expect(
      resources["artifact download"]!(c, { runId: 7, name: "artifact" }, { ...options, output: join(home, "out") })
    ).rejects.toThrow("503")
  })
})

describe("raw API and backend flows", () => {
  it.each(["{\"ok\":true}", "plain", ""])("preserves raw response %j", async (text) => {
    const { c } = await fixture(), response = vi.spyOn(c, "response").mockResolvedValue(new Response(text))
    const value = await misc.api!(c, { endpoint: "/api/path" }, {
      method: "PATCH",
      field: ["body=a=b"],
      header: ["X-Test: value"]
    })
    expect(value).toEqual(text.startsWith("{") ? { ok: true } : text || null)
    expect(response).toHaveBeenCalledWith("PATCH", "/api/path", { body: "a=b" }, { headers: { "X-Test": "value" } })
  })
  it.each([{ method: "CONNECT" }, { field: ["bad"] }, { header: ["bad"] }])(
    "rejects malformed raw requests %j",
    async (o) => {
      const { c } = await fixture()
      await expect(misc.api!(c, { endpoint: "/api/path" }, o)).rejects.toThrow()
    }
  )
  it("finds a flow by name and forwards inputs with equals signs", async () => {
    const { c, request } = await fixture()
    request.mockResolvedValueOnce({ workflows: [{ id: 7, name: "Build" }] }).mockResolvedValueOnce(null)
    expect(
      await runs["workflow run"]!(c, { workflow: " build " }, { ...options, input: ["value=a=b", "bad", "=missing"] })
    ).toEqual({ status: "dispatched" })
    expect(request).toHaveBeenLastCalledWith("POST", "/api/repos/owner/repo/workflows/7/dispatches", {
      ref: "main",
      inputs: { value: "a=b" }
    })
    await expect(runs["workflow run"]!(c, { workflow: "missing" }, options)).rejects.toThrow("not found")
  })
  it.each(["success", "failed", "cancelled"])("does not watch a terminal run (%s)", async (status) => {
    const { c, request } = await fixture()
    request.mockResolvedValue({ status })
    const events = vi.spyOn(c, "events")
    expect(await runs["run watch"]!(c, { id: 7 }, options)).toEqual({ status })
    expect(events).not.toHaveBeenCalled()
  })
  it("creates a landing from the local stack", async () => {
    const { c, request, exec } = await fixture()
    exec.mockImplementation(async (_cmd, args) => args.at(-1)!.startsWith("change_id") ? "abc\tcommit" : "Description")
    await local["land create"]!(c, {}, { ...options, stack: true, title: "Land", target: "main" })
    expect(request).toHaveBeenCalledWith("POST", "/api/repos/owner/repo/landings", {
      title: "Land",
      body: "",
      target_bookmark: "main",
      change_ids: ["abc"]
    })
  })
  it("loads landing detail and per-change checks", async () => {
    const { c, request } = await fixture()
    request.mockImplementation(async (_method, path) =>
      path.endsWith("/statuses") ? [{ state: "success" }] : { change_ids: ["abc"] }
    )
    expect(object(await local["land checks"]!(c, { number: 7 }, options)).statuses).toEqual([{
      state: "success",
      change_id: "abc"
    }])
    expect(await local["land view"]!(c, { number: 7 }, options)).toHaveProperty("reviews")
  })
})

describe("repository connection", () => {
  it.each([
    ["MIT", "SPDX-License-Identifier: MIT"],
    ["Apache-2.0", "Apache License Version 2.0"],
    ["MPL-2.0", "Mozilla Public License v. 2.0"],
    ["ISC", "Permission to use, copy, modify, and/or distribute this software for any purpose"],
    ["BSD-3-Clause", "Redistribution and use in source and binary forms. Neither the name"],
    [
      "BSD-2-Clause",
      "Redistribution and use in source and binary forms. This software is provided by the copyright holders and contributors \"as is\""
    ]
  ])("connects and disconnects a locally licensed %s repository", async (license, content) => {
    const { c, home, request } = await fixture()
    await mkdir(join(home, ".jj"))
    await writeFile(join(home, "LICENSE"), content)
    process.chdir(home)
    request.mockImplementation(async (_method, path) =>
      path.startsWith("/repos/") ? { private: false, license: {} } : { github_app_installed: true }
    )
    expect(await repositories["repo connect"]!(c, { repo: "owner/repo" }, {})).toMatchObject({
      license_spdx_id: license,
      connected: true
    })
    expect(await repositories["repo status"]!(c, {}, {})).toMatchObject({ connected: true })
    expect(await repositories["repo disconnect"]!(c, {}, {})).toEqual({ connected: false })
    expect(await repositories["repo status"]!(c, {}, {})).toMatchObject({ connected: false })
    expect(await repositories["repo disconnect"]!(c, {}, {})).toEqual({ connected: false })
  })
  it.each([{ private: true }, { license: { spdx_id: "GPL-3.0" } }, { license: {} }])(
    "refuses unsupported repo licensing %j",
    async (record) => {
      const { c, home, request } = await fixture()
      await mkdir(join(home, ".jj"))
      process.chdir(home)
      request.mockResolvedValue(record)
      await expect(repositories["repo connect"]!(c, { repo: "owner/repo" }, {})).rejects.toThrow()
      expect(request.mock.calls.some(([method]) => method === "POST")).toBe(false)
    }
  )
  it("waits for app installation and rolls back if local persistence fails", async () => {
    const { c, home, request } = await fixture()
    await mkdir(join(home, ".jj"))
    await writeFile(join(home, ".smithers"), "blocked")
    process.chdir(home)
    request.mockResolvedValueOnce({ license: { spdx_id: "MIT" } }).mockResolvedValueOnce({
      github_app_installed: false
    }).mockResolvedValue({ github_app_installed: true })
    await expect(repositories["repo connect"]!(c, { repo: "owner/repo" }, {})).rejects.toThrow()
    expect(request).toHaveBeenLastCalledWith("DELETE", "/api/repo-connection", { owner: "owner", repo: "repo" })
  })
})

describe("Observe administration", () => {
  it.each(["", ".", "..", "a/b", "a\\b", "a\nb"])("rejects a non-atomic admin target %j", async (id) => {
    const { c, request } = await fixture()
    await expect(admin["admin sessions cancel"]!(c, { id }, { yes: true })).rejects.toThrow("single target")
    expect(request).not.toHaveBeenCalled()
  })
  it("sends explicit confirmation only to the configured Observe origin", async () => {
    const { c, request } = await fixture()
    c.session.saveConfig({ observe_url: "https://observe.example.test" })
    await admin["admin deploys platform rollback"]!(c, { component: "api" }, { yes: true, revision: "previous" })
    expect(request.mock.calls[0]![3]).toEqual({
      origin: "https://observe.example.test",
      token: "session-secret",
      headers: { "X-Confirm": "api" }
    })
    await admin["admin deploys platform status"]!(c, { component: "api" }, {})
    expect(request.mock.calls[1]![3]).toMatchObject({ headers: {} })
  })
})

describe("remaining read and update contracts", () => {
  it.each(
    [
      ["variable get", { name: "KEY" }, "GET", "/api/repos/owner/repo/variables/KEY"],
      ["ssh-key list", {}, "GET", "/api/user/keys"],
      ["ssh-key add", {}, "POST", "/api/user/keys"],
      ["cache list", {}, "GET", "/api/repos/owner/repo/caches"],
      ["cache stats", {}, "GET", "/api/repos/owner/repo/caches/stats"],
      ["cache clear", {}, "DELETE", "/api/repos/owner/repo/caches"],
      ["changeset get", {}, "GET", "/api/orgs/org/changesets/7"],
      ["changeset land", {}, "POST", "/api/orgs/org/changesets/7/land"],
      ["changeset list", {}, "GET", "/api/orgs/org/changesets"],
      ["wiki search", {}, "GET", "/api/repos/owner/repo/wiki/search"],
      ["wiki revisions", { slug: "page" }, "GET", "/api/repos/owner/repo/wiki/page/revisions"],
      ["wiki history", { "page-id": 7 }, "GET", "/api/repos/owner/repo/wiki/history/7"],
      ["wiki index", {}, "GET", "/api/repos/owner/repo/wiki/navigation/index"]
    ] as const
  )("%s retains its API method and endpoint", async (name, args, method, path) => {
    const { c, request } = await fixture()
    await resources[name]!(c, args, {
      ...options,
      org: "org",
      id: 7,
      title: "laptop",
      key: "ssh-ed25519 public",
      query: "search",
      visibility: "private"
    })
    expect(request.mock.calls[0]![0]).toBe(method)
    expect(request.mock.calls[0]![1].split("?")[0]).toBe(path)
  })
  it.each(["repos", "issues", "code", "users"])("searches %s with explicit pagination", async (category) => {
    const { c, request } = await fixture()
    await resources[`search ${category}`]!(c, { query: "term" }, { page: 2, limit: 10 })
    expect(request).toHaveBeenCalledWith(
      "GET",
      `/api/search/${category === "repos" ? "repositories" : category}?q=term&page=2&per_page=10`
    )
  })
  it.each([false, true])("lists notifications with unread=%s", async (unread) => {
    const { c } = await fixture()
    const response = vi.spyOn(c, "response").mockResolvedValue(new Response("[]"))
    await resources["notification list"]!(c, {}, { unread })
    expect(response.mock.calls[0]![1]).toBe(`/api/notifications/list?limit=30${unread ? "&status=unread" : ""}`)
  })
  it.each(["all", "landed", "open"])("maps landing list state %s", async (state) => {
    const { c } = await fixture()
    const response = vi.spyOn(c, "response").mockResolvedValue(new Response("[]"))
    await local["land list"]!(c, {}, { ...options, state })
    const url = new URL(response.mock.calls[0]![1], "https://example.test")
    expect(url.searchParams.get("state")).toBe(state === "all" ? null : state === "landed" ? "merged" : state)
  })
  it.each([{}, { change: "abc" }])("creates a bookmark with an optional revision %j", async (o) => {
    const { c, exec } = await fixture()
    expect(await local["bookmark create"]!(c, { name: "new" }, o)).toEqual({
      name: "new",
      target_change_id: "change" in o ? o.change : null
    })
    exec.mockResolvedValue("new\tchange\tcommit")
    expect(await local["bookmark create"]!(c, { name: "new" }, o)).toMatchObject({ target_commit_id: "commit" })
    exec.mockResolvedValue("empty\t\t")
    expect(await local["bookmark list"]!(c, {}, {})).toEqual([{ name: "empty", target_change_id: null }])
  })
  it("parses local change descriptions and file summaries", async () => {
    const { c, exec } = await fixture()
    exec.mockResolvedValue("abc\tDescription\tcontinued")
    expect(await local["change list"]!(c, {}, { limit: 2 })).toEqual([{
      change_id: "abc",
      description: "Description\tcontinued"
    }])
    await local["change list"]!(c, {}, {})
    expect(await local["change diff"]!(c, {}, {})).toHaveProperty("change_id", "@")
    expect(await local["change diff"]!(c, { id: "abc" }, {})).toHaveProperty("change_id", "abc")
    exec.mockResolvedValue("ignored\nM file")
    expect(await local["change files"]!(c, { id: "abc" }, {})).toEqual({ change_id: "abc", files: ["file"] })
    exec.mockResolvedValue("")
    await expect(local["change show"]!(c, { id: "missing" }, {})).rejects.toThrow("resolve revision")
  })
  it("defaults a landing to the working copy and supports explicit change aliases", async () => {
    const { c, request, exec } = await fixture()
    exec.mockResolvedValue("current\tcommit\tTitle")
    for (const selection of [{}, { change: "chosen" }, { "change-id": "chosen" }]) {
      await local["land create"]!(c, {}, { ...options, ...selection })
      expect(object(request.mock.calls.at(-1)![2]).change_ids).toEqual([
        Object.keys(selection).length ? "chosen" : "current"
      ])
    }
    await local["land edit"]!(c, { number: 7 }, options)
    await local["land review"]!(c, { number: 7 }, options)
    expect(request).toHaveBeenLastCalledWith("POST", "/api/repos/owner/repo/landings/7/reviews", {
      type: "comment",
      body: "",
      commit_id: undefined
    })
  })
  it("erases a user with the request date and reports delete as a suspension", async () => {
    const { c, request } = await fixture()
    request.mockResolvedValue({ user_id: 7, tombstone: "erased-ab-7", already_erased: false })
    expect(await admin["admin user erase"]!(c, { username: "a b" }, { "request-date": "2026-09-01", yes: true }))
      .toEqual({ user_id: 7, tombstone: "erased-ab-7", already_erased: false })
    expect(request).toHaveBeenLastCalledWith("POST", "/api/admin/users/a%20b/erase", { request_date: "2026-09-01" })
    await admin["admin user erase"]!(c, { username: "a" }, { "request-date": "2026-09-01", "user-id": 7, yes: true })
    expect(request).toHaveBeenLastCalledWith("POST", "/api/admin/users/a/erase", {
      request_date: "2026-09-01",
      user_id: 7
    })
    expect(await admin["admin user delete"]!(c, { username: "a" }, { yes: true })).toEqual({
      status: "suspended",
      username: "a"
    })
    expect(request).toHaveBeenLastCalledWith("DELETE", "/api/admin/users/a")
  })
  it("downloads a user's export archive to the requested path", async () => {
    const { c } = await fixture()
    const dir = await mkdtemp(join(tmpdir(), "smithers-export-"))
    const out = join(dir, "nested", "alice.tar.gz")
    const response = vi.spyOn(c, "response").mockImplementation(async () => new Response("archive-bytes"))
    expect(await admin["admin user export"]!(c, { username: "a b", out }, {}))
      .toEqual({ username: "a b", path: out, bytes: 13 })
    expect(response).toHaveBeenLastCalledWith("POST", "/api/admin/users/a%20b/export", undefined, {
      stream: true,
      headers: { accept: "application/gzip" }
    })
    expect(await readFile(out, "utf8")).toBe("archive-bytes")
    expect(existsSync(`${out}.partial`)).toBe(false)
  })
  it("leaves no archive when the export download fails", async () => {
    const { c } = await fixture()
    const dir = await mkdtemp(join(tmpdir(), "smithers-export-"))
    const out = join(dir, "alice.tar.gz")
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"))
        controller.error(new Error("connection reset"))
      }
    })
    vi.spyOn(c, "response").mockImplementation(async () => new Response(failing))
    await expect(admin["admin user export"]!(c, { username: "alice", out }, {})).rejects.toThrow("connection reset")
    expect(existsSync(out)).toBe(false)
    expect(existsSync(`${out}.partial`)).toBe(false)
  })
  it.each(["admin user list", "admin runs list"])("reads %s with page controls", async (name) => {
    const { c, request } = await fixture()
    await admin[name]!(c, {}, { ...options, page: 2, limit: 10, "per-page": 10 })
    expect(request.mock.calls[0]![0]).toBe("GET")
    expect(request.mock.calls[0]![1]).toContain("page=2")
  })
  it("streams backend run logs through the shared event transport", async () => {
    const { c } = await fixture()
    const events = vi.spyOn(c, "events").mockResolvedValue([{ type: "done" }])
    expect(await runs["run logs"]!(c, { id: 7 }, options)).toEqual([{ type: "done" }])
    expect(events).toHaveBeenCalledWith("/api/repos/owner/repo/runs/7/logs")
  })
  it("preserves issue defaults and rejects blank titles", async () => {
    const { c, request } = await fixture()
    expect(() => resources["issue create"]!(c, {}, options)).toThrow("title")
    await resources["issue create"]!(c, { title: "Issue" }, options)
    expect(request).toHaveBeenLastCalledWith("POST", "/api/repos/owner/repo/issues", { title: "Issue", body: "" })
    const response = vi.spyOn(c, "response").mockImplementation(async () => new Response("[]"))
    await resources["issue list"]!(c, {}, { ...options, state: "all" })
    expect(response.mock.calls[0]![1]).not.toContain("state=")
    await resources["issue list"]!(c, {}, options)
    expect(response.mock.calls[1]![1]).toContain("state=open")
  })
  it("keeps optional mutable fields explicit", async () => {
    const { c, request } = await fixture()
    await resources["org edit"]!(c, { name: "org" }, { visibility: "private" })
    expect(request.mock.calls.at(-1)![2]).toEqual({ visibility: "private" })
    await resources["org team edit"]!(c, { org: "org", team: "team" }, { permission: "admin" })
    expect(request.mock.calls.at(-1)![2]).toEqual({ permission: "admin" })
    await resources["wiki edit"]!(c, { slug: "page" }, options)
    expect(request.mock.calls.at(-1)![2]).toEqual({})
    await resources["wiki create"]!(c, {}, { ...options, title: "Title" })
    expect(request.mock.calls.at(-1)![2]).toMatchObject({ slug: null })
    await resources["changeset create"]!(c, {}, { org: "org", member: ["repo=change"] })
    expect(request.mock.calls.at(-1)![2]).not.toHaveProperty("parent_change_id")
  })
})
