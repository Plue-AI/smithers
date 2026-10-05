import { test, expect, type BrowserContext, type Page } from "@playwright/test"
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { INSTALL_MODEL, PROVIDER_MODEL } from "../real/support/model-provider-behaviors"
import { githubRoute } from "./github-route"
import { README } from "./demo-repository"

// Shared browser history, never seeded product state: later rows expose the
// first real missing control or predecessor receipt instead of faking progress.
let context: BrowserContext, page: Page
let run: { setupURL: string; fakeURL: string; home: string; modelOrigin: string; modelKey: string }
let traffic: Awaited<ReturnType<typeof githubRoute>>
const output = "test-results/local-no-github"
const card = () => page.locator('[aria-label="Set up Smithers"]').first()
const writes = async () => (await context.request.get(`${run.fakeURL}/_fake/writes`)).json()
/** The model stand-in's journal: every call the install made, with the TODO coding step a scripted answer served. */
const modelRequests = async () => (await context.request.get(`${run.modelOrigin}/__journal`)).json()
const install = async () => {
  const response = await context.request.get("http://localhost:4000/api/install")
  expect(response.status()).toBe(200)
  return response.json()
}
/** A step's work runs in the background, so a step that clones or builds may take longer than the default 5 s. */
const done = async (id: string, timeout = 5_000) => {
  await expect.poll(async () => (await install()).steps.find((s: { id: string }) => s.id === id)?.state, { timeout }).toBe("done")
  await expect(card().locator(`[data-step="${id}"]`)).toHaveAttribute("data-state", "done", { timeout })
  expect(await writes()).toEqual(expect.any(Array))
}
const click = (name: string) => card().getByRole("button", { name, exact: true }).first().click()

test.beforeAll(async ({ browser }) => {
  await expect.poll(() => { try { run = JSON.parse(readFileSync(`${output}/run.json`, "utf8")); return true } catch { return false } }).toBe(true)
  context = await browser.newContext()
  traffic = await githubRoute(context, run.fakeURL)
  await context.route(/^https?:\/\//, async route => {
    const origin = new URL(route.request().url()).origin
    if (["http://localhost:4000", "http://127.0.0.1:4000", run.fakeURL, run.modelOrigin].includes(origin)) return route.continue()
    if (/^https?:\/\/([a-z0-9-]+\.)*(github\.com|githubusercontent\.com)([:/]|$)/i.test(route.request().url())) return route.fallback()
    traffic.aborted.push(`${route.request().method()} ${origin}${new URL(route.request().url()).pathname}`)
    await route.abort()
  })
  page = await context.newPage()
  await page.goto(run.setupURL)
  await expect(card()).toBeVisible()
})
test.afterEach(async ({}, info) => {
  const owner = info.annotations.find(a => a.type === "owner")?.description ?? ""
  appendFileSync(`${output}/steps.tsv`, `${info.title}\t${info.status}\t${info.expectedStatus}\t${owner}\n`)
  // Each row's screen is the walk's receipt beside its row.
  if (page) await page.screenshot({ path: `${output}/screens/${info.title}.png`, fullPage: true })
  writeFileSync(`${output}/writes.json`, JSON.stringify(await writes(), null, 2), { mode: 0o600 })
  writeFileSync(`${output}/model-requests.json`, JSON.stringify(await modelRequests(), null, 2), { mode: 0o600 })
  writeFileSync(`${output}/github-requests.json`, JSON.stringify(traffic, null, 2), { mode: 0o600 })
  expect(traffic.aborted).toEqual([])
})
test.afterAll(async () => { await context?.close() })

test("1 address", async () => {
  await click("This Mac only")
  await done("address")
})
test("2 app_manifest", async () => {
  await card().getByLabel("Owner", { exact: true }).last().fill("local-owner")
  await click("Create GitHub App")
  await page.getByRole("link", { name: "Create GitHub App", exact: true }).click()
  await done("app_manifest")
  expect(await writes()).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: "POST", path: "/settings/apps/new", status: 200 }),
    expect.objectContaining({ method: "POST", status: 201 })
  ]))
  expect(traffic.routed).toEqual(["POST /settings/apps/new"])
})
test("3 sign_in", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "crit3-setup-steps (T-ACC-01; now passing)" })
  await click("Sign in")
  await page.getByRole("link", { name: "Authorize", exact: true }).click()
  await done("sign_in")
  expect(await writes()).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/login/oauth/access_token", status: 200 })]))
})
test("4 repository", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "crit3-setup-steps (T-INS-06; now passing)" });
  await card().getByLabel("Repository", { exact: true }).last().selectOption({ label: "local-owner/demo" })
  await click("Repository")
  await done("repository")
})
test("5 models", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "crit3-setup-steps (T-INS-06; now passing)" });
  // The install sends every built-in key to the walk's model stand-in (SMITHERS_MODEL_PROVIDER_ORIGIN), so each role is
  // the owner's Setup card alone, on the stand-in's key: no paid key, no network. Coding runs on the AI Gateway key
  // Decisions shares, as the coding host does through the model proxy.
  const models = card().locator('[data-step="models"]')
  const role = (label: string) => models.locator(".setup-model").filter({ has: page.getByText(label, { exact: true }) })
  const fast = role("Fast model"), coding = role("Coding model"), decisions = role("Decisions")
  await fast.getByLabel("Cerebras key", { exact: true }).fill(run.modelKey)
  await fast.getByRole("button", { name: "Save", exact: true }).click()
  await expect(fast).toHaveAttribute("data-state", "saved")
  await coding.getByLabel("Provider", { exact: true }).selectOption({ label: "AI Gateway" })
  await coding.getByLabel("Model", { exact: true }).fill(PROVIDER_MODEL.answers)
  await coding.getByLabel("API key", { exact: true }).fill(run.modelKey)
  await coding.getByRole("button", { name: "Save", exact: true }).click()
  await expect(coding).toHaveAttribute("data-state", "saved")
  await decisions.getByLabel("AI Gateway key", { exact: true }).fill(run.modelKey)
  await decisions.getByRole("button", { name: "Save", exact: true }).click()
  await expect(decisions).toHaveAttribute("data-state", "saved")
  await click("Model access")
  await done("models")
  // Model access tested each role's key with one call at the stand-in.
  expect(await modelRequests()).toEqual(expect.arrayContaining([
    expect.objectContaining({ protocol: "openai-chat", modelId: INSTALL_MODEL.fast, status: 200, authorized: true }),
    expect.objectContaining({ protocol: "openai-chat", modelId: PROVIDER_MODEL.answers, status: 200, authorized: true }),
    expect.objectContaining({ protocol: "evaluation", modelId: INSTALL_MODEL.decisions, status: 200, authorized: true })
  ]))
})
test("6 source", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "crit4-local-source-model (T-INS-06)" })
  // Mirroring clones the repository: 7 s on a mini at load 30 (walk at 37c391fafd), so it waits up to 2 min.
  test.setTimeout(3 * 60_000)
  await click("Mirror")
  await done("source", 2 * 60_000)
  expect(await writes()).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/local-owner/demo.git/git-upload-pack", status: 200 })]))
})
test("Make TODO drafts the changed discussion with the install fast model", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "make-todo-draft #3721 J2.2" })
  const repo = "local-owner/demo"
  const created = await context.request.post(`${run.fakeURL}/_fake/issues`, { data: { repo, title: "Retry webhook delivery", body: "Retry forever after a 502." } })
  expect(created.ok()).toBe(true)
  const { number } = await created.json()
  const clarification = "Stop after five attempts and use jittered backoff."
  expect((await context.request.post(`${run.fakeURL}/_fake/comments`, { data: { repo, number, login: "local-owner", body: clarification } })).ok()).toBe(true)
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await input.fill(`/issues.view ${number} ${repo}`); await input.press("Enter")
  const make = page.getByRole("button", { name: "Make TODO", exact: true }).last()
  await expect(make).toBeVisible(); await make.click()
  const draft = page.locator('[data-kind="draft"]').last()
  await expect(draft.getByLabel("Prompt", { exact: true })).toHaveValue(clarification, { timeout: 30_000 })
  await expect(draft.getByLabel("Acceptance", { exact: true })).toHaveValue(clarification)
  await expect(draft.getByLabel("Prompt", { exact: true })).not.toHaveValue(/Retry forever/)
  const calls = (await modelRequests()).filter((entry: { step?: string }) => entry.step === "todo/draft")
  expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ modelId: INSTALL_MODEL.fast, status: 200, authorized: true })
  await make.click(); await expect(page.locator('[data-kind="draft"]')).toHaveCount(1)
  await draft.getByLabel("Title", { exact: true }).fill("Member edited retry policy")
  await draft.getByLabel("Prompt", { exact: true }).fill(`${clarification} Log each attempt.`)
  await draft.getByLabel("Acceptance", { exact: true }).focus()
  await draft.getByLabel("Place", { exact: true }).selectOption({ label: "Append" })
  await expect(draft.getByRole("button", { name: "Commit", exact: true })).toBeEnabled()
  await draft.getByRole("button", { name: "Discard", exact: true }).click()
  await expect(page.locator('[data-kind="draft"]')).toHaveCount(0)
})
test("Make TODO model failure visibly falls back to discussion and can retry after Discard", async () => {
  const input = page.getByTestId("composer-input")
  // Only the failure case injects a transport refusal; success above drives the real backend and provider.
  await context.route("**/api/agent/turn", route => route.fulfill({ status: 503, body: "model unavailable" }))
  try {
    const repo = "local-owner/demo"
    const created = await context.request.post(`${run.fakeURL}/_fake/issues`, { data: { repo, title: "Fallback request", body: "Original request" } })
    const { number } = await created.json()
    await context.request.post(`${run.fakeURL}/_fake/comments`, { data: { repo, number, login: "local-owner", body: "Changed request" } })
    await input.fill(`/todo.from-issue ${number} ${repo}`); await input.press("Enter")
    const draft = page.locator('[data-kind="draft"]').last()
    await expect(draft).toContainText("Agent unavailable. Using quoted discussion.")
    await expect(draft.getByLabel("Prompt", { exact: true })).toHaveValue("Original request\n\n@local-owner:\n> Changed request")
    await expect(draft.getByRole("button", { name: "Commit", exact: true })).toBeEnabled()
    await draft.getByRole("button", { name: "Discard", exact: true }).click()
  } finally { await context.unroute("**/api/agent/turn") }
})
test("7 machine", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "w-machine (T-MCH-10; now passing)" })
  // A cold store loads the bundled base image, then builds and verifies the
  // toolchain and dependency layers in real microVMs.
  test.setTimeout(15 * 60_000)
  await click("Build image")
  const started = Date.now()
  for (;;) {
    const step = (await install()).steps.find((s: { id: string }) => s.id === "machine")
    if (step?.state === "done") break
    if (step?.state === "failed") throw new Error(`machine failed: ${JSON.stringify(step.error)}`)
    if (Date.now() - started > 14 * 60_000) throw new Error(`machine still ${step?.state}`)
    await page.waitForTimeout(2000)
  }
  // Machine ready is the last step: the card shows it done or has already given way to Home.
  await expect(card().locator('[data-step="machine"][data-state="done"]').or(page.getByRole("button", { name: "New TODO", exact: true }))).toBeVisible()
  // Machine ready names real layers this install built for main.
  const dir = join(run.home, "state/microvm/layers")
  const layers = readdirSync(dir).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(dir, name), "utf8")))
  expect(layers.map(layer => [layer.kind, layer.main])).toEqual(expect.arrayContaining([["toolchain", true], ["dependencies", true]]))
  writeFileSync(`${output}/machine.json`, JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000),
    layers: layers.map(({ kind, key, name, buildSeconds }) => ({ kind, key, name, buildSeconds })) }, null, 2), { mode: 0o600 })
})
test("agent question with file cards", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "crit4-agent-file-cards (T-APP-03 #3497; T-APP-16 host tools; now passing)" })
  // Setup has closed after Machine ready, so Source ready is read from the install, not the card.
  expect((await install()).steps.find((s: { id: string }) => s.id === "source")?.state).toBe("done")
  // The host reads main's mirror as the asking member; the browser runs no files.read of its own.
  const contents: string[] = []
  const watch = (request: { url: () => string }) => { if (new URL(request.url()).pathname.includes("/contents")) contents.push(request.url()) }
  page.on("request", watch)
  try {
    const input = page.getByTestId("composer-input")
    if (!await input.isVisible()) await page.keyboard.press("Control+k")
    await input.fill("What is in README.md? Show the file.")
    await input.press("Enter")
    const file = page.locator('[data-kind="file"]').last()
    await expect(file).toContainText("README.md", { timeout: 15_000 })
    await expect(file).toContainText(README.trim().split("\n").at(-1)!)
    expect(contents).toEqual([])
  } finally { page.off("request", watch) }
})
const todoCard = () => page.getByRole("article", { name: "TODO T1", exact: true }).last()
const served = async () => {
  const response = await context.request.get("http://localhost:4000/api/todos/1")
  expect(response.status()).toBe(200)
  return response.json()
}
/**
 * How long each state may take to arrive on a real install, as the J1 rehearsal waits for its own: Starting until the
 * lane's microVM boots from Machine ready's layers, Working until its coding host accepts the run, In review once the
 * coding run delivered and the PR opened, Merged after GitHub's merge receipt.
 */
const WAITS = { starting: 3 * 60_000, working: 5 * 60_000, in_review: 15 * 60_000, merged: 2 * 60_000 } as const
/** The served state when the last row gave up. A TODO still queued after Starting's wait will not start: later rows wait 15 s. */
let gaveUpAt: string | undefined
/** The card's state word is the server's state, read through GET /api/todos/1 (never a client guess). */
const showsServedState = async (state: keyof typeof WAITS) => {
  const wait = gaveUpAt === "queued" ? 15_000 : WAITS[state]
  test.setTimeout(wait + 60_000)
  const began = Date.now()
  for (let todo = await served(); todo.state !== state; todo = await served()) {
    if (todo.state === "failed" || todo.state === "dropped" || Date.now() - began > wait) {
      gaveUpAt = todo.state
      throw new Error(`TODO ${JSON.stringify({ state: todo.state, queue: todo.queue, failure: todo.failure })} after ${Math.round((Date.now() - began) / 1000)} s; expected ${state}`)
    }
    // Fast while a short state may pass, then gently for a wait that lasts minutes.
    await page.waitForTimeout(Date.now() - began < 5_000 ? 100 : 1_000)
  }
  await expect(todoCard().locator("header .mvp-state")).toHaveAttribute("data-state", state)
}
test("8 TODO created", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "f6-app-install (T-APP-02 #3466; now passing)" })
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await input.fill("/todo.new")
  await input.press("Enter")
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  await draft.getByLabel("Title", { exact: true }).fill("First local TODO")
  await draft.getByLabel("Prompt", { exact: true }).fill("Add a greeting to JOURNEY.md")
  await draft.getByRole("combobox", { name: "Place", exact: true }).selectOption({ label: "Append" })
  await draft.getByRole("button", { name: "Commit", exact: true }).click()
  await expect(todoCard()).toContainText("First local TODO", { timeout: 10_000 })
  expect(await served()).toMatchObject({ n: 1, title: "First local TODO", prompt_revisions: [expect.objectContaining({ text: "Add a greeting to JOURNEY.md" })] })
  await expect.poll(async () => {
    const state = (await served()).state
    return await todoCard().locator("header .mvp-state").getAttribute("data-state") === state ? state : `card differs from ${state}`
  }, { timeout: 10_000 }).toMatch(/^(queued|starting|working|needs_you|in_review)$/)
})
for (const [state, owner] of [
  ["starting", "J1 rehearsal row 'TODO starting' (T-STK-01, T-MCH-04; now passing)"],
  ["working", "J1 rehearsal row 'TODO working' (T-STK-01; now passing on a real lane microVM)"]
] as const) test(`8 TODO ${state}`, async ({}, info) => {
  info.annotations.push({ type: "owner", description: owner })
  await showsServedState(state)
})
test("9 PR", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "J1 rehearsal rows 'TODO in_review' and 'PR' (T-STK-01, T-GH-06; now passing)" })
  await showsServedState("in_review")
  // The lane's coding run asked the stand-in for each scripted step: a real run, not a projected state.
  const steps = new Set((await modelRequests()).map((entry: { step?: string }) => entry.step))
  for (const step of ["coding/review-request", "coding/draft-plan", "coding/edit-atom", "coding/review-final-history", "todo/judge"]) {
    expect(steps, step).toContain(step)
  }
  await expect(todoCard().locator('a[href^="https://github.com/local-owner/demo/pull/"]').first()).toBeVisible()
  await expect(todoCard().getByRole("region", { name: /^Attempt \d+ evidence$/ }).last()).toBeVisible()
  expect(await writes()).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/repos/local-owner/demo/pulls", status: 201 })]))
})
test("9 review", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "f6-lane-release (T-MCH-06 #3567): the review runs on a lane of its own once the coding lane's machine stops" })
  test.setTimeout(6 * 60_000)
  // The review lane needs a machine: the retired coding lane's machine stopped, so even a host with room for one
  // machine starts it. A lane that failed to start is a failure, never a wait.
  type Evidence = { items: { kind: string; summary?: string }[] }
  const reviewOf = (todo: { evidence: Evidence[] }) => todo.evidence.flatMap(attempt => attempt.items).find(item => item.kind === "review")
  const began = Date.now()
  let todo = await served()
  for (; !reviewOf(todo); todo = await served()) {
    if (todo.branch?.machine?.state === "failed" || Date.now() - began > 5 * 60_000) {
      throw new Error(`no review on the card after ${Math.round((Date.now() - began) / 1000)} s: ${JSON.stringify({ state: todo.state, branch: todo.branch, evidence: todo.evidence })}`)
    }
    await page.waitForTimeout(1_000)
  }
  expect(reviewOf(todo)?.summary).toBe("approve")
  expect(new Set((await modelRequests()).map((entry: { step?: string }) => entry.step))).toContain("review/change")
  // The review lane is released once it answers; the card keeps naming the TODO's branch, the pull request's
  // head branch, on its own lane machine, asleep while a person decides.
  await expect.poll(async () => {
    const branch = (await served()).branch
    return branch && /^smithers\//.test(branch.name) ? branch.machine.state : JSON.stringify(branch ?? null)
  }, { timeout: 60_000 }).toBe("asleep")
})
test("10 merge", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "J1 rehearsal rows 'Merge in Smithers' and 'Merged' (T-STK-04 merge readiness and dispatch; now passing)" })
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await input.fill("/merge T1")
  await input.press("Enter")
  // Review & merge is bound to the head the person reviews; its press is the browser session's POST /api/todos/1/merge.
  const review = page.getByRole("region", { name: "Merge T1 into main?", exact: true }).last()
  const head = (await served()).pr.head
  await expect(review).toContainText(`#${(await served()).pr.number}`)
  const merge = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/todos/1/merge")
  await review.getByRole("button", { name: "Merge", exact: true }).click()
  expect((await merge).postDataJSON()).toEqual({ reviewed_head_sha: head })
  await showsServedState("merged")
  // A merged TODO has left the stack: its card names no place.
  await expect(todoCard().locator("header")).not.toContainText("Next to merge")
  expect(await writes()).toEqual(expect.arrayContaining([expect.objectContaining({ method: "PUT", path: "/repos/local-owner/demo/pulls/1/merge", status: 200 })]))
})
