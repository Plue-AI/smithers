import { test, expect } from "./browserTest"
import { fixtures as actorFixtures } from "@smthrs/rpc/fixtures/ActorChip"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { createRequire } from "node:module"
const require = createRequire(resolve(process.cwd(), "package.json"))
const axePath = require.resolve("axe-core/axe.min.js")
const shots = process.env.SMITHERS_VIEW_SHOTS ?? resolve(process.cwd(), "../../.artifacts/checks/C-UI-12", new Date().toISOString().replace(/[:.]/g, "-"))
test("every View story: light/dark, desktop/mobile, axe and overflow", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "C-UI-12 requires Chromium")
  test.setTimeout(600_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
  await mkdir(shots, { recursive: true })
  await page.goto("/view-stories.html")
  const stories = await page.locator("nav a").evaluateAll(links => links.map(link => ({ name: link.textContent!, href: (link as HTMLAnchorElement).getAttribute("href")! })))
  const selectedStories = process.env.SMITHERS_VIEW_STORY_FILTER
    ? stories.filter(story => story.name.includes(process.env.SMITHERS_VIEW_STORY_FILTER!))
    : stories
  expect(selectedStories.length).toBeGreaterThan(0)
  const receipts = []
  for (const story of selectedStories) for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
    await page.goto(`/view-stories.html${story.href}&theme=${theme}`)
    await expect(page.locator("[data-story]")).toBeVisible()
    if (story.name.startsWith("SettingsView/")) {
      const copy = await page.locator('[data-kind="settings"]').evaluate(card => [card.textContent, ...[card, ...card.querySelectorAll("*")].flatMap(element => [...element.attributes].map(attribute => attribute.value))].join("\n"))
      expect(copy).not.toMatch(/jev/i)
    }
    if (story.name.includes("/actor-")) {
      const agents = page.locator(".mvp-avatar[data-agent]")
      await expect(agents.locator("img")).toHaveCount(0)
      for (const chip of await agents.all()) {
        const label = await chip.getAttribute("aria-label")
        const fixtureKey = story.name.split("/actor-fixture-")[1] as keyof typeof actorFixtures | undefined
        const fixtureActor = fixtureKey ? actorFixtures[fixtureKey]?.model.actor : undefined
        const agent = fixtureActor?.kind === "agent" ? fixtureActor.agent : story.name.split("/actor-")[1]?.replace(/-for-ben$/, "")
        if (agent === "coding") await expect(chip.locator("svg.lucide-bot")).toHaveCount(1)
        else await expect(chip).toHaveText(agent === "smithers" ? "S" : agent === "reviewer" ? "R" : label![0]!)
      }
    }
    await page.evaluate(() => document.fonts.ready)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.addScriptTag({ path: axePath })
    const violations = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: () => Promise<{ violations: { id: string; impact: string; nodes: unknown[] }[] }> } }).axe
      return (await axe.run()).violations.filter(item => item.impact === "serious" || item.impact === "critical")
    })
    receipts.push({ story: story.name, theme, width, violations })
    await page.screenshot({ path: resolve(shots, `${story.name.replace(/[^a-z0-9_-]/gi, "-")}-${theme}-${width}.png`), animations: "disabled", fullPage: true })
    expect(violations, `${story.name} ${theme} ${width}`).toEqual([])
  }
  await writeFile(join(shots, "axe.json"), JSON.stringify(receipts, null, 2))
  expect(errors).toEqual([])
})
test("live agents respect reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/view-stories.html?story=PrimitivesView/actor-coding")
  await expect(page.locator("[data-live]")).toHaveCSS("animation-name", "none")
})

test("primitive labels, starting animation and neutral glyph colors", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  for (const theme of ["light", "dark"]) {
    await page.goto(`/view-stories.html?story=PrimitivesView/state-starting-step&theme=${theme}`)
    await expect(page.locator(".mvp-state")).toHaveText("Starting · Implement")
    await expect(page.locator(".mvp-dot")).toHaveCSS("animation-name", "mvp-blink")
    await page.emulateMedia({ reducedMotion: "reduce" })
    await expect(page.locator(".mvp-dot")).toHaveCSS("animation-name", "none")
    await page.emulateMedia({ reducedMotion: "no-preference" })
    for (const [state, token] of [["in_review", "--text-muted"], ["merged", "--text-faint"]]) {
      await page.goto(`/view-stories.html?story=PrimitivesView/state-${state}&theme=${theme}`)
      const colors = await page.locator(".mvp-glyph").evaluate((glyph, token) => {
        const probe = document.createElement("span")
        probe.style.color = `var(${token})`
        document.body.append(probe)
        const expected = getComputedStyle(probe).color
        probe.remove()
        return { actual: getComputedStyle(glyph).color, expected }
      }, token!)
      expect(colors.actual).toBe(colors.expected)
    }
    await page.goto(`/view-stories.html?story=PrimitivesView/actor-fixture-system&theme=${theme}`)
    await expect(page.locator(".mvp-avatar")).toHaveAttribute("aria-label", "Install event")
  }
})

test("Confirm approval and Cancel keep supplied revision bindings", async ({ page }) => {
  await page.goto("/view-stories.html?story=ConfirmView/review_merge")
  await page.evaluate(() => {
    const receipts: unknown[] = []
    Object.assign(window, { confirmCallbacks: receipts })
    window.addEventListener("story-callback", event => receipts.push((event as CustomEvent).detail))
  })
  await page.locator('[data-flow="merge.confirm"]').focus()
  await page.keyboard.press("Enter")
  await page.locator('[data-flow="confirm.cancel"]').focus()
  await page.keyboard.press("Space")
  expect(await page.evaluate(() => (window as unknown as { confirmCallbacks: unknown[] }).confirmCallbacks)).toEqual([
    { kind: "action", value: { tag: "merge.confirm", args: { n: "12", revision: "4bc79ae" } } },
    { kind: "action", value: { tag: "confirm.cancel", args: { confirmation: "confirm-review_merge", revision: "4bc79ae" } } }
  ])
  await expect(page.locator(".confirm-view h2")).toHaveText("Merge T12 into main?")
})

test("Confirm disabled, absent actions and stale approval", async ({ page }) => {
  await page.goto("/view-stories.html?story=ConfirmView/disabled")
  await expect(page.getByRole("button", { name: "Amend" })).toBeDisabled()
  await expect(page.locator(".confirm-disabled")).toHaveText("Revision moved")
  for (const name of ["no_actions", "done", "cancelled", "expired", "merging", "merged"]) {
    await page.goto(`/view-stories.html?story=ConfirmView/${name}`)
    await expect(page.locator(".confirm-view button")).toHaveCount(0)
  }
  await page.goto("/view-stories.html?story=ConfirmView/stale_approval")
  await expect(page.locator(".confirm-stale")).toHaveText("You approved 1b2c3d4. Review 9e8f7a6.")
  await expect(page.locator('[data-flow="merge.confirm"]')).toHaveCount(0)
})
test("answer and late draft use their supplied actions", async ({ page }) => {
  await page.goto("/view-stories.html?story=TodoView/needs_you");
  await page.evaluate(() => window.addEventListener("story-callback", (event) => document.body.setAttribute("data-last-action", JSON.stringify((event as CustomEvent).detail.value))));
  await page.getByRole("textbox", { name: "Answer", exact: true }).fill("Yes, optional");
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-last-action",
    JSON.stringify({ tag: "todo.answer", args: { n: "12", wait: "wait-question-1", answer: "Yes, optional" } }),
  );
  await page.goto("/view-stories.html?story=TodoView/late_answer");
  await page.evaluate(() => window.addEventListener("story-callback", (event) => document.body.setAttribute("data-last-action", JSON.stringify((event as CustomEvent).detail.value))));
  await page.getByRole("textbox", { name: "Steer", exact: true }).fill("Keep my answer");
  await page.getByRole("button", { name: "Send as steer" }).click();
  await expect(page.getByRole("textbox", { name: "Steer", exact: true })).toHaveValue("Keep my answer");
  await expect(page.locator("body")).toHaveAttribute(
    "data-last-action",
    JSON.stringify({ tag: "todo.steer", args: { n: "12", text: "Keep my answer" } }),
  );
});
test("Setup and Settings forms dispatch edited values, fixes and write-only retry", async ({ page }) => {
  await page.addInitScript(() => {
    const calls: unknown[] = []
    Object.assign(window, { storyCalls: calls })
    window.addEventListener("story-callback", event => calls.push((event as CustomEvent).detail))
  })
  await page.goto("/view-stories.html?story=SetupView/A%20fresh%20install%20choosing%20its%20address")
  await page.getByLabel("Bind", { exact: true }).fill("0.0.0.0:9090")
  await page.getByRole("button", { name: "Save address" }).click()
  expect(await page.evaluate(() => (window as unknown as { storyCalls: unknown[] }).storyCalls)).toEqual([
    { kind: "action", value: { tag: "settings", args: { step: "address", listen: "mac", bind: "0.0.0.0:9090" } } }
  ])
  await page.goto("/view-stories.html?story=SetupView/A%20rejected%20AI%20Gateway%20key")
  await page.locator('input[id$="-key"]').fill("replacement-key")
  await expect(page.locator('input[id$="-key"]')).toHaveAttribute("type", "password")
  await page.getByRole("button", { name: "Retry" }).click()
  expect(await page.evaluate(() => (window as unknown as { storyCalls: unknown[] }).storyCalls)).toEqual([
    { kind: "action", value: { tag: "settings.model-key", args: { role: "jev", provider: "AI Gateway", key: "replacement-key" } } }
  ])
  await page.goto("/view-stories.html?story=SetupView/This%20Mac%20has%20no%20room%20for%20a%20machine")
  await page.getByRole("button", { name: "Close apps to free 6 GB" }).click()
  expect(await page.evaluate(() => (window as unknown as { storyCalls: unknown[] }).storyCalls)).toEqual([
    { kind: "action", value: { tag: "settings", args: { step: "machine" } } }
  ])
  await page.goto("/view-stories.html?story=SettingsView/Address%20apply%20failed%3B%20the%20previous%20bind%20remains%20active")
  await expect(page.locator('[role="alert"]')).toHaveText("Address already in use")
  const row = page.locator(".setup-settings dd").first()
  await expect(row).toContainText("In effect: 0.0.0.0:8080")
  await row.getByLabel("Address", { exact: true }).fill("0.0.0.0:9091")
  await row.getByRole("button", { name: "Retry" }).click()
  expect(await page.evaluate(() => (window as unknown as { storyCalls: unknown[] }).storyCalls)).toEqual([
    { kind: "action", value: { tag: "settings", args: { step: "address", bind: "0.0.0.0:9091" } } }
  ])
})

for (const native of ["unavailable", "refused"]) test(`Settings Copy uses the fallback when native clipboard is ${native}`, async ({ page }) => {
  await page.addInitScript(mode => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: mode === "unavailable" ? undefined : { writeText: async () => { throw new Error("Refused") } } })
    Object.assign(window, { copiedLines: [] })
    document.execCommand = command => {
      if (command !== "copy") return false
      ;(window as unknown as { copiedLines: string[] }).copiedLines.push((document.activeElement as HTMLTextAreaElement).value)
      return true
    }
  }, native)
  await page.goto("/view-stories.html?story=SettingsView/Settings%20for%20the%20owner")
  const copy = page.getByRole("button", { name: /^Copy / }).first()
  await copy.focus()
  await copy.press("Enter")
  expect(await page.evaluate(() => (window as unknown as { copiedLines: string[] }).copiedLines)).toEqual(["smthrs login http://mac-mini.local:8080"])
  await expect(copy).toBeFocused()
  await expect(page.locator('textarea[aria-hidden="true"]')).toHaveCount(0)
})
