import { expect } from "@playwright/test"
import { showcase } from "../showcase"

const REPO = "smithersai/smithers"
const API = `/api/repos/${REPO}`

const README = `# Smithers

Durable flows for coding agents: plan, run, review and land changes.

## Start

\`\`\`sh
pnpm install
pnpm --filter smithers-app start
\`\`\`
`

const TREE = [
  { name: "apps", path: "apps", type: "dir", size: 0 },
  { name: "flows", path: "flows", type: "dir", size: 0 },
  { name: "packages", path: "packages", type: "dir", size: 0 },
  { name: "AGENTS.md", path: "AGENTS.md", type: "file", size: 5120 },
  { name: "README.md", path: "README.md", type: "file", size: README.length },
  { name: "package.json", path: "package.json", type: "file", size: 2048 }
]

const change = (id: string, commit: string, description: string, parents: ReadonlyArray<string>, minutes: number) => ({
  change_id: id, commit_id: commit, description, author_name: "will", author_email: "will@example.com",
  timestamp: new Date(Date.UTC(2026, 8, 24, 10, minutes)).toISOString(), has_conflict: false, is_empty: false, parent_change_ids: parents
})
/* main's head is the cloud fixture's bookmark target, kxyzqrpv. */
const LOG = [
  change("kxyzqrpv", "c0ffee1234567890", "feat(app): the Stack card shows each lane's clock", ["tvwlmnop"], 40),
  change("tvwlmnop", "b1a2c3d4e5f60718", "fix(backend): price long-context tiers", ["srqponml"], 20),
  change("srqponml", "0a1b2c3d4e5f6071", "feat(backend): serve the system status", [], 0)
]

export default showcase({
  id: "repo-home",
  order: 60,
  title: "Repository",
  summary: "Open owner/name: its homepage, files, branches and commits, in chat.",
  flows: ["files.list", "files.read", "branches.list", "commits.list", "commits.read"],
  run: async ({ page, app, backend }) => {
    await backend.cloud()
    await backend.json(`${API}/home`, {
      kind: "blocks",
      blocks: [
        { type: "text", title: "smithersai/smithers", text: "Durable flows for coding agents." },
        { type: "links", links: [{ label: "Docs", url: "https://smithers.sh/docs" }, { label: "GitHub", url: "https://github.com/smithersai/smithers" }] },
        { type: "markdown", path: "README.md", markdown: README }
      ]
    })
    await backend.json("/api/public/repos", { repos: [{ name: REPO }] })
    await backend.json(API, { default_bookmark: "main" })
    await backend.json(`${API}/contents`, TREE)
    await backend.json(`${API}/changes`, { items: LOG, next_cursor: "" })
    for (const row of LOG) await backend.json(`${API}/changes/${row.change_id}`, row)
    await backend.json(`${API}/changes/kxyzqrpv/diff`, { change_id: "kxyzqrpv", file_diffs: [
      { path: "apps/app/src/mainview/cards/HomeContainer.tsx", change_type: "modified", additions: 12, deletions: 2, is_binary: false,
        patch: "@@ -40,3 +40,6 @@\n   <li className=\"mvp-run-row\">\n+    <span>{run.title}</span>\n+    <span>{run.detail}</span>\n   </li>" }
    ] })
    await backend.json("/api/repos/smithersai/smithers/commits/c0ffee1234567890/statuses", [
      { context: "typecheck", status: "success", created_at: "2026-09-24T10:42:00Z" },
      { context: "browser e2e", status: "success", created_at: "2026-09-24T10:47:00Z" }
    ])
    await backend.json(`${API}/contents/README.md`, { type: "file", path: "README.md", content: README, encoding: "utf-8" })

    await app.open(`/${REPO}`)
    const home = page.locator(".mvp-home").first()
    await expect(home).toContainText("T8")
    await app.show(home)
    await app.beat(1500)

    await app.slash(`/files.list / ${REPO}`)
    const list = page.locator('[data-kind="file-list"]').last()
    await expect(list).toContainText("README.md")
    await app.closeComposer()
    await app.show(list)
    await app.beat(900)

    await app.click(list.getByText("README.md", { exact: true }).first())
    const file = page.locator('[data-kind="file"]').last()
    await expect(file).toContainText("Durable flows for coding agents")
    await app.show(file)
    await app.beat(1500)

    await app.slash(`/branches.list ${REPO}`)
    const branches = page.locator('[data-kind="branches"]').last()
    await expect(branches).toContainText("main")
    await app.closeComposer()
    await app.show(branches)
    await app.beat(900)

    await app.slash(`/commits.list main ${REPO}`)
    const commits = page.locator('[data-kind="commit-list"]').last()
    await expect(commits).toContainText("price long-context tiers")
    await app.closeComposer()
    await app.show(commits)
    await app.beat(900)
    await app.click(commits.getByText("the Stack card shows each lane's clock").first())
    const commit = page.locator('[data-kind="commit"]').last()
    await expect(commit).toContainText("HomeContainer.tsx", { timeout: 15_000 })
    await app.show(commit)
    await app.beat(1500)
  }
})
