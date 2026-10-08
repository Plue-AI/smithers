import { HomeCardSchema, type HomeCard } from "@smthrs/rpc/HomeCard"
import { test } from "./support"
import { scenario } from "./coverage/types"
import { withReference, home, runSlash, required, expect, attachJson } from "./todo/reference"
import { journeyActivate } from "./support/keyboard-journey-input"

// Prepared real install only: no scripted flow, SQL writes or fixture routes.
// This recording slice does not qualify the whole C-J4-01 check.
test("C-J4-01 Home shared facts, private filter and retained background failures", scenario("journey.home", {
  capabilities: [], coverage: ["host:local", "host:production", "surface:home", "door:slash", "door:button", "dimension:keyboard", "path:persistence"]
}), async ({ browser }, info) => {
  test.setTimeout(240_000)
  const failed = [required("SMITHERS_JOURNEY_HOME_F1"), required("SMITHERS_JOURNEY_HOME_F2")]
  expect(failed[0]).not.toBe(failed[1])
  for (const id of failed) expect(id).toMatch(/^[1-9][0-9]*$/)
  await withReference(browser, info, async f => {
    const actors = ["Will", "Ben", "Alice"] as const
    type Snapshot = { cursor: number; bytes: string; model: HomeCard; at: number }
    const received = new Map<string, Snapshot[]>()
    const actions: Array<{ op: string; actor: string; id: string; started: number; acknowledged: number; status: number; receipt: unknown }> = []
    try {
    for (const actor of actors) {
      const page = f.members[actor].page, rows: Snapshot[] = []
      received.set(actor, rows)
      page.on("websocket", socket => {
        if (new URL(socket.url()).pathname !== "/api/live") return
        socket.on("framereceived", frame => {
          if (typeof frame.payload !== "string") return
          let value: any
          try { value = JSON.parse(frame.payload) } catch { return }
          if (value.t !== "snap" || !Number.isSafeInteger(value.cursor)) return
          const parsed = HomeCardSchema.safeParse(value.data)
          if (parsed.success && parsed.data.repository === f.repo) rows.push({ cursor: value.cursor,
            bytes: JSON.stringify(value.data), model: parsed.data, at: Date.now() })
        })
      })
      await page.reload()
      await runSlash(page, "/stack")
      await expect(home(page)).toBeVisible()
    }
    // Shared snapshots compare at one cursor; private preferences stay separate.
    let shared: Snapshot | undefined
    await expect.poll(() => {
      for (const candidate of [...received.get("Will")!].reverse()) {
        if (actors.every(actor => [...received.get(actor)!].reverse().find(row => row.cursor === candidate.cursor)?.bytes === candidate.bytes)) {
          shared = candidate; return true
        }
      }
      return false
    }, { timeout: 15_000 }).toBe(true)
    const model = shared!.model
    for (const state of ["needs_you", "starting", "working", "queued", "in_review"] as const) expect(model.counts[state]).toBeGreaterThan(0)
    expect(model.counts.in_review).toBeGreaterThanOrEqual(2)
    const stored = f.sql("SELECT number AS n FROM mythical_items WHERE repository_id IN (SELECT repository_id FROM mythical_stacks WHERE state = 'active') AND number IS NOT NULL AND state NOT IN ('landed','cancelled','rejected','declined') ORDER BY stack_position")
    expect(model.items.map(item => item.n)).toEqual(stored.map(row => row.n))
    const api = await f.read("Will", "/api/todos")
    const items = Array.isArray(api) ? api : api.items
    expect(Array.isArray(items)).toBe(true)
    for (const [state, count] of Object.entries(model.counts)) expect(count).toBe(state === "merged" || state === "dropped" ? 0 : items.filter((item: any) => item.state === state).length)
    for (const actor of actors) {
      const card = home(f.members[actor].page)
      await expect(card.locator(".stack-row .ref")).toHaveText(model.items.map(item => `T${item.n}`))
      for (const state of ["needs_you", "working", "queued", "in_review"] as const) await expect(card.locator(`[data-filter="${state}"] b`)).toHaveText(String(model.counts[state] + (state === "working" ? model.counts.starting : 0)))
      await expect(card.getByLabel(`${model.machines.in_use} of ${model.machines.capacity} machines in use`, { exact: true })).toBeVisible()
      const ready = model.items.filter(item => item.state === "in_review" && item.merge.state === "ready")
      expect(ready).toHaveLength(1)
      await expect(card.getByRole("button", { name: "Merge", exact: true })).toHaveCount(actor === "Alice" ? 0 : 1)
      if (actor !== "Alice") await expect(card.locator(".stack-row").filter({ hasText: new RegExp(`\\bT${ready[0]!.n}\\b`) }).getByRole("button", { name: "Merge", exact: true })).toBeVisible()
    }
    const owner = f.members.Will.page
    // Working includes Starting. Verify the actual row identities, rather than
    // just a matching count that could conceal the wrong filter membership.
    for (const state of ["working", "queued", "in_review"] as const) {
      const expected = model.items.filter(item => item.state === state || (state === "working" && item.state === "starting"))
      const button = home(owner).locator(`[data-filter="${state}"]`)
      await journeyActivate(button)
      await expect(button).toHaveAttribute("aria-pressed", "true")
      await expect(home(owner).locator(".stack-row .ref")).toHaveText(expected.map(item => `T${item.n}`))
      for (const member of ["Ben", "Alice"] as const) await expect(home(f.members[member].page).locator(".stack-row .ref")).toHaveText(model.items.map(item => `T${item.n}`))
      await journeyActivate(button)
      await expect(button).toHaveAttribute("aria-pressed", "false")
      await expect(home(owner).locator(".stack-row .ref")).toHaveText(model.items.map(item => `T${item.n}`))
    }
    await journeyActivate(home(owner).locator('[data-filter="needs_you"]'))
    const needs = model.items.filter(item => item.state === "needs_you").map(item => `T${item.n}`)
    await expect(home(owner).locator(".stack-row .ref")).toHaveText(needs)
    await owner.reload()
    await expect(home(owner).locator('[data-filter="needs_you"]')).toHaveAttribute("aria-pressed", "true")
    await expect(home(owner).locator(".stack-row .ref")).toHaveText(needs)
    for (const actor of ["Ben", "Alice"] as const) {
      await expect(home(f.members[actor].page).locator('[data-filter="needs_you"]')).toHaveAttribute("aria-pressed", "false")
      await expect(home(f.members[actor].page).locator(".stack-row")).toHaveCount(model.items.length)
    }
    const preferences = await Promise.all(actors.map(actor => f.read(actor, "/api/conversations/main/view-state")))
    expect(preferences[0].home.filter).toBe("needs_you")
    expect(preferences.slice(1).every(view => view.home?.filter !== "needs_you")).toBe(true)
    for (const id of failed) {
      const run = model.background_runs.find(row => row.id === id)
      expect(run?.state).toBe("failed")
      expect(run!.actions.map(action => action.label)).toEqual(expect.arrayContaining(["Retry", "Dismiss"]))
      for (const actor of actors) {
        const page = f.members[actor].page
        if (actor !== "Will") await page.reload()
        const index = model.background_runs.findIndex(row => row.id === id)
        const row = home(page).locator(".run-row").nth(index)
        await expect(row).toContainText(run!.title)
        await expect(row).toHaveCount(1)
        await expect(row.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
        await expect(row.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible()
      }
    }
    // Execute the same typed card doors as the slash and agent actions. An
    // admission response is not completion: retain the actual new running row.
    const control = async (actor: "Ben" | "Alice", id: string, op: "retry" | "dismiss") => {
      const page = f.members[actor].page
      const title = model.background_runs.find(run => run.id === id)!.title
      const response = page.waitForResponse(candidate => candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname === `/api/runs/${id}` && candidate.request().postDataJSON()?.op === op).then(answer => ({ answer, acknowledged: Date.now() }))
      void response.catch(() => undefined)
      const started = Date.now()
      const index = received.get(actor)!.at(-1)!.model.background_runs.findIndex(run => run.id === id)
      expect(index).toBeGreaterThanOrEqual(0)
      const row = home(page).locator(".run-row").nth(index)
      await expect(row).toContainText(title)
      await journeyActivate(row.getByRole("button", { name: op === "retry" ? "Retry" : "Dismiss", exact: true }))
      await expect(page.getByTestId("composer-input")).toBeEnabled()
      const { answer, acknowledged } = await response
      const receipt = await answer.json()
      actions.push({ op, actor, id, started, acknowledged, status: answer.status(), receipt })
      expect(answer.ok()).toBe(true)
      expect(receipt.state).toBe(op === "retry" ? "accepted" : "dismissed")
      expect(Number.isSafeInteger(receipt.run_id) && receipt.run_id > 0).toBe(true)
      if (op === "retry") {
        expect(String(receipt.run_id)).not.toBe(id)
        for (const member of actors) {
          await expect.poll(() => received.get(member)!.some(row => row.at >= started &&
            row.model.background_runs.some(run => run.id === String(receipt.run_id) && run.state === "running")), { timeout: 15_000 }).toBe(true)
          const running = received.get(member)!.find(row => row.at >= started && row.model.background_runs.some(run => run.id === String(receipt.run_id) && run.state === "running"))!
          expect(running.at - acknowledged).toBeLessThanOrEqual(1000)
        }
      } else {
        for (const member of actors) {
          const page = f.members[member].page
          await expect.poll(() => received.get(member)!.at(-1)?.model.background_runs.some(run => run.id === id)).toBe(false)
          const reloading = Date.now()
          await page.reload()
          await expect(home(page)).toBeVisible()
          await expect.poll(() => (received.get(member)!.at(-1)?.at ?? 0) >= reloading).toBe(true)
          await expect.poll(() => received.get(member)!.at(-1)?.model.background_runs.some(run => run.id === id)).toBe(false)
          const visible = received.get(member)!.at(-1)!.model.background_runs
          await expect(home(page).locator(".run-row")).toHaveCount(visible.length)
          for (const [index, run] of visible.entries()) await expect(home(page).locator(".run-row").nth(index)).toContainText(run.title)
        }
      }
      return receipt
    }
    await control("Ben", failed[0]!, "retry")
    await control("Alice", failed[1]!, "dismiss")
    await attachJson(info, "home-shared-facts-and-private-filter", { shared, stored, preferences,
      members: Object.fromEntries(received), failed })
    } finally {
      // Preserve partial observations when a dependency or live action fails.
      await attachJson(info, "home-live-observations", { members: Object.fromEntries(received), actions })
    }
  })
})
