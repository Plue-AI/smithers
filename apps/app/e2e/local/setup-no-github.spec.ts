import { test, expect, type BrowserContext, type Page } from "@playwright/test"
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PROVIDER_MODEL } from "../real/support/model-provider-behaviors"
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
const install = async () => {
  const response = await context.request.get("http://localhost:4000/api/install")
  expect(response.status()).toBe(200)
  return response.json()
}
const done = async (id: string) => {
  await expect.poll(async () => (await install()).steps.find((s: { id: string }) => s.id === id)?.state).toBe("done")
  await expect(card().locator(`[data-step="${id}"]`)).toHaveAttribute("data-state", "done")
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
  writeFileSync(`${output}/writes.json`, JSON.stringify(await writes(), null, 2), { mode: 0o600 })
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
  const models = card().locator('[data-step="models"]')
  const coding = models.locator(".setup-model").filter({ has: page.getByText("Coding model", { exact: true }) })
  const decisions = models.locator(".setup-model").filter({ has: page.getByText("Decisions", { exact: true }) })
  await coding.getByLabel("Provider", { exact: true }).selectOption({ label: "OpenAI" })
  await coding.getByLabel("Model", { exact: true }).fill("gpt-4.1-mini")
  await expect(coding.getByLabel("API key", { exact: true })).toBeVisible()
  await coding.getByLabel("API key", { exact: true }).fill(run.modelKey)
  await coding.getByRole("button", { name: "Save", exact: true }).click()
  await expect(coding).toHaveAttribute("data-state", "saved")
  await expect(decisions.getByLabel("AI Gateway key", { exact: true })).toBeVisible()
  await decisions.getByLabel("AI Gateway key", { exact: true }).fill(run.modelKey)
  await decisions.getByRole("button", { name: "Save", exact: true }).click()
  await expect(decisions).toHaveAttribute("data-state", "saved")
  // Reuse the owner-model API's existing user-supplied endpoint, like the
  // real-journey harness; setup has no provider-base field of its own.
  const headers = { Origin: "http://localhost:4000", "X-CSRF-Token": (await context.cookies()).find(cookie => cookie.name === "__csrf")!.value }
  const enrolled = await context.request.post("http://localhost:4000/api/model/credential", { headers, data: { action: "enroll", requestId: "local-model-enroll", name: "LOCAL_MODEL_API_KEY", value: run.modelKey, origin: run.modelOrigin } })
  expect(enrolled.status(), await enrolled.text()).toBe(200)
  expect(await enrolled.json()).toMatchObject({ ok: true })
  // The stand-in model that reads: asked about a file, it calls files.read and quotes the result.
  const binding = { protocol: "openai-chat", modelId: PROVIDER_MODEL.reads, credential: "LOCAL_MODEL_API_KEY", baseUrl: run.modelOrigin }
  const model = { id: "local-coding", ...binding }
  const configured = await context.request.put("http://localhost:4000/api/model/default", { headers, data: { model: binding } })
  expect(configured.status()).toBe(200)
  const probe = await context.request.post("http://localhost:4000/api/model/test", { headers, data: { model } })
  expect(probe.status(), await probe.text()).toBe(200)
  expect(await probe.json()).toMatchObject({ ok: true })
  const journal = await (await context.request.get(`${run.modelOrigin}/__journal`)).json()
  expect(journal).toEqual(expect.arrayContaining([expect.objectContaining({ authorized: true, status: 200, modelId: PROVIDER_MODEL.reads })]))
  writeFileSync(`${output}/model-requests.json`, JSON.stringify(journal, null, 2), { mode: 0o600 })
  await click("Model access")
  await done("models")
})
test("6 source", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "crit4-local-source-model (T-INS-06)" })
  await click("Mirror")
  await done("source")
  expect(await writes()).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/local-owner/demo.git/git-upload-pack", status: 200 })]))
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
/** The card's state word is the server's state, read through GET /api/todos/1 (never a client guess). */
const showsServedState = async (state: string) => {
  await expect.poll(async () => (await served()).state, { timeout: 15_000 }).toBe(state)
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
  await draft.getByLabel("Prompt", { exact: true }).fill("Add a greeting to README.md")
  await draft.getByRole("combobox", { name: "Place", exact: true }).selectOption({ label: "Append" })
  await draft.getByRole("button", { name: "Commit", exact: true }).click()
  await expect(todoCard()).toContainText("First local TODO", { timeout: 10_000 })
  expect(await served()).toMatchObject({ n: 1, title: "First local TODO", prompt_revisions: [expect.objectContaining({ text: "Add a greeting to README.md" })] })
  await expect.poll(async () => {
    const state = (await served()).state
    return await todoCard().locator("header .mvp-state").getAttribute("data-state") === state ? state : `card differs from ${state}`
  }, { timeout: 10_000 }).toMatch(/^(queued|starting|working|needs_you|in_review)$/)
})
for (const [state, owner] of [
  ["starting", "J1 rehearsal row 'TODO starting' (T-STK-01: the TODO stays queued)"],
  ["working", "J1 rehearsal row 'TODO working' (T-STK-01)"]
]) test(`8 TODO ${state}`, async ({}, info) => {
  info.annotations.push({ type: "owner", description: owner }); test.fail()
  await showsServedState(state)
})
test("9 PR", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "J1 rehearsal rows 'TODO in_review' and 'PR' (T-STK-01, T-GH-06)" }); test.fail()
  await showsServedState("in_review")
  await expect(todoCard().locator('a[href^="https://github.com/local-owner/demo/pull/"]').first()).toBeVisible()
  await expect(todoCard().getByRole("region", { name: /^Attempt \d+ evidence$/ }).last()).toBeVisible()
  expect(await writes()).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/repos/local-owner/demo/pulls", status: 201 })]))
})
test("10 merge", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "J1 rehearsal rows 'Merge in Smithers' and 'Merged' (T-STK-04 merge readiness and dispatch)" }); test.fail()
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
  expect(await writes()).toEqual(expect.arrayContaining([expect.objectContaining({ method: "PUT", path: "/repos/local-owner/demo/pulls/1/merge", status: 200 })]))
})
