import { test, expect } from "./browserTest"
import { fixtures as actorFixtures } from "@smthrs/rpc/fixtures/ActorChip"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { createRequire } from "node:module"
const require = createRequire(resolve(process.cwd(), "package.json"))
const axePath = require.resolve("axe-core/axe.min.js")
const diffExpected: Record<string, string> = { item_base: 'description: "Complete one TODO"', fork: "export const repro = true", deleted: "export const legacy = true", burst: 'description: "Build"', multiple_hunks: "same", hostile: '<script>alert("diff")</script>' }
const shots = process.env.SMITHERS_VIEW_SHOTS ?? resolve(process.cwd(), "../../.artifacts/checks/C-UI-12", new Date().toISOString().replace(/[:.]/g, "-"))
test("Shell breakpoint and keyboard controls", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { shellReceipts: [] })
    window.addEventListener("story-callback", event =>
      (window as unknown as { shellReceipts: unknown[] }).shellReceipts.push((event as CustomEvent).detail))
  })
  for (const theme of ["light", "dark"]) for (const width of [1179, 1180]) for (const input of ["pointer", "Enter", "Space"]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(`/view-stories.html?story=Shell/Breakpoint%20and%20controls&theme=${theme}`)
    const timeline = page.getByRole("navigation", { name: "Timeline", includeHidden: true })
    await expect(timeline).toHaveCSS("display", width === 1179 ? "none" : "block")
    for (const direction of ["above", "below"]) {
      const edge = page.locator(`.edge[data-edge="${direction}"]`)
      if (width === 1179) {
        await expect(edge.locator(".edge-pill")).toBeVisible()
        await expect(edge.locator(".tl-edge")).toBeHidden()
      } else {
        await expect(edge.locator(".edge-pill")).toBeHidden()
        await expect(edge.locator(".tl-edge")).toBeVisible()
        await expect(edge.locator(".tl-row")).toHaveCount(2)
        await expect(edge.locator(".tl-more")).toHaveText(`+1 ${direction}`)
      }
    }
    expect(await timeline.locator("li[data-in-view]").evaluateAll(rows => rows.map(row => row.getAttribute("data-entry")))).toEqual(["line-2", "line-3"])
    await expect.poll(() => page.evaluate(() => Reflect.get(window, "shellReceipts"))).toEqual([
      { kind: "view", value: { timeline_visible: width === 1180 } },
    ])
    await page.evaluate(() => { Reflect.get(window, "shellReceipts").length = 0 })
    const expected: unknown[] = []
    const activate = async (selector: string, receipt: unknown) => {
      const control = page.locator(selector)
      if (input === "pointer") await control.click()
      else {
        await control.focus()
        await page.keyboard.press("Shift+Tab")
        await page.keyboard.press("Tab")
        await expect(control).toBeFocused()
        expect(await control.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe("none")
        await page.keyboard.press(input)
      }
      if (receipt) expected.push(receipt)
      await expect.poll(() => page.evaluate(() => Reflect.get(window, "shellReceipts"))).toEqual(expected)
    }
    await expect(page.locator(".notice")).toHaveCount(3)
    await expect(page.locator(".notice-more")).toHaveText("+2 more")
    await activate(".notice-more", undefined)
    await expect(page.locator(".notice")).toHaveCount(5)
    await expect(page.locator(".notice-more")).toHaveCount(0)
    await expect(page.locator(".notice").nth(3).getByRole("button").first()).toBeFocused()
    await activate('[aria-label="Hide Needs you"]', { kind: "view", value: { toast_hidden: "notice-2" } })
    await expect(page.locator(".notice")).toHaveCount(5)
    await expect(timeline.locator("li")).toHaveCount(4)
    await expect(page.locator(".edge .tl-row")).toHaveCount(4)
    await activate('[data-flow="notifications.allow"]', { kind: "action", value: { tag: "notifications.allow", args: {} } })
    if (width === 1179) {
      await activate('[data-edge="above"] .edge-pill', { kind: "view", value: { jump_to: "above-3" } })
      await activate('[data-edge="below"] .edge-pill', { kind: "view", value: { jump_to: "below-1" } })
    } else {
      await activate('[data-edge="above"] .tl-row >> nth=0', { kind: "view", value: { jump_to: "above-1" } })
      await activate('[data-edge="below"] .tl-row >> nth=0', { kind: "view", value: { jump_to: "below-1" } })
      await activate('[data-edge="above"] .tl-more', { kind: "view", value: { jump_to: "above-3" } })
      await activate('[data-edge="below"] .tl-more', { kind: "view", value: { jump_to: "below-3" } })
      await activate('[data-entry="line-2"] > button', { kind: "view", value: { jump_to: "line-2" } })
      await activate('[data-entry="line-3"] > button', { kind: "view", value: { jump_to: "line-3" } })
      expect(await timeline.locator('[data-entry="line-2"] > button').evaluate(node => getComputedStyle(node).boxShadow)).not.toBe("none")
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
})

test("Shell resize preserves disclosure and reports only breakpoint transitions", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { resizeReceipts: [] })
    window.addEventListener("story-callback", event =>
      (window as unknown as { resizeReceipts: unknown[] }).resizeReceipts.push((event as CustomEvent).detail))
  })
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 1179, height: 1000 })
    await page.goto(`/view-stories.html?story=Shell/Breakpoint%20and%20controls&theme=${theme}`)
    const timeline = page.getByRole("navigation", { name: "Timeline", includeHidden: true })
    await expect.poll(() => page.evaluate(() => Reflect.get(window, "resizeReceipts"))).toEqual([
      { kind: "view", value: { timeline_visible: false } },
    ])
    await page.locator(".notice-more").press("Enter")
    await expect(page.locator(".notice")).toHaveCount(5)
    const revealed = page.locator(".notice").nth(3).getByRole("button").first()
    await expect(revealed).toBeFocused()
    await page.keyboard.press("Tab")
    const next = page.locator(".notice").nth(4).getByRole("button").first()
    await expect(next).toBeFocused()
    const expected = [{ kind: "view", value: { timeline_visible: false } }]
    for (const [width, visible, changed] of [[1180, true, true], [1280, true, false], [1179, false, true], [1100, false, false], [1180, true, true]] as const) {
      await page.setViewportSize({ width, height: 1000 })
      await expect(timeline).toHaveCSS("display", visible ? "block" : "none")
      await expect(page.locator('[data-edge="above"] .edge-pill')).toBeVisible({ visible: !visible })
      await expect(page.locator(".notice")).toHaveCount(5)
      await expect(page.locator(".notice-more")).toHaveCount(0)
      await expect(next).toBeFocused()
      if (changed) expected.push({ kind: "view", value: { timeline_visible: visible } })
      await expect.poll(() => page.evaluate(() => Reflect.get(window, "resizeReceipts"))).toEqual(expected)
    }
    expect(await timeline.locator("li[data-in-view]").evaluateAll(rows => rows.map(row => row.getAttribute("data-entry")))).toEqual(["line-2", "line-3"])
    await page.locator('[data-entry="line-3"] > button').press("Space")
    await expect.poll(() => page.evaluate(() => Reflect.get(window, "resizeReceipts"))).toEqual([
      ...expected, { kind: "view", value: { jump_to: "line-3" } },
    ])
  }
})

test("every View story: light/dark, desktop/mobile, axe and overflow", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "C-UI-12 requires Chromium")
  test.setTimeout(1_800_000) // ~360 stories × 2 themes × 3 widths with axe takes ~11 min on the mini
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
  await mkdir(shots, { recursive: true })
  await page.goto("/view-stories.html")
  const stories = await page.locator("nav a").evaluateAll(links => links.map(link => ({ name: link.textContent!, href: (link as HTMLAnchorElement).getAttribute("href")! })))
  const selectedStories = process.env.SMITHERS_VIEW_STORY_FILTER
    ? stories.filter(story => process.env.SMITHERS_VIEW_STORY_FILTER!.split(",").some(name => story.name.includes(name)))
    : stories
  expect(selectedStories.length).toBeGreaterThan(0)
  // SMITHERS_VIEW_STORY_FILTER selects lane stories; include the ticket's 1440px acceptance width.
  const receipts = []
  for (const story of selectedStories) for (const theme of ["light", "dark"]) for (const width of [1280, 1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
    await page.goto(`/view-stories.html${story.href}&theme=${theme}`)
    await expect(page.locator("[data-story]")).toBeVisible()
    if (story.name.startsWith("SettingsView/")) {
      const copy = await page.locator('[data-kind="settings"]').evaluate(card => [card.textContent, ...[card, ...card.querySelectorAll("*")].flatMap(element => [...element.attributes].map(attribute => attribute.value))].join("\n"))
      expect(copy).not.toMatch(/jev/i)
    }
    if (story.name.includes("/actor-")) {
      const agents = page.locator(".avatar[data-agent]")
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
    if (story.name.startsWith("DiffSurface/")) {
      
      const text = diffExpected[story.name.split("/")[1]!]
      if (text) await expect(page.locator("diffs-container")).toContainText(text)
    }
    if (story.name.startsWith("DocsView/")) {
      await expect(page.locator(".mvp-docs .sui-md")).toBeVisible()
      if (story.name.endsWith("No navigation gesture")) {
        const current = page.locator('.mvp-docs nav [aria-current="page"]')
        await expect(current).toHaveText("Quickstart")
        await expect(current).toHaveCSS("font-weight", "600")
        expect(await current.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)")
      }
      if (story.name.endsWith("Inert HTML")) {
        await expect(page.locator(".mvp-docs script,.mvp-docs img,.mvp-docs iframe")).toHaveCount(0)
        for (const name of ["Blocked", "Control", "Data"]) await expect(page.locator(".mvp-docs .sui-md a").filter({ hasText: name })).not.toHaveAttribute("href")
      }
      if (story.name.endsWith("Scrolled to a heading")) {
        const top = await page.locator(".mvp-docs .sui-md-heading").evaluate(node => node.getBoundingClientRect().top)
        expect(top).toBeGreaterThanOrEqual(0)
        expect(top).toBeLessThan(width === 390 ? 844 : 800)
      }
    }
    if (story.name.startsWith("ActLineView/")) {
      await page.locator(".act-line-steps, .act-line-output").evaluateAll(nodes => nodes.forEach(node => (node as HTMLDetailsElement).open = true))
    }
    await page.evaluate(() => document.fonts.ready)
    // Worker highlighting can replace an entering annotation. Audit its settled projection.
    const flagCount = story.name === "CodeEditorView/live_separate" ? 3
      : /^CodeEditorView\/(live|five_editors|remote_carets_on|remote_carets_off)$/.test(story.name) ? 1 : 0
    await expect.poll(() => page.locator(".code-name-flag").evaluateAll(flags =>
      flags.map(flag => getComputedStyle(flag).opacity))).toEqual(Array(flagCount).fill("1"))
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
    await expect(page.locator(".state")).toHaveText("Starting · Implement")
    await expect(page.locator(".dot")).toHaveCSS("animation-name", "blink")
    await page.emulateMedia({ reducedMotion: "reduce" })
    await expect(page.locator(".dot")).toHaveCSS("animation-name", "none")
    await page.emulateMedia({ reducedMotion: "no-preference" })
    for (const [state, token] of [["in_review", "--text-muted"], ["merged", "--text-faint"]]) {
      await page.goto(`/view-stories.html?story=PrimitivesView/state-${state}&theme=${theme}`)
      const colors = await page.locator(".glyph").evaluate((glyph, token) => {
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
    await expect(page.locator(".avatar")).toHaveAttribute("aria-label", "Smithers")
  }
})

test("Confirm approval and Cancel keep supplied revision bindings", async ({ page }) => {
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`/view-stories.html?story=ConfirmView/review_merge&theme=${theme}`)
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
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
})

test("Confirm disabled, absent actions and stale approval", async ({ page }) => {
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`/view-stories.html?story=ConfirmView/disabled&theme=${theme}`)
    await expect(page.getByRole("button", { name: "Amend" })).toBeDisabled()
    await expect(page.locator(".confirm-disabled")).toHaveText("Revision moved")
    for (const name of ["no_actions", "done", "cancelled", "expired", "merging", "merged"]) {
      await page.goto(`/view-stories.html?story=ConfirmView/${name}&theme=${theme}`)
      await expect(page.locator(".confirm-view button")).toHaveCount(0)
  }
  await page.goto(`/view-stories.html?story=ConfirmView/stale_approval&theme=${theme}`)
  await expect(page.locator(".confirm-stale")).toHaveText("Approved 1b2c3d4 · Review 9e8f7a6")
  await expect(page.locator('[data-flow="merge.confirm"]')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
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
  await expect(page.locator('[role="alert"]')).toHaveText("infra")
  const details = page.locator(".setup-address-failed details")
  await expect(details).not.toHaveAttribute("open", "")
  await expect(details.locator("pre")).toHaveText("Address already in use")
  await expect(details.locator("pre")).not.toBeVisible()
  await details.locator("summary").focus()
  await page.keyboard.press("Enter")
  await expect(details.locator("pre")).toBeVisible()
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

// T-UI-14 §Tests: native disclosure must never dispatch a command.
test("Commands keyboard disclosure and inert policy marks", async ({ page }) => {
  await page.goto("/view-stories.html?story=CommandsView/Commands%20a%20maintainer%20may%20run")
  await page.evaluate(() => {
    Object.assign(window, { commandCallbacks: [] })
    window.addEventListener("story-callback", event => (window as unknown as { commandCallbacks: unknown[] }).commandCallbacks.push((event as CustomEvent).detail))
  })
  const advanced = page.locator("details")
  await expect(advanced).not.toHaveAttribute("open")
  await expect(page.getByText("/monitor", { exact: true })).toBeHidden()
  await page.keyboard.press("Tab")
  await expect(page.locator("summary")).toBeFocused()
  await expect(page.locator("summary")).toHaveCSS("outline-style", "solid")
  await page.keyboard.press("Enter")
  await expect(page.getByText("/monitor", { exact: true })).toBeVisible()
  await page.keyboard.press("Space")
  await expect(advanced).not.toHaveAttribute("open")
  await expect(page.locator(".command-policy").filter({ hasText: "Asks first" })).toHaveCount(1)
  await expect(page.locator("button, a")).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { commandCallbacks: unknown[] }).commandCallbacks)).toEqual([])
})

// T-UI-14 acceptance: review widths and expanded disclosure belong to Commands.
test("Commands review screenshots and muted policy marks", async ({ page }) => {
  await mkdir(shots, { recursive: true })
  await page.goto("/view-stories.html")
  const stories = await page.locator("nav a").evaluateAll(links => links.map(link => ({ name: link.textContent!, href: link.getAttribute("href")! })).filter(story => story.name.startsWith("CommandsView/")))
  const receipts = []
  for (const story of stories) for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
    await page.goto(`/view-stories.html${story.href}&theme=${theme}`)
    await expect(page.locator("[data-story]")).toBeVisible()
    if (story.name.startsWith("DiffSurface/")) {
      
      const text = diffExpected[story.name.split("/")[1]!]
      if (text) await expect(page.locator("diffs-container")).toContainText(text)
    }
    if (story.name.startsWith("ActLineView/")) {
      await page.locator(".act-line-steps, .act-line-output").evaluateAll(nodes => nodes.forEach(node => (node as HTMLDetailsElement).open = true))
    }
    await page.evaluate(() => document.fonts.ready)
    {
      const policyColors = await page.locator(".command-policy").evaluateAll(marks => {
        const probe = document.createElement("span")
        probe.style.color = "var(--text-faint)"
        document.body.append(probe)
        const expected = getComputedStyle(probe).color
        probe.remove()
        return marks.map(mark => ({ actual: getComputedStyle(mark).color, expected }))
      })
      for (const colors of policyColors) expect(colors.actual).toBe(colors.expected)
    }
    await page.addScriptTag({ path: axePath })
    for (const expanded of [false, true]) {
      if (expanded) {
        if (!await page.locator("summary").count()) continue
        await page.locator("summary").click()
      }
      const violations = await page.evaluate(async () => (await (window as unknown as { axe: { run: () => Promise<{ violations: { impact: string }[] }> } }).axe.run()).violations.filter(item => item.impact === "serious" || item.impact === "critical"))
      expect(violations).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      receipts.push({ story: story.name, theme, width, expanded, violations })
      await page.screenshot({ path: resolve(shots, `${story.name.replace(/[^a-z0-9_-]/gi, "-")}-${theme}-${width}${expanded ? "-advanced" : ""}.png`), animations: "disabled", fullPage: true })
    }
  }
  await writeFile(join(shots, "commands-axe.json"), JSON.stringify(receipts, null, 2))
})

// ui-components Rules (1): the browser sends edited fields with bound args.
test("Commands action input dispatches edited values exactly once", async ({ page }) => {
  await page.goto("/view-stories.html?story=CommandsView/Action%20input")
  await page.evaluate(() => {
    Object.assign(window, { commandCallbacks: [] })
    window.addEventListener("story-callback", event => (window as unknown as { commandCallbacks: unknown[] }).commandCallbacks.push((event as CustomEvent).detail))
  })
  await page.getByLabel("Query").fill("")
  await expect(page.getByRole("button", { name: "Search" })).toBeDisabled()
  await page.getByLabel("Query").fill("edited")
  await page.getByLabel("Scope").selectOption("wiki")
  await page.getByLabel("Token").fill("test-token")
  await page.getByLabel("Notes").fill("two\nlines")
  await page.getByRole("button", { name: "Search" }).click()
  expect(await page.evaluate(() => (window as unknown as { commandCallbacks: unknown[] }).commandCallbacks)).toEqual([
    { kind: "action", value: { tag: "search", args: { query: "edited", scope: "wiki", token: "test-token", notes: "two\nlines" } } }
  ])
})

// T-UI-09: spec §14.3 Members; literal command/payload and §14.7 keyboard oracle.
test("Members keyboard Add and Role dispatch exactly once", async ({ page }) => {
  await page.goto('/view-stories.html?story=MembersView/team')
  await page.evaluate(() => {
    (window as unknown as { memberCalls: unknown[] }).memberCalls = []
    window.addEventListener('story-callback', event => {
      (window as unknown as { memberCalls: unknown[] }).memberCalls.push((event as CustomEvent).detail)
    })
  })
  await page.getByRole('textbox', { name: 'GitHub username' }).fill('alice-new')
  await page.getByRole('button', { name: 'Add', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as unknown as { memberCalls: unknown[] }).memberCalls)).toEqual([
    { kind: 'action', value: { tag: 'members.add', args: { login: 'alice-new', role: 'member' } } },
  ])
  await page.getByRole('textbox', { name: 'GitHub username' }).fill('')
  await page.getByRole('button', { name: 'Add', exact: true }).press('Enter')
  expect(await page.evaluate(() => (window as unknown as { memberCalls: unknown[] }).memberCalls.length)).toBe(1)
  const row = page.locator('[data-login="ben"]')
  await row.getByRole('combobox', { name: 'Role' }).selectOption('member')
  await row.getByRole('button', { name: 'Role', exact: true }).focus()
  await page.keyboard.press('Space')
  await expect.poll(() => page.evaluate(() => (window as unknown as { memberCalls: unknown[] }).memberCalls)).toEqual([
    { kind: 'action', value: { tag: 'members.add', args: { login: 'alice-new', role: 'member' } } },
    { kind: 'action', value: { tag: 'members.role', args: { login: 'ben', role: 'member' } } },
  ])
  await expect(page.locator('[data-login="williamcory"] button')).toHaveCount(0)
  await page.goto('/view-stories.html?story=MembersView/member_view')
  await expect(page.locator('[data-story] button')).toHaveCount(0)
})

test("Flow versions stay local; keyboard actions dispatch once", async ({ page }) => {
  await page.goto("/view-stories.html?story=FlowView/proposed")
  await page.evaluate(() => {
    Object.assign(window, { flowReceipts: [] })
    window.addEventListener("story-callback", event => (window as unknown as { flowReceipts: unknown[] }).flowReceipts.push((event as CustomEvent).detail))
  })
  await page.locator('.flow-version[data-state="proposed"]').focus()
  await page.keyboard.press("Enter")
  await expect(page.locator('[data-added="true"]')).toContainText("Update docs")
  expect(await page.evaluate(() => (window as unknown as { flowReceipts: unknown[] }).flowReceipts)).toEqual([])
  await page.locator('[data-flow="flow.run"]').focus()
  await page.keyboard.press("Space")
  expect(await page.evaluate(() => (window as unknown as { flowReceipts: unknown[] }).flowReceipts)).toEqual([{ kind: "action", value: { tag: "flow.run", args: { name: "todo" } } }])
})

test("T-UI-11 Pierre renders supplied hunks with line numbers and burst Restore", async ({ page }) => {
  // T-UI-11 Tests: literal expectations from the committed Diff fixtures.
  for (const [story, text, numbers] of [
    ['item_base', 'Complete one TODO', ['2', '3']],
    ['fork', 'export const repro = true', ['1']],
    ['deleted', 'export const legacy = true', ['1']],
    ['burst', 'description: "Build"', ['2', '3']],
    ['multiple_hunks', 'same', ['1', '5']],
  ] as const) {
    await page.goto(`/view-stories.html?story=DiffSurface/${story}`)
    await expect(page.locator('diffs-container')).toBeVisible()
    await expect(page.locator('diffs-container')).toContainText(text)
    for (const n of numbers) await expect(page.locator(`diffs-container [data-column-number="${n}"]`).first()).toBeVisible()
    if (story === 'multiple_hunks') await expect(page.locator('diffs-container [data-line="5"][data-alt-line="4"]')).toContainText('same')
    await expect(page.getByRole('button', { name: 'Restore this file' })).toHaveCount(story === 'burst' ? 1 : 0)
  }
  await page.goto('/view-stories.html?story=DiffSurface/burst')
  await page.evaluate(() => window.addEventListener('story-callback', event => document.body.setAttribute('data-diff-action', JSON.stringify((event as CustomEvent).detail))))
  await page.getByRole('button', { name: 'Restore this file' }).focus(); await page.keyboard.press('Enter')
  await expect(page.locator('body')).toHaveAttribute('data-diff-action', JSON.stringify({ kind: 'action', value: { tag: 'file.restore', args: { path: 'flows/todo/flow.ts', revision: 'burst-17' } } }))
  await page.goto('/view-stories.html?story=DiffSurface/hostile')
  await expect(page.locator('diffs-container')).toContainText('<script>alert("diff")</script>')
  await expect(page.locator('diffs-container script')).toHaveCount(0)
})

// T-UI-03 named Draft cases share the same fixture harness and Chromium runner.
import { fixtures as draftFixtures } from "@smthrs/rpc/fixtures/Draft"
const draftActionCalls = {
  append: [{ tag: "todo.new", args: {} }, { tag: "draft.discard", args: { draft: "entry-draft-1" } }],
  before: [{ tag: "todo.new", args: { before: "8" } }, { tag: "draft.discard", args: { draft: "entry-draft-1" } }],
  amend: [{ tag: "todo.amend", args: { n: "9" } }, { tag: "draft.discard", args: { draft: "entry-draft-1" } }],
  issue_fixes: [{ tag: "todo.new", args: {} }, { tag: "draft.discard", args: { draft: "entry-draft-1" } }],
  issue_without_fixes: [{ tag: "todo.new", args: {} }, { tag: "draft.discard", args: { draft: "entry-draft-1" } }],
  seed: [{ tag: "todo.new", args: {} }, { tag: "draft.discard", args: { draft: "entry-draft-1" } }],
  committed: [],
  committed_amendment: [],
  empty_stack: [{ tag: "draft.discard", args: { draft: "entry-draft-1" } }],
} as const
for (const name of Object.keys(draftActionCalls) as (keyof typeof draftActionCalls)[]) test(`Draft ${name}: supplied actions and keyboard`, async ({ page }) => {
  const fixture = draftFixtures[name]
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(`/view-stories.html?story=${encodeURIComponent(`DraftView/${fixture.name}`)}&theme=${theme}`)
    await expect(page.getByRole("region", { name: "Draft", exact: true })).toBeVisible()
    await page.evaluate(() => {
      (window as unknown as { draftCalls: unknown[] }).draftCalls = []
      window.addEventListener("story-callback", event => {
        ;(window as unknown as { draftCalls: unknown[] }).draftCalls.push((event as CustomEvent).detail)
      })
    })
    if (name === "committed" || name === "committed_amendment") {
      await expect(page.locator(".draft-actions button")).toHaveCount(0)
      await expect(page.locator(".draft-private")).toHaveCount(0)
      await expect(page.locator(".draft-receipt")).toContainText(name === "committed" ? "Committed as T12" : "Committed as T9+1")
    } else {
      await expect(page.locator(".draft-private")).toHaveText("Only you")
      await page.keyboard.press("Tab")
      await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeFocused()
      await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveCSS("outline-width", "2px")
      await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveCSS("outline-style", "solid")
      if (name === "empty_stack") await expect(page.locator('button[data-flow="todo.new"]')).toBeDisabled()
      if (name === "seed") {
        await expect(page.locator(".draft-seed")).toContainText("Seed · Read-only")
        await expect(page.locator(".draft-seed button,.draft-seed input,.draft-seed textarea")).toHaveCount(0)
      }
      for (const action of draftActionCalls[name]) {
        const control = page.locator(`button[data-flow="${action.tag}"]`)
        await control.focus(); await page.keyboard.press("Enter")
      }
      expect(await page.evaluate(() => (window as unknown as { draftCalls: unknown[] }).draftCalls)).toEqual(
        draftActionCalls[name].map(value => ({ kind: "action", value })))
      await page.goto(`/view-stories.html?story=${encodeURIComponent(`DraftView/${fixture.name}`)}&removeFirst&theme=${theme}`)
      await expect(page.getByRole("button", { name: "Commit", exact: true })).toHaveCount(0)
      await expect(page.locator('button[data-flow="draft.discard"]')).toHaveCount(1)
      continue
    }
    expect(await page.evaluate(() => (window as unknown as { draftCalls: unknown[] }).draftCalls)).toEqual([])
  }
})

test("Draft field edits forward literal payloads once and unchanged blur is silent", async ({ page }) => {
  await page.goto("/view-stories.html?story=DraftView/From%20an%20issue%20it%20closes")
  await page.evaluate(() => {
    (window as unknown as { draftCalls: unknown[] }).draftCalls = []
    window.addEventListener("story-callback", event => (window as unknown as { draftCalls: unknown[] }).draftCalls.push((event as CustomEvent).detail))
  })
  await page.getByRole("textbox", { name: "Title", exact: true }).focus()
  await page.getByRole("textbox", { name: "Title", exact: true }).blur()
  expect(await page.evaluate(() => (window as unknown as { draftCalls: unknown[] }).draftCalls)).toEqual([])
  for (const [label, value] of [["Title", "Browser title"], ["Prompt", "Browser\nprompt"], ["Acceptance", "First\nSecond"]]) {
    const field = page.getByRole("textbox", { name: label!, exact: true })
    await field.fill(value!); await field.blur()
  }
  const place = page.getByRole("combobox", { name: "Place", exact: true })
  await place.selectOption('{"mode":"before","n":8}'); await place.blur()
  const fixes = page.getByRole("checkbox")
  await fixes.uncheck(); await fixes.blur()
  // Switch to the unchecked fixture so true changes the supplied model value.

  expect(await page.evaluate(() => (window as unknown as { draftCalls: unknown[] }).draftCalls)).toEqual([
    { kind: "action", value: { tag: "form.set", args: { entry: "entry-draft-1", field: "title", value: "Browser title" } } },
    { kind: "action", value: { tag: "form.set", args: { entry: "entry-draft-1", field: "prompt", value: "Browser\nprompt" } } },
    { kind: "action", value: { tag: "form.set", args: { entry: "entry-draft-1", field: "acceptance", value: '["First","Second"]' } } },
    { kind: "action", value: { tag: "form.set", args: { entry: "entry-draft-1", field: "place", value: '{"mode":"before","n":8}' } } },
    { kind: "action", value: { tag: "form.set", args: { entry: "entry-draft-1", field: "fixes", value: "false" } } }
  ])
  await page.goto("/view-stories.html?story=DraftView/From%20an%20issue%20it%20does%20not%20close")
  await page.evaluate(() => {
    (window as unknown as { draftCalls: unknown[] }).draftCalls = []
    window.addEventListener("story-callback", event => (window as unknown as { draftCalls: unknown[] }).draftCalls.push((event as CustomEvent).detail))
  })
  await page.getByRole("checkbox").check(); await page.getByRole("checkbox").blur()
  expect(await page.evaluate(() => (window as unknown as { draftCalls: unknown[] }).draftCalls)).toEqual([
    { kind: "action", value: { tag: "form.set", args: { entry: "entry-draft-1", field: "fixes", value: "true" } } }
  ])
  await page.goto("/view-stories.html?story=DraftView/Place%20before%20T8")
  await page.evaluate(() => {
    (window as unknown as { draftCalls: unknown[] }).draftCalls = []
    window.addEventListener("story-callback", event => (window as unknown as { draftCalls: unknown[] }).draftCalls.push((event as CustomEvent).detail))
  })
  await page.getByRole("combobox", { name: "Place", exact: true }).selectOption('{"mode":"append"}')
  await page.getByRole("combobox", { name: "Place", exact: true }).blur()
  expect(await page.evaluate(() => (window as unknown as { draftCalls: unknown[] }).draftCalls)).toEqual([
    { kind: "action", value: { tag: "form.set", args: { entry: "entry-draft-1", field: "place", value: '{"mode":"append"}' } } }
  ])
})

test("T-UI-17 watched and frozen terminals never take input focus", async ({ page }) => {
  for (const name of ["Someone else's terminal", "The coding agent's terminal", "Frozen while rebasing", "Watching while rebasing"]) {
    await page.goto(`/view-stories.html?story=${encodeURIComponent(`TerminalView/${name}`)}`)
    const output = page.locator('.terminal-output > div')
    await expect(output).toHaveAttribute('inert', '')
    await expect(page.locator('.xterm-helper-textarea')).toHaveCount(1)
    await output.click({ force: true })
    await page.keyboard.press('Tab')
    await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused()
    await page.keyboard.press('Meta+k')
    await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused()
    await expect(page.locator('.terminal-status')).toContainText(name.includes('rebasing') ? 'Rebasing…' : 'Watching')
  }
  await page.goto(`/view-stories.html?story=${encodeURIComponent("TerminalView/Owner's idle terminal")}`)
  await expect(page.locator('.terminal-output > div')).not.toHaveAttribute('inert')
  await page.locator('.xterm-helper-textarea').focus()
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
})

// T-UI-16 / R6: bind the light syntax override to the rendered adapter, not its CSS text.
test("File light syntax resolves to Paper ink", async ({ page }) => {
  await page.goto("/view-stories.html?story=CodeSurface/deleted_readonly&theme=light")
  const keyword = page.locator('.cm-content span').filter({ hasText: /^make$/ }).first()
  await expect(keyword).toBeVisible()
  await expect.poll(async () => keyword.evaluate(element => {
    const probe = document.createElement("span")
    probe.style.color = "var(--lane-1)"
    document.body.append(probe)
    const matches = getComputedStyle(element).color === getComputedStyle(probe).color
    probe.remove()
    return matches
  })).toBe(true)
  const tokens = await page.locator(".cm-content span").evaluateAll(spans => {
    const luminance = (color: string) => {
      const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(value => {
        const channel = Number(value) / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
    }
    return spans.filter(span => {
      const bounds = span.getBoundingClientRect()
      return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight && bounds.right > 0 && bounds.left < innerWidth && getComputedStyle(span).visibility === "visible"
    }).map(span => {
      const ink = luminance(getComputedStyle(span).color)
      const paper = luminance(getComputedStyle(span.closest(".cm-editor")!).backgroundColor)
      return { token: span.textContent, ratio: (Math.max(ink, paper) + 0.05) / (Math.min(ink, paper) + 0.05) }
    })
  })
  expect(tokens.length).toBeGreaterThan(0)
  for (const { token, ratio } of tokens) expect(ratio, `Token ${JSON.stringify(token)} contrast`).toBeGreaterThanOrEqual(4.5)
})

test("Secrets Add, Cancel and absent actions use real controls", async ({ page }) => {
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
    await page.goto(`/view-stories.html?story=SecretsView/empty&theme=${theme}`)
    await page.evaluate(() => {
      Object.assign(window, { secretCalls: [] })
      window.addEventListener("story-callback", event => (window as unknown as { secretCalls: unknown[] }).secretCalls.push((event as CustomEvent).detail))
    })
    const form = page.locator('.secret-add form')
    await form.getByRole("textbox", { name: "Name", exact: true }).fill("NEW_TOKEN")
    await form.locator('input[type="password"]').fill("cancelled-write")
    await form.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(form.locator('input[type="password"]')).toHaveValue("")
    expect(await page.evaluate(() => (window as unknown as { secretCalls: unknown[] }).secretCalls)).toEqual([])
    await form.getByRole("textbox", { name: "Name", exact: true }).fill("NEW_TOKEN")
    await form.locator('input[type="password"]').fill("submitted-write")
    await form.locator('select').selectOption("main_only")
    await form.getByRole("textbox", { name: "Hosts", exact: true }).fill("api.example.com")
    await form.getByRole("button", { name: "Add", exact: true }).focus()
    await page.keyboard.press("Enter")
    expect(await page.evaluate(() => (window as unknown as { secretCalls: unknown[] }).secretCalls)).toEqual([
      { kind: "action", value: { tag: "secrets", args: { operation: "set", name: "NEW_TOKEN", value: "[redacted]", scope: "main_only", hosts: "api.example.com" } } }
    ])
    await expect(form.locator('input[type="password"]')).toHaveValue("")
    await page.goto(`/view-stories.html?story=SecretsView/member_view&theme=${theme}`)
    await expect(page.locator('.secrets-view')).toContainText("NPM_TOKEN")
    await expect(page.locator('.secrets-view button')).toHaveCount(0)
    await page.goto(`/view-stories.html?story=SecretsView/empty&removeFirst&theme=${theme}`)
    await expect(page.locator('.secrets-view button')).toHaveCount(0)
    await page.goto(`/view-stories.html?story=SecretsView/disabled&theme=${theme}`)
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled()
  }
})

test("Secrets optional Hosts, disabled forms and Delete use real controls", async ({ page }) => {
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`/view-stories.html?story=SecretsView/no_hosts_field&theme=${theme}`)
    await expect(page.getByRole("textbox", { name: "Hosts", exact: true })).toHaveCount(0)
    await page.goto(`/view-stories.html?story=SecretsView/disabled_form&theme=${theme}`)
    await page.evaluate(() => {
      Object.assign(window, { secretCalls: [] })
      window.addEventListener("story-callback", event => (window as unknown as { secretCalls: unknown[] }).secretCalls.push((event as CustomEvent).detail))
    })
    await expect(page.locator('.secret-add input:disabled,.secret-add select:disabled')).toHaveCount(4)
    await expect(page.getByRole("button", { name: "Add", exact: true })).toBeDisabled()
    await page.getByRole("button", { name: "Cancel", exact: true }).focus()
    await page.keyboard.press("Enter")
    expect(await page.evaluate(() => Reflect.get(window, "secretCalls"))).toEqual([])
    await page.goto(`/view-stories.html?story=SecretsView/hostile&theme=${theme}`)
    await expect(page.locator('.secrets-view code')).toHaveText('<img src=x onerror="alert(1)">')
    await expect(page.locator('.secrets-view img,.secrets-view script')).toHaveCount(0)
    await page.goto(`/view-stories.html?story=SecretsView/mixed&theme=${theme}`)
    await expect(page.locator('.secret-scope')).toHaveText(["all branches", "main only"])
    await page.evaluate(() => {
      Object.assign(window, { secretCalls: [] })
      window.addEventListener("story-callback", event => (window as unknown as { secretCalls: unknown[] }).secretCalls.push((event as CustomEvent).detail))
    })
    await page.getByRole("button", { name: "Delete", exact: true }).first().focus()
    await page.keyboard.press("Space")
    expect(await page.evaluate(() => Reflect.get(window, "secretCalls"))).toEqual([
      { kind: "action", value: { tag: "secrets", args: { operation: "delete", name: "NPM_TOKEN" } } }
    ])
  }
})

test("Secrets Replace keyboard form keeps values write-only", async ({ page }) => {
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
    await page.goto(`/view-stories.html?story=SecretsView/bound_hosts&theme=${theme}`)
    await page.evaluate(() => {
      Object.assign(window, { secretCalls: [] })
      window.addEventListener("story-callback", event => (window as unknown as { secretCalls: unknown[] }).secretCalls.push((event as CustomEvent).detail))
    })
    await page.locator('.secrets-view summary').focus(); await page.keyboard.press("Enter")
    await page.screenshot({ path: resolve(shots, `SecretsView-replace-open-${theme}-${width}.png`), fullPage: true })
    const form = page.locator('.secrets-view details form')
    await expect(form.locator('input[type="password"]')).toHaveValue("")
    await expect(form.locator('input[aria-label="Hosts"]')).toHaveValue("api.stripe.com, files.stripe.com")
    await form.locator('input[type="password"]').fill("replacement-value")
    await form.locator('select').selectOption("all_branches")
    await form.locator('input[aria-label="Hosts"]').fill("")
    await form.getByRole("button", { name: "Replace" }).focus(); await page.keyboard.press("Enter")
    expect(await page.evaluate(() => (window as unknown as { secretCalls: unknown[] }).secretCalls)).toEqual([
      { kind: "action", value: { tag: "secrets", args: { operation: "set", name: "STRIPE_KEY", value: "[redacted]", scope: "all_branches", hosts: "" } } },
    ])
    await expect(form.locator('input[type="password"]')).toHaveValue("")
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.addScriptTag({ path: axePath })
    expect(await page.evaluate(async () => (await (window as unknown as { axe: { run: () => Promise<{ violations: { impact: string }[] }> } }).axe.run()).violations.filter(v => v.impact === "serious" || v.impact === "critical"))).toEqual([])
  }
})

test("File recovery Copy and Reapply remain keyboard accessible", async ({ page }) => {
  await page.goto("/view-stories.html?story=CodeEditorView/unsaved")
  await page.evaluate(() => {
    const calls: unknown[] = []
    Object.assign(window, { fileRecoveryCalls: calls, copiedRecovery: [] })
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copiedRecovery: string[] }).copiedRecovery.push(text) } } })
    window.addEventListener("story-callback", event => calls.push((event as CustomEvent).detail))
  })
  const notice = page.locator('.code-notice[data-tone="attention"]')
  const copy = notice.getByRole("button", { name: "Copy", exact: true })
  const reapply = notice.getByRole("button", { name: "Reapply", exact: true })
  await page.keyboard.press("Tab")
  await expect(copy).toBeFocused()
  await page.keyboard.press("Enter")
  expect(await page.evaluate(() => (window as unknown as { copiedRecovery: string[] }).copiedRecovery)).toEqual(['  description: "Build",\n'])
  await page.keyboard.press("Tab")
  await expect(reapply).toBeFocused()
  await page.keyboard.press("Enter")
  await expect.poll(() => page.evaluate(() => (window as unknown as { fileRecoveryCalls: unknown[] }).fileRecoveryCalls)).toEqual([
    { kind: "action", value: { tag: "file.reapply", args: { path: "flows/todo/flow.ts" } } },
  ])
  await expect(notice.locator("pre")).toHaveText('  description: "Build",\n')
})

test("File Copy failure remains visible and retains recovered text", async ({ page }) => {
  await page.goto("/view-stories.html?story=CodeEditorView/unsaved")
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("unavailable") } } })
    document.execCommand = () => false
  })
  await page.getByRole("button", { name: "Copy", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Copy failed")
  await expect(page.locator('.code-notice pre')).toHaveText('  description: "Build",\n')
  await expect(page.getByRole("button", { name: "Reapply", exact: true })).toBeEnabled()
})

test("Docs missing and disabled navigation stay on the page", async ({ page }) => {
  for (const story of ["No navigation gesture", "Navigation unavailable"]) {
    await page.goto(`/view-stories.html?story=DocsView/${encodeURIComponent(story)}`)
    const url = page.url()
    await page.evaluate(() => {
      Object.assign(window, { docsReceipts: [] })
      window.addEventListener("story-callback", event => (window as unknown as { docsReceipts: unknown[] }).docsReceipts.push((event as CustomEvent).detail))
    })
    const link = page.locator(".mvp-docs .sui-md a")
    await expect(link).not.toHaveAttribute("href")
    await expect(link).toHaveAttribute("tabindex", "-1")
    for (const entry of await page.locator(".mvp-docs nav a").all()) {
      await expect(entry).not.toHaveAttribute("href")
      await entry.click({ button: "middle" })
    }
    await link.click({ button: "middle" })
    await link.click()
    expect(page.url()).toBe(url)
    expect(page.context().pages()).toHaveLength(1)
    expect(await page.evaluate(() => (window as unknown as { docsReceipts: unknown[] }).docsReceipts)).toEqual([])
  }
})

test("Docs document links are gestures and HTML remains inert", async ({ page }) => {
  await page.goto("/view-stories.html?story=DocsView/Inert%20HTML")
  await expect(page.locator(".mvp-docs .sui-md")).toBeVisible()
  await expect(page.locator(".mvp-docs script,.mvp-docs img,.mvp-docs iframe,.mvp-docs a[href^=\"javascript:\"]")).toHaveCount(0)
  await expect(page.locator(".mvp-docs .sui-md")).toContainText("<script>alert(1)</script>")
  await expect(page.locator(".mvp-docs .sui-md")).toContainText("<div>")
  await page.evaluate(() => {
    const receipts: unknown[] = []
    Object.assign(window, { docsReceipts: receipts })
    window.addEventListener("story-callback", event => receipts.push((event as CustomEvent).detail))
  })
  const url = page.url()
  for (const name of ["Blocked", "Control", "Data"]) {
    const link = page.locator(".mvp-docs .sui-md a").filter({ hasText: name })
    await expect(link).not.toHaveAttribute("href")
    await link.click()
  }
  expect(page.url()).toBe(url)
  expect(await page.evaluate(() => (window as unknown as { docsReceipts: unknown[] }).docsReceipts)).toEqual([])
  const titled = page.getByRole("link", { name: "Titled", exact: true })
  await titled.focus()
  await page.keyboard.press("Shift+Tab")
  await page.keyboard.press("Tab")
  await expect(titled).toBeFocused()
  expect(await titled.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe("none")
  await page.keyboard.press("Enter")
  expect(await page.evaluate(() => (window as unknown as { docsReceipts: unknown[] }).docsReceipts)).toEqual([
    { kind: "action", value: { tag: "docs", args: { source: "docs-card", page: "todos" } } }
  ])
  await page.evaluate(() => { (window as unknown as { docsReceipts: unknown[] }).docsReceipts.length = 0 })
  await page.getByRole("link", { name: "Heading", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { docsReceipts: unknown[] }).docsReceipts)).toEqual([
    { kind: "action", value: { tag: "docs", args: { source: "docs-card", page: "quickstart#put-https-in-front" } } }
  ])
  await page.goto("/view-stories.html?story=DocsView/The%20quickstart%20page")
  await expect(page.locator(".mvp-docs .sui-md")).toBeVisible()
  await page.evaluate(() => {
    Object.assign(window, { docsReceipts: [] })
    window.addEventListener("story-callback", event => (window as unknown as { docsReceipts: unknown[] }).docsReceipts.push((event as CustomEvent).detail))
  })
  await page.locator(".mvp-docs-markdown").getByRole("link", { name: "TODOs", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { docsReceipts: unknown[] }).docsReceipts)).toEqual([
    { kind: "action", value: { tag: "docs", args: { page: "todos" } } }
  ])
  await page.goto("/view-stories.html?story=DocsView/Scrolled%20to%20a%20heading")
  await expect(page.locator('.mvp-docs .sui-md-heading')).toHaveText("Put HTTPS in front")
  await expect(page.getByRole("heading", { name: "Quickstart", exact: true })).toHaveCount(1)
  const scroll = page.locator('.mvp-docs .sui-md')
  const headingTop = await page.locator(".mvp-docs .sui-md-heading").evaluate(node => node.getBoundingClientRect().top)
  expect(headingTop).toBeGreaterThanOrEqual(0)
  expect(headingTop).toBeLessThan(page.viewportSize()!.height)
  const position = await scroll.evaluate(node => ({ editor: node.scrollTop, window: window.scrollY }))
  expect(position.editor + position.window).toBeGreaterThan(0)
  await page.waitForTimeout(500)
  expect(await scroll.evaluate(node => ({ editor: node.scrollTop, window: window.scrollY }))).toEqual(position)
})


for (const key of ["Enter", "Space"]) test(`DebugApiView keyboard selection and Send: ${key}`, async ({ page }) => {
  await page.goto('/view-stories.html?story=DebugApiView/get_200')
  await page.evaluate(() => {
    const calls: unknown[] = []
    Object.assign(window, { debugApiCalls: calls })
    window.addEventListener('story-callback', event => calls.push((event as CustomEvent).detail))
  })
  await page.locator('nav[aria-label="Operations"] button').first().focus()
  await page.keyboard.press(key)
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "debugApiCalls"))).toEqual([
    { kind: "view", value: { selected: "getHealth" } }
  ])
  await page.getByRole('textbox', { name: 'n', exact: true }).fill('12')
  await page.getByRole('button', { name: 'Send', exact: true }).focus()
  await page.keyboard.press(key)
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "debugApiCalls"))).toEqual([
    { kind: "view", value: { selected: "getHealth" } },
    { kind: "action", value: { tag: "debug-api", args: { operation: "getTodo", n: "12" } } }
  ])
})

test("DebugApiView hostile body and failure render as text", async ({ page }) => {
  await page.goto('/view-stories.html?story=DebugApiView/hostile')
  await expect(page.locator('[data-story]')).toContainText('<img src=x onerror="window.__pwned=1">')
  await expect(page.locator('[data-story]')).toContainText('<script>window.__pwned=1</script>')
  await expect(page.locator('[data-story] img, [data-story] script')).toHaveCount(0)
  expect(await page.evaluate(() => Reflect.get(window, "__pwned"))).toBeUndefined()
})

test("DebugApiView supplied confirmations and unavailable actions obey the keyboard seam", async ({ page }) => {
  const cases = [
    ["pending_mutation", "Confirm POST /api/todos/12/drop", "dropTodo"],
    ["pending_put", "Confirm PUT /api/secrets/key", "putSecret"],
    ["pending_patch", "Confirm PATCH /api/settings", "patchSettings"],
    ["pending_delete", "Confirm DELETE /api/secrets/key", "deleteSecret"],
  ] as const
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 })
    for (const [story, label, operation] of cases) {
      await page.goto(`/view-stories.html?story=DebugApiView/${story}&theme=${theme}`)
      await page.evaluate(() => {
        Object.assign(window, { debugApiCalls: [] })
        window.addEventListener("story-callback", event =>
          (window as unknown as { debugApiCalls: unknown[] }).debugApiCalls.push((event as CustomEvent).detail))
      })
      const control = page.getByRole("button", { name: label, exact: true })
      await expect(page.locator(".mvp-debug-api button[data-flow]")).toHaveCount(1)
      await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0)
      expect(await page.evaluate(() => Reflect.get(window, "debugApiCalls"))).toEqual([])
      await control.focus()
      await control.press("Enter")
      expect(await page.evaluate(() => Reflect.get(window, "debugApiCalls"))).toEqual([
        { kind: "action", value: { tag: "debug-api", args: { operation, confirm: "true" } } },
      ])
    }
    await page.goto(`/view-stories.html?story=DebugApiView/disabled&theme=${theme}`)
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled()
    await expect(page.getByRole("textbox", { name: "n", exact: true })).toBeDisabled()
    await page.goto(`/view-stories.html?story=DebugApiView/operations&theme=${theme}`)
    await expect(page.locator(".mvp-debug-api button[data-flow]")).toHaveCount(0)
  }
})

for (const key of ["Enter", "Space"]) test(`T-UI-15 keyboard ${key} controls preserve supplied arguments once`, async ({ page }) => {
  const cases = [
    ["awake", "Sleep", "box.suspend", { branch: "todo/12" }],
    ["asleep", "Wake", "box.resume", { branch: "todo/12" }],
    ["failed", "Retry", "box.resume", { branch: "todo/12" }],
    ["rebase_pending", "Rebase now", "branch.rebase-now", { branch: "todo/12" }],
    ["scratch_conflict", "Resolve", "terminal", { branch: "scratch/repro" }],
    ["scratch_ready", "Done", "branch.rebase", { branch: "scratch/repro", conflict_change: "conflict-1", onto_revision: "main-revision" }],
    ["moved_off", "Return to T12", "todo.return-to-item", { n: "12" }],
    ["moved_off", "Keep for now", "todo.keep-moved", { n: "12" }],
    ["active", "Diff", "diff", { branch: "todo/12", burst: "burst-6" }],
    ["scratch_item", "Add to stack", "branch.add-to-stack", { branch: "scratch/repro", text: "Keyboard TODO" }],
  ] as const
  for (const [story, label, tag, args] of cases) {
    await page.goto(`/view-stories.html?story=BranchView/branch-${story}-activity`)
    await page.evaluate(() => {
      (window as unknown as { branchCalls: unknown[] }).branchCalls = []
      window.addEventListener("story-callback", event => (window as unknown as { branchCalls: unknown[] }).branchCalls.push((event as CustomEvent).detail))
    })
    if (label === "Add to stack") await page.getByRole("textbox", { name: "TODO", exact: true }).fill("Keyboard TODO")
    const button = page.getByRole("button", { name: label, exact: true })
    await expect(button).toHaveAttribute("data-flow", tag)
    await button.focus()
    await page.keyboard.press(key)
    expect(await page.evaluate(() => (window as unknown as { branchCalls: unknown[] }).branchCalls)).toEqual([
      { kind: "action", value: { tag, args } },
    ])
  }
  await page.goto("/view-stories.html?story=BranchView/branch-scratch_conflict-activity")
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeDisabled()
  await page.goto("/view-stories.html?story=BranchView/branch-waking-activity")
  await expect(page.locator("button[data-flow]")).toHaveCount(0)
})

test("T-UI-15 tab arrow and boundary keys move focus through the View seam", async ({ page }) => {
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`/view-stories.html?story=BranchView/branch-active-activity&theme=${theme}`)
    await page.evaluate(() => {
      Object.assign(window, { branchCalls: [] })
      window.addEventListener("story-callback", event =>
        (window as unknown as { branchCalls: unknown[] }).branchCalls.push((event as CustomEvent).detail))
    })
    await page.locator('[data-tab="activity"]').focus()
    for (const [key, tab] of [
      ["ArrowLeft", "terminals"], ["ArrowRight", "activity"],
      ["ArrowRight", "files"], ["End", "terminals"], ["Home", "activity"],
    ]) {
      await page.evaluate(() => { Reflect.get(window, "branchCalls").length = 0 })
      await page.keyboard.press(key!)
      await expect(page.locator(`[data-tab="${tab}"]`)).toBeFocused()
      expect(await page.evaluate(() => Reflect.get(window, "branchCalls"))).toEqual([
        { kind: "view", value: { tab } },
      ])
    }
  }
})

test("T-UI-15 tabs and SSH use only their supplied View and clipboard seams", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { branchCalls: [], branchCopied: [] })
    window.addEventListener("story-callback", event =>
      (window as unknown as { branchCalls: unknown[] }).branchCalls.push((event as CustomEvent).detail))
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => {
      (window as unknown as { branchCopied: string[] }).branchCopied.push(text)
    } } })
  })
  await page.goto("/view-stories.html?story=BranchView/branch-active-activity")
  const activity = page.getByRole("tab", { name: "Activity", exact: true })
  const files = page.getByRole("tab", { name: "Files", exact: false })
  await expect(activity).toHaveAttribute("tabindex", "0")
  await expect(files).toHaveAttribute("tabindex", "-1")
  await activity.press("ArrowRight")
  await expect(files).toBeFocused()
  await page.getByRole("button", { name: "Copy SSH line", exact: true }).press("Space")
  expect(await page.evaluate(() => Reflect.get(window, "branchCalls"))).toEqual([{ kind: "view", value: { tab: "files" } }])
  expect(await page.evaluate(() => Reflect.get(window, "branchCopied"))).toEqual(["ssh -p 2222 todo-12@mac-mini.local"])
})

test("T-UI-15 missing and disabled actions refuse callbacks; hostile text opens no connection", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { branchCalls: [], branchConnections: [] })
    window.addEventListener("story-callback", event =>
      (window as unknown as { branchCalls: unknown[] }).branchCalls.push((event as CustomEvent).detail))
    window.fetch = ((...args: unknown[]) => {
      (window as unknown as { branchConnections: unknown[] }).branchConnections.push(args)
      throw new Error("BranchView opened a fetch")
    }) as unknown as typeof fetch
    window.WebSocket = class {
      constructor(...args: unknown[]) {
        (window as unknown as { branchConnections: unknown[] }).branchConnections.push(args)
        throw new Error("BranchView opened a socket")
      }
    } as unknown as typeof WebSocket
  })
  for (const story of ["branch-no-actions", "branch-disabled-gestures", "branch-hostile", "branch-scratch_conflict-activity"]) {
    await page.goto(`/view-stories.html?story=BranchView/${story}`)
    await expect(page.locator("[data-story]")).toBeVisible()
    if (story === "branch-no-actions" || story === "branch-hostile") await expect(page.locator("button[data-flow]")).toHaveCount(0)
    if (story === "branch-disabled-gestures") {
      for (const button of await page.locator("button[data-flow]").all()) {
        await expect(button).toBeDisabled()
        await button.evaluate(node => (node as HTMLButtonElement).click())
      }
    }
    if (story === "branch-scratch_conflict-activity") {
      const done = page.getByRole("button", { name: "Done", exact: true })
      await expect(done).toBeDisabled()
      await done.evaluate(node => (node as HTMLButtonElement).click())
    }
    if (story === "branch-hostile") {
      await expect(page.locator("[data-story]")).toContainText('<script>window.__branchPwned=1</script>')
      await expect(page.locator("[data-story] script, [data-story] img[src=x]")).toHaveCount(0)
      expect(await page.evaluate(() => Reflect.get(window, "__branchPwned"))).toBeUndefined()
    }
    expect(await page.evaluate(() => Reflect.get(window, "branchCalls"))).toEqual([])
    expect(await page.evaluate(() => Reflect.get(window, "branchConnections"))).toEqual([])
  }
})

// T-UI-16 uses the existing production story runner; no live route is enabled.
test("File and burst Diff supplied actions have keyboard doors", async ({ page }) => {
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const [story, label, tag, args] of [
      ["CodeSurface/deleted", "Restore", "file.restore-deleted", { path: "flows/todo/flow.ts" }],
      ["CodeSurface/renamed", "Follow", "file.follow-rename", { path: "flows/todo/flow.ts" }],
      ["CodeSurface/outside", "Compare", "file.compare", { path: "flows/todo/flow.ts" }],
      ["DiffSurface/burst", "Restore this file", "file.restore", { path: "flows/todo/flow.ts", revision: "burst-17" }],
    ] as const) {
      await page.goto(`/view-stories.html?story=${story}&theme=${theme}`)
      await page.evaluate(() => {
        Object.assign(window, { liveStateReceipts: [] })
        window.addEventListener("story-callback", event =>
          (window as unknown as { liveStateReceipts: unknown[] }).liveStateReceipts.push((event as CustomEvent).detail))
      })
      await page.getByRole("button", { name: label, exact: true }).focus()
      await page.keyboard.press("Enter")
      expect(await page.evaluate(() => (window as unknown as { liveStateReceipts: unknown[] }).liveStateReceipts)).toEqual([
        { kind: "action", value: { tag, args } },
      ])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    for (const story of ["deleted_readonly", "renamed_readonly", "outside_readonly"]) {
      await page.goto(`/view-stories.html?story=CodeSurface/${story}&theme=${theme}`)
      await expect(page.locator('.code-actions button')).toHaveCount(0)
    }
    await page.goto(`/view-stories.html?story=CodeSurface/restore_disabled&theme=${theme}`)
    await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeDisabled()
  }
})

test("Home menu dispatches its supplied action and restores keyboard focus", async ({ page }) => {
  await page.addInitScript(() => {
    const calls: unknown[] = []
    Object.assign(window, { homeCalls: calls })
    window.addEventListener("story-callback", event => calls.push((event as CustomEvent).detail))
  })
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`/view-stories.html?story=HomeView/home-active&theme=${theme}`)
    const trigger = page.getByRole("button", { name: "Order Persist merge requests", exact: true })
    await trigger.press("Enter")
    await page.getByRole("menuitem", { name: "Move up", exact: true }).press("Enter")
    await expect(page.getByRole("menu")).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(await page.evaluate(() => (window as unknown as { homeCalls: unknown[] }).homeCalls)).toEqual([
      { kind: "view", value: { on_screen: true } },
      { kind: "view", value: { menu: 8 } },
      { kind: "action", value: { tag: "stack.move", args: { n: "8", direction: "up" } } },
      { kind: "view", value: { menu: undefined } },
    ])
  }
})

test("Proposal keyboard actions and receipt navigation use supplied callbacks", async ({ page }) => {
  await page.addInitScript(() => {
    const calls: unknown[] = []
    Object.assign(window, { proposalCalls: calls })
    window.addEventListener("story-callback", event => calls.push((event as CustomEvent).detail))
  })
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`/view-stories.html?story=ProposalView/Open%20proposal&theme=${theme}`)
    const accept = page.getByRole("button", { name: "Make TODO", exact: true })
    await accept.focus()
    await expect(accept).toBeFocused()
    await page.keyboard.press("Enter")
    await page.keyboard.press("Tab")
    await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toBeFocused()
    await page.keyboard.press("Space")
    expect(await page.evaluate(() => (window as unknown as { proposalCalls: unknown[] }).proposalCalls)).toEqual([
      { kind: "action", value: { tag: "learning.accept", args: { id: "proposal-12" } } },
      { kind: "action", value: { tag: "learning.dismiss", args: { id: "proposal-12" } } },
    ])
    await page.goto(`/view-stories.html?story=ProposalView/Lesson%20links&theme=${theme}`)
    await page.getByRole("button", { name: "Retry policy", exact: true }).focus()
    await page.keyboard.press("Enter")
    expect(await page.evaluate(() => (window as unknown as { proposalCalls: unknown[] }).proposalCalls)).toEqual([
      { kind: "action", value: { tag: "wiki.page", args: { name: "Retry policy" } } },
    ])
    await page.goto(`/view-stories.html?story=ProposalView/Accepted%20TODO%20link&theme=${theme}`)
    await expect(page.locator('.proposal-status')).toHaveText("Accepted")
    const todo = page.getByRole("button", { name: "T14 · Keep completion receipts in toasts", exact: true })
    await todo.focus()
    await expect(todo).toBeFocused()
    await todo.press("Enter")
    expect(await page.evaluate(() => (window as unknown as { proposalCalls: unknown[] }).proposalCalls)).toEqual([
      { kind: "action", value: { tag: "todo", args: { n: "14" } } },
    ])
    for (const [story, state] of [["Dismissed", "Dismissed"], ["Read-only proposal", "Suggested"]]) {
      await page.goto(`/view-stories.html?story=${encodeURIComponent(`ProposalView/${story}`)}&theme=${theme}`)
      await expect(page.locator('.proposal-status')).toHaveText(state!)
      await expect(page.locator('.proposal-actions button')).toHaveCount(0)
    }
    await page.goto(`/view-stories.html?story=ProposalView/Hostile%20proposal&theme=${theme}`)
    await expect(page.locator('.proposal-evidence')).toContainText('<script>alert("evidence")</script>')
    await expect(page.locator('.proposal-ref')).toHaveText("Unsafe ref")
    await expect(page.locator('.proposal-ref a, .proposal-view script')).toHaveCount(0)
    for (const [story, count] of [["No lessons", null], ["One lesson", "1 lesson"], ["Lessons from T12", "2 lessons"]]) {
      await page.goto(`/view-stories.html?story=${encodeURIComponent(`ProposalView/${story}`)}&theme=${theme}`)
      if (count === null) await expect(page.locator('.proposal-lessons')).toHaveCount(0)
      else await expect(page.locator('.proposal-lessons')).toContainText(count!)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  }
})

test("T-UI-15r phone SSH ellipsis retains full copy and empty presence is unboxed", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const theme of ["light", "dark"]) {
    await page.goto(`/view-stories.html?story=BranchView/branch-scratch_conflict-activity&theme=${theme}`)
    const code = page.locator(".branch-ssh code")
    await expect(code).toHaveAttribute("title", "ssh -p 2222 scratch-repro@mac-mini.local")
    await expect(code).toHaveCSS("overflow", "hidden")
    await expect(code).toHaveCSS("text-overflow", "ellipsis")
    await expect(code).toHaveCSS("white-space", "nowrap")
    await expect(code).toHaveCSS("min-width", "0px")
    expect(await code.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)
    const copy = page.getByRole("button", { name: "Copy SSH line" })
    expect(await copy.evaluate(node => node.getBoundingClientRect().right <= innerWidth)).toBe(true)
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { Reflect.set(window, "copiedSsh", text) } } }))
    await copy.click()
    await expect.poll(() => page.evaluate(() => Reflect.get(window, "copiedSsh"))).toBe("ssh -p 2222 scratch-repro@mac-mini.local")
    await expect(page.locator(".branch-presence")).toHaveCount(0)
    await expect(page.locator("p.branch-muted").filter({ hasText: "Nobody here" })).toHaveCSS("border-width", "0px")
  }
})

test("ContextLine empty state and chip presentation", async ({ page }) => {
  for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
    await page.goto(`/view-stories.html?story=ConversationView/context-empty&theme=${theme}`)
    await expect(page.locator(".context")).toHaveCount(0)
    await expect(page.locator("[data-story]")).toBeEmpty()
    await page.goto(`/view-stories.html?story=ConversationView/context-mixed&theme=${theme}`)
    const plain = page.locator('.context-text[data-kind="page"]')
    await expect(plain).toHaveText("Factory decisions")
    await expect(plain).toHaveCSS("border-width", "0px")
    await expect(plain).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
    await expect(plain.locator("svg")).toHaveCount(1)
    const inspect = page.getByRole("button", { name: "Inspect", exact: true })
    await expect(inspect.locator("svg.lucide-maximize2")).toHaveCount(1)
    const heights = await page.locator(".context-chip").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))
    expect(heights.length).toBe(3)
    expect(new Set(heights).size).toBe(1)
  }
})


test("File remote carets and selections follow the person colour only with the flag on", async ({ page }) => {
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) for (const flag of ["on", "off"]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`/view-stories.html?story=CodeEditorView/remote_carets_${flag}&theme=${theme}`)
    await expect(page.locator('.code-name-flag')).toHaveText('Ben+1')
    if (flag === "on") {
      await expect(page.locator('.cm-ySelectionInfo')).toHaveText('Ben')
      await expect(page.locator('.cm-ySelection')).toHaveCount(1)
      const colours = await page.locator('.cm-ySelectionCaret').evaluate(node => {
        const flag = document.querySelector('.code-name-flag')!
        return { caret: getComputedStyle(node).borderLeftColor, flag: getComputedStyle(flag).borderLeftColor,
          selection: getComputedStyle(document.querySelector('.cm-ySelection')!).backgroundColor }
      })
      expect(colours.caret).toBe(colours.flag)
      expect(colours.selection).not.toBe('rgba(0, 0, 0, 0)')
    } else await expect(page.locator('.cm-ySelectionCaret, .cm-ySelection')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
})
