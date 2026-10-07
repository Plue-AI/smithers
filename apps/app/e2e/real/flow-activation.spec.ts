import { test } from "./support"
import { scenario } from "./coverage/types"
import { withReference, createTodo, openTodo, todoCard, runSlash, expect, attachJson, required } from "./todo/reference"
import { journeyActivate } from "./support/keyboard-journey-input"

// Fresh-canary J5 teaching and activation. File the factory edit first so it
// can be merged while T2 waits: append-only stack order forbids merging over
// a waiting predecessor. Both are real app work, never fixture preparation.
// Immutable closure retry, learning and watchdog checks remain separate.
test("C-J5-01 chat teaching activates only for new TODO attempts", scenario("journey-flow-activation", {
  capabilities: [], coverage: ["host:local", "host:production", "door:slash", "door:button", "surface:flow", "surface:todo", "dimension:keyboard", "path:success", "evidence:flow-version-pinning"]
}), async ({ browser }, info) => {
  test.setTimeout(1_800_000)
  expect(required("SMITHERS_JOURNEY_KEYBOARD")).toBe("1")
  expect(["light", "dark"]).toContain(required("SMITHERS_JOURNEY_THEME"))
  await withReference(browser, info, async f => {
    const page = f.members.Will.page
    const flow = () => f.read("Will", "/api/flows/todo")
    const active = (card: any) => card.versions.find((version: any) => version.state === "active")
    expect(await f.read("Will", "/api/todos")).toEqual([])
    const initial = await flow()
    expect(initial.source).toEqual({ builtin: true })
    const old = active(initial)
    expect(old.id).toMatch(/^[0-9a-f]{64}$/)
    await runSlash(page, "Every TODO must run `pnpm test` and update the changelog.")
    const teaching = page.locator('.flow-view').last()
    await expect(teaching).toBeVisible({ timeout: 120_000 })
    const diff = teaching.locator(".flow-proposal pre")
    await expect(diff).toContainText("flows/todo/flow.ts", { timeout: 120_000 })
    await expect(diff).toContainText("pnpm test")
    await expect(diff).toContainText("CHANGELOG.md")
    // The proposed diff is still a conversation card, not a committed TODO.
    expect(await f.read("Will", "/api/todos")).toEqual([])
    await journeyActivate(teaching.getByRole("button", { name: "Make TODO", exact: true }))
    const draft = page.locator('.smithers-card[data-kind="draft"]').last()
    await expect(draft.getByLabel("Prompt", { exact: true })).toHaveValue(/pnpm test/)
    await journeyActivate(draft.getByRole("button", { name: "Commit", exact: true }))
    await expect.poll(async () => (await f.read("Will", "/api/todos/1")).state, { timeout: 660_000 }).toBe("in_review")
    // Keep a genuine old-version attempt alive during merge and flow-load.
    await createTodo(page, "Ask me which file to edit before editing. Wait for my answer.")
    await expect.poll(async () => (await f.read("Will", "/api/todos/2")).state, { timeout: 660_000 }).toBe("needs_you")
    const proposed = (await flow()).versions.find((version: any) => version.state === "proposed" && version.todo === 1)
    expect(proposed).toBeDefined()
    expect(proposed.id).toMatch(/^[0-9a-f]{64}$/)
    expect(proposed.id).not.toBe(old.id)
    expect(proposed.steps.some((step: any) => step.id === "changelog")).toBe(true)
    const change = await f.read("Will", "/api/todos/1")
    expect(change.state).toBe("in_review")
    expect(change.flow_version.digest).toBe(old.id)
    const running = await f.read("Will", "/api/todos/2")
    expect(running.state).toBe("needs_you")
    expect(running.run.id).toEqual(expect.any(String))
    const before = { run: running.run.id, attempt: running.run.attempt, version: running.flow_version }
    expect(before.version.digest).toBe(old.id)
    expect(before.version.source_commit).toMatch(/^[0-9a-f]{40}$/)
    // Independently inspect the candidate on GitHub before authorizing its merge.
    const files = await f.github("Will", "GET", `/pulls/${change.pr.number}/files?per_page=100`) as any[]
    const patch = files.find(file => file.filename === "flows/todo/flow.ts")?.patch
    expect(patch).toContain("pnpm test")
    expect(patch).toContain("CHANGELOG.md")
    await runSlash(page, "/flow todo")
    const card = page.locator('.flow-view').last()
    await expect(card.locator(`[data-version="${old.id}"]`)).toHaveAttribute("data-state", "active")
    await journeyActivate(card.locator(`[data-version="${proposed.id}"]`))
    await expect(card).toContainText("Changelog")
    const timeline: unknown[] = []
    const sampleActivation = async () => {
      const snapshot = await flow()
      // Observe the real loader after reading the public projection. This is
      // reference database readback, never injected activation or a SQL write.
      const loaded = f.sql(`SELECT digest,source_commit,status,is_active FROM workflow_definitions WHERE name='todo' AND digest='${proposed.id}'`)
      const shown = await card.locator(`[data-version="${proposed.id}"]`).getAttribute("data-state")
      const activeDigest = active(snapshot)?.id
      timeline.push({ at: new Date().toISOString(), activeDigest, shown, versions: snapshot.versions, loaded })
      if (activeDigest === proposed.id || shown === "active") {
        expect(loaded).toHaveLength(1)
        expect(loaded[0]).toMatchObject({ digest: proposed.id, status: "loaded", is_active: true })
        expect(loaded[0].source_commit).toMatch(/^[0-9a-f]{40}$/)
      }
      return activeDigest
    }
    expect(await sampleActivation()).toBe(old.id)
    await openTodo(page, 1)
    await expect.poll(async () => (await f.read("Will", "/api/todos/1")).merge?.state, { timeout: 120_000 }).toBe("ready")
    const ben = f.members.Ben.page
    await openTodo(ben, 1)
    await journeyActivate(todoCard(ben, 1).getByRole("button", { name: "Merge", exact: true }))
    try {
      await expect.poll(async () => {
        await sampleActivation()
        return (await f.read("Will", "/api/todos/1")).state
      }, { timeout: 300_000, intervals: [1000, 2000] }).toBe("merged")
      await expect.poll(sampleActivation, { timeout: 300_000, intervals: [1000, 2000] }).toBe(proposed.id)
    } finally {
      // Retain failed and partial loading transitions, too. A final Active
      // screenshot alone cannot explain an activation ordering failure.
      await info.attach("flow-states.jsonl", { body: timeline.map(sample => JSON.stringify(sample)).join("\n") + "\n", contentType: "application/x-ndjson" })
    }
    const pull = await f.github("Will", "GET", `/pulls/${change.pr.number}`) as any
    expect(pull.merged).toBe(true)
    await runSlash(page, "/flow todo")
    await expect(page.locator('.flow-view').last().locator(`[data-version="${proposed.id}"]`)).toHaveAttribute("data-state", "active")
    // Flow-load cannot change an existing attempt's execution identity.
    const stillRunning = await f.read("Will", "/api/todos/2")
    expect({ run: stillRunning.run.id, attempt: stillRunning.run.attempt, version: stillRunning.flow_version }).toEqual(before)
    expect(stillRunning.state).toBe("needs_you")
    expect((await flow()).versions.find((version: any) => version.id === old.id)?.state).toBe("previous")
    await createTodo(page, "Add FLOW-VERSION-NEW to README.md, run pnpm test, and update CHANGELOG.md.")
    await expect.poll(async () => (await f.read("Will", "/api/todos")).find((todo: any) => todo.n === 3)?.flow_version?.digest,
      { timeout: 660_000 }).toBe(proposed.id)
    await expect.poll(async () => (await f.read("Will", "/api/todos/3")).state, { timeout: 660_000 }).toBe("in_review")
    const next = await f.read("Will", "/api/todos/3")
    const nextFiles = await f.github("Will", "GET", `/pulls/${next.pr.number}/files?per_page=100`) as any[]
    expect(nextFiles.find(file => file.filename === "README.md")?.patch).toContain("FLOW-VERSION-NEW")
    expect(nextFiles.some(file => file.filename === "CHANGELOG.md")).toBe(true)
    await openTodo(page, 3)
    await expect(todoCard(page, 3)).toContainText("pnpm test")
    await attachJson(info, "flow-activation-pinning", { before, after: stillRunning.flow_version, old: old.id, active: proposed.id, merged: pull.merge_commit_sha, next: next.n })
  })
})
