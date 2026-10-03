import { expect,test,type Page } from "./browserTest"

// The summoned composer is transparent around its card and dismisses to the
// same readable transcript, without a modal backdrop or an inert conversation.
const expectReadableTurn = async (page: Page, text: string) => {
  const overlay = page.getByTestId('composer-overlay')
  const transcript = page.locator('.smithers-transcript')
  expect(await overlay.evaluate(element => getComputedStyle(element).backdropFilter)).toBe('none')
  expect(await overlay.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
  expect(await transcript.evaluate(element => element.closest('[inert]') === null)).toBe(true)
  await page.getByTestId('composer-input').press('Escape')
  await expect(overlay).toBeHidden()
  for (const role of ['user', 'assistant']) {
    const bubble = transcript.locator(`.smithers-chat-message[data-role="${role}"]`, { hasText: text }).last()
    await expect(bubble).toBeInViewport({ ratio: 1 })
    expect(await bubble.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    })).toBe(true)
  }
}

const installFocusFrameProbe = (page: Page) => page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window)
    const cancel = window.cancelAnimationFrame.bind(window)
    const held = new Map<number, FrameRequestCallback>()
    const probe = { armed: false, frame: () => new Promise<void>(resolve => request(() => resolve())), release: () => {
      probe.armed = false
      const callbacks = [...held.values()]
      held.clear()
      for (const callback of callbacks) callback(performance.now())
    } }
    ;(window as any).chatFocusFrames = probe
    window.requestAnimationFrame = callback => {
      const id = request(time => { if (probe.armed) held.set(id, callback); else callback(time) })
      return id
    }
    window.cancelAnimationFrame = id => { held.delete(id); cancel(id) }
})

for (const opening of ['button', 'shortcut', 'already open']) test(`opening Chat by ${opening} preserves a newer focus choice`, async ({ page }) => {
  await installFocusFrameProbe(page)
  await page.goto('/')
  const chat = page.getByRole('button', { name: 'Chat', exact: true })
  const input = page.getByTestId('composer-input')
  await expect(chat).toBeVisible()
  if (opening === 'already open') {
    await chat.click()
    await input.fill('keep this draft')
  }
  await page.evaluate(() => { (window as any).chatFocusFrames.armed = true })
  try {
    if (opening === 'shortcut') await page.keyboard.press('Control+k')
    else await chat.click()
    await expect(input).toBeFocused()
    await page.keyboard.type(' ready')
    await expect(input).toHaveValue(opening === 'already open' ? 'keep this draft ready' : ' ready')
    await page.evaluate(() => (window as any).chatFocusFrames.frame())
    const next = page.getByRole('button', { name: 'Mode: Normal', exact: true })
    await next.focus()
    await page.evaluate(() => (window as any).chatFocusFrames.release())
    await expect(next).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menuitemradio', { name: 'Normal', exact: true })).toBeFocused()
  } finally { await page.evaluate(() => (window as any).chatFocusFrames.release()) }
})

for (const dismissal of ['Escape', 'Control+k', 'backdrop']) test(`closing Chat with ${dismissal} preserves a newer focus choice`, async ({ page }) => {
  await installFocusFrameProbe(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  const input = page.getByTestId('composer-input')
  await input.fill('keep this draft')
  await page.evaluate(() => { (window as any).chatFocusFrames.armed = true })
  try {
    if (dismissal === 'backdrop') await page.getByTestId('composer-overlay').click({ position: { x: 1, y: 1 } })
    else await input.press(dismissal)
    await expect(input).toBeHidden()
    await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeFocused()
    // Let the browser reach the frame while its app callbacks stay held.
    await page.evaluate(() => (window as any).chatFocusFrames.frame())
    const next = page.getByRole('button', { name: 'Mode: Normal', exact: true })
    await next.focus()
    await page.evaluate(() => (window as any).chatFocusFrames.release())
    await expect(next).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menuitemradio', { name: 'Normal', exact: true })).toBeFocused()
  } finally { await page.evaluate(() => (window as any).chatFocusFrames.release()) }
})

test.use({ actionTimeout: 3_000, navigationTimeout: 10_000 })
test.setTimeout(30_000)

/*
 * M0 chat (LOCAL-APP.md): a turn typed into the composer is POSTed to the
 * local origin's /api/chat/turn and the streamed reply lands as an
 * assistant bubble, with no login. Runs against the stub
 * (SMITHERS_CHAT_STUB=1, the default).
 */

test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the stub suite; chat.real.spec.ts covers the real endpoint")


test("typing 'say ok' and sending renders the stub reply", async ({ page }) => {
  await page.goto("/")
  const input = page.getByTestId("composer-input")
  await expect(input).toBeHidden()
  await page.getByRole("button", { name: "Chat", exact: true }).focus()
  await page.keyboard.press("Meta+k")
  await expect(input).toBeVisible()
  await input.fill("say ok")
  await page.getByTestId("composer-send").click()
  // The user's own bubble first, then the assistant's streamed text.
  await expect(page.locator(".smithers-chat-message[data-role=\"user\"]")).toContainText("say ok")
  const assistant = page.locator(".smithers-chat-message[data-role=\"assistant\"]", { hasText: "stub: say ok" })
  await expect(assistant).toContainText("stub: say ok", { timeout: 5_000 })
})

for (const path of ["/", "/smithersai/smithers/"]) {
  test(`Chat button preserves immediately typed slash prefixes on every open: ${path}`, async ({ page }) => {
    await page.goto(path)
    const input = page.getByTestId('composer-input')
    for (const draft of ['/account.show', '/wiki']) {
      await page.getByRole('button', { name: 'Chat', exact: true }).click()
      await page.keyboard.type(draft)
      await expect(input).toHaveValue(draft)
      await input.fill('')
      await page.keyboard.press('Escape')
      await expect(input).toBeHidden()
    }
  })

  test(`/help displays an unknown-flow refusal and keeps the draft: ${path}`, async ({ page }) => {
    let turns = 0
    page.on('request', request => { if (request.method() === 'POST' && /\/api\/(?:agent|chat)\/turn/.test(request.url())) turns++ })
    await page.goto(path)
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await page.keyboard.type('/help')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('palette')).toContainText('There is no /help flow.')
    await expect(page.getByTestId('composer-input')).toHaveValue('/help')
    expect(turns).toBe(0)
  })

  test(`keyboard chat sends a turn and Shift+Enter inserts a newline: ${path}`, async ({ page }) => {
    await page.goto(path)
    await expect(page.getByRole("button", { name: "Mode: Normal", exact: true })).toBeVisible()
    await page.keyboard.press("Meta+k")
    const input = page.getByTestId("composer-input")
    await expect(input).toBeFocused()
    await expect(page.getByTestId("palette")).toBeVisible()
    await input.press("Enter")
    await expect(input).toBeFocused()
    await expect(page.locator('.smithers-chat-message[data-role="user"]')).toHaveCount(0)
    await input.fill("First line")
    await input.press("Shift+Enter")
    await expect(input).toHaveValue("First line\n")
    await expect(page.getByTestId("palette")).toBeVisible()

    const draft = "What does this repository do? Answer in two sentences."
    await input.fill(draft)
    const turn = page.waitForRequest(request => request.method() === "POST" && /\/api\/(?:agent|chat)\/turn(?:\?|$)/.test(request.url()), { timeout: 5_000 })
    await input.press("Enter")
    await turn
    const reply = page.locator('.smithers-chat-message[data-role="assistant"]', { hasText: `stub: ${draft}` })
    await expect(reply).toContainText(`stub: ${draft}`, { timeout: 5_000 })
    await expect(page.locator('.smithers-chat-message[data-role="user"]', { hasText: draft })).toBeInViewport({ ratio: 1 })
    await expect(reply).toBeInViewport({ ratio: 1 })
    if (path === "/") await expectReadableTurn(page, draft)
  })

  test(`Escape closes Chat and its root palette and restores the draft on reopen: ${path}`, async ({ page }) => {
    await page.goto(path)
    const chat = page.getByRole('button', { name: 'Chat', exact: true })
    await chat.click()
    const input = page.getByTestId('composer-input')
    await input.fill('keep this draft')
    await expect(page.getByTestId('palette')).toBeVisible()
    await input.press('Escape')
    await expect(input).toBeHidden()
    if (path === "/") await expect(chat).toBeFocused()
    await expect(page.getByTestId('palette')).toBeHidden()
    await chat.click()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('keep this draft')
  })

  for (const draft of ['/issues', '/issues.']) test(`Escape closes the slash menu for ${draft} before Chat: ${path}`, async ({ page }) => {
    await page.goto(path)
    await expect(page.getByRole("button", { name: "Mode: Normal", exact: true })).toBeVisible()
    await page.keyboard.press("Meta+k")
    const input = page.getByTestId("composer-input")
    await input.fill(draft)
    await expect(page.getByTestId("palette")).toBeVisible()
    await input.press("Escape")
    await expect(page.getByTestId("palette")).toBeHidden()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue(draft)
    await input.press("Escape")
    await expect(input).toBeHidden()
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await expect(input).toHaveValue(draft)
  })
}
