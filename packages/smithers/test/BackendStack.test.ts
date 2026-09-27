import { afterEach, describe, expect, it, vi } from "vitest"
import { APIError, Client, object, type Values } from "../src/internal/backend/Client.ts"
import { stacks } from "../src/internal/backend/Stack.ts"
const options = { repo: "owner/repo" }
const error = (status: number) => new APIError(status, {}, "GET", "/github", new Headers())
afterEach(() => vi.restoreAllMocks())
const fixture = (
  config: {
    githubToken?: boolean
    changes?: Values[]
    locals?: string[]
    github?: (method: string, path: string, body?: Values) => unknown
  } = {}
) => {
  const changes = config.changes ??
    [{
      change_id: "a1234567",
      position: 0,
      pr_number: 1,
      body: "Notes\n<!-- smithers:stack:start -->old<!-- smithers:stack:end -->"
    }]
  const locals = config.locals ?? changes.map((change) => String(change.change_id))
  const c = new Client({
    environment: {
      HOME: "/nonexistent-smithers-stack-test",
      SMITHERS_API_ORIGIN: "https://api.example.test",
      SMITHERS_TOKEN: "session",
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
      ...(config.githubToken ? { GITHUB_TOKEN: "github-secret", SMITHERS_GITHUB_API_URL: "https://github.test" } : {})
    }
  })
  const exec = vi.spyOn(c, "exec").mockImplementation((_command, args) => {
    if (!args.includes("log")) return ""
    const template = args.at(-1)!
    if (template.startsWith("change_id")) return locals.map((id) => `${id}\tcommit-${id}`).join("\n")
    if (template.startsWith("author")) return "Author\tauthor@example.test"
    return "Change title\n\nNotes\n<!-- smithers:stack:start -->old<!-- smithers:stack:end -->"
  })
  let created = 10
  const github = vi.fn((method: string, path: string, body?: Values): unknown => {
    const custom = config.github?.(method, path, body)
    if (custom !== undefined) return custom
    if (path.endsWith("/check-runs")) {
      return { check_runs: [{ name: "CI", status: "completed", conclusion: "success" }] }
    }
    if (path.endsWith("/reviews")) return [{ user: { login: "owner" }, state: "APPROVED" }]
    if (path.endsWith("/merge")) return { merged: true }
    return {
      number: method === "POST" ? created++ : Number(path.split("/").at(-1)) || 1,
      state: "open",
      head: { sha: "commit" },
      mergeable: true,
      html_url: "https://github.test/pr"
    }
  })
  const request = vi.spyOn(c, "request").mockImplementation(async (method, path, body) => {
    if (path.includes("/stacks/active")) return { id: "stack", changes: structuredClone(changes) }
    if (path.endsWith("/github-proxy")) {
      const input = object(body)
      return github(String(input.method), String(input.path), input.body as Values | undefined)
    }
    return github(method, path, body as Values | undefined)
  })
  return { c, request, exec, github }
}
describe("stack synchronization and merge safety", () => {
  it("updates existing PRs in one ordered stack using direct GitHub auth", async () => {
    const f = fixture({
      githubToken: true,
      changes: [{ change_id: "second", pr_number: 2, position: 1 }, { change_id: "first", pr_number: 1, position: 0 }],
      locals: ["second", "first"]
    })
    const result = object(await stacks["stack submit"]!(f.c, {}, { ...options, draft: true }))
    expect(result.auth_source).toBe("github_token")
    expect(result.change_ids).toEqual(["first", "second"])
    const patch = f.github.mock.calls.find(([method, path, body]) =>
      method === "PATCH" && path.endsWith("/2") && body?.base
    )
    expect(patch?.[2]?.base).toBe("smithers/first")
    const bodies = f.github.mock.calls.filter(([method, , body]) => method === "PATCH" && body?.body).map((
      [, , body]
    ) => String(body!.body))
    expect(bodies.at(-1)).toContain("#1")
    expect(bodies.at(-1)).toContain("#2")
    expect(bodies.at(-1)).not.toContain("-->old<!--")
    expect(f.request.mock.calls.find(([, path]) => path.startsWith("/repos/"))?.[3]).toMatchObject({
      origin: "https://github.test",
      headers: { authorization: "Bearer github-secret" }
    })
  })
  it.each([404, 503])("handles updating a PR after HTTP %s", async (status) => {
    let failed = false
    const f = fixture({
      github: (method) => {
        if (method === "PATCH" && !failed) {
          failed = true
          throw error(status)
        }
      }
    })
    if (status === 404) expect(object(await stacks["stack submit"]!(f.c, {}, options)).pr_numbers).toEqual([10])
    else await expect(stacks["stack submit"]!(f.c, {}, options)).rejects.toThrow("503")
  })
  it("rejects incomplete PR receipts and empty local stacks", async () => {
    const f = fixture({ github: () => ({}) })
    await expect(stacks["stack submit"]!(f.c, {}, options)).rejects.toThrow("PR number")
    const empty = fixture({ locals: [] })
    await expect(stacks["stack submit"]!(empty.c, {}, options)).rejects.toThrow("No non-empty")
  })
  it("restacks every unmerged change after fetching authoritative PR state", async () => {
    const f = fixture({
      changes: [{ change_id: "merged", pr_number: 1 }, { change_id: "first", pr_number: 2 }, {
        change_id: "second",
        pr_number: 3
      }],
      github: (_method, path) => path.endsWith("/1") ? { state: "closed", merged: true } : undefined
    })
    const result = object(await stacks["stack sync"]!(f.c, {}, options))
    expect(result.merged).toEqual([expect.objectContaining({ change_id: "merged" })])
    expect(result.remaining).toHaveLength(2)
    const rebases = f.exec.mock.calls.filter(([, args]) => args.includes("rebase"))
    expect(rebases[0]![1]).toContain("main")
    expect(rebases[1]![1]).toContain("first")
    expect(rebases[0]![1]).toContain("user.name=\"Author\"")
  })
  it("removes a stack after all PRs have merged", async () => {
    const f = fixture({ github: () => ({ state: "closed", merged: true }) })
    expect(await stacks["stack sync"]!(f.c, {}, options)).toMatchObject({ stack_deleted: true, remaining: [] })
  })
  it("refuses restacking when a local change or PR mapping is missing", async () => {
    const missing = fixture({ locals: [] })
    await expect(stacks["stack sync"]!(missing.c, {}, options)).rejects.toThrow("Local stack is missing")
    const unmapped = fixture({ changes: [{ change_id: "abc" }] })
    await expect(stacks["stack sync"]!(unmapped.c, {}, options)).rejects.toThrow("pr_number")
    await expect(stacks["stack land"]!(unmapped.c, {}, options)).rejects.toThrow("pr_number")
  })
  it("shows local changes missing from the backend mapping without treating them as mergeable", async () => {
    const f = fixture({ locals: ["unsubmitted", "a1234567"] })
    const result = object(await stacks["stack status"]!(f.c, {}, options))
    expect(result.changes).toEqual([
      expect.objectContaining({ change_id: "unsubmitted", pr_number: null, mergeable: false }),
      expect.objectContaining({ change_id: "a1234567" })
    ])
  })
  it.each(["neutral", "skipped", "unknown", "failure"])(
    "normalizes a completed check with conclusion %s",
    async (conclusion) => {
      const f = fixture({
        github: (_method, path) =>
          path.endsWith("/check-runs") ? { check_runs: [{ status: "completed", conclusion }] } : undefined
      })
      const result = object(await stacks["stack status"]!(f.c, {}, options))
      expect(object((result.changes as unknown[])[0]).ci_status).toBe(
        ["neutral", "skipped"].includes(conclusion) ? "passing" : conclusion === "failure" ? "failing" : "pending"
      )
    }
  )
  it("uses the latest decisive review for each reviewer", async () => {
    const f = fixture({
      github: (_method, path) =>
        path.endsWith("/reviews")
          ? [
            { user: { login: "Zoe" }, state: "APPROVED" },
            { user: { login: "alice" }, state: "APPROVED" },
            { user: { login: "ALICE" }, state: "CHANGES_REQUESTED" },
            { user: { login: "alice" }, state: "COMMENTED" },
            { state: "APPROVED" }
          ]
          : undefined
    })
    const result = object(await stacks["stack status"]!(f.c, {}, options))
    expect(object((result.changes as unknown[])[0])).toMatchObject({
      review_status: "changes_requested",
      reviewers: [{ login: "ALICE", state: "changes_requested" }, { login: "Zoe", state: "approved" }]
    })
  })
  it.each(["review", "checks", "closed", "sha", "empty-checks"])(
    "refuses merging with non-passing %s evidence",
    async (kind) => {
      const f = fixture({
        github: (_method, path) => {
          if (path.endsWith("/reviews") && kind === "review") return []
          if (path.endsWith("/check-runs") && kind === "checks") {
            return { check_runs: [{ status: "completed", conclusion: "failure" }] }
          }
          if (path.endsWith("/check-runs") && kind === "empty-checks") return { check_runs: [] }
          if (path.endsWith("/1") && kind === "closed") {
            return { state: "closed", merged: true, head: { sha: "commit" } }
          }
          if (path.endsWith("/1") && kind === "sha") {
            return { state: "open", head: {} }
          }
        }
      })
      await expect(stacks["stack land"]!(f.c, {}, { ...options, all: kind === "review" })).rejects.toThrow()
      expect(f.github.mock.calls.some(([method]) => method === "PUT")).toBe(false)
    }
  )
  it.each([{ change: "" }, { change: "a", all: true }, { change: "missing" }])(
    "refuses invalid change selection %j",
    async (selection) => {
      const f = fixture()
      await expect(stacks["stack land"]!(f.c, {}, { ...options, ...selection })).rejects.toThrow()
    }
  )
  it("refuses ambiguous change prefixes and an empty active stack", async () => {
    const f = fixture({ changes: [{ change_id: "abc1", pr_number: 1 }, { change_id: "abc2", pr_number: 2 }] })
    await expect(stacks["stack land"]!(f.c, {}, { ...options, change: "abc" })).rejects.toThrow("ambiguous")
    const empty = fixture({ changes: [] })
    await expect(stacks["stack land"]!(empty.c, {}, options)).rejects.toThrow("no changes")
  })
  it.each(["all", "prefix"])("lands the selected ordered prefix (%s)", async (kind) => {
    const f = fixture({ changes: [{ change_id: "abc1", pr_number: 1 }, { change_id: "def2", pr_number: 2 }] })
    const result = object(
      await stacks["stack land"]!(f.c, {}, { ...options, ...(kind === "all" ? { all: true } : { change: "def" }) })
    )
    expect(result.landed).toHaveLength(2)
    expect(result.stack_deleted).toBe(true)
  })
  it.each(["fallback", "all-rejected", "failed", "not-merged"])(
    "handles merge result %s without claiming success",
    async (kind) => {
      const f = fixture({
        github: (_method, path, body) => {
          if (!path.endsWith("/merge")) return
          if (kind === "not-merged") return { merged: false }
          if (kind === "failed") throw error(503)
          if (kind === "all-rejected" || body?.merge_method === "merge") throw error(405)
        }
      })
      if (kind === "fallback") {
        expect(object(await stacks["stack land"]!(f.c, {}, options)).landed).toHaveLength(1)
        expect(f.github.mock.calls.some(([, , body]) => body?.merge_method === "squash")).toBe(true)
      } else await expect(stacks["stack land"]!(f.c, {}, options)).rejects.toThrow()
    }
  )
  it("rechecks gates immediately before merging", async () => {
    let checks = 0
    const f = fixture({
      github: (_method, path) => path.endsWith("/check-runs") && ++checks > 1 ? { check_runs: [] } : undefined
    })
    await expect(stacks["stack land"]!(f.c, {}, options)).rejects.toThrow("Refusing")
    expect(f.github.mock.calls.some(([method]) => method === "PUT")).toBe(false)
  })
  it.each([404, 422, 503])("handles unsubmit cleanup with HTTP %s", async (status) => {
    const f = fixture({
      github: (method) => {
        if (method === "DELETE") throw error(status)
        return { state: "closed" }
      }
    })
    if (status === 503) await expect(stacks["stack unsubmit"]!(f.c, {}, options)).rejects.toThrow("503")
    else {expect(await stacks["stack unsubmit"]!(f.c, {}, options)).toMatchObject({
        prs: [{ pr_number: 1, status: "already_closed" }],
        branches: [{ branch: "smithers/a1234567", status: "missing" }]
      })}
  })
  it.each([404, 503])("handles a missing PR during unsubmit (%s)", async (status) => {
    const f = fixture({
      github: (method) => {
        if (method === "GET") throw error(status)
      }
    })
    if (status === 404) {
      expect(object(await stacks["stack unsubmit"]!(f.c, {}, options)).prs).toEqual([{
        pr_number: 1,
        status: "missing"
      }])
    } else await expect(stacks["stack unsubmit"]!(f.c, {}, options)).rejects.toThrow("503")
  })
  it("accepts a concurrent close only after rereading the PR", async () => {
    let reads = 0
    const f = fixture({
      github: (method) => {
        if (method === "PATCH") throw error(422)
        if (method === "GET") return { state: ++reads === 1 ? "open" : "closed" }
      }
    })
    expect(object(await stacks["stack unsubmit"]!(f.c, {}, options)).stack_deleted).toBe(true)
    expect(reads).toBe(2)
  })
})
