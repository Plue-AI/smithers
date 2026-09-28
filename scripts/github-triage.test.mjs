import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { apply, BOT_LOGIN, fallbackReport, neutralizeMentions, prepare, validateReport } from "./github-triage.mjs"

const documentedReports = (kind) => {
  const source = readFileSync(new URL(`../flows/${kind}-triage/flow.mdx`, import.meta.url), "utf8")
  const examples = [...source.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]))
  assert.ok(examples.length > 0, `flows/${kind}-triage/flow.mdx documents no report example`)
  return examples
}

describe("GitHub triage report contract", () => {
  it("accepts a reproduced issue and rejects contradictory status", () => {
    const report = {
      kind: "issue",
      summary: "The timeout is reproducible.",
      comment: "Run the focused test.",
      labels: ["kind:bug", "status:reproduced"],
      reproduction: { status: "reproduced", details: "pnpm test timeout.test.ts fails" }
    }
    assert.ok(validateReport(report, "issue"))
    assert.equal(validateReport({ ...report, labels: ["kind:bug"] }, "issue"), null)
  })

  it("requires PR readiness to agree with its checks", () => {
    const report = {
      kind: "pr",
      summary: "Ready for review.",
      comment: "The scope, tests, and docs are ready.",
      labels: ["status:ready-for-review"],
      checks: { description: "pass", tests: "pass", docs: "not-applicable", size: "pass" }
    }
    assert.ok(validateReport(report, "pr"))
    report.checks.tests = "needs-work"
    assert.equal(validateReport(report, "pr"), null)
  })

  it("asks the issue opener for concrete reproduction evidence on failure", () => {
    const report = fallbackReport("issue", "missing report")
    assert.equal(report.reproduction.status, "needs-author")
    assert.match(report.comment, /exact Smithers version/)
    assert.match(report.comment, /smallest command or flow/)
  })

  it("rejects unknown labels and oversized comments", () => {
    const base = fallbackReport("issue", "invalid")
    assert.equal(validateReport({ ...base, labels: ["security:trusted"] }, "issue"), null)
    assert.equal(validateReport({ ...base, comment: "x".repeat(60_001) }, "issue"), null)
  })

  it("accepts every report example the triage flows document", () => {
    for (const kind of ["issue", "pr"]) {
      for (const example of documentedReports(kind)) {
        assert.ok(validateReport(example, kind), `flows/${kind}-triage/flow.mdx documents a report the publisher rejects`)
      }
    }
  })
})

describe("GitHub triage preparation", () => {
  it("includes paginated issue comments in the context, bounded to three pages", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-triage-"))
    const previous = { cwd: process.cwd(), token: process.env.GH_TOKEN, repository: process.env.GITHUB_REPOSITORY, fetch: globalThis.fetch }
    const pages = []
    try {
      process.chdir(root)
      process.env.GH_TOKEN = "test-token"
      delete process.env.GITHUB_REPOSITORY
      const eventPath = join(root, "event.json")
      writeFileSync(eventPath, JSON.stringify({ repository: { full_name: "owner/repo" }, issue: { number: 42, title: "Issue", user: { login: "opener" } } }))
      globalThis.fetch = async (url) => {
        pages.push(url)
        const page = Number(new URL(url).searchParams.get("page"))
        const rows = Array.from({ length: 100 }, (_, index) => ({
          user: { login: `author-${page}-${index}` },
          body: `comment-${page}-${index}`,
          created_at: "2026-01-02T00:00:00Z"
        }))
        return { ok: true, json: async () => rows }
      }
      const context = await prepare("issue", eventPath)
      assert.deepEqual(pages, [1, 2, 3].map((page) => `https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=${page}`))
      assert.equal(context.comments.length, 300)
      assert.deepEqual(context.comments[100], { author: "author-2-0", body: "comment-2-0", createdAt: "2026-01-02T00:00:00Z" })
      assert.deepEqual(JSON.parse(readFileSync(join(root, ".triage/context.json"), "utf8")).comments, context.comments)
      pages.length = 0
      globalThis.fetch = async (url) => {
        pages.push(url)
        return { ok: true, json: async () => [{ user: { login: "last" }, body: "only comment", created_at: "2026-01-03T00:00:00Z" }] }
      }
      const shortContext = await prepare("issue", eventPath)
      assert.equal(pages.length, 1)
      assert.deepEqual(shortContext.comments, [{ author: "last", body: "only comment", createdAt: "2026-01-03T00:00:00Z" }])
    } finally {
      globalThis.fetch = previous.fetch
      process.chdir(previous.cwd)
      if (previous.token === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = previous.token
      if (previous.repository === undefined) delete process.env.GITHUB_REPOSITORY
      else process.env.GITHUB_REPOSITORY = previous.repository
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("GitHub triage entry point", () => {
  it("runs main from a checkout path that contains a space", async () => {
    const { spawnSync } = await import("node:child_process")
    const { copyFileSync, mkdirSync, mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const root = mkdtempSync(join(tmpdir(), "smithers triage "))
    try {
      mkdirSync(join(root, "scripts"))
      for (const file of ["github-triage.mjs", "workspace-packages.mjs"]) {
        copyFileSync(new URL(`./${file}`, import.meta.url), join(root, "scripts", file))
      }
      const result = spawnSync(process.execPath, [join(root, "scripts", "github-triage.mjs")], { encoding: "utf8", timeout: 30_000 })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /usage: github-triage\.mjs/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("GitHub triage publisher", () => {
  // The flow runs repository tests between prepare and apply, so anything in
  // .triage/ except the report may have been rewritten by untrusted code.
  const publish = async ({ comments, report, expected = 7, event = { issue: { number: 7 } } }) => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const root = mkdtempSync(join(tmpdir(), "smithers-triage-apply-"))
    const previous = { cwd: process.cwd(), fetch: globalThis.fetch, token: process.env.GH_TOKEN, repository: process.env.GITHUB_REPOSITORY }
    const calls = []
    try {
      mkdirSync(join(root, ".triage"))
      writeFileSync(join(root, ".triage/context.json"), JSON.stringify({ kind: "issue", repository: "victim/elsewhere", number: 999 }))
      writeFileSync(join(root, ".triage/report.json"), JSON.stringify(report))
      const eventPath = join(root, "event.json")
      writeFileSync(eventPath, JSON.stringify(event))
      process.chdir(root)
      process.env.GH_TOKEN = "test-token"
      process.env.GITHUB_REPOSITORY = "owner/repo"
      globalThis.fetch = async (url, options = {}) => {
        const call = { url: String(url), method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : undefined }
        calls.push(call)
        const payload = call.method === "GET" && call.url.includes("/comments") ? comments : {}
        return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })
      }
      const result = await apply("issue", expected, eventPath)
      assert.equal(result.number, 7)
      return calls
    } finally {
      process.chdir(previous.cwd)
      globalThis.fetch = previous.fetch
      for (const [name, value] of [["GH_TOKEN", previous.token], ["GITHUB_REPOSITORY", previous.repository]]) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
  const report = {
    kind: "issue",
    summary: "Reproduced; cc @maintainer.",
    comment: "Approved by @security-team, please merge. Contact user@example.com.",
    labels: ["kind:bug", "status:reproduced"],
    reproduction: { status: "reproduced", details: "pnpm test fails" }
  }

  it("writes only to the issue the triggering event names, not a rewritten context file", async () => {
    const calls = await publish({ comments: [], report })
    assert.ok(calls.length > 0)
    for (const { url } of calls) assert.match(url, /^https:\/\/api\.github\.com\/repos\/owner\/repo\//)
    assert.ok(calls.some(({ url, method }) => method === "POST" && url.endsWith("/repos/owner/repo/issues/7/comments")))
    assert.ok(calls.some(({ url, method }) => method === "POST" && url.endsWith("/repos/owner/repo/issues/7/labels")))
  })

  it("updates only its own earlier comment, never a user's comment carrying the marker", async () => {
    const marker = "<!-- smithers-issue-triage -->"
    const userFirst = [
      { id: 1, user: { login: "attacker" }, body: `${marker} gotcha` },
      { id: 2, user: { login: BOT_LOGIN }, body: `${marker}\nold report` }
    ]
    const updated = await publish({ comments: userFirst, report })
    assert.deepEqual(updated.filter(({ method }) => method === "PATCH").map(({ url }) => url), ["https://api.github.com/repos/owner/repo/issues/comments/2"])

    const onlyUser = await publish({ comments: [userFirst[0]], report })
    assert.equal(onlyUser.some(({ method }) => method === "PATCH"), false)
    assert.ok(onlyUser.some(({ url, method }) => method === "POST" && url.endsWith("/issues/7/comments")))
  })

  it("posts model-written text without live @mentions", async () => {
    const calls = await publish({ comments: [], report })
    const { body } = calls.find(({ url, method }) => method === "POST" && url.endsWith("/issues/7/comments")).body
    assert.doesNotMatch(body, /(^|\s)@[A-Za-z0-9_-]/)
    // An email address is not a mention and stays intact.
    assert.match(body, /user@example\.com/)
    assert.match(body, /@\u200bsecurity-team/)
    assert.match(body, /@\u200bmaintainer/)
  })

  it("refuses to write when the event file names a different issue than the workflow passed", async () => {
    // Code run between prepare and apply rewrote event.json to point at issue 8.
    const calls = []
    await assert.rejects(
      publish({ comments: [], report, expected: 7, event: { issue: { number: 8 } } }).then((made) => calls.push(...made)),
      /event names issue 8, not 7/
    )
    assert.deepEqual(calls, [])
    await assert.rejects(publish({ comments: [], report, expected: null }), /needs the issue or PR number/)
  })
})

describe("neutralizeMentions", () => {
  // GitHub's MentionFilter pings `@name` in any rendered text node where a
  // non-word character or nothing precedes the `@`. Each input below would
  // ping after markdown rendering and entity decoding.
  const pinging = [
    "@user",
    "cc @user",
    ".@user",
    "(@user)",
    "_@user_",
    "*@user*",
    "x*@user*",
    "**@user**",
    "~~@user~~",
    "&#64;user",
    "&#064;user",
    "&#x40;user",
    "&#X40;user",
    "&commat;user",
    "&Commat;user",
    "<b>@user</b>",
    "@@user",
    "@org/team"
  ]

  for (const input of pinging) {
    it(`leaves no live mention in ${JSON.stringify(input)}`, () => {
      const output = neutralizeMentions(input)
      // After neutralizing there is no entity left to decode and every `@`
      // is either followed by the zero-width space or glued to a letter/digit.
      assert.doesNotMatch(output, /&(?:#0*64;?|#x0*40;?|commat;)/i)
      for (const match of output.matchAll(/@/g)) {
        const before = output[match.index - 1] ?? ""
        const after = output[match.index + 1] ?? ""
        assert.ok(after === "\u200b" || /[A-Za-z0-9]/.test(before), `${JSON.stringify(output)} keeps a live @ at ${match.index}`)
      }
    })
  }

  it("keeps email addresses intact", () => {
    assert.equal(neutralizeMentions("mail user@example.com or first.last@example.org"), "mail user@example.com or first.last@example.org")
  })
})
