import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of C-UI-12; its unit/CLI acceptance evidence remains separate.
// Written before implementation: mvp.md §6, §9; lands with T-UI-01..T-UI-14
test("C-UI-12: Every card fixture renders inline and maximized", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6, §9; lands with T-UI-01..T-UI-14")
  // Required seed: all View boundary fixtures as ordinary conversation entries,
  // including failures, empty lists, unavailable machines and stale confirmations.
  await owner(page)
  await page.goto("/")
  for (const mode of ["light", "dark"]) {
    await say(page, `/theme ${mode}`)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      for (const line of ["/stack", "/todo T8", "/branch retry-webhooks", "/settings", "/members", "/secrets", "/flows", "/wiki", "/help"]) {
        await say(page, line)
        const card = page.locator(".smithers-card").last()
        await expect(card).toBeVisible()
        await expect(card).not.toContainText("Something went wrong")
        await card.getByRole("button", { name: "Maximize card", exact: true }).press("Enter")
        await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible()
        await expect(card).toBeVisible()
        await page.getByRole("button", { name: "Restore", exact: true }).press("Enter")
        await expect(card).toBeVisible()
      }
    }
  }
})

// T-UI-01's phase is the shared primitives. Other View tickets own the matrix above.
test("C-UI-12: primitive actors, states and tones render in both Paper themes", async ({ page }) => {
  test.setTimeout(180_000)
  const actors = [
    ["person", "Ben"], ["person-ssh", "Maya via SSH"], ["person-terminal", "Maya's terminal"],
    ["person-cli", "Maya via CLI"], ["system", "Install event"], ["github", "@octocat"],
    ["outside", "Changed outside Smithers"], ["smithers", "Smithers"],
    ["smithers-for-ben", "Smithers for Ben"], ["coding-for-ben", "Coding agent for Ben"],
    ["reviewer-for-ben", "Reviewer for Ben"], ["claude-code-for-ben", "Claude Code for Ben"],
    ["codex-for-ben", "Codex for Ben"], ["external-for-ben", "External agent for Ben"]
  ] as const
  const states = [["queued", "Queued"], ["starting", "Starting"], ["working", "Working"],
    ["needs_you", "Needs you"], ["paused", "Paused"], ["failed", "Failed"],
    ["in_review", "In review"], ["merged", "Merged"], ["dropped", "Dropped"]] as const
  for (const theme of ["light", "dark"]) {
    for (const [actor, label] of actors) {
      await page.goto(`/view-stories.html?story=PrimitivesView/actor-${actor}&theme=${theme}`)
      await expect(page.locator(".avatar").first()).toHaveAttribute("aria-label", label)
      await expect(page.locator(".avatar").first()).toHaveCSS("width", "22px")
      await expect(page.locator(".avatar").last()).toHaveCSS("width", "28px")
      if (actor.startsWith("person-")) await expect(page.locator(".avatar-badge")).toHaveCount(2)
    }
    for (const [state, label] of states) for (const step of [false, true]) {
      await page.goto(`/view-stories.html?story=PrimitivesView/state-${state}${step ? "-step" : ""}&theme=${theme}`)
      await expect(page.locator(".state")).toHaveText(label + (step ? " · Implement" : ""))
      await expect(page.locator(".state")).toHaveAttribute("data-state", state)
      await expect(page.locator(".state .glyph, .state .dot")).toHaveCount(1)
    }
    for (const [tone, token] of [["live", "--brand"], ["attention", "--attention"],
      ["failed", "--danger"], ["done", "--text-muted"], ["quiet", "--text-muted"]] as const) {
      await page.goto(`/view-stories.html?story=PrimitivesView/tone-${tone}&theme=${theme}`)
      const colors = await page.locator(`[data-tone="${tone}"]`).evaluate((node, token) => {
        const probe = document.createElement("span")
        probe.style.color = `var(${token})`
        document.body.append(probe)
        const expected = getComputedStyle(probe).color
        probe.remove()
        return { actual: getComputedStyle(node).color, expected }
      }, token)
      expect(colors.actual).toBe(colors.expected)
    }
  }
})
