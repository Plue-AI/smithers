import { test } from "./support"
import { scenario } from "./coverage/types"
import { journeyActivate } from "./support/keyboard-journey-input"
import { withReference, createTodo, openTodo, todoCard, runSlash, expect, attachJson } from "./todo/reference"

// Prepared fresh reference install, real models and scratch GitHub repository.
// No injected pages, proposals, activation, check outputs or merge events.
test("C-J5-03 learning proposal changes checks only after a member merges", scenario("journey-learning", {
  capabilities: [], coverage: ["host:local", "host:production", "path:success", "door:button", "door:slash", "surface:proposal", "surface:todo", "surface:flow", "dimension:learning", "dimension:evidence"]
}), async ({ browser }, info) => {
  test.setTimeout(3_600_000)
  await withReference(browser, info, async f => {
    const page = f.members.Will.page, maintainer = f.members.Ben.page
    const flow = () => f.read("Will", "/api/flows/todo")
    const active = (card: any) => card.versions.find((v: any) => v.state === "active")
    const before = active(await flow())
    expect(before.id).toMatch(/^[0-9a-f]{64}$/)
    expect(await f.read("Will", "/api/todos")).toEqual([])
    const manifest = await f.github("Will", "GET", "/contents/package.json") as { content: string }
    const scripts = JSON.parse(Buffer.from(manifest.content, "base64").toString()).scripts
    expect(scripts.test).toEqual(expect.any(String)); expect(scripts.lint).toEqual(expect.any(String))
    const config = f.sql("SELECT value FROM install_settings WHERE key='coding.project'")
    await attachJson(info, "initial-install-flow-config", config)
    // Assert the executed evidence too: setup must omit lint at check, while
    // review runs it. Merely configuring this is insufficient.
    const waitReview = async (n: number) => {
      await expect.poll(async () => (await f.read("Will", `/api/todos/${n}`)).state,
        { timeout: 780_000, intervals: [1000, 2000] }).toBe("in_review")
      return f.read("Will", `/api/todos/${n}`)
    }
    const merge = async (n: number) => {
      await openTodo(maintainer, n)
      await expect.poll(async () => (await f.read("Ben", `/api/todos/${n}`)).merge?.state,
        { timeout: 120_000 }).toBe("ready")
      await journeyActivate(todoCard(maintainer, n).getByRole("button", { name: "Merge", exact: true }))
      await expect.poll(async () => (await f.read("Will", `/api/todos/${n}`)).state,
        { timeout: 180_000 }).toBe("merged")
    }
    const inputs = [
      "Add src/learning-one.ts exporting one() returning 1. Start with an unused import of readFile from node:fs.",
      "Add src/learning-two.ts exporting two() returning 2 with no imports.",
      "Add src/learning-three.ts exporting three() returning 3. Start with an unused import of readFile from node:fs.",
      "Add src/learning-four.ts exporting four() returning 4 with no imports.",
      "Add src/learning-five.ts exporting five() returning 5. Start with an unused import of readFile from node:fs."
    ]
    const todos: any[] = []
    for (const [index, prompt] of inputs.entries()) {
      const n = index + 1
      await createTodo(page, prompt)
      const todo = await waitReview(n)
      expect(todo.flow_version.digest).toBe(before.id)
      const stored = f.sql(`SELECT checks FROM mythical_items WHERE number=${n}`)[0].checks
      const failures = stored.attempts.flatMap((a: any) => a.failures ?? []).filter((x: any) => x.signature === "check:lint@review")
      expect(failures.length > 0).toBe([1, 3, 5].includes(n))
      for (const attempt of stored.attempts) {
        expect(attempt.run_id).toEqual(expect.any(String))
        expect((attempt.items ?? []).some((x: any) => x.kind === "check" && x.name === "lint" && x.tier !== "slow")).toBe(false)
      }
      todos.push({ todo, stored })
      await merge(n)
      if (n < 5) {
        await expect.poll(() => f.sql(`SELECT learning_receipt FROM mythical_items WHERE number=${n}`)[0]?.learning_receipt != null,
          { timeout: 300_000 }).toBe(true)
        const early = f.sql("SELECT id FROM memory_notes WHERE provenance_json::jsonb->>'signature'='check:lint@review' AND status='pending'")
        expect(early).toEqual([])
        expect(active(await flow()).id).toBe(before.id)
      }
    }
    await runSlash(page, "/stack")
    await expect(page.locator(".home").last()).toBeVisible()
    await expect.poll(async () => (await f.read("Will", "/api/todos/5")).lessons,
      { timeout: 300_000 }).toBeGreaterThan(0)
    const fifth = await f.read("Will", "/api/todos/5")
    expect(fifth.state).toBe("merged")
    await openTodo(page, 5)
    const receipt = todoCard(page, 5).getByRole("region", { name: "Lessons from T5" })
    await expect(receipt).toContainText(`${fifth.lessons} lessons`)
    const pending = f.sql("SELECT id,provenance_json::jsonb AS provenance_json FROM memory_notes WHERE provenance_json::jsonb->>'signature'='check:lint@review' AND status='pending'")
    expect(pending).toHaveLength(1)
    expect(pending[0].provenance_json.signature).toBe("check:lint@review")
    expect(pending[0].provenance_json.diff).toContain("--- a/flows/todo/flow.ts")
    expect(pending[0].provenance_json.diff).toContain("Require lint as a fast required check")
    const proposals = await f.read("Will", "/api/proposals")
    const proposal = proposals.find((p: any) => p.id === pending[0].id)
    expect(proposal).toBeDefined()
    expect(proposal.state).toBe("open")
    expect(proposal.evidence.join(" ")).toContain("3 of the last 5")
    expect(proposal.refs.map((r: any) => r.label).sort()).toEqual(["T1", "T3", "T5"])
    expect(await f.read("Will", "/api/todos")).toHaveLength(5)
    await journeyActivate(receipt.getByRole("button", { name: proposal.title, exact: true }))
    const card = page.locator('[data-kind="proposal"]').last()
    await expect(card).toContainText("3 of the last 5")
    await journeyActivate(card.getByRole("button", { name: "Make TODO", exact: true }))
    await expect.poll(async () => (await f.read("Will", "/api/proposals")).find((p: any) => p.id === proposal.id)?.state,
      { timeout: 30_000 }).toBe("accepted")
    const accepted = (await f.read("Will", "/api/proposals")).find((p: any) => p.id === proposal.id)
    expect(accepted.state).toBe("accepted"); expect(accepted.todo.n).toBe(6)
    const change = await waitReview(6)
    expect(change.flow_version.digest).toBe(before.id)
    const files = await f.github("Will", "GET", `/pulls/${change.pr.number}/files`) as any[]
    expect(files.find(file => file.filename === "flows/todo/flow.ts")?.patch).toContain("lint")
    expect(active(await flow()).id).toBe(before.id)
    const eventsBefore = f.sql("SELECT * FROM product_job_events WHERE data->>'itemId'=(SELECT id::text FROM mythical_items WHERE number=5) ORDER BY tenant_id,principal_id,sequence")
    await merge(6)
    await expect.poll(async () => active(await flow()).id, { timeout: 300_000 }).not.toBe(before.id)
    const next = active(await flow())
    await createTodo(page, "Add src/learning-six.ts exporting six() returning 6. Start with an unused import of readFile from node:fs.")
    const sixth = await waitReview(7)
    expect(sixth.flow_version.digest).toBe(next.id)
    expect(sixth.attempts).toHaveLength(1)
    const lint = sixth.evidence[0].items.filter((x: any) => x.name === "lint" && x.kind === "check")
    expect(lint).toHaveLength(1); expect(lint[0].state).toBe("passed")
    const storedSixth = f.sql("SELECT checks FROM mythical_items WHERE number=7")[0].checks
    expect(storedSixth.attempts.flatMap((a: any) => a.failures ?? []).filter((x: any) => x.signature === "check:lint@review")).toEqual([])
    expect(await f.read("Will", "/api/todos")).toHaveLength(7)
    const fifthStored = f.sql("SELECT lessons,learning_receipt FROM mythical_items WHERE number=5")[0]
    expect(fifthStored.lessons).toBe(fifthStored.learning_receipt.lessons.length)
    const eventsAfter = f.sql("SELECT * FROM product_job_events WHERE data->>'itemId'=(SELECT id::text FROM mythical_items WHERE number=5) ORDER BY tenant_id,principal_id,sequence")
    expect(eventsAfter).toEqual(eventsBefore)
    await attachJson(info, "learning-journey", { todos, proposal, pending, fifthStored, change, next, sixth, storedSixth, eventsBefore, eventsAfter })
  })
})
