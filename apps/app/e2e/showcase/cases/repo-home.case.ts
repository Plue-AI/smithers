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

export default showcase({
  id: "repo-home",
  order: 60,
  title: "Repository",
  summary: "Open owner/name: its homepage, files and branches, in chat.",
  flows: ["files", "file", "branches"],
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
    await backend.json(`${API}/contents/README.md`, { type: "file", path: "README.md", content: README, encoding: "utf-8" })

    await app.open(`/${REPO}`)
    const home = page.locator(".home").first()
    await expect(home).toContainText("T8")
    await app.show(home)
    await app.beat(1500)

    await app.slash(`/files / ${REPO}`)
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

    await app.slash(`/branches ${REPO}`)
    const branches = page.getByRole("navigation", { name: "Branches", exact: true })
    await expect(branches).toContainText("main")
    await app.closeComposer()
    await app.show(branches)
    await app.beat(900)


  }
})
