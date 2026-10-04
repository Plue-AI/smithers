import { expect, test } from "./browserTest"

/*
 * The composer's two affordances, proven end to end.
 *
 * Send and Stop are `chat.send` and `stop`'s button doors, bound through
 * `ChatComposer`'s `submitProps` / `stopProps`. A test that only read the
 * binding off the DOM would pass while the flow behind it was unwired, so
 * each test here clicks the button, lets the flow run, and asserts what the
 * app does: the reply that lands, or the turn that never finishes.
 *
 * Stub suite (SMITHERS_CHAT_STUB=1, the default); the stub answers in ~15ms,
 * so the Stop test holds the turn's own POST open to make the window real.
 */

test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the stub suite; the real endpoint has its own spec")
test.use({ actionTimeout: 5_000 })

const openComposer = async (page: import("@playwright/test").Page) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Chat", exact: true }).click()
  const input = page.getByTestId("composer-input")
  await expect(input).toBeVisible()
  return input
}

test("clicking Send runs chat.send and the reply lands in the transcript", async ({ page }) => {
  const input = await openComposer(page)
  await input.fill("say ok")
  await page.getByTestId("composer-send").click()
  await expect(page.locator('.smithers-chat-message[data-role="user"]', { hasText: "say ok" })).toBeVisible()
  await expect(page.locator('.smithers-chat-message[data-role="assistant"]', { hasText: "stub: say ok" }))
    .toBeVisible({ timeout: 10_000 })
  // The flow, not the click, cleared the draft: the composer is ready for the next turn.
  await expect(input).toHaveValue("")
})

test("clicking Stop runs stop and the held turn never produces a reply", async ({ page }) => {
  // Hold the turn's own request open so the composer really is mid-turn when Stop is clicked.
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/agent/turn", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    await held
    return route.continue()
  })

  const input = await openComposer(page)
  await input.fill("say never")
  await page.getByTestId("composer-send").click()
  await expect(page.locator('.smithers-chat-message[data-role="user"]', { hasText: "say never" })).toBeVisible()

  const stop = page.locator(".sui-chat-composer-stop")
  await expect(stop).toBeVisible()
  await stop.click()
  release?.()

  // The turn is over: Send is back, and the answer the held turn would have
  // streamed never reaches the transcript.
  await expect(page.getByTestId("composer-send")).toBeVisible()
  await expect(stop).toHaveCount(0)
  await expect(page.locator('.smithers-chat-message[data-role="assistant"]', { hasText: "stub: say never" }))
    .toHaveCount(0)
})
