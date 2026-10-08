import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { say } from "./j1-fixtures"

// Browser proof of the production command/card/seam wiring. PostgreSQL and
// credential refusals are exercised by model_routes_owner_test.go.
test("C-J11-03: the owner switches the reviewer model immediately", async ({ page }) => {
 // Plain-HTTP LAN browsers expose getRandomValues, but not randomUUID.
 await page.addInitScript(() => Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined }))
 await installCloudFixture(page, { capabilities: ["agent", "identity", "install"] })
 await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [] } }))
 await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
 let model = "model-a"
 const snapshot = () => ({ native: false, canAssign: true, agents: [
  { id: "planner", label: "Planner agent", purpose: "", model: { id: "model-a", label: "model-a", provider: "openai-responses" }, builtin: true, available: false, account: "", reason: "", source: "owner", instructions: "flows/todo/flow.ts" },
  { id: "implementer", label: "Implementer agent", purpose: "", model: { id: "model-a", label: "model-a", provider: "openai-responses" }, builtin: true, available: false, account: "", reason: "", source: "owner", instructions: "flows/todo/flow.ts" },
  { id: "reviewer", label: "Reviewer agent", purpose: "", model: { id: model, label: model, provider: "openai-responses" }, binding: { protocol: "openai-responses", modelId: model, credential: "OPENAI_API_KEY" }, builtin: true, available: false, account: "", reason: "", source: "owner", instructions: "flows/todo/flow.ts" },
  { id: "app", label: "App agent", purpose: "", runs: [{ id: "turn-before-switch", model: "model-old" }, { id: "turn-after-switch", model: "model-f" }], model: { id: "model-f", label: "model-f", provider: "openai-chat" }, builtin: true, available: false, account: "", reason: "", source: "owner", instructions: ".smithers/instructions/app.md" }
 ] })
 let holdRefresh = false
 let refreshStarted = false
 let releaseRefresh!: () => void
 const refresh = new Promise<void>(resolve => { releaseRefresh = resolve })
 await page.route("**/api/agents", async route => {
  if (holdRefresh) { refreshStarted = true; await refresh }
  await route.fulfill({ json: snapshot() })
 })
 const writes: unknown[] = []
 await page.route("**/api/agents/reviewer/model", async route => {
  const body = route.request().postDataJSON(); writes.push(body); model = body.model.modelId
  await route.fulfill({ json: snapshot() })
 })
 await page.route("**/api/branches/main/files/.smithers/instructions/app.md", route => route.fulfill({ json: {
  path: ".smithers/instructions/app.md", branch: "main", language: "markdown", digest: "sha256:instructions-builtin",
  content: { kind: "text", text: "Answer the repository question as Smithers for the prompt author." }, mode: "read_only", diagnostics: [], authors: [], editors: []
 } }))
 let probeComplete = false
 const probeIds: string[] = []
 await page.route("**/api/model/test", route => {
  probeIds.push(route.request().postDataJSON().requestId)
  return route.fulfill({ status: 202, json: { requestId: probeIds.at(-1), state: "accepted" } })
 })
 await page.route("**/api/model/test/receipt?*", route => route.fulfill({ json: probeComplete ? { state: "completed", result: { ok: true, latencyMs: 2, sample: "ok" } } : { state: "running" } }))
 await page.goto("/smithersai/smithers")
 await say(page, "/agents")
 for (const name of ["Planner agent", "Implementer agent", "Reviewer agent", "App agent"])
  await expect(page.getByText(name, { exact: true }).last()).toBeVisible()
 await expect(page.getByTestId("agent-recent-runs-app")).toContainText("turn-before-switch · model-old")
 await expect(page.getByTestId("agent-recent-runs-app")).toContainText("turn-after-switch · model-f")
 await expect(page.getByTestId("agent-model-reviewer")).toHaveAttribute("data-flow", "model.assign")
 await page.getByTestId("agent-model-reviewer").press("Enter")
 await page.getByLabel("Model", { exact: true }).last().fill("model-b")
 await expect(page.getByRole("button", { name: "Save", exact: true }).last()).toBeEnabled()
 await page.getByRole("button", { name: "Save", exact: true }).last().press("Enter")
 await expect(page.locator('[data-agent="reviewer"]')).toContainText("model-b")
 expect(writes).toEqual([{ model: { protocol: "openai-responses", modelId: "model-b", credential: "OPENAI_API_KEY" } }])
 await page.reload()
 await say(page, "/agents")
 await expect(page.locator('[data-agent="reviewer"]')).toContainText("model-b")
 await expect(page.locator('[data-agent="app"] [data-flow="file"]')).toBeVisible()
 await page.locator('[data-agent="app"] [data-flow="file"]').press("Enter")
 await expect(page.getByText("Answer the repository question as Smithers for the prompt author.", { exact: true }).last()).toBeVisible()
 await say(page, "/agent reviewer")
 await expect(page.locator("[data-agent]")).toHaveCount(1)
 await expect(page.locator('[data-agent="reviewer"]')).toBeVisible()
 await say(page, '/model.save {"name":"review-c","protocol":"openai-responses","modelId":"model-c","credential":"OPENAI_API_KEY"}')
 const record = page.locator('[data-model-id="review-c"]')
 await expect(record).toContainText("model-c")
 holdRefresh = true
 await record.getByRole("button", { name: "Test", exact: true }).press("Enter")
 await expect(record.getByRole("button", { name: "Test", exact: true })).toBeDisabled()
 await expect.poll(() => refreshStarted).toBe(true)
 expect(probeIds).toHaveLength(0)
 await say(page, "/help")
 await expect(page.getByRole("textbox").last()).toBeEnabled()
 holdRefresh = false
 releaseRefresh()
 await say(page, "/agent reviewer")
 await expect(page.locator("[data-agent]")).toHaveCount(1)
 await expect(page.locator('[data-agent="reviewer"]')).toBeVisible()
 await page.reload()
 await say(page, "/agents")
 await expect(record.getByRole("button", { name: "Test", exact: true })).toBeDisabled()
 await expect.poll(() => probeIds.length).toBe(2)
 expect(new Set(probeIds).size).toBe(1)
 expect(probeIds[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
 probeComplete = true
 await expect(record).toContainText("2 ms")
 await say(page, "/model.assign reviewer review-c")
 await expect(page.locator('[data-agent="reviewer"]')).toContainText("model-c")
 await record.getByRole("button", { name: "Edit", exact: true }).press("Enter")
 await expect(page.getByRole("button", { name: "Save", exact: true }).last()).toBeVisible()
 await record.getByRole("button", { name: "Remove", exact: true }).press("Enter")
 await expect(record).toHaveCount(0)
 await say(page, "/help")
 await expect(page.getByText("model.compose", { exact: true })).toHaveCount(0)
 await expect(page.getByText("model.ask", { exact: true })).toHaveCount(0)
})

test("C-J11-03: the instruction link reads the activated main revision after reload", async ({ page }) => {
 await installCloudFixture(page, { capabilities: ["agent", "identity", "install"] })
 await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [] } }))
 await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
 await page.route("**/api/agents", route => route.fulfill({ json: { native: false, canAssign: true, agents: [
  { id: "app", label: "App agent", purpose: "", model: { id: "model-f", label: "model-f", provider: "openai-chat" }, builtin: true, available: false, account: "", reason: "", source: "owner", instructions: ".smithers/instructions/app.md", runs: [] }
 ] } }))
 let active = "Answer the repository question as Smithers for the prompt author."
 const draft = "Always end answers with the word DONE.\n```js\nthrow new Error(\"instruction Markdown executed\")\n```"
 const reads: string[] = []
 const writes: string[] = []
 await page.route("**/api/branches/main/files/.smithers/instructions/app.md", route => {
  if (route.request().method() !== "GET") writes.push(route.request().method())
  reads.push(active)
  return route.fulfill({ json: {
   path: ".smithers/instructions/app.md", branch: "main", language: "markdown", digest: active === draft ? "sha256:merged" : "sha256:builtin",
   content: { kind: "text", text: active }, mode: "read_only", diagnostics: [], authors: [], editors: []
  } })
 })
 const openInstructions = async () => {
  await say(page, "/agents")
  await page.locator('[data-agent="app"] [data-flow="file"]').press("Enter")
 }
 await page.goto("/smithersai/smithers")
 await openInstructions()
 await expect(page.getByText(active, { exact: true }).last()).toBeVisible()
 // A working-copy draft does not change the main-file seam.
 await page.reload()
 await openInstructions()
 await expect(page.getByText(active, { exact: true }).last()).toBeVisible()
 await expect(page.getByText(draft, { exact: true })).toHaveCount(0)
 active = draft // The real reference journey observes this transition after owner merge/activation.
 await page.reload()
 await openInstructions()
 await expect.poll(() => reads).toContain(draft)
 await expect(page.getByRole("textbox", { name: ".smithers/instructions/app.md", exact: true }).locator(".cm-line")).toHaveText(draft.split("\n"))
 expect(reads[0]).toBe("Answer the repository question as Smithers for the prompt author.")
 expect(reads.at(-1)).toBe(draft)
 const source = page.getByRole("textbox", { name: ".smithers/instructions/app.md", exact: true })
 await expect(source).toHaveAttribute("aria-readonly", "true")
 await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0)
 await say(page, "/help")
 await expect(page.getByRole("textbox").last()).toBeEnabled()
 expect(writes).toEqual([])
})


test("C-J11-03: a member reads agent models and instructions without assignment controls", async ({ page }) => {
 await installCloudFixture(page, { capabilities: ["agent", "identity", "install"] })
 await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [] } }))
 await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
 const writes: string[] = []
 await page.route("**/api/agents/reviewer/model", route => {
  writes.push(route.request().method())
  return route.fulfill({ status: 403, json: { class: "permission" } })
 })
 await page.route("**/api/agents", route => route.fulfill({ json: { native: false, canAssign: false, agents: [
  { id: "reviewer", label: "Reviewer agent", purpose: "", model: { id: "model-b", label: "model-b", provider: "openai-responses" }, binding: { protocol: "openai-responses", modelId: "model-b", credential: "OPENAI_API_KEY" }, builtin: true, available: false, account: "", reason: "", source: "owner", instructions: "flows/todo/flow.ts", runs: [{ id: "review-1", model: "model-b" }] }
 ] } }))
 await page.goto("/smithersai/smithers")
 await say(page, "/agents")
 await expect(page.locator('[data-agent="reviewer"]')).toContainText("model-b")
 await expect(page.getByTestId("agent-source-reviewer")).toHaveText("owner")
 await expect(page.getByTestId("agent-recent-runs-reviewer")).toContainText("review-1 · model-b")
 await expect(page.locator('[data-agent="reviewer"] [data-flow="file"]')).toBeVisible()
 await expect(page.getByTestId("agent-model-reviewer")).toHaveCount(0)
 await page.reload()
 await say(page, "/agents")
 await expect(page.locator('[data-agent="reviewer"]')).toContainText("model-b")
 await expect(page.getByTestId("agent-model-reviewer")).toHaveCount(0)
 expect(writes).toEqual([])
})


test("C-J11-03: Settings reads the install roles and refreshes them after reload", async ({ page }) => {
 await installCloudFixture(page, { capabilities: ["agent", "identity", "install"] })
 await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [] } }))
 let coding = "model-a"
 const writes: string[] = []
 await page.route("**/api/install", route => {
  if (route.request().method() !== "GET") writes.push(route.request().method())
  return route.fulfill({ json: { ...installFixture(), models: [
   { role: "fast", provider: "Cerebras", key: "saved", model: "model-f" },
   { role: "coding", provider: "OpenAI", key: "saved", model: coding },
   { role: "jev", provider: "AI Gateway", key: "saved", model: "model-j" }
  ] } })
 })
 await page.goto("/smithersai/smithers")
 await say(page, "/settings")
 const settings = page.locator('[data-kind="settings"]').last()
 for (const label of ["Fast model", "Coding model", "Decisions"])
  await expect(settings.getByText(label, { exact: true })).toBeVisible()
 await expect(settings.getByTestId("settings-model-fast")).toHaveText("model-f")
 await expect(settings.getByTestId("settings-model-coding")).toHaveText("model-a")
 await expect(settings.getByTestId("settings-model-jev")).toHaveText("model-j")
 coding = "model-b"
 await page.reload()
 await say(page, "/settings")
 await expect(settings.getByTestId("settings-model-coding")).toHaveText("model-b")
 await expect(settings.getByTestId("settings-model-fast")).toHaveText("model-f")
 expect(writes).toEqual([])
})


test("C-J11-03: the owner removes the fast key in Settings without blocking Chat", async ({ page }) => {
 await installCloudFixture(page, { capabilities: ["agent", "identity", "install"] })
 await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [] } }))
 let removed = false
 await page.route("**/api/install", route => route.fulfill({ json: {
  ...installFixture(), models: [
   { role: "fast", provider: "Cerebras", key: removed ? "none" : "saved", model: "model-f" },
   { role: "coding", provider: "OpenAI", key: "saved", model: "model-a" },
   { role: "jev", provider: "AI Gateway", key: "saved", model: "model-j" }
  ]
 } }))
 const requests: any[] = []
 let release!: () => void
 const receipt = new Promise<void>(resolve => { release = resolve })
 await page.route("**/api/model/credential", async route => {
  requests.push(route.request().postDataJSON())
  if (requests.length === 1) {
   await route.fulfill({ status: 500, json: { code: "vault_unavailable", class: "infra", message: "Removal refused" } })
   return
  }
  await receipt
  removed = true
  await route.fulfill({ json: { ok: true, credential: { name: "CEREBRAS_API_KEY", present: false, managed: true, origins: ["https://api.cerebras.ai"] } } })
 })
 await page.goto("/smithersai/smithers")
 await say(page, "/settings")
 const remove = page.getByTestId("settings-key-remove-fast")
 await expect(remove).toHaveAttribute("data-flow", "settings")
 await expect(remove).toHaveAttribute("data-operation", "model-key")
 await remove.press("Enter")
 await expect.poll(() => requests.length).toBe(1)
 await expect(page.getByRole("alert").filter({ hasText: "Removing key" })).toContainText("The operation failed.")
 await expect(remove).toBeVisible()
 await remove.press("Enter")
 await expect.poll(() => requests.length).toBe(2)
 expect(requests[0]).toEqual({ action: "remove", name: "CEREBRAS_API_KEY", requestId: expect.any(String) })
 await expect(page.getByTestId("settings-key-remove-coding")).toBeVisible()
 await say(page, "/help")
 await expect(page.getByRole("textbox").last()).toBeEnabled()
 expect(removed).toBe(false)
 release()
 await say(page, "/settings")
 await expect(remove).toHaveCount(0)
 await expect(page.getByTestId("settings-key-remove-coding")).toBeVisible()
 await page.reload()
 await say(page, "/settings")
 await expect(remove).toHaveCount(0)
 expect(requests).toHaveLength(2)
})


test("C-J11-03: a refused owner switch keeps the model and retries through the same picker", async ({ page }) => {
 await installCloudFixture(page, { capabilities: ["agent", "identity", "install"] })
 await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [] } }))
 await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
 let model = "model-a"
 const snapshot = () => ({ native: false, canAssign: true, agents: [
  { id: "reviewer", label: "Reviewer agent", purpose: "", model: { id: model, label: model, provider: "openai-responses" }, binding: { protocol: "openai-responses", modelId: model, credential: "OPENAI_API_KEY" }, builtin: true, available: false, account: "", reason: "", source: "owner", instructions: "flows/todo/flow.ts", runs: [] }
 ] })
 await page.route("**/api/agents", route => route.fulfill({ json: snapshot() }))
 const requests: unknown[] = []
 await page.route("**/api/agents/reviewer/model", route => {
  const body = route.request().postDataJSON()
  requests.push(body)
  if (requests.length === 1) return route.fulfill({ status: 503, json: { code: "settings_unavailable", class: "infra", message: "Assignment refused" } })
  model = body.model.modelId
  return route.fulfill({ json: snapshot() })
 })
 await page.goto("/smithersai/smithers")
 await say(page, "/agents")
 const choose = async () => {
  await page.getByTestId("agent-model-reviewer").press("Enter")
  await page.getByLabel("Model", { exact: true }).last().fill("model-b")
  await expect(page.getByRole("button", { name: "Save", exact: true }).last()).toBeEnabled()
  await page.getByRole("button", { name: "Save", exact: true }).last().press("Enter")
 }
 await choose()
 await expect.poll(() => requests.length).toBe(1)
 await expect(page.locator('[data-agent="reviewer"]')).toContainText("model-a")
 await say(page, "/help")
 await expect(page.getByTestId("composer-input")).toBeEnabled()
 await say(page, "/agents")
 await choose()
 await expect(page.locator('[data-agent="reviewer"]')).toContainText("model-b")
 expect(requests).toEqual([
  { model: { protocol: "openai-responses", modelId: "model-b", credential: "OPENAI_API_KEY" } },
  { model: { protocol: "openai-responses", modelId: "model-b", credential: "OPENAI_API_KEY" } }
 ])
 await page.reload()
 await say(page, "/agents")
 await expect(page.locator('[data-agent="reviewer"]')).toContainText("model-b")
})
