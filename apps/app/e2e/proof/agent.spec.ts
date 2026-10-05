import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { githubRoute } from "../local/github-route"
import { bootInstall, type Install } from "./agent-boot"

/*
 * The coding agent at work (.specs/product/mvp.md Appendix B.3; mock reel `agent`, agent#1..agent#12). One test, one
 * proofStep per feature in mock-step order, on the real bundle with the GitHub fake and real models. The owner sets
 * up the install and adds Ben; Ben writes T1 and follows its coding agent from T1's branch: the branch tree, the
 * branch conversation, a review finding's Please fix as his steer, the agent's Context, Read, edit and terminal
 * lines, its question and his answer in the branch input, then a plain-words drop of T2 confirmed with ⏎.
 * Prerequisites (setup, Ben, the TODOs) belong to J1; a failed prerequisite records every step that needs it as
 * `blocked by setup: <name>`. Outside actors (the GitHub collaborators) act on the GitHub fake.
 */

const APP = "http://localhost:4000"
const TITLE = "Greet readers in JOURNEY.md"
// The prompt asks for the B.3 rhythm after a steer (fix, run the tests, ask once), so the question comes from a real
// model in its own words; nothing is scripted.
const PROMPT = [
  "Add one greeting line to the end of JOURNEY.md and a test in journey.test.mjs that checks the line is there.",
  "Whenever someone steers you, make the change they asked for, run the repository's tests, and then ask that person",
  "one short question about the change before you open or update the pull request; wait for the answer."
].join(" ")
const STEER_FALLBACK = "Please fix JOURNEY.md: end the greeting line with an exclamation mark."
const ANSWER = "Yes, keep it to one line."
const DROP_TITLE = "Log every retry"
/** The coding model on the AI Gateway key, as the real-GitHub walks bind it (m4-walk). */
const CODING_MODEL = "anthropic/claude-sonnet-4.5"
const SHOTS = "test-results/proof/agent"

let install: Install | undefined
let owner: Page, ben: Page
const contexts: BrowserContext[] = []
const failures: string[] = []
const passed = new Set<string>()

const shot = async (name: string) => {
  const page = ben ?? owner
  if (!page) return
  const body = await page.screenshot({ fullPage: true }).catch(() => undefined)
  if (!body) return
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(SHOTS, `${name}.png`), body)
  await test.info().attach(name, { body, contentType: "image/png" })
}
/** A J1 prerequisite: its failure blocks the steps that need it, never the whole run. */
const prerequisite = async (name: string, needs: string[], fn: () => Promise<void>) => {
  const blockedBy = needs.find(need => !passed.has(need))
  try {
    await test.step(`setup: ${name}`, async () => {
      if (blockedBy) throw new Error(`blocked by ${blockedBy}`)
      await fn()
    })
    passed.add(`setup: ${name}`)
  } catch (error) {
    failures.push(`setup: ${name}: ${String(error).split("\n")[0]}`)
    await shot(`setup-${name.replace(/\W+/g, "-")}`)
  }
}
/** One feature: a test.step named by its features.json id, with a screenshot named by the id, pass or fail. */
const proofStep = async (id: string, needs: string[], fn: () => Promise<void>) => {
  const blockedBy = needs.find(need => !passed.has(need))
  try {
    await test.step(id, async () => {
      try {
        if (blockedBy) throw new Error(`blocked by ${blockedBy}`)
        await fn()
      } finally { await shot(id) }
    })
    passed.add(id)
  } catch (error) { failures.push(`${id}: ${String(error).split("\n")[0]}`) }
}

const say = async (page: Page, text: string) => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await input.fill(text)
  await input.press("Enter")
}
const setupCard = () => owner.locator('[aria-label="Set up Smithers"]').first()
const setupClick = (name: string) => setupCard().getByRole("button", { name, exact: true }).first().click()
const readJSON = async (page: Page, path: string) => {
  const response = await page.request.get(`${APP}${path}`)
  expect(response.status(), path).toBe(200)
  return response.json()
}
const setupDone = async (id: string, timeout: number) => {
  const began = Date.now()
  for (;;) {
    const step = (await readJSON(owner, "/api/install")).steps.find((s: { id: string }) => s.id === id)
    if (step?.state === "done") return
    if (step?.state === "failed") throw new Error(`${id} failed: ${JSON.stringify(step.error)}`)
    if (Date.now() - began > timeout) throw new Error(`${id} still ${step?.state} after ${Math.round(timeout / 1000)} s`)
    await owner.waitForTimeout(1000)
  }
}
const fake = async (path: string, body: unknown) => {
  const response = await fetch(`${install!.fakeURL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  expect(response.status, path).toBeLessThan(300)
}
/** Opens the install's address in a fresh browser and signs in with GitHub (the fake) as login. */
const signIn = async (browser: Browser, login: "owner" | "ben") => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  contexts.push(context)
  await githubRoute(context, install!.fakeURL)
  const page = await context.newPage()
  await page.goto(`${APP}/api/auth/github`)
  await page.getByRole("link", { name: login === "owner" ? "Authorize" : `Authorize as ${login}`, exact: true }).click()
  await page.waitForURL(url => url.origin === APP && !url.pathname.startsWith("/api/"))
  await expect(page.getByTestId("composer-input")).toBeAttached({ timeout: 15_000 })
  return page
}

type Todo = { n: number; state: string; branch?: { name: string; machine?: { state: string } }; title: string }
const served = async (n: number): Promise<Todo> => readJSON(ben, `/api/todos/${n}`)
/** Waits for one of the served states; a failed or dropped TODO ends the wait. */
const reach = async (n: number, states: string[], timeout: number): Promise<Todo> => {
  const began = Date.now()
  for (let todo = await served(n); ; todo = await served(n)) {
    if (states.includes(todo.state)) return todo
    if (["failed", "dropped", "merged"].includes(todo.state) || Date.now() - began > timeout)
      throw new Error(`T${n} ${todo.state} after ${Math.round((Date.now() - began) / 1000)} s; expected ${states.join("|")}`)
    await ben.waitForTimeout(2000)
  }
}
const commit = async (page: Page, title: string, prompt: string) => {
  await say(page, "/todo.new")
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  await draft.getByLabel("Title", { exact: true }).fill(title)
  await draft.getByLabel("Prompt", { exact: true }).fill(prompt)
  await draft.getByRole("combobox", { name: "Place", exact: true }).selectOption({ label: "Append" })
  await draft.getByRole("button", { name: "Commit", exact: true }).click()
}
const todoCard = (n: number) => ben.getByRole("article", { name: `TODO T${n}`, exact: true }).last()
/** T1's branch card as Ben sees it: the conversation of T1's branch, never the design seed's branches. */
let branchName = ""
const branchCard = (): Locator => ben.locator('section[data-kind="branch"]').filter({ has: ben.getByRole("heading", { name: branchName, exact: true }) }).last()
const activity = (kind: string) => branchCard().locator(`ol.branch-activity > li[data-kind="${kind}"]`)
/** Opens T1's branch card the way a person can when the tree does not offer it: the TODO card's Open branch, then /branch. */
const openBranch = async () => {
  if (await branchCard().isVisible()) return
  await say(ben, "/todo T1")
  const open = todoCard(1).getByRole("button", { name: "Open branch", exact: true })
  if (await open.isVisible({ timeout: 5_000 }).catch(() => false)) await open.click()
  else await say(ben, `/branch ${branchName}`)
  await expect(branchCard()).toBeVisible({ timeout: 10_000 })
}

test("The coding agent at work", async ({ browser }) => {
  test.setTimeout(120 * 60_000)
  const keys = { cerebras: "", gateway: "" }
  try {
    await prerequisite("boot", [], async () => {
      install = await bootInstall()
      keys.cerebras = install.keys.CEREBRAS_API_KEY ?? ""
      keys.gateway = install.keys.AI_GATEWAY_API_KEY ?? ""
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
      contexts.push(context)
      await githubRoute(context, install.fakeURL)
      owner = await context.newPage()
      await owner.goto(install.setupURL)
      await expect(setupCard()).toBeVisible({ timeout: 30_000 })
    })

    // J1 setup, through the Setup card, on the GitHub fake.
    await prerequisite("install", ["setup: boot"], async () => {
      await setupClick("This Mac only")
      await setupDone("address", 10_000)
      await setupCard().getByLabel("Owner", { exact: true }).last().fill("local-owner")
      await setupClick("Create GitHub App")
      await owner.getByRole("link", { name: "Create GitHub App", exact: true }).click()
      await setupDone("app_manifest", 30_000)
      await setupClick("Sign in")
      await owner.getByRole("link", { name: "Authorize", exact: true }).click()
      await setupDone("sign_in", 30_000)
      await setupCard().getByLabel("Repository", { exact: true }).last().selectOption({ label: "local-owner/demo" })
      await setupClick("Repository")
      await setupDone("repository", 30_000)
      const models = setupCard().locator('[data-step="models"]')
      const role = (label: string) => models.locator(".setup-model").filter({ has: owner.getByText(label, { exact: true }) })
      const fast = role("Fast model"), coding = role("Coding model"), decisions = role("Decisions")
      await fast.getByLabel("Cerebras key", { exact: true }).fill(keys.cerebras)
      await fast.getByRole("button", { name: "Save", exact: true }).click()
      await expect(fast).toHaveAttribute("data-state", "saved", { timeout: 30_000 })
      await coding.getByLabel("Provider", { exact: true }).selectOption({ label: "AI Gateway" })
      await coding.getByLabel("Model", { exact: true }).fill(CODING_MODEL)
      await coding.getByLabel("API key", { exact: true }).fill(keys.gateway)
      await coding.getByRole("button", { name: "Save", exact: true }).click()
      await expect(coding).toHaveAttribute("data-state", "saved", { timeout: 30_000 })
      await decisions.getByLabel("AI Gateway key", { exact: true }).fill(keys.gateway)
      await decisions.getByRole("button", { name: "Save", exact: true }).click()
      await expect(decisions).toHaveAttribute("data-state", "saved", { timeout: 30_000 })
      await setupClick("Model access")
      await setupDone("models", 60_000)
      await setupClick("Mirror")
      await setupDone("source", 3 * 60_000)
      await setupClick("Build image")
      await setupDone("machine", 15 * 60_000)
    })

    // J1 8: the owner adds Ben (a Maintainer on GitHub) on the Members card; Ben signs in from his own browser.
    await prerequisite("Ben", ["setup: install"], async () => {
      await fake("/_fake/collaborators", { id: 201, login: "ben", permission: "maintain" })
      await say(owner, "/members")
      const members = owner.getByRole("region", { name: "Members", exact: true }).last()
      await members.getByLabel("GitHub username", { exact: true }).fill("ben")
      await members.getByRole("button", { name: "Add", exact: true }).click()
      await expect(members.locator('li[data-login="ben"]')).toBeVisible({ timeout: 10_000 })
      ben = await signIn(browser, "ben")
    })

    await prerequisite("TODO T1", ["setup: Ben"], async () => {
      await commit(ben, TITLE, PROMPT)
      await expect(todoCard(1)).toContainText(TITLE, { timeout: 15_000 })
      const todo = await reach(1, ["working", "needs_you", "in_review"], 10 * 60_000)
      expect(todo.branch?.name, "T1 serves its branch").toBeTruthy()
      branchName = todo.branch!.name
    })

    // agent#1: Ben is in main; the last crumb opens the branch tree, which lists T1's branch.
    await proofStep("agent-branch-tree", ["setup: TODO T1"], async () => {
      await ben.locator(".mvp-crumbs .mvp-crumb-here").first().click()
      const tree = ben.getByRole("navigation", { name: "Branches" }).last()
      await expect(tree.locator("button.mvp-tree-row").filter({ hasText: branchName })).toBeVisible({ timeout: 10_000 })
    })
    // agent#2: he picks T1's branch; he is in its conversation with the coding agent at work.
    await proofStep("agent-branch-conversation", ["setup: TODO T1"], async () => {
      const row = ben.getByRole("navigation", { name: "Branches" }).last().locator("button.mvp-tree-row").filter({ hasText: branchName })
      if (await row.isVisible()) await row.click()
      else await openBranch()
      await expect(branchCard()).toBeVisible({ timeout: 10_000 })
      const here = branchCard().getByRole("list", { name: "On this branch", exact: true })
      await expect(here.locator("li").filter({ has: ben.locator('[data-kind="person"]') }).filter({ hasText: /ben/i }).first()).toBeVisible({ timeout: 30_000 })
      await expect(here.locator('[data-kind="agent"]').first()).toBeVisible({ timeout: 60_000 })
    })

    // agent#3: the review posts findings; Ben presses Please fix on the first, and it becomes his steer in the branch
    // activity. The review runs once T1's coding run delivers.
    let steered = false
    await proofStep("agent-finding-steer", ["setup: TODO T1"], async () => {
      await reach(1, ["in_review", "needs_you"], 30 * 60_000)
      await say(ben, "/merge T1")
      const fix = ben.getByRole("button", { name: "Please fix", exact: true }).first()
      if (!await fix.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await say(ben, "/todo T1")
        await expect(fix, "a review finding offers Please fix").toBeVisible({ timeout: 10_000 })
      }
      await fix.click()
      steered = true
      await openBranch()
      await expect(activity("steer").filter({ hasText: "Please fix" }).last()).toBeVisible({ timeout: 30_000 })
    })
    // Without a finding to press, Ben steers T1 in plain words so the agent's next steps can still be recorded.
    await prerequisite("steer", ["setup: TODO T1"], async () => {
      if (!steered) await say(ben, `/todo.steer T1 ${STEER_FALLBACK}`)
      await reach(1, ["working", "needs_you"], 10 * 60_000)
    })

    // agent#4: the agent picks the steer up; its Context line counts what it recalled, its Read line names files.
    await proofStep("agent-context-read-lines", ["agent-branch-conversation", "setup: steer"], async () => {
      await openBranch()
      await expect(branchCard().locator(".mvp-context-toggle").last()).toContainText(/Context · \d+/, { timeout: 5 * 60_000 })
      await expect(activity("read").last().locator("code").first()).toBeVisible({ timeout: 60_000 })
    })
    // agent#5: Ben opens the Context line: what the agent recalled, item by item.
    await proofStep("agent-context-open", ["agent-context-read-lines"], async () => {
      const toggle = branchCard().locator(".mvp-context-toggle").last()
      await toggle.click()
      await expect(toggle).toHaveAttribute("aria-expanded", "true")
      await expect(branchCard().locator(".mvp-context-chip").first()).toBeVisible()
    })
    // agent#6: he opens a file from the Read line; it opens in the File card.
    await proofStep("agent-read-file-open", ["agent-context-read-lines"], async () => {
      const read = activity("read").last()
      const path = (await read.locator("code").first().textContent())!.trim()
      await read.getByRole("button", { name: path }).first().click({ timeout: 5_000 })
      await expect(ben.locator('[data-kind="file"]').filter({ hasText: path }).last()).toBeVisible({ timeout: 10_000 })
    })
    // agent#7: the agent edits the way a teammate does: an edit line in the branch, its flag on the line in the file.
    await proofStep("agent-live-edit", ["agent-branch-conversation", "setup: steer"], async () => {
      await openBranch()
      const edit = activity("edit").or(activity("change")).last()
      await expect(edit).toBeVisible({ timeout: 10 * 60_000 })
      await expect(edit.locator('[data-kind="agent"]').first()).toBeVisible()
      const here = branchCard().getByRole("list", { name: "On this branch", exact: true })
      await expect(here.locator("li").filter({ has: ben.locator('[data-kind="agent"]') }).locator(".branch-location").filter({ hasText: /\.\w+(:\d+)?$/ }).first(),
        "the agent is shown in the file it edits").toBeVisible({ timeout: 60_000 })
    })
    // agent#8: it opens its own terminal on the branch; the session joins the conversation and Ben watches it.
    await proofStep("agent-terminal-session", ["agent-branch-conversation", "setup: steer"], async () => {
      await openBranch()
      await branchCard().getByRole("tab", { name: /^Terminals/ }).click()
      const session = branchCard().locator("ul.branch-list > li").filter({ has: ben.locator('.branch-avatars [data-kind="agent"]') }).first()
      await expect(session).toBeVisible({ timeout: 5 * 60_000 })
      await session.locator("button.branch-link").first().click()
      await expect(ben.locator('[data-kind="terminal"]').last()).toBeVisible({ timeout: 10_000 })
    })
    // agent#9: it runs the tests the way a person would; the output is in its terminal and the result in the branch.
    await proofStep("agent-terminal-tests", ["agent-terminal-session"], async () => {
      await expect(ben.locator('[data-kind="terminal"]').last()).toContainText(/test/i, { timeout: 5 * 60_000 })
      await branchCard().getByRole("tab", { name: "Activity", exact: true }).click()
      await expect(activity("step").filter({ hasText: /test/i }).last()).toBeVisible({ timeout: 60_000 })
    })
    // agent#10: so it asks. A notification offers Answer, and the branch input reads Answer the coding agent.
    await proofStep("agent-question-notice", ["setup: steer"], async () => {
      await reach(1, ["needs_you"], 15 * 60_000)
      const notice = ben.locator("[data-sonner-toast]").filter({ hasText: TITLE }).last()
      await expect(notice.getByRole("button", { name: "Answer", exact: true })).toBeVisible({ timeout: 30_000 })
      await openBranch()
      await expect(activity("question").last()).toBeVisible({ timeout: 30_000 })
      await expect(branchCard().getByRole("textbox", { name: "Answer the coding agent", exact: true })).toBeVisible()
    })
    // agent#11: Ben answers in the branch input; the answer settles the question and the agent carries on.
    await proofStep("agent-answer-branch-input", ["agent-question-notice"], async () => {
      const input = branchCard().getByRole("textbox", { name: "Answer the coding agent", exact: true })
      await input.fill(ANSWER)
      await branchCard().getByRole("button", { name: "Answer", exact: true }).click()
      await expect(activity("answer").filter({ hasText: ANSWER }).last()).toBeVisible({ timeout: 30_000 })
      await expect.poll(async () => (await served(1)).state, { timeout: 60_000 }).not.toBe("needs_you")
    })

    // agent#12: Ben asks in plain words to drop T2; the app agent asks first, he presses ⏎, T2 is Dropped and its
    // branch records that Ben via Smithers asked.
    await prerequisite("TODO T2", ["setup: Ben"], async () => {
      await commit(ben, DROP_TITLE, "Log each webhook retry attempt with its delay.")
      await expect.poll(async () => (await served(2)).title, { timeout: 15_000 }).toBe(DROP_TITLE)
    })
    await proofStep("agent-drop-confirm", ["setup: TODO T2"], async () => {
      await say(ben, "drop T2")
      const press = ben.getByRole("button", { name: /^Drop\b/ }).last()
      await expect(press).toBeVisible({ timeout: 60_000 })
      await press.focus()
      await ben.keyboard.press("Enter")
      await expect.poll(async () => (await served(2)).state, { timeout: 60_000 }).toBe("dropped")
      const dropped = (await served(2)).branch?.name
      expect(dropped, "T2 keeps its branch").toBeTruthy()
      await say(ben, `/branch ${dropped}`)
      const branch = ben.locator('section[data-kind="branch"]').filter({ has: ben.getByRole("heading", { name: dropped!, exact: true }) }).last()
      await expect(branch.locator("ol.branch-activity")).toContainText(/via Smithers/i, { timeout: 15_000 })
    })
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined)
    await install?.stop()
  }
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(SHOTS, "failures.json"), JSON.stringify(failures, null, 2))
  // Honest result: every feature that failed or was blocked fails the test.
  expect(failures).toEqual([])
})
