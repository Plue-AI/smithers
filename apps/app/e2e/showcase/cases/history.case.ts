import { expect } from "@playwright/test"
import type { MythicalItem, MythicalStack, MythicalWiki } from "@smthrs/rpc/Mythical"
import { showcase } from "../showcase"

const REPO = "smithersai/smithers"
const BASE = `/api/repos/${REPO}/mythical`

const item = (id: string, state: MythicalItem["state"], extra: Partial<MythicalItem> = {}): MythicalItem => ({
  id, state, attempt: 1, runs: {}, dependsOn: [], updatedAt: new Date().toISOString(),
  issue: { number: Number(id.slice(1)), title: id === "i7" ? "Retry a failed lane from its toast" : "Show lane seats", url: `https://github.com/${REPO}/issues/${id.slice(1)}` },
  ...extra
})

export default showcase({
  id: "history",
  order: 70,
  title: "History",
  summary: "History opens every change: landed ones, and issues moving through lanes live.",
  flows: ["history.show", "card.maximize", "history.backfill", "card.minimize", "wiki.create"],
  run: async ({ page, app, backend }) => {
    let startedAt = new Date().toISOString()
    let wiki: MythicalWiki = { state: "refreshing", commit: "c1", pages: 12, edited: 0, attempt: 1 }
    const snapshot = (generation: number, items: MythicalItem[]): MythicalStack => ({
      repository: REPO, state: "active", generation, mainBehind: false,
      changes: [
        { changeId: "kfoldchange00", commitId: "c2", title: "ci: pin the browser", kind: "fold", state: "landed" },
        { changeId: "kbootstrapchange", commitId: "c1", title: "Initial import", kind: "bootstrap", state: "landed" }
      ],
      items, lanes: [
        items.some(row => row.lane === 0)
          ? { index: 0, state: "busy", startedAt, account: { provider: "claude", label: "work@example.com", count: 2 }, seat: "opus" }
          : { index: 0, state: "idle" },
        { index: 1, state: "idle" }
      ],
      limits: { maxParallel: 2 },
      wiki
    })
    let current = snapshot(1, [item("i7", "queued"), item("i9", "queued")])
    let backfill = 403
    await backend.cloud()
    await backend.json(BASE, () => current)
    await backend.route(url => url.pathname === `${BASE}/events`, route => route.fulfill({
      status: 200, headers: { "content-type": "text/event-stream" },
      body: `event: mythical\ndata: {"generation":${current.generation},"kind":"item"}\n\n`
    }))
    await backend.route(url => url.pathname === `${BASE}/wiki`, route => {
      wiki = { ...wiki, state: "refreshing", attempt: wiki.attempt + 1, error: undefined }
      current = { ...current, generation: current.generation + 1, wiki }
      return route.fulfill({ status: 202, json: current })
    })
    await backend.route(url => url.pathname === `${BASE}/backfill`, route => backfill === 403
      ? route.fulfill({ status: 403, json: { message: "Only a repository writer can backfill." } })
      : route.fulfill({ status: 202, json: current }))

    await app.open("/")
    await app.click(page.getByTestId("chrome-history"))
    const card = page.locator('[data-kind="stack"]')
    await expect(card.getByTestId("stack-lane-count")).toHaveText("0/2 lanes")
    await expect(card.getByTestId("stack-landed")).toHaveText("2 landed")
    await expect(card.getByTestId("stack-change-kfoldchange00")).toContainText("ci: pin the browser")
    const wikiRow = card.getByTestId("stack-wiki")
    await expect(wikiRow.locator(".stack-state")).toHaveAttribute("data-state", "refreshing")
    await app.closeComposer()
    await app.show(card)
    await app.maximize(card)

    startedAt = new Date(Date.now() - 65_000).toISOString()
    wiki = { state: "current", commit: "c1", publishedCommit: "c1", pages: 14, edited: 1, attempt: 1 }
    current = snapshot(2, [item("i7", "integrating", { lane: 0 }), item("i9", "queued")])
    await expect(card.getByTestId("stack-lane-0")).toContainText("#7", { timeout: 15_000 })
    await expect(card.getByTestId("stack-lane-count")).toHaveText("1/2 lanes")
    await expect(wikiRow.locator(".stack-state")).toHaveAttribute("data-state", "current")
    await expect(wikiRow).toContainText("14 pages")
    await expect(wikiRow).toContainText("1 edited")
    await expect(page.locator('.toast-stack .toast[data-toast-status="running"]', { hasText: "#7" })).toBeVisible()
    await app.beat(2500)

    current = snapshot(3, [item("i7", "proposed", {
      checks: { state: "passed", failed: [] }, pullRequest: { number: 70, url: "https://github.com/pr/70", state: "open" }
    }), item("i9", "queued")])
    await expect(card.getByTestId("stack-item-i7")).toContainText("PR #70", { timeout: 15_000 })
    await app.beat(1500)
    await app.click(card.getByRole("button", { name: "Backfill", exact: true }))
    await expect(card).toHaveAttribute("data-maximized", "true")
    const failure = card.locator('[data-testid="stack-failure"][data-act="backfill"]')
    await expect(failure).toContainText("backfill")
    await app.beat(1200)
    backfill = 202
    await app.click(failure.getByRole("button", { name: "Retry" }))
    await expect(failure).toHaveCount(0)

    // The next fold's refresh fails review: the row states why and offers Retry, which runs until the Wiki is current again.
    wiki = { state: "failed", commit: "c2", publishedCommit: "c1", pages: 14, edited: 1, attempt: 1, error: "2 pages failed review" }
    current = { ...current, generation: current.generation + 1, wiki }
    await expect(wikiRow.locator(".stack-state")).toHaveAttribute("data-state", "failed", { timeout: 15_000 })
    await expect(wikiRow).toContainText("2 pages failed review")
    await app.beat(1200)
    await app.click(wikiRow.getByRole("button", { name: "Retry" }))
    const notice = page.locator('.toast-stack .toast[data-toast-status="running"]', { hasText: "Refreshing the Wiki" })
    await expect(notice).toBeVisible()
    await expect(wikiRow.getByRole("button", { name: "Retry" })).toHaveCount(0)
    await app.beat(1500)
    wiki = { state: "current", commit: "c2", publishedCommit: "c2", pages: 15, edited: 1, attempt: 2 }
    current = { ...current, generation: current.generation + 1, wiki }
    await expect(page.locator('.toast-stack .toast[data-toast-status="ok"]', { hasText: "Wiki current" })).toBeVisible({ timeout: 15_000 })
    await expect(wikiRow).toContainText("15 pages")
    await app.beat(1200)
    await expect(card).toHaveAttribute("data-maximized", "true")
    await app.beat(900)
    await app.click(card.getByRole("button", { name: "Restore" }))
    await expect(card).toHaveAttribute("data-maximized", "false")
  }
})
