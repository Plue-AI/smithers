import { test, expect, type BrowserContext, type Page } from "@playwright/test"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { githubRoute } from "./github-route"

// Shared browser history, never seeded product state: later rows expose the
// first real missing control or predecessor receipt instead of faking progress.
let context: BrowserContext, page: Page
let run: { setupURL: string; fakeURL: string }
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
  writeFileSync(`${output}/steps.tsv`, "step\tactual\texpected\towner\n", { mode: 0o600 })
  context = await browser.newContext()
  traffic = await githubRoute(context, run.fakeURL)
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
  await click("Address")
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
  info.annotations.push({ type: "owner", description: "crit3-setup-steps (T-ACC-01)" })
  test.fail()
  await click("Sign in")
  await page.getByRole("link", { name: "Authorize", exact: true }).click()
  await done("sign_in")
  expect(await writes()).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/login/oauth/access_token", status: 200 })]))
})
test("4 repository", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "crit3-setup-steps (T-INS-06)" }); test.fail()
  await card().getByLabel("Repository", { exact: true }).last().selectOption({ label: "local-owner/demo" })
  await click("Repository")
  await done("repository")
})
test("5 models", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "crit3-setup-steps (T-INS-06)" }); test.fail()
  const models = card().locator('[data-step="models"]')
  await models.getByLabel("Provider", { exact: true }).selectOption({ label: "OpenAI" })
  await models.getByLabel("API key", { exact: true }).fill("local-no-github-key")
  await models.getByRole("button", { name: "Save", exact: true }).first().click()
  await click("Model access")
  await done("models")
})
for (const [id, label, owner] of [
  ["source", "Mirror", "w-source-machine (T-GH-02; hard-coded GitHub clone and retention URLs)"],
  ["machine", "Build image", "w-source-machine (T-MCH-10)"]
]) test(`${id === "source" ? 6 : 7} ${id}`, async ({}, info) => {
  info.annotations.push({ type: "owner", description: owner }); test.fail()
  await click(label)
  await done(id)
})
test("8 TODO start", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "TODO start lane (T-FLW-11)" }); test.fail()
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await input.fill("/todo.new")
  await input.press("Enter")
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  await draft.getByLabel("Title", { exact: true }).fill("First local TODO")
  await draft.getByLabel("Prompt", { exact: true }).fill("Add a greeting to README.md")
  await draft.getByLabel("Place", { exact: true }).selectOption({ label: "Append" })
  await draft.getByRole("button", { name: "Commit", exact: true }).click()
  await expect(page.getByRole("article", { name: "TODO T1", exact: true }).getByText("Working", { exact: true })).toBeVisible()
  expect((await install()).steps.every((s: { state: string }) => s.state === "done")).toBe(true)
  expect(await writes()).toEqual(expect.any(Array))
})
test("9 PR", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "PR lane (T-GH-06)" }); test.fail()
  const todo = page.getByRole("article", { name: "TODO T1", exact: true })
  await expect(todo.getByText("In review", { exact: true })).toBeVisible()
  await todo.getByText("Evidence", { exact: true }).click()
  await expect(todo.locator('a[href^="https://github.com/local-owner/demo/pull/"]')).toBeVisible()
  expect(await writes()).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/repos/local-owner/demo/pulls", status: 201 })]))
  expect((await install()).steps.every((s: { state: string }) => s.state === "done")).toBe(true)
})
test("10 merge", async ({}, info) => {
  info.annotations.push({ type: "owner", description: "merge lane (T-STK-04)" }); test.fail()
  await page.getByRole("button", { name: "Merge", exact: true }).click()
  await expect(page.getByText("Merged", { exact: true })).toBeVisible()
  expect(await writes()).toEqual(expect.arrayContaining([expect.objectContaining({ method: "PUT", path: "/repos/local-owner/demo/pulls/1/merge", status: 200 })]))
  expect((await install()).steps.every((s: { state: string }) => s.state === "done")).toBe(true)
})
