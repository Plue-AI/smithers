/*
 * J5 Teach the factory, recorded on the real app (mvp.md J5; mock .specs/design/mock/src/journeys/j5.ts, captions
 * j5#1..j5#16 in the proof page's mock steps). One test, one proofStep per feature in mock-step order, on the real
 * bundle with the GitHub fake as the outside world and the providers' real models (e2e/proof/fixtures.ts). Maya, the
 * owner, does every step through the app. A failed step records its screenshot and error and the journey goes on; a
 * step whose predecessor did not pass records "blocked by <feature id>". The test fails when any feature did not pass.
 */
import { test, expect, say, setUp, APP } from "./fixtures"
import type { BrowserContext, Page } from "@playwright/test"

const RULE = "Every TODO must run pnpm test and update the changelog."
const WHICH = "Which TODOs use the new flow?"

let page: Page, context: BrowserContext

const served = async (n: number) => {
  const response = await context.request.get(`${APP}/api/todos/${n}`)
  expect(response.status(), `GET /api/todos/${n}`).toBe(200)
  return response.json()
}
const todos = async (): Promise<Array<{ n: number; title: string; state: string }>> => {
  const response = await context.request.get(`${APP}/api/todos`)
  expect(response.status(), "GET /api/todos").toBe(200)
  const body = await response.json()
  return Array.isArray(body) ? body : body.todos ?? body.items ?? []
}
const composer = (text: string) => say(page, text)
const todoCard = (n: number) => page.getByRole("article", { name: `TODO T${n}`, exact: true }).last()
const flowCard = () => page.locator('[data-kind="flow"]').last()
/** Waits for a served TODO state; failed or dropped ends the wait at once. */
const reaches = async (n: number, states: ReadonlyArray<string>, timeout: number) => {
  const began = Date.now()
  for (let todo = await served(n); !states.includes(todo.state); todo = await served(n)) {
    if (todo.state === "failed" || todo.state === "dropped" || Date.now() - began > timeout)
      throw new Error(`T${n} ${todo.state} after ${Math.round((Date.now() - began) / 1000)} s, expected ${states.join("|")}: ${JSON.stringify(todo.failure ?? todo.queue ?? null)}`)
    await page.waitForTimeout(2_000)
  }
  return served(n)
}
/** Commits the open Draft card as a TODO and answers its number. */
const commitDraft = async (title?: string, prompt?: string): Promise<number> => {
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  await expect(draft).toBeVisible({ timeout: 15_000 })
  if (title) await draft.getByLabel("Title", { exact: true }).fill(title)
  if (prompt) await draft.getByLabel("Prompt", { exact: true }).fill(prompt)
  const before = new Set((await todos()).map(each => each.n))
  await draft.getByRole("button", { name: "Commit", exact: true }).click()
  let created: number | undefined
  await expect.poll(async () => (created = (await todos()).map(each => each.n).find(n => !before.has(n))), { timeout: 15_000 }).toBeDefined()
  return created!
}
const merge = async (n: number) => {
  await composer(`/merge T${n}`)
  const review = page.getByRole("region", { name: `Merge T${n} into main?`, exact: true }).last()
  await review.getByRole("button", { name: "Merge", exact: true }).click()
  await reaches(n, ["merged"], 3 * 60_000)
}
const showFlow = async () => {
  await composer("/flow todo")
  await expect(flowCard()).toBeVisible({ timeout: 15_000 })
}
/** The served catalog's todo flow (GET /api/flows), the model the Flow card renders. */
const todoFlow = async () => {
  const response = await context.request.get(`${APP}/api/flows`)
  expect(response.status(), "GET /api/flows").toBe(200)
  return (await response.json() as Array<{ name: string; versions: Array<{ id: string; state: string; todo?: number; steps: Array<{ id: string; label?: string }> }> }>).find(each => each.name === "todo")
}
const hasChangelog = (steps: ReadonlyArray<{ id: string; label?: string }>) => steps.some(step => /changelog/i.test(`${step.id} ${step.label ?? ""}`))
const lastAnswer = () => page.locator('[data-kind="answer"], .mvp-entry[data-kind="agent"], [data-role="assistant"]').last()

test("J5 Teach the factory", async ({ install, person, proofStep }) => {
  test.setTimeout(150 * 60_000)
  page = await person("maya")
  context = page.context()
  await test.step("setup: J1 setup through Machine ready", () => setUp(page, install))

  let flowTodo = 0, oldTodo = 0, newTodo = 0, mergedVersion = ""

  // j5#1: the rule in plain words; the app agent opens the TODO flow with the change proposed.
  await proofStep("j5-agent-proposes-flow-edit", async () => {
    await composer(RULE)
    // Proposing a flow edit needs Maya's press (mock: a Confirm card only she sees), then a Proposed version.
    const confirm = page.locator('[data-kind="confirm"]').filter({ hasText: /flow/i }).last()
    const proposed = flowCard().locator('.mvp-version[data-state="proposed"]')
    await expect(confirm.or(proposed)).toBeVisible({ timeout: 3 * 60_000 })
    if (await confirm.isVisible()) await confirm.locator("button[data-primary]").first().click()
    await expect(proposed).toBeVisible({ timeout: 60_000 })
    await proposed.click()
    await expect(flowCard().locator("li[data-added]").filter({ hasText: /changelog/i })).toBeVisible()
  })

  // j5#2: the edit as a diff of flows/todo/flow.ts, already a TODO working on its own branch.
  await proofStep("j5-flow-edit-diff-todo", async () => {
    const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
    // The documented door when the agent proposed nothing: Maya types /flow.edit herself (mvp.md Appendix A).
    if (!await draft.isVisible()) await composer(`/flow.edit todo ${RULE}`)
    await expect(draft).toBeVisible({ timeout: 60_000 })
    await expect(draft.locator(':is(pre, code, [data-diff], .mvp-diff)').filter({ hasText: /changelog/i }).first(), "the Draft quotes the diff").toBeVisible()
    flowTodo = await commitDraft()
    await reaches(flowTodo, ["working", "needs_you", "in_review"], 10 * 60_000)
    expect((await served(flowTodo)).branch?.name, "its own branch").toBeTruthy()
    await composer(`/todo T${flowTodo}`)
    await expect(todoCard(flowTodo)).toBeVisible({ timeout: 15_000 })
  })

  // A TODO that starts before the flow edit merges (the mock's Alice T10; Maya places it, the install has one person).
  await test.step("context: a TODO started before the merge", async () => {
    await composer("/todo.new")
    oldTodo = await commitDraft("Greet in JOURNEY.md", "Add a one-line greeting to JOURNEY.md")
    await reaches(oldTodo, ["starting", "working", "needs_you", "in_review"], 10 * 60_000)
  }).catch(() => undefined)

  // j5#3: it runs on the current flow and opens a PR; its checks pass and the edited flow loads.
  await proofStep("j5-flow-edit-pr", async () => {
    const todo = await reaches(flowTodo, ["in_review"], 25 * 60_000)
    await composer(`/todo T${flowTodo}`)
    await expect(todoCard(flowTodo).locator('a[href*="/pull/"]').first()).toBeVisible({ timeout: 15_000 })
    const checks = todoCard(flowTodo).locator(".todo-check[data-check]")
    await expect(checks.first(), "the TODO's checks").toBeVisible()
    for (const state of await checks.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-check"))))
      expect(state, "every check passed").toMatch(/^(pass|passed|ok|done|success)$/)
    expect(JSON.stringify(todo.evidence ?? []), "the evidence names the edited flow").toMatch(/flows\/todo\/flow\.ts/)
  }, { needs: ["j5-flow-edit-diff-todo"] })

  // j5#4: she merges; until the install loads it the Flow card reads Merged · active after sync.
  await proofStep("j5-flow-merged-syncing", async () => {
    await merge(flowTodo)
    await showFlow()
    const version = flowCard().locator('.mvp-version:is([data-state="merged-syncing"], [data-state="active"])').last()
    await expect(version).toBeVisible({ timeout: 60_000 })
    const served = await todoFlow()
    const merged = served?.versions.find(each => each.todo === flowTodo)
    expect(merged?.state, `the version T${flowTodo} proposed`).toMatch(/^(merged-syncing|active)$/)
    mergedVersion = merged!.id
  }, { needs: ["j5-flow-edit-pr"] })

  // j5#5: she asks which TODOs stay on the old version; the one that started before the merge keeps its steps.
  await proofStep("j5-old-todo-keeps-version", async () => {
    expect(oldTodo, "a TODO started before the merge").toBeGreaterThan(0)
    await composer(WHICH)
    await expect(lastAnswer()).toContainText(`T${oldTodo}`, { timeout: 2 * 60_000 })
    expect(hasChangelog((await served(oldTodo)).steps ?? []), `T${oldTodo} has no Changelog step`).toBe(false)
  }, { needs: ["j5-flow-merged-syncing"] })

  // j5#6: the install syncs the merge and loads the new flow; the timeline reports it active.
  await proofStep("j5-flow-load-active", async () => {
    await expect.poll(async () => (await todoFlow())?.versions.find(each => each.id === mergedVersion)?.state, { timeout: 5 * 60_000, intervals: [2_000] }).toBe("active")
    await expect(page.locator("li[data-entry], [role=status], .toast").filter({ hasText: /flow.*active|active.*flow/i }).first(), "the timeline reports the new flow active").toBeVisible({ timeout: 30_000 })
  }, { needs: ["j5-flow-merged-syncing"] })

  // j5#7: she opens it; the merged version is Active, with its Changelog step.
  await proofStep("j5-flow-card-active-version", async () => {
    await showFlow()
    const active = flowCard().locator('.mvp-version[data-state="active"]')
    await expect(active).toHaveCount(1)
    await expect(active).toHaveAttribute("data-version", mergedVersion)
    await active.click()
    await expect(flowCard()).toContainText(/changelog/i)
    await expect(flowCard().locator('.mvp-version[data-state="previous"]').first()).toBeVisible()
  }, { needs: ["j5-flow-load-active"] })

  // j5#8: she adds a TODO; it starts on the new version, so its steps include Changelog.
  await proofStep("j5-new-todo-new-version", async () => {
    await composer("/todo.new")
    newTodo = await commitDraft("Note the greeting in README.md", "Add a sentence to README.md saying JOURNEY.md holds a greeting")
    await reaches(newTodo, ["starting", "working", "needs_you", "in_review"], 10 * 60_000)
    await composer(`/todo T${newTodo}`)
    await expect(todoCard(newTodo).getByRole("list", { name: "Flow steps" })).toContainText(/changelog/i, { timeout: 30_000 })
  }, { needs: ["j5-flow-load-active"] })

  // j5#9: minutes later it reaches Changelog; the older TODO merged on the version it started with.
  await proofStep("j5-todo-reaches-new-step", async () => {
    const steps = todoCard(newTodo).getByRole("list", { name: "Flow steps" })
    await expect(steps.locator('li[data-phase="current"]').filter({ hasText: /changelog/i }).or(steps.locator('li[data-phase="done"]').filter({ hasText: /changelog/i }))).toBeVisible({ timeout: 25 * 60_000 })
    if (oldTodo > 0) {
      await reaches(oldTodo, ["in_review", "merged"], 20 * 60_000)
      if ((await served(oldTodo)).state !== "merged") await merge(oldTodo)
      expect(hasChangelog((await served(oldTodo)).steps ?? []), `T${oldTodo} merged without Changelog`).toBe(false)
    }
  }, { needs: ["j5-new-todo-new-version"] })

  // j5#10: it merges too, and the learning run after it suggests a change to the flow.
  await proofStep("j5-learning-suggests-flow-change", async () => {
    await reaches(newTodo, ["in_review"], 25 * 60_000)
    await merge(newTodo)
    await expect(page.locator('[data-kind="run"]').filter({ hasText: /learning/i }).or(page.getByText(/Learning from/)).first(), "a learning run after the merge").toBeVisible({ timeout: 5 * 60_000 })
    await expect(page.locator('[data-kind="proposal"]').last(), "the learning run's suggestion").toBeVisible({ timeout: 10 * 60_000 })
  }, { needs: ["j5-todo-reaches-new-step"] })

  // j5#11: the suggestion carries its evidence.
  await proofStep("j5-suggestion-evidence", async () => {
    await expect(page.locator('[data-kind="proposal"]').last()).toContainText(/\d+ of the last \d+ TODOs/)
  }, { needs: ["j5-learning-suggests-flow-change"] })

  let lintTodo = 0
  // j5#12: she makes it a TODO; a person has to merge it.
  await proofStep("j5-suggestion-to-todo", async () => {
    const before = new Set((await todos()).map(each => each.n))
    await page.locator('[data-kind="proposal"]').last().getByRole("button", { name: /TODO/ }).first().click()
    if (await page.getByRole("region", { name: "Draft", exact: true }).last().isVisible()) lintTodo = await commitDraft()
    else await expect.poll(async () => (lintTodo = (await todos()).map(each => each.n).find(n => !before.has(n)) ?? 0), { timeout: 30_000 }).toBeGreaterThan(0)
    await expect(page.locator('[data-kind="proposal"]').last()).toContainText(`T${lintTodo}`)
  }, { needs: ["j5-suggestion-evidence"] })

  // j5#13: it opens a PR with its evidence.
  await proofStep("j5-suggestion-pr-evidence", async () => {
    await reaches(lintTodo, ["in_review"], 25 * 60_000)
    await composer(`/todo T${lintTodo}`)
    await expect(todoCard(lintTodo).locator('a[href*="/pull/"]').first()).toBeVisible()
    await expect(todoCard(lintTodo).getByRole("region", { name: /^Attempt \d+ evidence$/ }).last()).toBeVisible()
  }, { needs: ["j5-suggestion-to-todo"] })

  // j5#14: she merges it.
  await proofStep("j5-suggestion-merge", async () => { await merge(lintTodo) }, { needs: ["j5-suggestion-pr-evidence"] })

  let nextTodo = 0
  // j5#15: once it loads, Verify runs lint for every new TODO; her next TODO opens a PR.
  await proofStep("j5-verify-runs-lint", async () => {
    await expect.poll(async () => (await todoFlow())?.versions.find(each => each.todo === lintTodo)?.state, { timeout: 5 * 60_000 }).toBe("active")
    await composer("/todo.new")
    nextTodo = await commitDraft("Log refunds in README.md", "Add a Refunds section to README.md")
    await reaches(nextTodo, ["in_review"], 25 * 60_000)
    expect(JSON.stringify((await served(nextTodo)).evidence ?? []), "lint ran at Verify").toMatch(/lint/i)
  }, { needs: ["j5-suggestion-merge"] })

  // j5#16: lint passed at Verify on the first run, so Review had nothing to send back.
  await proofStep("j5-lint-first-pass", async () => {
    const todo = await served(nextTodo)
    expect(todo.evidence?.length, "one attempt").toBe(1)
    expect(JSON.stringify(todo.evidence), "review sent nothing back").not.toMatch(/request-changes/)
  }, { needs: ["j5-verify-runs-lint"] })

})
