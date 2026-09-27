import { expect,test,type Page } from "./browserTest"
import { installCloudFixture } from "./cloudFixture"

/*
 * Durable frame contract: the same card node expands in chat, frame identity
 * is addressable, browser history restores presentation, and a fork gets a
 * new branch without losing its source URL. The explicitly requested theme
 * picker provides a deterministic card without depending on repository I/O.
 */
test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the deterministic local-app lane")

const openWorkspaceChat = async (page: Page): Promise<void> => {
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } }))
  const chat = page.getByRole("button", { name: "Chat", exact: true })
  await expect(chat).toBeVisible()
  const dismiss = page.getByRole("button", { name: "Dismiss", exact: true })
  if (await dismiss.isVisible()) await dismiss.click()
}

const sendSlash = async (page: Page, line: string): Promise<void> => {
  await page.getByRole("button", { name: "Chat", exact: true }).click()
  await page.getByTestId("composer-input").fill(line)
  await page.getByTestId("composer-send").click()
  await expect(page.getByTestId("composer-input")).toHaveValue("")
  await page.getByTestId("composer-input").press("Escape")
  await expect(page.getByTestId("composer-input")).toBeHidden()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // A browser that denies storage is already an empty profile.
    }
  })
})

test("clear archives locally and its recovery link restores the conversation after reload", async ({ page }) => {
  let summaryRequests = 0
  await page.route("**/api/model/stream", async (route) => {
    summaryRequests++
    await route.fulfill({ status: 503, body: "offline" })
  })
  await page.goto("/")
  await openWorkspaceChat(page)
  await sendSlash(page, "/appearance.theme")
  const card = page.getByTestId("transcript").locator('.smithers-card[data-kind="theme-picker"]')
  await expect(card).toBeVisible()
  const cardId = await card.getAttribute("data-testid")
  const originalUrl = page.url()
  await sendSlash(page, "/chat.clear")
  await expect(page.getByRole("link", { name: "Open the archived conversation" })).toBeVisible()
  await expect(card).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await expect(page).not.toHaveURL(originalUrl)
  const newUrl = page.url()
  await page.reload()
  await page.getByRole("link", { name: "Open the archived conversation" }).click()
  await expect(page).toHaveURL(originalUrl)
  await expect(page.getByTestId(cardId!)).toBeVisible()
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(newUrl)
  await expect(page.getByRole("link", { name: "Open the archived conversation" })).toBeVisible()
  expect(summaryRequests).toBe(0)
})

test("frame URLs survive reload, traverse history, preserve the card node, and fork", async ({ page }) => {
  await page.goto("/")
  await openWorkspaceChat(page)
  await sendSlash(page, "/appearance.theme")

  const card = page.locator('.smithers-card[data-kind="theme-picker"]')
  await expect(card).toBeVisible()
  const cardId = (await card.getAttribute("data-testid"))?.replace(/^card-/, "")
  expect(cardId).toBeTruthy()

  await card.evaluate((node) => {
    ;(node as HTMLElement & { frameIdentity?: string }).frameIdentity = "preserved"
  })
  await card.getByTestId(`card-maximize-${cardId}`).click()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toMatch(/^\/w\/workspace-main\/b\/branch-main\/f\/frame-card:branch-main:/)
  expect(await card.evaluate((node) =>
    (node as HTMLElement & { frameIdentity?: string }).frameIdentity
  )).toBe("preserved")

  const maximizedUrl = page.url()
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()

  await page.getByTestId("frame-back").click()
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toBe("/w/workspace-main/b/branch-main/f/frame-root:branch-main")
  await expect(card).toHaveAttribute("data-maximized", "false")
  await page.goForward()
  await expect(page).toHaveURL(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")

  await page.reload()
  await expect(page).toHaveURL(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()

  await page.getByTestId("frame-fork").click()
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toMatch(/^\/w\/workspace-main\/b\/branch-[^/]+\/f\/frame-card:branch-[^:]+:/)
  await expect(page).not.toHaveURL(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")

  await page.goBack()
  await expect(page).toHaveURL(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")
})

test("open-in-tab returns the address bar to the root frame and Escape minimizes a pointer-maximized card", async ({ page }) => {
  await page.goto("/")
  await openWorkspaceChat(page)
  await sendSlash(page, "/appearance.theme")

  const card = page.getByTestId("transcript").locator('.smithers-card[data-kind="theme-picker"]')
  await expect(card).toBeVisible()
  const cardId = (await card.getAttribute("data-testid"))?.replace(/^card-/, "")
  expect(cardId).toBeTruthy()

  // Escape after a pointer maximize: the pressed button unmounted, but focus followed to its replacement.
  await card.getByTestId(`card-maximize-${cardId}`).click()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await page.keyboard.press("Escape")
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toBe("/w/workspace-main/b/branch-main/f/frame-root:branch-main")

  // Open in tab embeds the transcript's copy AND moves the address bar back to root, so reload keeps it embedded.
  await card.getByTestId(`card-maximize-${cardId}`).click()
  await page.getByTestId(`card-open-in-tab-${cardId}`).click()
  await expect(page.locator(".card-tab .smithers-card")).toBeVisible()
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toBe("/w/workspace-main/b/branch-main/f/frame-root:branch-main")
  await page.reload()
  await expect(page.locator('.smithers-card[data-kind="theme-picker"][data-maximized="true"]')).toHaveCount(0)
  await expect(page.locator(".card-maximize-backdrop")).toHaveCount(0)
})

test("a maximized Files card reveals pointer and keyboard file navigation with Back and visible failures", async ({ page }) => {
  await installCloudFixture(page)
  await page.route("**/api/repos/smithersai/smithers/contents", route => route.fulfill({ json: [
    { name: "README.md", path: "README.md", type: "file" },
    { name: "missing.txt", path: "missing.txt", type: "file" }
  ] }))
  await page.route("**/api/repos/smithersai/smithers/contents/README.md", route => route.fulfill({ json: {
    path: "README.md", content: btoa("# CAP-007\n\nVisible file content."), encoding: "base64", size: 33
  } }))
  await page.route("**/api/repos/smithersai/smithers/contents/missing.txt", route => route.fulfill({
    status: 404, json: { message: "Path not found: missing.txt" }
  }))
  await page.goto("/")
  await openWorkspaceChat(page)
  await sendSlash(page, "/files.list / smithersai/smithers")

  const listed = page.getByTestId("transcript").locator('.smithers-card[data-kind="file-list"]')
  const cardId = (await listed.getAttribute("data-testid"))?.replace(/^card-/, "")
  expect(cardId).toBeTruthy()
  const card = page.getByTestId(`card-${cardId}`)
  await card.getByTestId(`card-maximize-${cardId}`).click()
  await expect(card).toHaveAttribute("data-maximized", "true")

  await card.getByRole("button", { name: "README.md", exact: true }).click()
  await expect(card).toHaveAttribute("data-kind", "file")
  await expect(card).toContainText("Visible file content.")
  await expect(card).toHaveAttribute("data-maximized", "true")

  await card.getByRole("button", { name: "Back in frame" }).click()
  await expect(card).toHaveAttribute("data-kind", "file-list")
  const missing = card.getByRole("button", { name: "missing.txt", exact: true })
  await missing.focus()
  await page.keyboard.press("Enter")
  await expect(card).toHaveAttribute("data-kind", "status")
  await expect(card).toContainText("Path not found: missing.txt")
  await expect(card).toHaveAttribute("data-maximized", "true")

  await card.getByRole("button", { name: "Back in frame" }).click()
  await expect(card).toHaveAttribute("data-kind", "file-list")
  await card.getByRole("button", { name: "Restore", exact: true }).click()
  await expect(card).toHaveAttribute("data-maximized", "false")
})

for (const sample of [
  { name: "desktop light", width: 1440, height: 960, dark: false },
  { name: "narrow dark", width: 390, height: 844, dark: true },
]) test(`maximized cards keep navigation and Chat operable by pointer and keyboard: ${sample.name}`, async ({ page }) => {
  await page.setViewportSize({ width: sample.width, height: sample.height })
  await page.goto("/")
  await openWorkspaceChat(page)
  if (sample.dark) {
    await page.getByRole("button", { name: "Toggle light and dark mode" }).click()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  }
  await sendSlash(page, "/appearance.theme")

  const card = page.getByTestId("transcript").locator('.smithers-card[data-kind="theme-picker"]')
  const cardId = (await card.getAttribute("data-testid"))?.replace(/^card-/, "")
  expect(cardId).toBeTruthy()
  await card.getByTestId(`card-maximize-${cardId}`).click()
  await expect(card).toHaveAttribute("data-maximized", "true")

  const chat = page.getByRole("button", { name: "Chat", exact: true })
  const rail = page.getByRole("navigation", { name: "Chrome" })
  const railButtons = rail.getByRole("button")
  expect(await railButtons.count()).toBeGreaterThan(0)
  const cardBox = await card.boundingBox()
  const railBox = await rail.boundingBox()
  const headerBox = await page.locator(".session-navigation").boundingBox()
  expect(cardBox!.x).toBeGreaterThanOrEqual(railBox!.x + railBox!.width + 8)
  expect(cardBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height + 8)
  await expect.poll(() => card.evaluate(node => {
    const box = node.getBoundingClientRect()
    return [box.top + 12, box.top + box.height / 2].every(y => {
      const hit = document.elementFromPoint(box.left + 12, y)
      return hit !== null && node.contains(hit)
    })
  })).toBe(true)
  for (const target of [chat, ...await railButtons.all()]) {
    const box = await target.boundingBox()
    expect(box).not.toBeNull()
    expect(await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y)
      return hit?.closest("button")?.getAttribute("aria-label") ?? hit?.closest("button")?.textContent?.trim()
    }, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 })).toBe(await target.getAttribute("aria-label") ?? (await target.textContent())?.trim())
  }

  await chat.click()
  await expect(page.getByTestId("composer-input")).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(chat).toBeFocused()

  let reachedRailButtons = 0
  for (let presses = 0; presses < 100 && reachedRailButtons < await railButtons.count(); presses++) {
    await page.keyboard.press("Tab")
    if (await railButtons.nth(reachedRailButtons).evaluate(node => node === document.activeElement)) reachedRailButtons++
  }
  expect(reachedRailButtons).toBe(await railButtons.count())
  await page.keyboard.press("Shift+Tab")
  await expect(railButtons.nth((await railButtons.count()) - 2)).toBeFocused()
  const theme = page.getByRole("button", { name: "Toggle light and dark mode" })
  await page.keyboard.press("Tab")
  await expect(theme).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.locator("html")).toHaveAttribute("data-theme", sample.dark ? "light" : "dark")
  await expect(card).toHaveAttribute("data-maximized", "true")

  await card.getByRole("button", { name: "Restore", exact: true }).click()
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(card.getByTestId(`card-maximize-${cardId}`)).toBeFocused()
})

test("booted from a repository path, the address bar keeps it while back and forward still switch frames", async ({ page }) => {
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } }))
  await page.goto("/smithersai/smithers")
  const repoUrl = page.url()
  expect(new URL(repoUrl).pathname).toBe("/smithersai/smithers")
  await openWorkspaceChat(page)
  await sendSlash(page, "/appearance.theme")

  const card = page.getByTestId("transcript").locator('.smithers-card[data-kind="theme-picker"]')
  await expect(card).toBeVisible()
  const cardId = (await card.getAttribute("data-testid"))?.replace(/^card-/, "")
  expect(cardId).toBeTruthy()
  await expect(page).toHaveURL(repoUrl)

  await card.getByTestId(`card-maximize-${cardId}`).click()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(page).toHaveURL(repoUrl)

  await page.goBack()
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(page).toHaveURL(repoUrl)
  await page.goForward()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(page).toHaveURL(repoUrl)

  await page.reload()
  await expect(page).toHaveURL(repoUrl)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
})
