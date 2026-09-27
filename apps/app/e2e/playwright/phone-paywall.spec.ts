import { expect, test, type Page } from "./browserTest"
import { signedOutVisitor, skipSignup } from "./identity"

/*
 * The paying path at 390 px (iPhone 12–15 width): the signup, the plans card
 * and the out-of-credit card must fit the screen. Nothing may render past the
 * viewport except inside a box that scrolls on its own (the plans table), and
 * every button a person needs is fully on screen and at least 24 px square
 * (WCAG 2.2 AA 2.5.8).
 */
const PHONE = { width: 390, height: 844 }
const SHOTS = process.env.PHONE_SHOTS

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) })

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
  for (const el of document.querySelectorAll<HTMLElement>("main *, [data-testid='signup'] *")) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.right <= viewport + 1 || scrolls(el.parentElement)) continue
    out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} right=${Math.round(rect.right)}`)
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-testid='signup'] button, .world-card-list button")) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || scrolls(el.parentElement)) continue
    if (rect.left < -1 || rect.right > viewport + 1) out.push(`button "${el.textContent}" off screen`)
    if (rect.width < 24 || rect.height < 24) out.push(`button "${el.textContent}" ${Math.round(rect.width)}x${Math.round(rect.height)}`)
  }
  return out
})

test("the signup fits a 390 px phone at every stage", async ({ page }) => {
  await page.setViewportSize(PHONE)
  await signedOutVisitor(page)
  await page.goto("/")
  await expect(page.getByTestId("signup-github")).toBeVisible()
  await page.waitForTimeout(1500)
  expect(await overflow(page)).toEqual([])
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/signup-1-doors.png`, fullPage: true })

  await page.route("**/api/auth/session", route => route.fulfill(json({ status: "signed-in", login: "adapark", allowlisted: true, admin: false })))
  await page.goto("/")
  await expect(page.getByTestId("signup-account")).toHaveValue("adapark")
  expect(await overflow(page)).toEqual([])
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/signup-2-account.png`, fullPage: true })
  await page.getByTestId("signup-name").fill("Ada Park")
  await page.getByTestId("signup-account-continue").click()

  const question = page.getByTestId("signup-question")
  for (const id of ["size", "role", "heard", "know", "models", "repo", "more"]) {
    await expect(question).toHaveAttribute("data-question", id)
    expect(await overflow(page), id).toEqual([])
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/signup-3-${id}.png`, fullPage: true })
    await page.getByTestId("signup-skip").click()
  }
  await expect(page.getByTestId("signup-finish")).toBeVisible()
  expect(await overflow(page)).toEqual([])
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/signup-4-ready.png`, fullPage: true })
})

const plans = [
  { key: "free", display_name: "Free", price_cents: 0, sandboxes: 1, idle: 1800, hours: 4, credit: 0 },
  { key: "pro", display_name: "Pro", price_cents: 5000, sandboxes: 3, idle: 14400, hours: -1, credit: 5000 },
  { key: "max", display_name: "Max", price_cents: 50000, sandboxes: 64, idle: 0, hours: -1, credit: 50000 }
].map(plan => ({ key: plan.key, display_name: plan.display_name, price_cents: plan.price_cents, interval: "monthly",
  checkout_available: plan.key !== "free", limits: { concurrent_sandboxes: plan.sandboxes, idle_timeout_secs: plan.idle,
    hours_per_day: plan.hours, private_repos: -1, storage_bytes: -1, ci_minutes: -1, agent_runs: -1, seats: 1,
    monthly_credit_cents: plan.credit } }))

test("the plans card fits a 390 px phone, hides Max, and states included, remaining and reset credit", async ({ page }) => {
  await page.setViewportSize(PHONE)
  await signedOutVisitor(page)
  // A cloud host with a billing upstream declares its billing routes.
  await page.route("**/api/bootstrap", route => route.fulfill(json({ apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
    capabilities: ["identity", "cloud", "agent", "billing.balance", "billing.overview", "billing.plans"], authFlow: "redirect", sandbox: null })))
  await page.route("**/api/auth/session", route => route.fulfill(json({ status: "signed-in", login: "adapark", allowlisted: true, admin: false })))
  await page.route("**/api/billing/plans", route => route.fulfill(json({ plans, current_plan_key: "pro" })))
  await page.route("**/api/billing", route => route.fulfill(json({ credit_balance_cents: 1234, usage_period_end: "2026-10-01T00:00:00Z",
    sandbox: { plan_key: "pro", concurrent_sandboxes: 3, concurrent_in_use: 1, idle_timeout_secs: 14400, hours_per_day: -1,
      seconds_used_today: 5400, day_resets_at: "2026-09-26T00:00:00Z" } })))
  await page.goto("/")
  await skipSignup(page)
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await input.fill("/billing.plans")
  await input.press("Enter")
  const line = page.getByTestId("billing-credit-line")
  await expect(line).toHaveText("Credit left: $12.34 · Included: $50.00 per month · Resets Oct 1")
  await expect(page.getByText("Max $500.00")).toHaveCount(0)
  await line.scrollIntoViewIfNeeded()
  expect(await overflow(page)).toEqual([])
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/billing-plans.png`, fullPage: true })
})
