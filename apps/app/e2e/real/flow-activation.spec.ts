import { test } from "./support"
import { scenario } from "./coverage/types"
import { withReference, createTodo, openTodo, todoCard, runSlash, expect, attachJson, required } from "./todo/reference"
import { journeyActivate } from "./support/keyboard-journey-input"

// Prepared continuation of J5, after the person has taught the factory and its
// change reached In review. T1 adds pnpm test and CHANGELOG.md; T2 is still
// waiting for an answer in the prior flow. Preparation is real app work, never SQL seeding.
// The same live run must remain pinned through T1's merge and flow-load.
// This continuation alone does not qualify the entire C-J5-01 check.
test("C-J5-01 merged factory edit activates only for new TODO attempts", scenario("journey-flow-activation", {
  capabilities: [], coverage: ["host:local", "host:production", "door:slash", "door:button", "surface:flow", "surface:todo", "dimension:keyboard", "path:success", "evidence:flow-version-pinning"]
}), async ({ browser }, info) => {
  test.setTimeout(1_800_000)
  expect(required("SMITHERS_JOURNEY_KEYBOARD")).toBe("1")
  expect(["light", "dark"]).toContain(required("SMITHERS_JOURNEY_THEME"))
  await withReference(browser, info, async f => {
    const page = f.members.Will.page
    const flow = () => f.read("Will", "/api/flows/todo")
    const active = (card: any) => card.versions.find((version: any) => version.state === "active")
    const initial = await flow()
    const old = active(initial)
    expect(old.id).toMatch(/^[0-9a-f]{64}$/)
    const proposed = initial.versions.find((version: any) => version.state === "proposed" && version.todo === 1)
    expect(proposed).toBeDefined()
    expect(proposed.id).toMatch(/^[0-9a-f]{64}$/)
    expect(proposed.id).not.toBe(old.id)
    expect(proposed.steps.some((step: any) => step.id === "changelog")).toBe(true)
    const change = await f.read("Will", "/api/todos/1")
    expect(change.state).toBe("in_review")
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
    await openTodo(page, 1)
    await expect.poll(async () => (await f.read("Will", "/api/todos/1")).merge?.state, { timeout: 120_000 }).toBe("ready")
    await journeyActivate(todoCard(page, 1).getByRole("button", { name: "Merge", exact: true }))
    await expect.poll(async () => (await f.read("Will", "/api/todos/1")).state, { timeout: 300_000 }).toBe("merged")
    const pull = await f.github("Will", "GET", `/pulls/${change.pr.number}`) as any
    expect(pull.merged).toBe(true)
    await expect.poll(async () => active(await flow())?.id, { timeout: 300_000 }).toBe(proposed.id)
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
