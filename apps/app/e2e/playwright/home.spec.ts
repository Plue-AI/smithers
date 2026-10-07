import { expect, test } from "./browserTest"
import type { Page } from "./browserTest"
import { fillComposer } from "./composer"

/*
 * The Home card (T-APP-01) on the seeded design world: it stands first in
 * main's conversation with the stack in merge order; the row menu's Move up
 * and `/stack.move` reorder it; a failed background run's Retry runs it again
 * and Dismiss removes it; `/stack` returns a member on a branch to main.
 */

/** A slash command through the composer: Control+K, type, Enter, Escape. */
const command = async (page: Page, line: string): Promise<void> => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await expect(input).toBeFocused()
  await input.fill(line)
  await expect(page.getByTestId("composer-send")).toBeEnabled()
  await page.keyboard.press("Enter")
  await expect(input).toHaveValue("")
  if (await input.isVisible()) await page.keyboard.press("Escape")
}

test("the Home card: merge order, Move, a failed run's Retry and Dismiss, and /stack", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto("/")
  const home = page.locator(".home").first()
  await expect(home).toBeVisible()
  const refs = home.locator(".stack-row .ref")
  await expect(refs).toHaveText(["T8", "T9", "T10", "T11"])
  await expect(home.locator(".stack-row[data-state='in_review']").getByRole("button", { name: "Merge", exact: true })).toBeVisible()

  await home.getByRole("button", { name: "Order Log every webhook retry attempt", exact: true }).click()
  await home.getByRole("menuitem", { name: "Move up", exact: true }).click()
  await expect(refs).toHaveText(["T8", "T9", "T11", "T10"])
  await command(page, "/stack.move T11 down")
  await expect(refs).toHaveText(["T8", "T9", "T10", "T11"])

  const failed = home.locator(".run-row[data-state='failed']", { hasText: "release-notes" })
  await expect(failed).toContainText("GitHub API rate limited")
  await expect(failed.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible()
  await failed.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(home.locator(".run-row", { hasText: "release-notes" })).toHaveAttribute("data-state", "running")
  await command(page, "/background.dismiss r-release")
  await expect(home.locator(".run-row", { hasText: "release-notes" })).toHaveCount(0)
  await expect(home.locator(".run-row", { hasText: "Wiki refresh" })).toHaveCount(1)

  // /stack from a branch returns to main, where the Home card stands first: the crumbs lose the branch.
  const crumbs = page.locator(".session-navigation")
  await command(page, "/branch retry-webhooks")
  await expect(crumbs).toContainText("retry-webhooks")
  await command(page, "/stack")
  await expect(crumbs).not.toContainText("retry-webhooks")
  await expect(home).toBeVisible()
})



test("T-UI-06 Home sync, actions, keyboard menu and inert text in both Paper themes", async ({ page }) => {
  test.setTimeout(180_000)
  await page.addInitScript(() => {
    const calls: unknown[] = []
    Object.assign(window, { homeCalls: calls })
    window.addEventListener("story-callback", event => {
      const detail = (event as CustomEvent).detail
      if (detail.kind === "action") calls.push(detail)
    })
  })
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const [state, text, control] of [
      ["fresh", "synced", "New TODO"], ["stale", "GitHub sync delayed", "Retry"],
      ["limited", "retries at 10:42", "New TODO"], ["refused", "Repository access refused", "Fix"],
    ] as const) {
      await page.goto(`/view-stories.html?story=HomeView/home-${state}&theme=${theme}`)
      await expect(page.locator('.home .sync')).toContainText(text)
      await expect(page.getByRole("button", { name: control, exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await page.goto(`/view-stories.html?story=HomeView/home-active&theme=${theme}`)
    await page.getByRole("button", { name: "Order Persist merge requests", exact: true }).focus()
    await page.keyboard.press("Enter")
    const menu = page.getByRole("menu", { name: "Order Persist merge requests", exact: true })
    await page.keyboard.press("Tab")
    await expect(menu.getByRole("menuitem", { name: "Move up", exact: true })).toBeFocused()
    await page.keyboard.press("ArrowDown")
    await expect(menu.getByRole("menuitem", { name: "Move down", exact: true })).toBeFocused()
    await page.keyboard.press("Enter")
    expect(await page.evaluate(() => Reflect.get(window, "homeCalls"))).toEqual([
      { kind: "action", value: { tag: "stack.move", args: { n: "8", direction: "down" } } },
    ])
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Order Persist merge requests", exact: true })).toBeFocused()
    await page.goto(`/view-stories.html?story=HomeView/home-fresh&removeFirst&theme=${theme}`)
    await expect(page.locator('.home button[data-flow]')).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Reset to GitHub main", exact: true })).toHaveCount(0)
    await page.goto(`/view-stories.html?story=HomeView/home-disabled&theme=${theme}`)
    await expect(page.locator('.home button[data-flow]')).toHaveCount(6)
    await expect(page.locator('.home')).toContainText("Permission missing")
    for (const button of await page.locator('.home button[data-flow]').all()) {
      await expect(button).toBeDisabled()
      await button.evaluate(node => (node as HTMLButtonElement).click())
    }
    expect(await page.evaluate(() => Reflect.get(window, "homeCalls"))).toEqual([])
    await page.goto(`/view-stories.html?story=HomeView/home-hostile&theme=${theme}`)
    const hostile = '<img src=x onerror="window.__homePwned=1"><script>window.__homePwned=1</script>'
    await expect(page.locator('.home h2')).toHaveText(hostile)
    await expect(page.locator('.home .sync')).toHaveText(hostile)
    await expect(page.locator('.home .home-attention')).toHaveText(hostile)
    await expect(page.locator('.home .stack-title')).toContainText(hostile)
    await expect(page.locator('.home button[data-flow]')).toHaveText(hostile)
    await expect(page.locator('.home img, .home script')).toHaveCount(0)
    expect(await page.evaluate(() => Reflect.get(window, "__homePwned"))).toBeUndefined()
  }
})

test("install Home keeps the next Merge after an earlier item merged and exposes reorder controls", async ({ page, baseURL }) => {
  const { installCloudFixture } = await import("./cloudFixture")
  const { fixtures } = await import("@smthrs/rpc/fixtures/Todo")
  await installCloudFixture(page, { capabilities: ["agent", "identity", "install"] })
  // Bind each intercepted request to the session that sent it. A teardown
  // request from Ben must never be written into Alice's view after navigation.
  const principal = (headers: Record<string, string>) => headers.cookie?.match(/home_member=(ben|alice|maya)/)?.[1] ?? "ben"
  const signIn = async (login: string) => {
    await page.goto("about:blank")
    await page.context().addCookies([{ name: "home_member", value: login, url: baseURL! }])
    await page.goto("/")
  }
  const memberViews: Record<string, Record<string, unknown>> = {
    ben: { scroll_anchor: "entry-8", last_seen_seq: 12, home: { filter: null }, toasts_hidden: false },
    alice: { home: { filter: null }, toasts_hidden: false },
    maya: { home: { filter: null }, toasts_hidden: false }
  }
  const viewWrites: Array<{ login: string; body: unknown }> = []
  await page.route("**/api/conversations/main/view-state", route => {
    const login = principal(route.request().headers())
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON()
      viewWrites.push({ login, body }); memberViews[login] = body
    }
    return route.fulfill({ json: memberViews[login] })
  })
  await page.route("**/api/user", route => {
    const login = principal(route.request().headers())
    return route.fulfill({ json: { id: { ben: 1, alice: 2, maya: 3 }[login], username: login, is_admin: false } })
  })
  await page.route("**/api/install", route => route.fulfill({ json: {
    steps: ["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"].map(id => ({ id, state: "done" })), capacity: 2, this_mac: { capacity: 2, memory_gb: 16, disk_free_gb: 100 },
    github: { app_installed: true, signed_in: true, owner: "maya", squash_allowed: true },
    repository: { owner: "acme", name: "api" }, models: ["fast", "coding", "jev"].map(role => ({ role, provider: "saved", key: "saved" })), chatgpt: false,
    address: { bind: "127.0.0.1:4000", origins: ["http://127.0.0.1:4000"], listen: "mac" }
  } }))
  const review = { ...fixtures.in_review.model, state: "in_review", merge: { state: "ready", on_github: true },
    pr: { ...fixtures.in_review.model.pr, draft: false } }
  await page.route("**/api/members", route => route.fulfill({ json: {
    access_url: "https://github.com/acme/api/settings/access",
    members: [
      { ...fixtures.in_review.model.owner, login: "maya", name: "Maya", color_index: 0, role: "owner", needs_access: false, suspended: false, actions: [] },
      { ...fixtures.in_review.model.owner, login: "ben", name: "Ben", color_index: 1, role: "maintainer", needs_access: false, suspended: false, actions: [] },
      { ...fixtures.in_review.model.owner, login: "alice", name: "Alice", color_index: 2, role: "member", needs_access: false, suspended: false, actions: [] }
    ]
  } }))
  let conflict = false
  let moved = false
  let dropped = false
  const drops: Array<{ body: unknown; key: string | undefined }> = []
  const moves: Array<{ body: unknown; key: string | undefined }> = []
  const secondTodo = { ...review, n: 2, place: 2, title: "Second TODO" }
  const thirdTodo = { ...review, n: 3, place: 3, title: "Third TODO" }
  const currentTodos = () => (moved ? [{ ...thirdTodo, place: 2 }, { ...secondTodo, place: 3 }] : [secondTodo, thirdTodo]).filter(todo => !dropped || todo.n !== 2).map(todo => conflict && todo.n === 3 ? { ...todo, state: "needs_you", waits: fixtures.conflict.model.waits } : todo)
  await page.route("**/api/todos", route => route.fulfill({ json: [
    { ...fixtures.merged.model, n: 1, place: 1 }, { ...fixtures.dropped.model, n: 4, place: 4 }, ...currentTodos()
  ] }))
  await page.route("**/api/todos/2", route => {
    if (route.request().method() === "POST") {
      drops.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] })
      dropped = true
      return route.fulfill({ status: 202, json: { state: "accepted", n: 2 } })
    }
    return route.fulfill({ json: dropped ? { ...fixtures.dropped.model, n: 2, title: "Second TODO" } : currentTodos().find(todo => todo.n === 2) })
  })
  await page.route("**/api/todos/3", route => {
    if (route.request().method() === "POST") {
      moves.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] })
      moved = true
      return route.fulfill({ status: 202, json: { state: "accepted", n: 3, place: 2 } })
    }
    return route.fulfill({ json: currentTodos().find(todo => todo.n === 3) })
  })
  await signIn("ben")
  const home = page.locator(".home").first()
  await expect(home).toBeVisible()
  await expect(home.locator(".stack-row .ref")).toHaveText(["T2", "T3"])
  await expect(home.locator('[data-filter="in_review"]')).toContainText("2")
  const second = home.locator(".stack-row").filter({ hasText: "Second TODO" })
  const third = home.locator(".stack-row").filter({ hasText: "Third TODO" })
  await expect(second.getByRole("button", { name: "Merge", exact: true })).toBeVisible()
  await expect(third.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await third.getByRole("button", { name: "Order Third TODO", exact: true }).press("Enter")
  await expect(third.getByRole("menuitem", { name: "Move up", exact: true })).toBeVisible()
  await expect(third.getByRole("menuitem", { name: "Move down", exact: true })).toHaveCount(0)
  await expect(third.getByRole("menuitem", { name: "Drop", exact: true })).toBeVisible()
  await expect.poll(() => memberViews.ben?.home).toEqual({ filter: null, menu: 3 })
  await page.reload()
  await expect(home).toBeVisible({ timeout: 30_000 })
  await expect(third.getByRole("menuitem", { name: "Move up", exact: true })).toBeVisible()
  await expect(home).not.toContainText("Stripe")
  await third.getByRole("menuitem", { name: "Move up", exact: true }).press("Enter")
  await expect.poll(() => moves.length).toBe(1)
  expect(moves[0]!.body).toEqual({ op: "move", direction: "up" })
  expect(moves[0]!.key).toMatch(/^[0-9a-f-]{36}$/)
  await expect(home.locator(".stack-row .ref")).toHaveText(["T3", "T2"])
  await expect(third.getByRole("button", { name: "Merge", exact: true })).toBeVisible()
  await expect(second.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await second.getByRole("button", { name: "Order Second TODO", exact: true }).press("Enter")
  await second.getByRole("menuitem", { name: "Drop", exact: true }).press("Enter")
  expect(drops).toEqual([])
  await page.getByRole("button", { name: "Confirm: drop this TODO", exact: true }).press("Enter")
  await expect.poll(() => drops.length).toBe(1)
  expect(drops[0]!.body).toEqual({ op: "drop" })
  expect(drops[0]!.key).toMatch(/^[0-9a-f-]{36}$/)
  await expect(home.locator(".stack-row .ref")).toHaveText(["T3"])
  await expect(home.locator('[data-filter="in_review"]')).toContainText("1")

  // Navigation may advance the anchor while a card scrolls into view.
  // Filtering must retain the member's independent look and toast preferences.
  viewWrites.length = 0
  const reviewFilter = home.locator('[data-filter="in_review"]')
  await reviewFilter.click()
  await expect.poll(() => memberViews.ben?.home).toEqual({ filter: "in_review", menu: null })
  expect(viewWrites.findLast(write => write.login === "ben" && (write.body as { home?: { filter?: string } }).home?.filter === "in_review")).toEqual({ login: "ben", body: { scroll_anchor: expect.stringMatching(/^(home|todo:3)$/), last_seen_seq: 12, home: { filter: "in_review", menu: null }, toasts_hidden: false, timeline_visible_until: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) } })
  await page.reload()
  await expect(reviewFilter).toHaveAttribute("aria-pressed", "true")
  await signIn("alice")
  await expect(home.getByText("T3", { exact: true })).toBeVisible()
  await expect(home.getByText("T2", { exact: true })).toHaveCount(0)
  await expect(home.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await expect(reviewFilter).toHaveAttribute("aria-pressed", "false")
  expect(memberViews.ben?.home).toEqual({ filter: "in_review", menu: null })
  await signIn("maya")
  await expect(home.getByRole("button", { name: "Merge", exact: true })).toHaveCount(1)
  const backgroundWrites: string[] = []
  await page.route("**/api/runs/**", route => {
    if (route.request().method() === "POST") backgroundWrites.push(route.request().url())
    return route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Unavailable" } } })
  })
  for (const name of ["retry", "dismiss"]) {
    await command(page, `/background.${name} stored-failure`)
    await expect(page.getByText("Background runs unavailable", { exact: true }).first()).toBeVisible()
  }
  expect(backgroundWrites).toEqual([])
  await expect(home.locator(".run-row")).toHaveCount(0)
  await expect(home.locator(".stack-row .ref")).toHaveText(["T3"])
  conflict = true
  await expect(home.getByRole("button", { name: "Resolve", exact: true })).toBeVisible()
  await expect(home.getByRole("button", { name: "Answer", exact: true })).toHaveCount(0)
  await expect(home.locator('.branch-chip')).toHaveCount(1)
})

test("install Home keeps capacity from the shared live snapshot across updates", async ({ page }) => {
  const { installCloudFixture } = await import("./cloudFixture")
  const { installFixture } = await import("../../src/mainview/state/seams/InstallFixtures.test-support")
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "maya", is_admin: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: { ...installFixture(), capacity: 3 } }))
  await page.route("**/api/todos", route => route.fulfill({ json: [] }))
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: [] } }))
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: {} }))
  let capacity = 2
  const publishers: Array<() => void> = []
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    const frame = JSON.parse(String(raw))
    if (frame.t !== "sub") return
    if (frame.topic !== "home") { socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" })); return }
    let cursor = 0
    const publish = () => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: ++cursor, data: {
      repository: "owner/repo", main: { sha: "a".repeat(40), title: "main", last_success_at: "2026-10-07T00:00:00Z", health: "fresh" },
      attention: [], items: [], counts: { queued: 0, starting: 0, working: 0, needs_you: 0, paused: 0, failed: 0, in_review: 0, merged: 0, dropped: 0 },
      merged_since_last_look: [], machines: { in_use: 0, capacity, slots: [] }, background_runs: []
    } }))
    publishers.push(publish); publish()
  }))
  await page.goto("/")
  await fillComposer(page, "/stack")
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("composer-input")).toHaveValue("")
  const home = page.locator(".home").first()
  await expect(home).toContainText("0/2 machines")
  await expect(home).not.toContainText("0/3 machines")
  capacity = 4
  publishers.forEach(publish => publish())
  await expect(home).toContainText("0/4 machines")
  await expect(home).not.toContainText("0/3 machines")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
