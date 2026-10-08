import { expect, test, type Page } from "./browserTest"
import { installConversationFixture } from "./conversationFixture"
import { fillComposer } from "./composer"

/* The self-hosted install keeps its existing controls inside a phone viewport. */
const PHONE = { width: 390, height: 844 }
const SHOTS = process.env.PHONE_SHOTS


const overflow = (page: Page) => page.evaluate(() => {
  const viewport = document.documentElement.clientWidth
  const scrolls = (el: Element | null): boolean => {
    for (let node = el; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node)
      if ((style.overflowX === "auto" || style.overflowX === "scroll") && node.scrollWidth > node.clientWidth) return true
    }
    return false
  }
  const out: string[] = []
  if (document.documentElement.scrollWidth > viewport) out.push(`document scrollWidth=${document.documentElement.scrollWidth}`)
  for (const el of document.querySelectorAll<HTMLElement>("main *")) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.right <= viewport + 1 || scrolls(el.parentElement)) continue
    out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} right=${Math.round(rect.right)}`)
  }
  for (const el of document.querySelectorAll<HTMLElement>(".world-card-list button")) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || scrolls(el.parentElement)) continue
    if (rect.left < -1 || rect.right > viewport + 1) out.push(`button "${el.textContent}" off screen`)
    if (rect.width < 24 || rect.height < 24) out.push(`button "${el.textContent}" ${Math.round(rect.width)}x${Math.round(rect.height)}`)
  }
  return out
})



// M-09 defers Cloud billing; the install's existing Home and Commands fit a phone.
test("the install fits a 390 px phone without a billing surface", async ({ page }) => {
  await page.setViewportSize(PHONE)
  await installConversationFixture(page)
  const billingReads: string[] = []
  await page.route(/\/api\/billing(?:\/|\?|$)/, route => { billingReads.push(route.request().url()); return route.fulfill({ status: 404, json: {} }) })
  await page.goto("/")
  await expect(page.locator(".home")).toBeVisible()
  expect(await overflow(page)).toEqual([])
  await fillComposer(page, "/help")
  await page.getByTestId("composer-input").press("Enter")
  const commands = page.getByRole("article", { name: "Commands", exact: true })
  await expect(commands).toBeVisible()
  await expect(commands.locator("code").filter({ hasText: /^\/billing(?:[ .]|$)/ })).toHaveCount(0)
  await expect(page.getByTestId("billing-credit-line")).toHaveCount(0)
  expect(billingReads).toEqual([])
  expect(await overflow(page)).toEqual([])
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/install-phone.png`, fullPage: true })
})
