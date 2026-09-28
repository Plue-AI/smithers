import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { fallbackReport, prepare, validateReport } from "./github-triage.mjs"

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
