import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { githubRoute } from "../local/github-route"

/*
 * J8 Memory (mvp.md J8; mock steps j8#1 to j8#12) on the real bundle, the GitHub fake and real models.
 * Maya is the install owner (the fake's local-owner), Alice a Member. Setup, the members and T1 reaching
 * review are the journey's starting state (mock: "T9 is green and next to merge"); each is done through the
 * UI before the first feature step. Every feature is one proofStep in mock-step order. A failed step is
 * recorded with its screenshot and the test goes on; a step that needs a failed one records "blocked by".
 * The person, proofStep and boot helpers are local until apps/app/e2e/proof/fixtures.ts lands.
 */
const app = "http://localhost:4000"
const output = "test-results/proof"
type Who = "maya" | "alice"
type Run = { setupURL: string; fakeURL: string; home: string; revision: string; keys: Record<string, string> }
let run: Run
const pages = new Map<Who, Page>()
const failed = new Map<string, string>()

/** One feature's proof: a step named by the feature id, with each person's screen attached under that id. */
async function proofStep(featureId: string, fn: () => Promise<void>, after: ReadonlyArray<string> = []): Promise<boolean> {
  try {
    await test.step(featureId, async () => {
      try {
        const blocker = after.find(id => failed.has(id))
        if (blocker) throw new Error(`blocked by ${blocker}`)
        await fn()
      } finally {
        for (const [who, page] of pages) {
          const body = await page.screenshot().catch(() => undefined)
          if (body) await test.info().attach(who === "maya" ? featureId : `${featureId}-${who}`, { body, contentType: "image/png" })
        }
      }
    })
    return true
  } catch (error) {
    failed.set(featureId, String(error).split("\n")[0]!)
    return false
  }
}

const browse = async (browser: Browser): Promise<BrowserContext> => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await githubRoute(context, run.fakeURL)
  await context.route(/^https?:\/\//, async route => {
    const url = route.request().url()
    if ([app, "http://127.0.0.1:4000", run.fakeURL].includes(new URL(url).origin)) return route.continue()
    if (/^https:\/\/github\.com\/[a-z\d-]+\.png$/i.test(url)) return route.fulfill({ status: 404 })
    return route.fallback()
  })
  return context
}
/** Alice opens the install's address and signs in with GitHub (the fake) as alice. */
const signIn = async (browser: Browser, who: Who) => {
  const page = await (await browse(browser)).newPage()
  await page.goto(`${app}/api/auth/github`)
  await page.getByRole("link", { name: who === "maya" ? "Authorize" : `Authorize as ${who}`, exact: true }).click()
  await page.waitForURL(url => url.origin === app && !url.pathname.startsWith("/api/"))
  await expect(page.getByTestId("composer-input")).toBeAttached({ timeout: 15_000 })
  pages.set(who, page)
  return page
}
const say = async (page: Page, text: string) => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await input.fill(text)
  await input.press("Enter")
}
const fake = async (path: string, body: unknown) => {
  const response = await fetch(`${run.fakeURL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  expect(response.status, path).toBeLessThan(300)
}
type Served = { n: number; state: string; title: string; lessons?: number; pr?: { number: number; head: string }; failure?: unknown }
/** The server's TODO, read as the person reads it (never written through the API). */
const served = async (page: Page, n: number): Promise<Served> => {
  const response = await page.request.get(`${app}/api/todos/${n}`)
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
    const body = await (await page.request.get(`${app}/api/todos`)).json() as Served[] | { todos: Served[] }
    n = (Array.isArray(body) ? body : body.todos).find(todo => todo.title === title)?.n ?? 0
    return n
  }, { timeout: 15_000 }).toBeGreaterThan(0)
  return n
}
/** The wiki page card on a person's screen: the card that holds the page's revision line. */
const wikiCard = (page: Page) => page.locator(".world-card-doc").filter({ hasText: /Page revision \d+/ }).last()
const revisionOf = async (card: Locator) => Number(/Page revision (\d+)/.exec(await card.innerText())?.[1] ?? 0)

/* What T1 decides and what the co-edit changes: the decision's cap and its reason (mock j8.ts). */
const T1 = {
  title: "Retry failed webhook deliveries",
  prompt: "In webhook.mjs, retry a failed delivery: call send again with exponential backoff between attempts, " +
    "backoff(attempt) = 100 ms * 2 ** attempt, and give up after at most 5 attempts in total. Add a node:test test for it."
}
const T2 = { title: "Retry failed Slack notifications", prompt: "Slack notifications in slack.mjs are lost when Slack is down. Retry them the way we retry webhooks." }
const CAP = "At most 8 attempts."
const REASON = "Why: endpoints go down for hours; Stripe retries for 3 days."

test("J8 Memory", async ({ browser }) => {
  test.setTimeout(120 * 60_000)
  await expect.poll(() => { try { run = JSON.parse(readFileSync(`${output}/j8-run.json`, "utf8")); return true } catch { return false } }, { timeout: 60_000 }).toBe(true)
  test.info().annotations.push({ type: "bundle", description: run.revision })
  let maya!: Page, alice!: Page, todo2 = 0

  // The starting state, through the UI: setup on real models, Alice a Member, and T1 in review (mock: T9 next to merge).
  const ready = await proofStep("start", async () => {
    const context = await browse(browser)
    maya = await context.newPage()
    await maya.goto(run.setupURL)
    const card = () => maya.locator('[aria-label="Set up Smithers"]').first()
    const click = (name: string) => card().getByRole("button", { name, exact: true }).first().click()
    // A step's work runs in the background; the install's own answer says when it is done.
    const done = async (id: string, timeout: number) => {
      await expect.poll(async () => {
        const steps = (await (await maya.request.get(`${app}/api/install`)).json()).steps as { id: string; state: string; error?: unknown }[]
        const step = steps.find(each => each.id === id)
        if (step?.state === "failed") throw new Error(`setup ${id} failed: ${JSON.stringify(step.error)}`)
        return step?.state
      }, { timeout, intervals: [1_000, 2_000] }).toBe("done")
    }
    await click("This Mac only"); await done("address", 10_000)
    await card().getByLabel("Owner", { exact: true }).last().fill("local-owner")
    await click("Create GitHub App")
    await maya.getByRole("link", { name: "Create GitHub App", exact: true }).click(); await done("app_manifest", 15_000)
    await click("Sign in")
    await maya.getByRole("link", { name: "Authorize", exact: true }).click(); await done("sign_in", 15_000)
    pages.set("maya", maya)
    await card().getByLabel("Repository", { exact: true }).last().selectOption({ label: "local-owner/demo" })
    await click("Repository"); await done("repository", 15_000)
    const models = card().locator('[data-step="models"]')
    const role = (label: string) => models.locator(".setup-model").filter({ has: maya.getByText(label, { exact: true }) })
    const fast = role("Fast model"), coding = role("Coding model"), decisions = role("Decisions")
    await fast.getByLabel("Cerebras key", { exact: true }).fill(run.keys.CEREBRAS_API_KEY!)
    await fast.getByRole("button", { name: "Save", exact: true }).click()
    await expect(fast).toHaveAttribute("data-state", "saved", { timeout: 30_000 })
    await coding.getByLabel("Provider", { exact: true }).selectOption({ label: "AI Gateway" })
    await coding.getByLabel("Model", { exact: true }).fill("anthropic/claude-sonnet-4.5")
    await coding.getByLabel("API key", { exact: true }).fill(run.keys.AI_GATEWAY_API_KEY!)
    await coding.getByRole("button", { name: "Save", exact: true }).click()
    await expect(coding).toHaveAttribute("data-state", "saved", { timeout: 30_000 })
    await decisions.getByLabel("AI Gateway key", { exact: true }).fill(run.keys.AI_GATEWAY_API_KEY!)
    await decisions.getByRole("button", { name: "Save", exact: true }).click()
    await expect(decisions).toHaveAttribute("data-state", "saved", { timeout: 30_000 })
    await click("Model access"); await done("models", 60_000)
    await click("Mirror"); await done("source", 3 * 60_000)
    await click("Build image"); await done("machine", 20 * 60_000)
    // GitHub (the fake, an outside actor): Alice can write to the repository. Maya adds her on the Members card.
    await fake("/_fake/collaborators", { id: 202, login: "alice", permission: "write" })
    await say(maya, "/members")
    const members = maya.getByRole("region", { name: "Members", exact: true }).last()
    await members.getByLabel("GitHub username", { exact: true }).fill("alice")
    await members.getByRole("button", { name: "Add", exact: true }).click()
    await expect(members.locator('li[data-login="alice"]')).toContainText("Member")
    alice = await signIn(browser, "alice")
    expect(await commitTodo(maya, T1.title, T1.prompt)).toBe(1)
    await waitState(maya, 1, /^in_review$/, 30 * 60_000)
    await say(maya, "/todo T1")
    await expect(todoCard(maya, 1)).toBeVisible()
  })
  const start = ready ? [] : ["start"]

  await proofStep("j8-merge-starts-learning", async () => {
    await say(maya, "/merge T1")
    const review = maya.getByRole("region", { name: "Merge T1 into main?", exact: true }).last()
    await review.getByRole("button", { name: "Merge", exact: true }).click()
    await waitState(maya, 1, /^merged$/, 3 * 60_000)
    // A learning run starts in the background: Maya sees it without opening anything.
    await expect(maya.getByText(/Learning from (#\d+|T1)/).first()).toBeVisible({ timeout: 60_000 })
  }, start)

  await proofStep("j8-learning-writes-lesson", async () => {
    await say(maya, "/todo T1")
    await expect(todoCard(maya, 1).getByText(/^1 lesson$/)).toBeVisible({ timeout: 10 * 60_000 })
    await say(maya, "/wiki.cloud")
    await expect(maya.getByText(/Page revision 1\b/).last()).toBeVisible({ timeout: 30_000 })
  }, ["j8-merge-starts-learning"])

  await proofStep("j8-lesson-opens-page", async () => {
    await todoCard(maya, 1).getByText(/^1 lesson$/).click()
    await expect(wikiCard(maya)).toBeVisible({ timeout: 15_000 })
    // main's conversation is shared: Alice sees the same page card arrive.
    await expect(wikiCard(alice)).toBeVisible({ timeout: 15_000 })
  }, ["j8-learning-writes-lesson"])

  await proofStep("j8-learned-decision-links-change", async () => {
    const card = wikiCard(maya)
    await expect(card).toContainText(/at most 5 attempts/i)
    await expect(card).toContainText(/Why/)
    await expect(card.locator('a[href*="/pull/1"]').first()).toBeVisible()
  }, ["j8-lesson-opens-page"])

  // Co-editing needs a page both people have open. Without the learned page, Maya writes the decision herself
  // through the UI, so presence, live typing and the saved revision are still proven (recorded on the step).
  let r0 = 0
  const pageOpen = async () => {
    if (!failed.has("j8-lesson-opens-page")) return
    test.info().annotations.push({ type: "substitute", description: "No learned page: Maya created Webhook retries with /wiki.cloud.new" })
    await say(maya, "/wiki.cloud.new Webhook retries")
    await expect(wikiCard(maya)).toBeVisible({ timeout: 30_000 })
    await wikiCard(maya).locator("..").getByRole("button", { name: "Edit", exact: true }).click()
    const editor = maya.getByLabel(/^Edit /).last()
    await editor.click()
    await maya.keyboard.type("Retry failed deliveries with backoff(attempt), at most 5 attempts.\nWhy: a fixed 30 s wait timed out the retry test.\n")
    await expect.poll(() => revisionOf(wikiCard(maya)), { timeout: 60_000 }).toBeGreaterThan(0)
    await say(alice, "/wiki.cloud")
    await alice.getByText("Webhook retries").last().click()
  }

  await proofStep("j8-wiki-presence", async () => {
    await pageOpen()
    r0 = await revisionOf(wikiCard(maya))
    await wikiCard(alice).locator("..").getByRole("button", { name: "Edit", exact: true }).click()
    await alice.getByLabel(/^Edit /).last().click()
    // Alice's name flag appears on Maya's screen, on the page she is in.
    await expect(wikiCard(maya).locator("..").getByText(/alice/i).first()).toBeVisible({ timeout: 15_000 })
  }, start)

  await proofStep("j8-wiki-live-coedit", async () => {
    await maya.getByRole("button", { name: "Edit", exact: true }).last().click()
    await maya.getByLabel(/^Edit /).last().click()
    await alice.keyboard.press("Control+End")
    await maya.keyboard.press("Control+End")
    await Promise.all([alice.keyboard.type(`\n${CAP}`, { delay: 40 }), maya.keyboard.type(`\n${REASON}`, { delay: 40 })])
    // Each sees the other's characters arrive, without a reload.
    await expect(maya.getByLabel(/^Edit /).last()).toContainText(CAP, { timeout: 15_000 })
    await expect(alice.getByLabel(/^Edit /).last()).toContainText(REASON, { timeout: 15_000 })
  }, ["j8-wiki-presence"])

  let revision = 0
  await proofStep("j8-wiki-autosave-revision", async () => {
    // Nobody presses Save: the page saves a new revision once typing stops, carrying both edits by both people.
    await expect.poll(() => revisionOf(wikiCard(maya)), { timeout: 60_000 }).toBeGreaterThan(r0)
    revision = await revisionOf(wikiCard(maya))
    await wikiCard(maya).locator("..").getByTestId("wiki-card-history").click()
    const history = maya.getByTestId("wiki-history").last()
    await expect(history.getByTestId(`wiki-revision-${revision}`)).toBeVisible({ timeout: 15_000 })
    const authors = (await history.locator('[data-testid^="wiki-revision-"]').allInnerTexts()).join("\n")
    expect(authors).toMatch(/alice/)
    expect(authors).toMatch(/local-owner/)
  }, ["j8-wiki-live-coedit"])

  await proofStep("j8-queued-todo-takes-machine", async () => {
    // T1 merged and released its machine; Alice's TODO takes it and starts.
    todo2 = await commitTodo(alice, T2.title, T2.prompt)
    await waitState(alice, todo2, /^(starting|working)$/, 10 * 60_000)
  }, start)

  await proofStep("j8-branch-at-plan", async () => {
    await say(alice, `/todo T${todo2}`)
    const card = todoCard(alice, todo2)
    await card.getByRole("button", { name: /^smithers\// }).or(card.getByRole("link", { name: /^smithers\// })).first().click()
    await expect(alice.getByText(/\bPlan\b/).last()).toBeVisible({ timeout: 5 * 60_000 })
  }, ["j8-queued-todo-takes-machine"])

  await proofStep("j8-preflight-context-cites-revision", async () => {
    await alice.getByRole("button", { name: /Context/ }).last().click()
    await expect(alice.getByText(new RegExp(`Webhook retries.*r${revision}\\b`)).last()).toBeVisible({ timeout: 5 * 60_000 })
  }, ["j8-branch-at-plan", "j8-wiki-autosave-revision"])

  await proofStep("j8-plan-follows-revision", async () => {
    await expect(alice.getByText(new RegExp(`Planned:.*r${revision}\\b`)).last()).toBeVisible({ timeout: 10 * 60_000 })
    await expect(alice.getByText(/at most 8 attempts/i).last()).toBeVisible()
  }, ["j8-preflight-context-cites-revision"])

  await proofStep("j8-wiki-records-citation", async () => {
    await expect(wikiCard(maya).locator("..").getByText(new RegExp(`T${todo2}.*r${revision}\\b`)).first()).toBeVisible({ timeout: 60_000 })
  }, ["j8-plan-follows-revision"])

  expect([...failed].map(([id, why]) => `${id}: ${why}`)).toEqual([])
})
