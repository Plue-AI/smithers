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



test("frame URLs survive reload, traverse history, and preserve the card node", async ({ page }) => {
  await page.goto("/")
  await openWorkspaceChat(page)
  await sendSlash(page, "/agent.list")

  const card = page.locator('.smithers-card[data-kind="agents"]')
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
  // Frame fork left with the client time-travel controls in the MVP cut (#3385).
  await expect(page.getByTestId("frame-fork")).toHaveCount(0)
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
    await sendSlash(page, "/appearance.dark-mode")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  }
  await sendSlash(page, "/agent.list")

  const card = page.getByTestId("transcript").locator('.smithers-card[data-kind="agents"]')
  const cardId = (await card.getAttribute("data-testid"))?.replace(/^card-/, "")
  expect(cardId).toBeTruthy()
  await card.getByTestId(`card-maximize-${cardId}`).click()
  await expect(card).toHaveAttribute("data-maximized", "true")

  const chat = page.getByRole("button", { name: "Chat", exact: true })
  // The default chrome has no icon rail (#3334).
  await expect(page.getByTestId("chrome-actions")).toHaveCount(0)
  const cardBox = await card.boundingBox()
  const headerBox = await page.locator(".session-navigation").boundingBox()
  expect(cardBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height + 8)
  await expect.poll(() => card.evaluate(node => {
    const box = node.getBoundingClientRect()
    return [box.top + 12, box.top + box.height / 2].every(y => {
      const hit = document.elementFromPoint(box.left + 12, y)
      return hit !== null && node.contains(hit)
    })
  })).toBe(true)
  for (const target of [chat]) {
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

  // The default chrome has no theme toggle (#3334), so the keyboard runs the flow from Chat: Enter on a
  // whole typed name runs that flow over the card. Send would be a new message, a return to the transcript.
  await chat.click()
  await page.getByTestId("composer-input").fill("/appearance.dark-mode")
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.locator("html")).toHaveAttribute("data-theme", sample.dark ? "light" : "dark")
  await expect(page.getByTestId("composer-input")).toBeHidden()
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
  await sendSlash(page, "/agent.list")

  const card = page.getByTestId("transcript").locator('.smithers-card[data-kind="agents"]')
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
