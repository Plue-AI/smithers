import { APP, expect, say, setUp, test } from "./fixtures"
import type { Locator, Page } from "@playwright/test"

/*
 * J8 Memory (mvp.md J8; mock steps j8#1 to j8#12) on the real bundle, the GitHub fake and real models.
 * Maya owns the install; Alice writes to the repository on GitHub and Maya adds her as a Member. Setup,
 * Alice's membership and T1 reaching review are the journey's starting state (mock: "T9 is green and next
 * to merge"), done through the UI in the "start" step. Then one proofStep per feature in mock-step order:
 * j8-learning-after-merge (j8#1, #4, #5), j8-wiki-pages (j8#5), j8-wiki-co-edit (j8#6-#8) and
 * j8-plan-cites-wiki-revision (j8#11-#13). The machine queue (j8#2, #3, #9) and opening a branch (j8#10) are
 * J1, J3 and J4 features; here they are only the way to T2's plan.
 */
type Served = { n: number; state: string; title: string; failure?: unknown }
/** The server's TODO, read as the person's browser reads it (never written through the API). */
const served = async (page: Page, n: number): Promise<Served> => {
  const response = await page.request.get(`${APP}/api/todos/${n}`)
  expect(response.status()).toBe(200)
  return response.json()
}
const waitState = async (page: Page, n: number, states: RegExp, timeout: number) => {
  const began = Date.now()
  for (let todo = await served(page, n); !states.test(todo.state); todo = await served(page, n)) {
    if (/^(failed|dropped)$/.test(todo.state) || Date.now() - began > timeout)
      throw new Error(`T${n} ${JSON.stringify({ state: todo.state, failure: todo.failure })} after ${Math.round((Date.now() - began) / 1000)} s; expected ${states}`)
    await page.waitForTimeout(2_000)
  }
}
const todoCard = (page: Page, n: number) => page.getByRole("article", { name: `TODO T${n}`, exact: true }).last()
const commitTodo = async (page: Page, title: string, prompt: string) => {
  await say(page, "/todo.new")
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  await draft.getByLabel("Title", { exact: true }).fill(title)
  await draft.getByLabel("Prompt", { exact: true }).fill(prompt)
  await draft.getByRole("combobox", { name: "Place", exact: true }).selectOption({ label: "Append" })
  await draft.getByRole("button", { name: "Commit", exact: true }).click()
  let n = 0
  await expect.poll(async () => {
    const body = await (await page.request.get(`${APP}/api/todos`)).json() as Served[] | { todos: Served[] }
    n = (Array.isArray(body) ? body : body.todos).find(todo => todo.title === title)?.n ?? 0
    return n
  }, { timeout: 15_000 }).toBeGreaterThan(0)
  return n
}
/** A wiki page card on a person's screen: the card whose source line names the page revision. */
const wikiCard = (page: Page) => page.locator(".world-card-doc").filter({ hasText: /Page revision \d+/ }).last()
const revisionOf = async (card: Locator) => Number(/Page revision (\d+)/.exec(await card.innerText())?.[1] ?? 0)
const editor = (page: Page) => page.getByLabel(/^Edit /).last()

/* What T1 decides and what the co-edit changes: the decision's cap and its reason (mock j8.ts). */
const T1 = {
  title: "Retry failed webhook deliveries",
  prompt: "Add webhook.mjs exporting deliver(send, event): call send(event); when it throws, retry with exponential backoff " +
    "between attempts, backoff(attempt) = 100 ms * 2 ** attempt, and give up after at most 5 attempts in total. Add a node:test test."
}
const T2 = { title: "Retry failed Slack notifications", prompt: "Add slack.mjs exporting notify(post, message). Slack notifications are lost when Slack is down: retry them the way we retry webhooks." }
const CAP = "At most 8 attempts."
const REASON = "Why: endpoints go down for hours; Stripe retries for 3 days."
const DECISION = "Retry failed deliveries with backoff(attempt), at most 5 attempts.\nWhy: a fixed 30 s wait timed out the retry test.\n"

test("J8 Memory", async ({ install, person, proofStep }) => {
  test.setTimeout(150 * 60_000)
  const maya = await person("maya")
  let alice!: Page, todo2 = 0, revision = 0

  const ready = await proofStep("start", async () => {
    await setUp(maya, install)
    await say(maya, "/members")
    const members = maya.getByRole("region", { name: "Members", exact: true }).last()
    await members.getByLabel("GitHub username", { exact: true }).fill("alice")
    await members.getByRole("button", { name: "Add", exact: true }).click()
    await expect(members.locator('li[data-login="alice"]')).toContainText("Member")
    alice = await person("alice")
    expect(await commitTodo(maya, T1.title, T1.prompt)).toBe(1)
    await waitState(maya, 1, /^in_review$/, 30 * 60_000)
    await say(maya, "/todo T1")
    await expect(todoCard(maya, 1)).toBeVisible()
  }, { page: maya })
  const start = ready ? [] : ["start"]

  // j8#1, #4, #5: Maya merges; a learning run starts, writes a page with the decision, why and a link to the PR, and
  // T1's card counts 1 lesson.
  const learned = await proofStep("j8-learning-after-merge", async () => {
    await say(maya, "/merge T1")
    await maya.getByRole("region", { name: "Merge T1 into main?", exact: true }).last().getByRole("button", { name: "Merge", exact: true }).click()
    await waitState(maya, 1, /^merged$/, 3 * 60_000)
    await expect(maya.getByText(/Learning from (#\d+|T1)/).first(), "a learning run shows after the merge").toBeVisible({ timeout: 60_000 })
    await say(maya, "/todo T1")
    await expect(todoCard(maya, 1).getByText(/^1 lesson$/)).toBeVisible({ timeout: 10 * 60_000 })
    await todoCard(maya, 1).getByText(/^1 lesson$/).click()
    const card = wikiCard(maya)
    await expect(card).toContainText(/at most 5 attempts/i, { timeout: 15_000 })
    await expect(card).toContainText(/Why/)
    await expect(card.locator('a[href*="/pull/1"]').first()).toBeVisible()
  }, { page: maya, needs: start })

  // j8#5: the page opens in main's conversation for both people. Without a learned page, Maya opens it by name with
  // /wiki.page (mvp.md Appendix A: open or create) and writes the decision herself.
  const opened = await proofStep("j8-wiki-pages", async () => {
    if (!learned) {
      await say(maya, "/wiki.page Webhook retries")
      await expect(wikiCard(maya), "/wiki.page opens a page of the repository's wiki").toBeVisible({ timeout: 30_000 })
      await maya.getByRole("button", { name: "Edit", exact: true }).last().click()
      await editor(maya).click()
      await maya.keyboard.type(DECISION)
      await expect.poll(() => revisionOf(wikiCard(maya)), { timeout: 60_000 }).toBeGreaterThan(0)
    }
    // main's conversation is shared: Alice sees the same page card.
    await expect(wikiCard(alice)).toBeVisible({ timeout: 15_000 })
  }, { page: alice, needs: start })

  // j8#6-#8: Alice's name flag on Maya's screen; both type and see each other's characters; the page saves a new
  // revision by both with no Save press.
  await proofStep("j8-wiki-co-edit", async () => {
    if (!opened) {
      // Neither the lesson nor /wiki.page opened a page: Maya creates one in the repository's wiki so co-editing
      // is still proven on a real page.
      test.info().annotations.push({ type: "substitute", description: "j8-wiki-co-edit ran on a page Maya created with /wiki.cloud.new" })
      await say(maya, "/wiki.cloud.new Webhook retries")
      await expect(wikiCard(maya)).toBeVisible({ timeout: 30_000 })
      await maya.getByRole("button", { name: "Edit", exact: true }).last().click()
      await editor(maya).click()
      await maya.keyboard.type(DECISION)
      await expect.poll(() => revisionOf(wikiCard(maya)), { timeout: 60_000 }).toBeGreaterThan(0)
      await say(alice, "/wiki.cloud")
      await alice.getByText("Webhook retries").last().click()
      await expect(wikiCard(alice)).toBeVisible({ timeout: 15_000 })
    }
    const before = await revisionOf(wikiCard(maya))
    await alice.getByRole("button", { name: "Edit", exact: true }).last().click()
    await editor(alice).click()
    await expect(wikiCard(maya).locator("..").getByText(/alice/i).first(), "Alice's name flag on Maya's screen").toBeVisible({ timeout: 15_000 })
    await maya.getByRole("button", { name: "Edit", exact: true }).last().click()
    await editor(maya).click()
    await alice.keyboard.press("ControlOrMeta+End")
    await maya.keyboard.press("ControlOrMeta+End")
    await Promise.all([alice.keyboard.type(`\n${CAP}`, { delay: 40 }), maya.keyboard.type(`\n${REASON}`, { delay: 40 })])
    await expect(editor(maya), "Alice's characters arrive on Maya's screen").toContainText(CAP, { timeout: 15_000 })
    await expect(editor(alice), "Maya's characters arrive on Alice's screen").toContainText(REASON, { timeout: 15_000 })
    // Nobody presses Save.
    await expect.poll(() => revisionOf(wikiCard(maya)), { timeout: 60_000 }).toBeGreaterThan(before)
    revision = await revisionOf(wikiCard(maya))
    await maya.getByTestId("wiki-card-history").last().click()
    const history = maya.getByTestId("wiki-history").last()
    await expect(history.getByTestId(`wiki-revision-${revision}`)).toBeVisible({ timeout: 15_000 })
    const authors = (await history.locator('[data-testid^="wiki-revision-"]').allInnerTexts()).join("\n")
    expect(authors, "the saved revisions name both editors").toMatch(/alice/)
    expect(authors).toMatch(new RegExp(install.owner))
  }, { page: maya, needs: start })

  // j8#11-#13: Alice's TODO starts after the edit; its preflight Context lists the page at the saved revision, the
  // plan cites it and follows the new cap, and Maya's page records the citation.
  await proofStep("j8-plan-cites-wiki-revision", async () => {
    expect(revision, "a saved co-edited revision to cite").toBeGreaterThan(0)
    todo2 = await commitTodo(alice, T2.title, T2.prompt)
    await waitState(alice, todo2, /^(starting|working|needs_you|in_review)$/, 10 * 60_000)
    await say(alice, `/todo T${todo2}`)
    const card = todoCard(alice, todo2)
    await card.getByRole("button", { name: /^smithers\// }).or(card.getByRole("link", { name: /^smithers\// })).first().click()
    await alice.getByRole("button", { name: /Context/ }).last().click()
    await expect(alice.getByText(new RegExp(`Webhook retries.*r${revision}\\b`)).last(), "Context lists the saved revision").toBeVisible({ timeout: 5 * 60_000 })
    await expect(alice.getByText(new RegExp(`Planned:.*r${revision}\\b`)).last(), "the plan cites the revision").toBeVisible({ timeout: 10 * 60_000 })
    await expect(alice.getByText(/at most 8 attempts/i).last(), "the plan follows the edited cap").toBeVisible()
    await expect(wikiCard(maya).locator("..").getByText(new RegExp(`T${todo2}.*r${revision}\\b`)).first(), "the page records the citation").toBeVisible({ timeout: 60_000 })
  }, { page: alice, needs: start })
})
