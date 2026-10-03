import { test, expect } from "./browserTest"
import { fixtures as actorFixtures } from "@smthrs/rpc/fixtures/ActorChip"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { createRequire } from "node:module"
const require = createRequire(resolve(process.cwd(), "package.json"))
const axePath = require.resolve("axe-core/axe.min.js")
const diffExpected: Record<string, string> = { item_base: 'description: "Complete one TODO"', fork: "export const repro = true", deleted: "export const legacy = true", burst: 'description: "Build"', multiple_hunks: "same", hostile: '<script>alert("diff")</script>' }
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
    if (story.name.startsWith("DiffSurface/")) {
      
      const text = diffExpected[story.name.split("/")[1]!]
      if (text) await expect(page.locator("diffs-container")).toContainText(text)
    }
    await page.evaluate(() => document.fonts.ready)
    // Worker highlighting can replace an entering annotation. Audit its settled projection.
    const flagCount = story.name === "FilePresenceView/live_separate" ? 3
      : /^FilePresenceView\/(live|no_binding|five_editors)$/.test(story.name) ? 1 : 0
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
    if (story.name.startsWith("DiffSurface/")) {
      
      const text = diffExpected[story.name.split("/")[1]!]
      if (text) await expect(page.locator("diffs-container")).toContainText(text)
    }
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

test("Flow versions stay local; keyboard actions dispatch once", async ({ page }) => {
  await page.goto("/view-stories.html?story=FlowView/proposed")
  await page.evaluate(() => {
    Object.assign(window, { flowReceipts: [] })
    window.addEventListener("story-callback", event => (window as unknown as { flowReceipts: unknown[] }).flowReceipts.push((event as CustomEvent).detail))
  })
  await page.locator('.mvp-version[data-state="proposed"]').focus()
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
for (const [name, fixture] of Object.entries(draftFixtures)) test(`Draft ${name}: supplied actions and keyboard`, async ({ page }) => {
  await page.goto(`/view-stories.html?story=${encodeURIComponent(`DraftView/${fixture.name}`)}`)
  await expect(page.getByRole("region", { name: "Draft", exact: true })).toBeVisible()
  await page.evaluate(() => {
    (window as unknown as { draftCalls: unknown[] }).draftCalls = []
    window.addEventListener("story-callback", event => {
      const detail = (event as CustomEvent).detail
      ;(window as unknown as { draftCalls: unknown[] }).draftCalls.push(detail)
    })
  })
  if (fixture.model.committed) {
    await expect(page.locator(".draft-actions button")).toHaveCount(0)
    await expect(page.locator(".draft-private")).toHaveCount(0)
  } else {
    await expect(page.locator(".draft-private")).toHaveText("Only you")
    for (const action of fixture.actions) {
      const control = page.locator(`button[data-flow="${action.tag}"]`)
      if (action.disabled) await expect(control).toBeDisabled()
      else { await control.focus(); await page.keyboard.press("Enter") }
    }
    expect(await page.evaluate(() => (window as unknown as { draftCalls: unknown[] }).draftCalls)).toEqual(
      fixture.actions.filter(action => !action.disabled).map(action => ({ kind: "action", value: { tag: action.tag, args: action.args ?? {} } })))
    await page.goto(`/view-stories.html?story=${encodeURIComponent(`DraftView/${fixture.name}`)}&removeFirst`)
    await expect(page.locator(`button[data-flow="${fixture.actions[0]!.tag}"]`)).toHaveCount(0)
    await expect(page.locator('button[data-flow="draft.discard"]')).toHaveCount(1)
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
  expect(await page.evaluate(() => (window as unknown as { draftCalls: unknown[] }).draftCalls)).toEqual([
    { kind: "action", value: { tag: "form.set", args: { entry: "entry-draft-1", field: "title", value: "Browser title" } } },
    { kind: "action", value: { tag: "form.set", args: { entry: "entry-draft-1", field: "prompt", value: "Browser\nprompt" } } },
    { kind: "action", value: { tag: "form.set", args: { entry: "entry-draft-1", field: "acceptance", value: '["First","Second"]' } } },
    { kind: "action", value: { tag: "form.set", args: { entry: "entry-draft-1", field: "place", value: '{"mode":"before","n":8}' } } },
    { kind: "action", value: { tag: "form.set", args: { entry: "entry-draft-1", field: "fixes", value: "false" } } }
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
  const keyword = page.locator('diffs-container [data-line] span').filter({ hasText: /^make$/ }).first()
  await expect(keyword).toBeVisible()
  await expect.poll(async () => keyword.evaluate(element => {
    const probe = document.createElement("span")
    probe.style.color = "var(--lane-1)"
    document.body.append(probe)
    const matches = getComputedStyle(element).color === getComputedStyle(probe).color
    probe.remove()
    return matches
  })).toBe(true)
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
      { kind: "action", value: { tag: "secrets.set", args: { name: "STRIPE_KEY", value: "replacement-value", scope: "all_branches", hosts: "" } } },
    ])
    await expect(form.locator('input[type="password"]')).toHaveValue("")
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.addScriptTag({ path: axePath })
    expect(await page.evaluate(async () => (await (window as unknown as { axe: { run: () => Promise<{ violations: { impact: string }[] }> } }).axe.run()).violations.filter(v => v.impact === "serious" || v.impact === "critical"))).toEqual([])
  }
})

test("File recovery Copy and Reapply remain keyboard accessible", async ({ page }) => {
  await page.goto("/view-stories.html?story=FilePresenceView/unsaved")
  await page.evaluate(() => {
    const calls: unknown[] = []
    Object.assign(window, { fileRecoveryCalls: calls })
    window.addEventListener("story-callback", event => calls.push((event as CustomEvent).detail))
  })
  const notice = page.locator('.code-notice[data-tone="attention"]')
  const copy = notice.getByRole("button", { name: "Copy", exact: true })
  const reapply = notice.getByRole("button", { name: "Reapply", exact: true })
  await page.keyboard.press("Tab")
  await expect(copy).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(reapply).toBeFocused()
  await page.keyboard.press("Enter")
  await expect.poll(() => page.evaluate(() => (window as unknown as { fileRecoveryCalls: unknown[] }).fileRecoveryCalls)).toEqual([
    { kind: "action", value: { tag: "file.reapply", args: { path: "flows/todo/flow.ts" } } },
  ])
  await expect(notice.locator("pre")).toHaveText('  description: "Build",\n')
})

test("File Copy failure remains visible and retains recovered text", async ({ page }) => {
  await page.goto("/view-stories.html?story=FilePresenceView/unsaved")
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("unavailable") } } })
    document.execCommand = () => false
  })
  await page.getByRole("button", { name: "Copy", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Copy failed")
  await expect(page.locator('.code-notice pre')).toHaveText('  description: "Build",\n')
  await expect(page.getByRole("button", { name: "Reapply", exact: true })).toBeEnabled()
})

test("Docs document links are gestures and HTML remains inert", async ({ page }) => {
  await page.goto("/view-stories.html?story=DocsView/Inert%20HTML")
  await expect(page.locator(".mvp-docs .ProseMirror")).toBeVisible()
  await expect(page.locator(".mvp-docs script,.mvp-docs img,.mvp-docs iframe,.mvp-docs a[href^=\"javascript:\"]")).toHaveCount(0)
  await expect(page.locator(".mvp-docs .ProseMirror")).toContainText("<script>alert(1)</script>")
  await expect(page.locator(".mvp-docs pre")).toContainText("<div>")
  await page.evaluate(() => {
    const receipts: unknown[] = []
    Object.assign(window, { docsReceipts: receipts })
    window.addEventListener("story-callback", event => receipts.push((event as CustomEvent).detail))
  })
  await page.getByRole("link", { name: "Titled", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { docsReceipts: unknown[] }).docsReceipts)).toEqual([
    { kind: "action", value: { tag: "docs", args: { source: "docs-card", page: "todos" } } }
  ])
  await page.evaluate(() => { (window as unknown as { docsReceipts: unknown[] }).docsReceipts = [] })
  await page.getByRole("link", { name: "Heading", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { docsReceipts: unknown[] }).docsReceipts)).toEqual([
    { kind: "action", value: { tag: "docs", args: { source: "docs-card", page: "quickstart#put-https-in-front" } } }
  ])
  await page.goto("/view-stories.html?story=DocsView/The%20quickstart%20page")
  await expect(page.locator(".mvp-docs .ProseMirror")).toBeVisible()
  await page.evaluate(() => {
    Object.assign(window, { docsReceipts: [] })
    window.addEventListener("story-callback", event => (window as unknown as { docsReceipts: unknown[] }).docsReceipts.push((event as CustomEvent).detail))
  })
  await page.locator(".mvp-docs-markdown").getByRole("link", { name: "TODOs", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { docsReceipts: unknown[] }).docsReceipts)).toEqual([
    { kind: "action", value: { tag: "docs", args: { page: "todos" } } }
  ])
  await page.goto("/view-stories.html?story=DocsView/Scrolled%20to%20a%20heading")
  await expect(page.locator('.mvp-docs .ProseMirror h2')).toHaveText("Put HTTPS in front")
  await expect(page.getByRole("heading", { name: "Quickstart", exact: true })).toHaveCount(1)
  const scroll = page.locator('.mvp-docs .sui-markdown-editor')
  await scroll.evaluate(node => { node.style.height = "40px"; node.scrollTop = 20 })
  const position = await scroll.evaluate(node => node.scrollTop)
  expect(position).toBeGreaterThan(0)
  await page.waitForTimeout(500)
  expect(await scroll.evaluate(node => node.scrollTop)).toBe(position)
})
