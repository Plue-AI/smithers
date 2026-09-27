import { expect } from "@playwright/test"
import { showcase } from "../showcase"

/* The workspace routes follow e2e/playwright/citc.spec.ts and state/seams/WorkspaceSeam.ts. */
const REPO = "smithersai/smithers"
const API = `/api/repos/${REPO}`
const WS = `${API}/workspaces/ws-1`

// Hosts come from URLs, as the egress log records them.
const hostOf = (url: string): string => new URL(url).host
const EGRESS = [
  { occurred_at: "2026-09-25T10:02:11Z", host: hostOf("https://api.anthropic.com/"), method: "POST", path: "/v1/messages", status: 200, allowed: true, swapped_secret_names: ["ANTHROPIC_API_KEY"] },
  { occurred_at: "2026-09-25T10:01:40Z", host: hostOf("https://registry.npmjs.org/"), method: "GET", path: "/effect", status: 200, allowed: true, swapped_secret_names: [] },
  { occurred_at: "2026-09-25T10:01:02Z", host: hostOf("https://example.net/"), method: "GET", path: "/collect", status: 403, allowed: false, swapped_secret_names: [] }
]

export default showcase({
  id: "workspace",
  order: 118,
  title: "Boxes",
  summary: "A box per branch: its files, services, egress; suspend, resume, delete.",
  flows: ["box.open", "box.facet", "box.file", "box.suspend", "box.resume", "box.list", "box.images", "egress.session", "box.delete"],
  run: async ({ page, app, backend }) => {
    let status = "running"
    let polls = 0
    let deleted = false
    const acts: Array<string> = []
    const ws = () => ({
      id: "ws-1", repo_full_name: REPO, name: "split-flow", target_bookmark: "main", status,
      provisioning_stage: status === "starting" ? "boot" : null, suspended_at: status === "suspended" ? "2026-09-25T10:05:00Z" : null,
      created_at: "2026-09-25T10:00:00Z"
    })
    await backend.cloud()
    await backend.route(url => url.pathname === `${API}/workspaces` || url.pathname === "/api/user/workspaces", route => {
      if (route.request().method() === "POST") return route.fulfill({ status: 201, json: { ...ws(), status: "pending", provisioning_stage: "allocating" } })
      return route.fulfill({ json: deleted ? [] : [ws()] })
    })
    await backend.route(url => url.pathname === WS, route => {
      if (route.request().method() === "DELETE") {
        acts.push("delete")
        deleted = true
        return route.fulfill({ status: 204, body: "" })
      }
      if (deleted) return route.fulfill({ status: 404, json: { message: "workspace not found" } })
      polls += 1
      if (status === "starting" && polls > 1) status = "running"
      return route.fulfill({ json: ws() })
    })
    await backend.route(url => url.pathname === `${WS}/suspend` || url.pathname === `${WS}/resume`, route => {
      const verb = route.request().url().endsWith("/suspend") ? "suspend" : "resume"
      acts.push(verb)
      status = verb === "suspend" ? "suspended" : "running"
      return route.fulfill({ json: ws() })
    })
    await backend.json(`${API}/workspace/sessions`, [])
    await backend.json(`${WS}/files`, [
      { name: "flows", path: "flows", type: "dir", size: 0 },
      { name: "package.json", path: "package.json", type: "file", size: 2048 },
      { name: "README.md", path: "README.md", type: "file", size: 120 }
    ])
    await backend.json(`${WS}/files/content`, { path: "README.md", content: "# Smithers\n\nEdited in the workspace: the split flow is wired in.\n", encoding: "utf-8" })
    await backend.json(`${WS}/services`, [
      { name: "postgres", state: "running", port: 5432 },
      { name: "app", state: "running", port: 5173, url: "https://ws-1-5173.smithers.dev" }
    ])
    await backend.json(`${WS}/egress`, EGRESS)
    await backend.json(`${API}/agent-sessions/as-7/egress`, EGRESS.slice(0, 1))
    await backend.json(`${API}/environment-images`, [
      { id: 3, kind: "container", source: "flake", source_revision: "c0ffee12", closure_hash: "9f8e7d6c5b4a", image: "smithers-env:c0ffee12", status: "ready", repository_id: 7, golden_snapshot_id: "snap-1" },
      { id: 1, kind: "container", source: "base", closure_hash: "0a1b2c3d", image: "smithers-base:2026-09", status: "ready", repository_id: 0, golden_snapshot_id: "" }
    ])

    await app.open("/")
    await app.slash(`/box.open main ${REPO}`)
    const card = page.getByTestId("card-workspace-ws-1")
    await expect(card).toContainText("Running", { timeout: 20_000 })
    await app.closeComposer()
    await app.show(card)

    await app.click(card.getByRole("tab", { name: "Files" }))
    await expect(card).toContainText("README.md")
    const readme = card.locator('[data-flow="box.file"]').filter({ hasText: "README.md" }).first()
    await app.click(readme)
    await expect(page.locator('[data-kind="file"]').last()).toContainText("the split flow is wired in", { timeout: 15_000 })
    await app.show(card)
    await app.click(card.getByRole("tab", { name: "Services" }))
    await expect(card).toContainText("postgres")
    await app.beat(500)
    await app.click(card.getByRole("tab", { name: "Egress" }))
    await expect(card).toContainText(EGRESS[0]!.host)
    await app.beat(900)

    await app.click(card.getByRole("button", { name: "Suspend", exact: true }))
    await expect(card.getByRole("button", { name: "Resume", exact: true })).toBeVisible({ timeout: 15_000 })
    await app.beat(600)
    await app.click(card.getByRole("button", { name: "Resume", exact: true }))
    await expect(card.getByRole("button", { name: "Suspend", exact: true })).toBeVisible({ timeout: 15_000 })

    await app.slash(`/box.list ${REPO}`)
    await app.slash(`/box.images ${REPO}`)
    await app.slash(`/egress.session as-7 ${REPO}`)
    await app.closeComposer()
    const images = page.locator(".smithers-card", { hasText: "platform base" }).last()
    await expect(images).toBeVisible({ timeout: 15_000 })
    await expect(page.locator("article", { hasText: "secrets ANTHROPIC_API_KEY" }).last()).toBeVisible({ timeout: 15_000 })
    await app.show(images)
    await app.beat(1000)

    await app.show(card)
    await app.click(card.getByRole("button", { name: "Delete", exact: true }))
    await app.type(card.getByLabel("Type split-flow to confirm the delete"), "split-flow")
    await app.click(card.getByRole("button", { name: "Delete permanently" }))
    await expect.poll(() => acts).toEqual(["suspend", "resume", "delete"])
    await app.beat(1200)
  }
})
