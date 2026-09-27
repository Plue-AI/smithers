import { controlTabKey, expect,test } from './browserTest'

test.use({ contextOptions: { reducedMotion: 'reduce' }, actionTimeout: 3_000, navigationTimeout: 10_000 })
test.setTimeout(30_000)

test('Chat Tab reaches Send and footer controls without trapping focus', async ({ page }) => {
  await page.goto('/')
  const chat = page.getByRole('button', { name: 'Chat', exact: true })
  await chat.click()
  const input = page.getByTestId('composer-input')
  const queue = page.getByRole('button', { name: 'Queue', exact: true })
  const send = page.getByTestId('composer-send')
  const mode = page.getByRole('button', { name: 'Mode: Normal', exact: true })
  await input.fill('hello there')
  await page.keyboard.press(controlTabKey(page))
  await expect(queue).toBeFocused()
  await page.keyboard.press(controlTabKey(page))
  await expect(send).toBeFocused()
  await page.keyboard.press(controlTabKey(page))
  await expect(chat).toBeFocused()
  await page.keyboard.press(controlTabKey(page))
  await expect(mode).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitemradio', { name: 'Normal' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(mode).toBeFocused()
  await page.keyboard.press(controlTabKey(page, true))
  await expect(chat).toBeFocused()
  await page.keyboard.press(controlTabKey(page, true))
  await expect(send).toBeFocused()
  await page.keyboard.press(controlTabKey(page, true))
  await expect(queue).toBeFocused()
  await page.keyboard.press(controlTabKey(page, true))
  await expect(input).toBeFocused()
  await page.keyboard.press(controlTabKey(page, true))
  await expect(page.locator('.smithers-transcript').getByRole('button', { name: 'Copy message' }).last()).toBeFocused()
})

test('switching away from Dictation stops capture without reopening Chat', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as any
    host.SpeechRecognition = class {
      onend: any
      start() { host.starts = (host.starts ?? 0) + 1 }
      stop() { this.onend?.() }
      abort() { host.aborts = (host.aborts ?? 0) + 1 }
    }
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Mode: Normal', exact: true })).toBeVisible()
  await page.keyboard.press('m')
  await page.getByRole('menuitemradio', { name: 'Dictation' }).click()
  expect(await page.evaluate(() => (window as any).starts ?? 0)).toBe(0)
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).starts)).toBe(1)
  await page.getByRole('button', { name: 'Mode: Dictation', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'Normal' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).aborts)).toBe(1)
  await expect(page.getByRole('button', { name: 'Stop dictation' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+k')
  await expect.poll(() => page.evaluate(() => (window as any).starts)).toBe(1)
})

test('Escape releases dictation before Chat and preserves the draft', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as any
    host.SpeechRecognition = class {
      onend: any
      start() { host.starts = (host.starts ?? 0) + 1 }
      stop() { this.onend?.() }
      abort() { host.aborts = (host.aborts ?? 0) + 1 }
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Mode: Normal', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'Dictation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Mode: Dictation', exact: true })).toBeVisible()
  await page.keyboard.press('Meta+k')
  await expect.poll(() => page.evaluate(() => (window as any).starts)).toBe(1)
  const input = page.getByTestId('composer-input')
  await input.fill('keep this dictation draft')
  await input.press('Escape')
  await expect.poll(() => page.evaluate(() => (window as any).aborts)).toBe(1)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('keep this dictation draft')
  await expect(page.getByTestId('palette')).toBeVisible()
  await input.press('Escape')
  await expect(input).toBeHidden()
})

test('unsupported Dictation is disabled with a reason and Chat stays in Normal mode', async ({ page }) => {
  await page.addInitScript(() => { delete (window as any).SpeechRecognition; delete (window as any).webkitSpeechRecognition })
  await page.goto('/')
  await page.getByRole('button', { name: 'Mode: Normal', exact: true }).click()
  const dictation = page.getByRole('menuitemradio', { name: 'Dictation', exact: true })
  await expect(dictation).toHaveAttribute('aria-disabled', 'true')
  await expect(dictation).toHaveAccessibleDescription('Dictation needs a browser with speech recognition')
  await page.keyboard.press('End')
  await expect(dictation).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('composer-input')).toBeFocused()
  await expect(page.getByRole('button', { name: 'Mode: Normal', exact: true })).toBeVisible()
  await expect(page.getByText("/chat.open didn't run", { exact: true })).toHaveCount(0)
})


test('Vim roves into Chat in normal mode, inserts explicitly, and leaves on j or a second Escape', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Mode: Normal', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'Vim', exact: true }).click()
  await page.keyboard.press('Meta+k')
  const input = page.getByTestId('composer-input')
  const queue = page.getByRole('button', { name: 'Queue', exact: true })
  await input.fill('draft')
  await input.press(controlTabKey(page))
  await expect(queue).toBeFocused()
  await page.keyboard.press('k')
  await expect(input).toBeFocused()
  await expect(input).toHaveAttribute('data-vim-mode', 'normal')
  await page.keyboard.press('j')
  await expect(queue).toBeFocused()
  await expect(input).toHaveValue('draft')
  await page.keyboard.press('h')
  await page.keyboard.press('i')
  await expect(input).toHaveAttribute('data-vim-mode', 'insert')
  await input.press('End')
  await page.keyboard.type(' hjkl')
  await expect(input).toHaveValue('draft hjkl')
  await page.keyboard.press('Escape')
  await expect(input).toBeFocused()
  await expect(input).toHaveAttribute('data-vim-mode', 'normal')
  await page.keyboard.press('Enter')
  await expect(input).toHaveAttribute('data-vim-mode', 'insert')
  await expect(input).toHaveValue('draft hjkl')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(input).not.toBeFocused()
  await expect(page.getByTestId('composer-overlay')).toBeVisible()
  await page.keyboard.press('j')
  await expect(input).toBeFocused()
  await expect(input).toHaveAttribute('data-vim-mode', 'normal')
})

test('selecting Vim enables keyboard navigation while SQLite commit is held', async ({ page }) => {
  await page.addInitScript(() => {
    const nativePost = Worker.prototype.postMessage
    const held: Array<() => void> = []
    const probe = { armed: false, commits: 0, release: () => {
      probe.armed = false
      for (const send of held.splice(0)) send()
    } }
    ;(window as any).modeCommitProbe = probe
    Worker.prototype.postMessage = function(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
      const send = () => Reflect.apply(nativePost, this, [message, options])
      if (probe.armed && typeof message === 'object' && message !== null && 'sql' in message &&
        typeof message.sql === 'string' && /^\s*COMMIT\b/i.test(message.sql)) {
        probe.commits++
        held.push(send)
      } else send()
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Mode: Normal', exact: true }).click()
  await page.evaluate(() => { (window as any).modeCommitProbe.armed = true })
  try {
    await page.getByRole('menuitemradio', { name: 'Vim', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as any).modeCommitProbe.commits)).toBeGreaterThan(0)
    await page.keyboard.press('Meta+k')
    const input = page.getByTestId('composer-input')
    const queue = page.getByRole('button', { name: 'Queue', exact: true })
    await input.fill('draft while saving')
    await input.press(controlTabKey(page))
    await expect(queue).toBeFocused()
    await page.keyboard.press('k')
    await expect(input).toBeFocused()
    await expect(input).toHaveAttribute('data-vim-mode', 'normal')
    await expect(page.getByRole('button', { name: 'Mode: Vim', exact: true })).toBeVisible()
    await page.keyboard.press('j')
    await expect(queue).toBeFocused()
    await expect(input).toHaveValue('draft while saving')
  } finally {
    await page.evaluate(() => (window as any).modeCommitProbe.release())
  }
})
