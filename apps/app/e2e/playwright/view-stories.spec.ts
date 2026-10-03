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

// T-UI-07: literal callbacks from ui-components T-UI-07, independent of model actions.
test("Conversation shell renders branch navigation, entries and Earlier", async ({ page }) => {
  const callbacks = async () => page.evaluate(() => (window as unknown as { shellCalls: unknown[] }).shellCalls)
  const clear = async () => page.evaluate(() => { (window as unknown as { shellCalls: unknown[] }).shellCalls = [] })
  await page.addInitScript(() => {
    const state = window as unknown as { shellCalls: unknown[] }
    state.shellCalls = []
    window.addEventListener("story-callback", event => state.shellCalls.push((event as CustomEvent).detail))
  })
  for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`/view-stories.html?story=ConversationView/branch-main&theme=${theme}`)
    await expect(page.locator(".mvp-tree-name")).toHaveText(["main", "todo/12", "scratch/repro", "Earlier · 3"])
    for (const [node, expected] of [["main", { kind: "view", value: { selected_branch: "main" } }], ["todo-12", { kind: "view", value: { selected_branch: "todo-12" } }], ["scratch-repro", { kind: "action", value: { tag: "branch", args: { name: "scratch/repro" } } }], ["earlier", { kind: "view", value: { selected_branch: "earlier" } }]] as const) {
      await clear()
      const control = page.locator(`[data-node="${node}"]`)
      await control.focus()
      await page.keyboard.press("Enter")
      await expect.poll(callbacks).toEqual([expected])
      await expect(control).toBeFocused()
    }
    await page.goto(`/view-stories.html?story=ConversationView/crumb-ancestry&theme=${theme}`)
    const crumb = page.locator(".mvp-crumb-here")
    await crumb.focus()
    await page.keyboard.press("Space")
    await expect(page.getByRole("navigation", { name: "Branches", exact: true })).toBeVisible()
    await page.locator('[data-node="main"]').focus()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("navigation", { name: "Branches", exact: true })).toHaveCount(0)
    await expect(crumb).toBeFocused()
    await page.goto(`/view-stories.html?story=ConversationView/context-collapsed&theme=${theme}`)
    await page.locator(".mvp-context-toggle").focus()
    await page.keyboard.press("Space")
    await expect.poll(callbacks).toEqual([{ kind: "view", value: { expanded: true } }])
    for (const [story, tag, label] of [["needs_you", "todo.answer", "Answer"], ["in_review", "merge", "Merge"]]) {
      await page.goto(`/view-stories.html?story=ConversationView/entry-${story}&theme=${theme}`)
      await expect(page.locator("[data-flow]")).toHaveAttribute("data-flow", tag!)
      await page.getByRole("button", { name: label }).click()
      await expect.poll(callbacks).toEqual([{ kind: "action", value: { tag, args: { n: "12" } } }])
    }
    // spec §14.5.2 and the Paper tone contract: literal token names, never schema-derived.
    for (const [entry, token] of [["working", "--brand"], ["needs_you", "--attention"], ["failed", "--danger"]]) {
      await page.goto(`/view-stories.html?story=ConversationView/entry-${entry}&theme=${theme}`)
      const colors = await page.locator(".mvp-entry").evaluate((node, token) => {
        const probe = document.createElement("span")
        probe.style.color = `var(${token})`
        document.body.append(probe)
        const expected = getComputedStyle(probe).color
        probe.remove()
        return { actual: getComputedStyle(node).borderLeftColor, expected }
      }, token!)
      expect(colors.actual).toBe(colors.expected)
    }
    await page.goto(`/view-stories.html?story=ConversationView/entry-failed&theme=${theme}`)
    await expect(page.getByRole("button", { name: "Retry" })).toBeDisabled()
    await expect(page.getByText("Repository access refused")).toBeVisible()
    expect(await callbacks()).toEqual([])
    await page.goto(`/view-stories.html?story=ConversationView/entry-tombstone&theme=${theme}`)
    await expect(page.locator("article[data-story]")).toHaveText("Card model contracts")
    await expect(page.locator(".mvp-tombstone")).toHaveCSS("white-space", "nowrap")
    await expect(page.locator("article[data-story] button")).toHaveCount(0)
    await page.goto(`/view-stories.html?story=ConversationView/entry-private&theme=${theme}`)
    await expect(page.getByText("Only you")).toBeVisible()
    await page.goto(`/view-stories.html?story=ConversationView/earlier-selected&theme=${theme}`)
    await expect(page.getByText("Read-only")).toBeVisible()
    await expect(page.locator("[data-flow]")).toHaveCount(0)
    await page.getByRole("button", { name: "Earlier question" }).click()
    await expect.poll(callbacks).toEqual([{ kind: "view", value: { selected_archive: "old" } }])
  }
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
  await page.keyboard.press("Enter")
  await expect(page.getByText("/monitor", { exact: true })).toBeVisible()
  await page.keyboard.press("Space")
  await expect(advanced).not.toHaveAttribute("open")
  await expect(page.locator(".mvp-command-policy").filter({ hasText: "Asks first" })).toHaveCount(1)
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
    await page.evaluate(() => document.fonts.ready)
    {
      const policyColors = await page.locator(".mvp-command-policy").evaluateAll(marks => {
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

test("ToastStack, EdgeMap and Timeline render actions, band and breakpoint", async ({ page }) => {
  const patches: unknown[] = []
  await page.exposeFunction("recordShellPatch", (patch: unknown) => patches.push(patch))
  await page.addInitScript(() => window.addEventListener("story-callback", event => {
    const detail = (event as CustomEvent).detail
    if (detail.kind === "view") (window as unknown as { recordShellPatch: (patch: unknown) => void }).recordShellPatch(detail.value)
  }))
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 1180, height: 800 })
    await page.goto(`/view-stories.html?story=ShellView/timeline-timeline&theme=${theme}`)
    await expect(page.locator(".mvp-timeline")).toBeVisible()
    await expect(page.locator('[data-entry="entry-11"] .mvp-tl-node')).toHaveCSS("animation-name", "mvp-shell-live")
    await page.emulateMedia({ reducedMotion: "reduce" })
    await expect(page.locator('[data-entry="entry-11"] .mvp-tl-node')).toHaveCSS("animation-name", "none")
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await expect(page.locator("[data-in-view]")).toHaveCount(2)
    // Literal tone oracles: ui-components Tone / spec §14.5.2.
    for (const [entry, token] of [["entry-10", "--text-muted"], ["entry-11", "--brand"], ["entry-12", "--attention"], ["entry-14", "--danger"], ["entry-15", "--text-muted"]]) {
      const colors = await page.locator(`[data-entry="${entry}"] .mvp-tl-node`).evaluate((node, token) => {
        const probe = document.createElement("span")
        probe.style.color = `var(${token})`
        document.body.append(probe)
        const expected = getComputedStyle(probe).color
        probe.remove()
        return { actual: getComputedStyle(node).color, expected }
      }, token!)
      expect(colors.actual).toBe(colors.expected)
    }
    await expect(page.locator('[data-entry="entry-13"] .mvp-tl-text span')).toHaveCount(0)
    await expect.poll(() => patches.some(patch => JSON.stringify(patch) === '{"timeline_visible":true}')).toBe(true)
    await page.locator('[data-entry="entry-12"] button').click()
    await expect.poll(() => patches.some(patch => JSON.stringify(patch) === '{"jump_to":"entry-12"}')).toBe(true)
    await page.setViewportSize({ width: 1179, height: 800 })
    await expect(page.locator(".mvp-timeline")).toBeHidden()
    await expect.poll(() => patches.some(patch => JSON.stringify(patch) === '{"timeline_visible":false}')).toBe(true)
    await page.goto(`/view-stories.html?story=ShellView/edge-wide&theme=${theme}`)
    await expect(page.locator(".mvp-edge-pill:visible")).toHaveCount(2)
    await expect(page.locator(".mvp-tl-edge:visible")).toHaveCount(0)
    await page.setViewportSize({ width: 1180, height: 800 })
    await expect(page.locator('[data-edge="above"] .mvp-tl-row:visible')).toHaveCount(2)
    await expect(page.locator(".mvp-tl-more")).toHaveText("+1 above")
    for (const keyboard of [false, true]) {
      await page.goto(`/view-stories.html?story=ShellView/toast-three-and-more&theme=${theme}`)
      await expect(page.locator(".mvp-notice")).toHaveCount(3)
      await expect(page.locator(".mvp-notice [data-flow]")).toHaveCount(3)
      const more = page.getByRole("button", { name: "+2 more" })
      if (keyboard) { await more.focus(); await page.keyboard.press("Enter") } else await more.click()
      await expect(page.locator(".mvp-notice")).toHaveCount(5)
      await expect(page.locator(".mvp-notice [data-flow]")).toHaveCount(5)
    }
    await page.goto(`/view-stories.html?story=ShellView/toast-no_action&theme=${theme}`)
    await expect(page.locator("[data-flow]")).toHaveCount(0)
  }
})

// T-UI-06 / C-UI-12: Home fixtures only; no backend or Container.
test("HomeView renders sync health, attention and background runs", async ({ page }) => {
  test.setTimeout(180_000)
  await mkdir(shots, { recursive: true })
  await page.clock.install({ time: new Date("2026-10-02T17:42:05Z") })
  await page.addInitScript(() => {
    (window as unknown as { homeVisibility: unknown[] }).homeVisibility = []
    window.addEventListener("story-callback", event => {
      const receipt = (event as CustomEvent).detail
      if (receipt.kind === "view" && "on_screen" in receipt.value) (window as unknown as { homeVisibility: unknown[] }).homeVisibility.push(receipt.value)
    })
  })
  const receipts = []
  for (const story of ["fresh", "stale", "limited", "refused", "active", "active_member", "boundaries", "merge-reasons"]) for (const theme of ["light", "dark"]) for (const width of [1280, 1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
    await page.clock.setFixedTime(new Date("2026-10-02T17:42:05Z"))
    await page.goto(`/view-stories.html?story=HomeView/home-${story}&theme=${theme}`)
    await expect(page.locator(".mvp-home")).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as unknown as { homeVisibility: unknown[] }).homeVisibility)).toContainEqual({ on_screen: true })
    if (story === "fresh") await expect(page.locator(".mvp-sync")).toHaveText("synced 5 s ago")
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.addScriptTag({ path: axePath })
    const violations = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: () => Promise<{ violations: { id: string; impact: string }[] }> } }).axe
      return (await axe.run()).violations.filter(item => item.impact === "serious" || item.impact === "critical")
    })
    receipts.push({ story, theme, width, violations })
    expect(violations).toEqual([])
    if (story === "active_member") await expect(page.getByRole("button", { name: "Reset to GitHub main" })).toHaveCount(0)
    await page.screenshot({ path: resolve(shots, `home-${story}-${theme}-${width}.png`), animations: "disabled", fullPage: true })
    await page.evaluate(() => {
      (window as unknown as { homeCallbacks: unknown[] }).homeCallbacks = []
      window.addEventListener("story-callback", event => (window as unknown as { homeCallbacks: unknown[] }).homeCallbacks.push((event as CustomEvent).detail))
    })
    // C-UI-12 literal callback oracles, independent of supplied action arrays.
    const actionCases = story.startsWith("active") ? [
      ["order.ok", "OK", { n: "3" }],
      ...(story === "active" ? [["main.reset-to-github", "Reset to GitHub main", { revision: "4bc79aef91d66ea28c90b706d584d3b9b48e14ea" }]] : []),
      ["merge", "Merge", { n: "8" }], ["todo.answer", "Answer", { n: "12" }],
      ["todo", "Open", { n: "15" }], ["todo.retry", "Retry", { n: "16" }],
      ["todo", "Open", { n: "17" }, true], ["todo", "Open", { n: "18" }],
      ["background.retry", "Retry", { id: "source-sync" }], ["background.dismiss", "Dismiss", { id: "source-sync" }],
      ["todo.new", "New TODO", {}],
    ] : story === "fresh" || story === "limited" ? [["todo.new", "New TODO", {}]]
      : story === "stale" ? [["github", "Retry", {}], ["todo.new", "New TODO", {}]]
      : story === "refused" ? [["settings", "Fix", {}]] : []
    await expect(page.locator("button[data-flow]")).toHaveCount(actionCases.length)
    for (const [index, [tag, label, args, disabled]] of actionCases.entries()) {
      const control = page.locator("button[data-flow]").nth(index)
      await expect(control).toHaveAttribute("data-flow", tag as string)
      await expect(control).toHaveText(label as string)
      await page.evaluate(() => { (window as unknown as { homeCallbacks: unknown[] }).homeCallbacks = [] })
      if (disabled) {
        await expect(control).toBeDisabled()
        await expect(control.locator("..")).toContainText("Waiting for a machine")
        await control.evaluate(button => (button as HTMLButtonElement).click())
      } else { await control.focus(); await page.keyboard.press("Enter") }
      expect(await page.evaluate(() => (window as unknown as { homeCallbacks: unknown[] }).homeCallbacks)).toEqual(disabled ? [] : [{ kind: "action", value: { tag, args } }])
    }
    if (story.startsWith("active")) {
      await expect(page.locator('.mvp-avatar[data-kind="agent"]')).not.toHaveCount(0)
      await expect(page.getByRole("button", { name: "Open", exact: true }).nth(1)).toBeDisabled()
      await expect(page.locator('.mvp-stack-row').first().locator('.mvp-avatar')).toHaveCount(1)
      await expect(page.locator('.mvp-home')).not.toContainText("Not in review yet")
      await expect(page.locator('.mvp-home')).toContainText("Daily limit reached · starts tomorrow")
      for (const [title, n] of [["Persist merge requests", "8"], ["Card model contracts", "12"], ["Wire Home", "15"], ["Retry webhook delivery", "16"]]) {
        const trigger = page.getByRole("button", { name: `Order ${title}`, exact: true })
        await trigger.focus(); await page.keyboard.press("Enter")
        const menu = page.getByRole("menu", { name: `Order ${title}`, exact: true })
        await expect(menu).toBeVisible()
        await expect(menu.getByRole("menuitem")).toHaveCount(3)
        for (const [label, tag, args] of [["Move up", "stack.move", { n, direction: "up" }], ["Move down", "stack.move", { n, direction: "down" }], ["Drop", "todo.drop", { n }]] as const) {
          await page.evaluate(() => { (window as unknown as { homeCallbacks: unknown[] }).homeCallbacks = [] })
          const control = menu.getByRole("menuitem", { name: label })
          await control.focus(); await page.keyboard.press("Enter")
          expect(await page.evaluate(() => (window as unknown as { homeCallbacks: unknown[] }).homeCallbacks)).toEqual([{ kind: "action", value: { tag, args } }])
        }
        const menuViolations = await page.evaluate(async () => {
          const axe = (window as unknown as { axe: { run: () => Promise<{ violations: { impact: string }[] }> } }).axe
          return (await axe.run()).violations.filter(item => item.impact === "serious" || item.impact === "critical")
        })
        expect(menuViolations).toEqual([])
        await page.keyboard.press("Escape")
        await expect(menu).toHaveCount(0)
        await expect(trigger).toBeFocused()
      }
      for (const [state, filter] of [["needs_you", "needs_you"], ["working", "working"], ["queued", "queued"], ["in_review", "in_review"]]) {
        await page.evaluate(() => { (window as unknown as { homeCallbacks: unknown[] }).homeCallbacks = [] })
        await page.locator(`[data-filter="${state}"]`).click()
        expect(await page.evaluate(() => (window as unknown as { homeCallbacks: unknown[] }).homeCallbacks)).toEqual([{ kind: "view", value: { filter } }])
      }
    }
  }
  await writeFile(join(shots, "home-axe.json"), JSON.stringify(receipts, null, 2))
})


