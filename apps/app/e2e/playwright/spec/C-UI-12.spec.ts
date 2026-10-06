import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

test("C-UI-12 TODO: supplied Fork and Add to stack have keyboard paths", async ({ page }) => {
  await page.goto("/view-stories.html?story=TodoView/fork_and_add")
  await page.evaluate(() => window.addEventListener("story-callback", event => {
    const detail = (event as CustomEvent).detail
    if (detail.kind === "action") document.body.dataset.action = JSON.stringify(detail.value)
  }))
  await page.getByRole("button", { name: "Fork", exact: true }).press("Enter")
  await expect(page.locator("body")).toHaveAttribute("data-action", JSON.stringify({ tag: "branch.fork", args: { from: "T12" } }))
  await page.getByRole("textbox", { name: "TODO", exact: true }).fill("Keep retry")
  await page.keyboard.press("Tab")
  await expect(page.getByRole("button", { name: "Add to stack", exact: true })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.locator("body")).toHaveAttribute("data-action", JSON.stringify({ tag: "branch.add-to-stack", args: { branch: "scratch/retry", text: "Keep retry" } }))
})

test("C-UI-12 TODO conflict: 390 px layout and keyboard order", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/view-stories.html?story=TodoView/conflict_with_terminal")
  const wait = page.locator('[data-wait-id="wait-conflict-1"]')
  await expect(wait).toContainText("packages/rpc/src/TodoCard.ts")
  await expect(wait).toContainText("ssh todo-12@mac-mini.local")
  const terminal = wait.getByRole("textbox", { name: "Conflict terminal", exact: true })
  await expect(terminal).toHaveCount(1)
  await expect(wait.locator(".todo-actions")).toHaveCSS("flex-direction", "column")
  const resolve = wait.getByRole("button", { name: "Resolve", exact: true })
  const done = wait.getByRole("button", { name: "Done", exact: true })
  const terminalBox = (await terminal.boundingBox())!, resolveBox = (await resolve.boundingBox())!, doneBox = (await done.boundingBox())!
  expect(terminalBox.y + terminalBox.height).toBeLessThanOrEqual(resolveBox.y)
  expect(resolveBox.y + resolveBox.height).toBeLessThanOrEqual(doneBox.y)
  expect(await wait.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  await page.evaluate(() => window.addEventListener("story-callback", event => {
    const detail = (event as CustomEvent).detail
    if (detail.kind === "action") document.body.dataset.action = JSON.stringify(detail.value)
  }))
  await terminal.focus()
  await page.keyboard.press("Tab")
  await expect(resolve).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.locator("body")).toHaveAttribute("data-action", JSON.stringify({ tag: "branch", args: { name: "todo/12", wait: "wait-conflict-1" } }))
  await page.keyboard.press("Tab")
  await expect(done).toBeFocused()
  await page.keyboard.press("Space")
  await expect(page.locator("body")).toHaveAttribute("data-action", JSON.stringify({ tag: "todo.answer", args: { n: "12", wait: "wait-conflict-1", answer: "done" } }))
})

test("C-UI-12 TODO: a REST-served question answers through the mounted card and real seam", async ({ page }) => {
  await owner(page)
  const model = {
    n: 24, title: "Retry from the install", state: "needs_you",
    owner: { login: "canary-owner", name: "Ben", avatar_url: "https://example.test/avatar.png" },
    prompt_revisions: [], steps: [], steers: [], evidence: [], present: [], merge: { state: "waiting", reason: "attention", on_github: false },
    waits: [{ id: "question-24", kind: "question", prompt: "Keep retry?", since: "2026-10-05T10:00:00Z",
      actions: [{ tag: "todo.answer", label: "Answer", input: [{ name: "answer", label: "Answer", kind: "text", required: true, multiline: true }] }] }],
  }
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/24", route => route.fulfill({ json: model }))
  const answers: unknown[] = []
  await page.route("**/api/todos/24/answer", async route => {
    answers.push(route.request().postDataJSON())
    await route.fulfill({ status: 202, json: { state: "accepted" } })
  })
  await page.goto("/")
  await say(page, "/todo T24")
  const card = page.getByRole("article", { name: "TODO T24", exact: true })
  await expect(card).toContainText("Retry from the install")
  await expect(card.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  await expect(card.getByRole("button", { name: "Open branch", exact: true })).toHaveCount(0)
  await card.getByRole("textbox", { name: "Answer", exact: true }).fill("Keep retry\nverbatim")
  await card.getByRole("button", { name: "Answer", exact: true }).press("Enter")
  await expect.poll(() => answers).toEqual([{ answer: "Keep retry\nverbatim", wait: "question-24" }])
})

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

test("File co-editing uses CodeMirror attribution and line flags in both themes and widths", async ({ page }) => {
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`/view-stories.html?story=CodeEditorView/live_separate&theme=${theme}`)
    await expect(page.locator('.code-file-view[data-mode="live"] .cm-editor')).toBeVisible()
    await expect(page.locator('.cm-gutter.code-presence-gutter .code-name-flag')).toHaveText(["Ben", "Will", "Claude Code for Ben"])
    await expect(page.locator('.code-name-flag[data-kind="agent"]')).toHaveText("Claude Code for Ben")
    await expect(page.locator('.code-author')).toHaveText(["const one = 1", "const two = 2", "const three = 3"])
    await expect(page.locator('.cm-ySelection, .cm-ySelectionCaret')).toHaveCount(0)
    expect(await page.locator('.code-author').first().evaluate(node => getComputedStyle(node).color)).not.toBe(await page.locator('.cm-content').evaluate(node => getComputedStyle(node).color))
    await page.goto(`/view-stories.html?story=CodeEditorView/saved&theme=${theme}`)
    await expect(page.locator('.code-saved')).toHaveText("Saved to the machine")
    await page.goto(`/view-stories.html?story=CodeEditorView/no_binding&theme=${theme}`)
    await expect(page.locator('.code-file-view[data-mode="read_only"]')).toBeVisible()
    await expect(page.locator('.code-author,.code-name-flag,.code-saved,.code-avatar-stack')).toHaveCount(0)
  }
})

// T-UI-16's File comparison phase uses the retained production story boundary.
test("C-UI-12: File Compare is read-only and keyboard accessible in both themes and widths", async ({ page }) => {
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`/view-stories.html?story=CodeSurface/comparing&theme=${theme}`)
    await expect(page.locator('.code-compare')).toBeVisible()
    await expect(page.locator('.code-compare-cap')).toHaveText(["Currentsha256:9f2c41", "Snapshotgit:7d1e0c2"])
    await expect(page.locator('.code-file-current .cm-content')).toContainText('description: "Complete one TODO"')
    await expect(page.locator('.code-file-outside .cm-content')).toContainText('description: "Build"')
    await expect(page.locator('.code-compare [contenteditable=true]')).toHaveCount(0)
    await page.evaluate(() => {
      Object.assign(window, { compareReceipts: [] })
      window.addEventListener("story-callback", event => (window as unknown as { compareReceipts: unknown[] }).compareReceipts.push((event as CustomEvent).detail))
    })
    const button = page.getByRole('button', { name: 'Compare', exact: true })
    await button.focus()
    await button.press('Enter')
    expect(await page.evaluate(() => (window as unknown as { compareReceipts: unknown[] }).compareReceipts)).toEqual([
      { kind: "action", value: { tag: "file.compare", args: { path: "flows/todo/flow.ts" } } },
    ])
    await page.keyboard.press('Tab')
    await expect(page.locator('.code-file-current .cm-content')).toBeFocused()
    await page.keyboard.press('Tab')
    const snapshot = page.locator('.code-file-outside .cm-content')
    await expect(snapshot).toBeFocused()
    await page.keyboard.type('cannot write')
    await expect(snapshot).toContainText('description: "Build"')
    await expect(snapshot).not.toContainText('cannot write')
    await snapshot.press('F12')
    await snapshot.press('Control+Space')
    expect(await page.evaluate(() => (window as unknown as { compareReceipts: { kind: string }[] }).compareReceipts.filter(call => call.kind === 'action'))).toHaveLength(1)
    const boxes = await page.locator('.code-file-current, .code-file-outside').evaluateAll(nodes => nodes.map(node => ({ x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y })))
    if (width === 390) expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y)
    else expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.goto(`/view-stories.html?story=CodeSurface/comparing_hostile&theme=${theme}`)
    await expect(page.locator('.code-file-current .cm-content')).toContainText('<img src=x onerror="window.__pwned=1">')
    await expect(page.locator('.code-file-outside .cm-content')).toContainText('<script>window.__pwned=1</script>')
    await expect(page.locator('.code-file-view img,.code-file-view script')).toHaveCount(0)
    expect(await page.evaluate(() => Reflect.get(window, '__pwned'))).toBeUndefined()
    await page.goto(`/view-stories.html?story=CodeSurface/comparing_empty&theme=${theme}`)
    await expect(page.locator('.code-compare')).toBeVisible()
    await expect(page.locator('.code-file-outside .cm-content')).toHaveText('')
  }
})


test("C-UI-12: File text reload retains comparison DOM, scroll and selected line", async ({ page }) => {
  await page.goto('/view-stories.html?story=CodeSurface/comparing_reload')
  const current = page.locator('.code-file-current .cm-content')
  await current.focus()
  for (let line = 0; line < 25; line++) await page.keyboard.press('ArrowDown')
  await page.locator('.code-file-current .cm-scroller').evaluate(node => { node.scrollTop = 200 })
  const line = await page.locator('.code-file-current .cm-activeLine').textContent()
  const before = await page.locator('.code-file-current .cm-scroller').evaluate(node => node.scrollTop)
  expect(before).toBeGreaterThan(0)
  await page.evaluate(() => {
    Object.assign(window, { reloadEditor: document.querySelector('.code-file-current .cm-editor'), reloadSnapshot: document.querySelector('.code-file-outside .cm-editor') })
    window.dispatchEvent(new Event('story-reload'))
  })
  await expect(page.locator('.code-file-current .code-compare-cap')).toHaveText('Currentsha256:next')
  await expect(page.locator('.code-file-current .cm-activeLine')).toHaveText(line!)
  expect(await page.locator('.code-file-current .cm-scroller').evaluate(node => node.scrollTop)).toBe(before)
  expect(await page.evaluate(() => Reflect.get(window, 'reloadEditor') === document.querySelector('.code-file-current .cm-editor'))).toBe(true)
  expect(await page.evaluate(() => Reflect.get(window, 'reloadSnapshot') === document.querySelector('.code-file-outside .cm-editor'))).toBe(true)
})
