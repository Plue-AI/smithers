import { expect, test } from "./browserTest"
import { SCOPED_TEST_USER, signedOutVisitor, skipSignup } from "./identity"

for (const key of ["Enter", "Space"]) test(`a Chat refusal survives account cleanup and an explicit ${key} retry`, async ({ page }) => {
  await signedOutVisitor(page)
  let signedIn = true
  await page.route("**/api/auth/session", route => route.fulfill({ json: signedIn ? SCOPED_TEST_USER : { status: "signed-out" } }))
  // Hold the real SQLite commit while the account privacy barrier is active.
  // No application debug API or replacement persistence implementation.
  await page.addInitScript(() => {
    const nativePost = Worker.prototype.postMessage
    const held: Array<() => void> = []
    const probe = { armed: true, commits: 0, release: () => { probe.armed = false; for (const send of held.splice(0)) send() } }
    ;(window as any).privacyCommitProbe = probe
    Worker.prototype.postMessage = function(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
      const send = () => Reflect.apply(nativePost, this, [message, options])
      if (probe.armed && JSON.parse(localStorage.getItem("smithers-mvp.privacyRetirement") ?? "null")?.phase === "pending" &&
          typeof message === "object" && message !== null && "sql" in message && typeof message.sql === "string" && /^\s*COMMIT\b/i.test(message.sql)) {
        probe.commits++; held.push(send)
      } else send()
    }
  })
  await page.goto("/smithersai/smithers/")
  await skipSignup(page)
  signedIn = false
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  const input = page.getByTestId("composer-input")
  const chat = page.getByRole("button", { name: "Chat", exact: true })
  const notice = page.getByRole("alert").filter({ hasText: "Account cleanup is running. Try again in a moment." })
  try {
    await expect.poll(() => page.evaluate(() => (window as any).privacyCommitProbe.commits)).toBeGreaterThan(0)
    await expect(page.getByTestId("chrome-sign-in")).toBeVisible()
    await chat.focus()
    await expect(chat).toBeFocused()
    await page.keyboard.press(key)
    await expect(input).toBeHidden()
    await expect(notice).toBeVisible()
    await page.evaluate(() => (window as any).privacyCommitProbe.release())
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("smithers-mvp.privacyRetirement") ?? "null")?.phase)).toBe("complete")
    // Cleanup cannot silently replay the refused gesture or erase its failure.
    await expect(input).toBeHidden()
    await expect(notice).toBeVisible()
    await chat.focus()
    await page.keyboard.press(key)
    await expect(input).toBeVisible()
    await input.fill("A new draft after account cleanup")
    await expect(input).toHaveValue("A new draft after account cleanup")
    await expect(notice).toBeVisible()
    const dismiss = notice.getByRole("button", { name: "Dismiss: Not saved", exact: true })
    await dismiss.focus()
    await page.keyboard.press(key)
    await expect(notice).toHaveCount(0)
  } finally {
    await page.evaluate(() => (window as any).privacyCommitProbe.release()).catch(() => {})
  }
})
