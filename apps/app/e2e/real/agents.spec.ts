import { keyboardInputFor, journeyActivate, journeyEnter } from "./support/keyboard-journey-input"
import type { Page } from "@playwright/test"
import { fillComposer } from "../playwright/composer"
import { scenario } from "./coverage/types"
import { closeComposer, command, expect, reloadApp, test } from "./support"
import { openApp, awaitBoot } from "./support"
const boot = async (page: Page) => { const at = performance.now(); await openApp(page); await awaitBoot(page, "navigate", at) }

const LEGACY_BUILTIN_ROLES = [
 { id: "orchestrator", label: "Orchestrator", model: { label: "Fable 5" } },
 { id: "implementation", label: "Implementation", model: { label: "GPT-6.1 Sol" } },
 { id: "trivial-implementation", label: "Trivial implementation", model: { label: "GPT-6 Luna" } },
 { id: "ui", label: "UI", model: { label: "Kimi K3" } },
 { id: "fast-ui", label: "Fast UI", model: { label: "Cerebras Qwen 3.8 27B" } }
]
const BUILTIN_ROLE_IDS = LEGACY_BUILTIN_ROLES.map((role) => role.id)

const agentsCard = (page: Page) => page.getByTestId("card-agents")
const cards = (page: Page) => page.locator(".smithers-card")
const agentRows = (page: Page) => agentsCard(page).locator("[data-testid=\"agents-list\"] > li.agent-row")

/** The rendered rows lead with the shipped role catalog, in its order, each with its label and its runs door. */
const expectBuiltinRoles = async (page: Page): Promise<void> => {
  await expect(agentsCard(page)).toHaveAttribute("data-kind", "agents")
  await expect.poll(() => agentRows(page).evaluateAll((rows, ids) => rows.map((row) => row.getAttribute("data-agent")).slice(0, ids.length), BUILTIN_ROLE_IDS))
    .toEqual(BUILTIN_ROLE_IDS)
  for (const role of LEGACY_BUILTIN_ROLES) {
    const row = agentRows(page).and(page.locator(`[data-agent="${role.id}"]`))
    await expect(row.locator("strong")).toHaveText(role.label)
    await expect(row).toContainText(role.model.label)
    await expect(row.getByTestId(`agent-runs-${role.id}`)).toBeVisible()
  }
}

test("/agents opens one durable Agents card that survives a reload", scenario("agents.list-doors-reload", {
  capabilities: [],
  coverage: [
    "action:agents", "host:local", "path:success", "path:persistence",
    "door:slash", "dimension:reload", "evidence:persisted-card-after-reload"
  ]
}), async ({ page }) => {
  await boot(page)
  await expect(agentsCard(page)).toHaveCount(0)

  await command(page, "/agents")
  await closeComposer(page)
  await expectBuiltinRoles(page)

  // A later card takes the tail; a second /agents brings the same Agents card back to it instead of adding a second.
  await command(page, "/help")
  await closeComposer(page)
  await expect(cards(page).last()).toHaveAttribute("data-kind", "commands")
  await command(page, "/agents")
  await closeComposer(page)
  await expect(page.getByTestId("chrome-actions")).toHaveCount(0)
  await expect(cards(page).last()).toHaveAttribute("data-kind", "agents")
  await expectBuiltinRoles(page)
  await expect(page.locator('.smithers-card[data-kind="agents"]')).toHaveCount(1)

  // The card is conversation state in the browser database: a reload restores it without asking again.
  await reloadApp(page)
  await expectBuiltinRoles(page)
  await expect(page.locator('.smithers-card[data-kind="agents"]')).toHaveCount(1)
})

// Reference-host proof uses real sessions, SQL observations and merged-main data.
// No intercepted API or direct GitHub writes: the owner merges the instruction TODO.
test("C-J11-03 install roles, owner switch and merged app instructions", scenario("agents.install-owner-switch", {
 capabilities: ["install"], coverage: ["host:local", "door:slash", "door:button", "path:success", "dimension:evidence"]
}), async ({ browser }, info) => {
 const { withReference, required, runSlash, attachJson, createTodo } = await import("./todo/reference")
 test.setTimeout(3_600_000)
 await withReference(browser, info, async f => {
  const page = f.members.Will.page
  const prepareComposer = async (text: string) => {
   if (!keyboardInputFor(page)) { await fillComposer(page, text); return }
   const input = page.getByTestId("composer-input")
   if (!await input.isVisible()) await page.keyboard.press("ControlOrMeta+k")
   await journeyEnter(input, text)
  }
  const modelA = required("SMITHERS_AGENT_MODEL_A")
  const modelB = required("SMITHERS_AGENT_MODEL_B")
  const modelF = required("SMITHERS_AGENT_MODEL_F")
  const modelJ = required("SMITHERS_AGENT_MODEL_J")
  await runSlash(page, "/agents")
  for (const [id, label, model] of [
   ["planner", "Planner agent", modelA], ["implementer", "Implementer agent", modelA],
   ["reviewer", "Reviewer agent", modelA], ["app", "App agent", modelF]
  ]) {
   const row = page.locator(`[data-agent="${id}"]`)
   await expect(row).toContainText(label!)
   await expect(row).toContainText(model!)
   await expect(row.locator('[data-flow="files.read"]')).toBeVisible()
   await expect(page.getByTestId(`agent-source-${id}`)).toHaveText("owner")
  }
  // Bind the answer and model receipt to this newly admitted turn, rather
  // than accepting any historical app run with the expected model.
  const ask = async (expectedModel = modelF, prompt = "What is this repository for? Answer in one sentence.") => {
   await prepareComposer(prompt)
   const admission = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/conversations/main/prompt" &&
    response.request().method() === "POST" && response.status() === 202)
   await page.keyboard.press("Enter")
   const accepted = await (await admission).json()
   const id = accepted.turnId
   expect(id).toEqual(expect.any(String))
   const turn = page.locator(`[data-shared-turn="${id}"]`)
   await expect(turn).toHaveAttribute("data-state", "completed", { timeout: 180_000 })
   const answer = turn.locator('[data-kind="answer"]')
   await expect(answer).not.toBeEmpty()
   const conversation = await f.read("Will", "/api/conversations/main")
   const runId = conversation.entries.find((entry: any) => entry.id === id).runId
   expect(runId).toEqual(expect.any(String))
   await expect.poll(async () => {
    const agents = await f.read("Will", "/api/agents")
    return agents.agents.find((row: any) => row.id === "app").runs.find((run: any) => run.id === runId)?.model
   }, { timeout: 30_000 }).toBe(expectedModel)
   await attachJson(info, `app-turn-${id}`, await f.read("Will", "/api/conversations/main"))
   return answer.innerText()
  }
  expect((await ask()).trim()).not.toMatch(/\bDONE[.!]?$/)
  const install = await f.read("Will", "/api/install")
  expect(install.models.map((row: any) => row.role)).toEqual(["fast", "coding", "jev"])
  await runSlash(page, "/settings")
  for (const label of ["Fast model", "Coding model", "Decisions"])
   await expect(page.getByText(label, { exact: true }).last()).toBeVisible()
  for (const [role, model] of [["fast", modelF], ["coding", modelA], ["jev", modelJ]]) {
   expect(install.models.find((row: any) => row.role === role).model).toBe(model)
   await expect(page.getByTestId(`settings-model-${role}`)).toHaveText(model!)
  }
  await info.attach("owner-settings-roles", { body: await page.locator('[data-kind="settings"]').last().screenshot(), contentType: "image/png" })
  await runSlash(page, "/agents")
  await info.attach("owner-agent-card-before-switch", { body: await agentsCard(page).screenshot(), contentType: "image/png" })
  const before = await f.read("Will", "/api/todos")
  const priorAgents = await f.read("Will", "/api/agents")
  const priorReviewerRuns = priorAgents.agents.find((row: any) => row.id === "reviewer").runs
  // Empty history is valid for a fresh install; a later observation must be new.
  expect(priorReviewerRuns.every((run: any) => run.model === modelA)).toBe(true)
  await attachJson(info, "reviewer-runs-before-switch", priorReviewerRuns)
  const bindingsBefore = f.sql("SELECT id,binding_id,runtime_artifact_digest FROM flow_runtime_host_bindings WHERE state='running' AND binding_kind='mythical-item' AND repository_id=(SELECT (value->>'repository_id')::bigint FROM install_settings WHERE key='github.repository')")
  expect(bindingsBefore.length, "TODO X must already be working before the switch").toBeGreaterThan(0)
  await attachJson(info, "ongoing-todo-bindings-before-switch", bindingsBefore)
  await journeyActivate(page.getByTestId("agent-model-reviewer"))
  await journeyEnter(page.getByLabel("Model", { exact: true }).last(), modelB)
  await expect(page.getByRole("button", { name: "Save", exact: true }).last()).toBeEnabled()
  const switchReceipt = page.waitForResponse(response =>
   new URL(response.url()).pathname === "/api/agents/reviewer/model" && response.request().method() === "PUT")
  await journeyActivate(page.getByRole("button", { name: "Save", exact: true }).last())
  const switchedResponse = await switchReceipt
  expect(switchedResponse.status()).toBe(200)
  expect(switchedResponse.request().postDataJSON().model.modelId).toBe(modelB)
  await attachJson(info, "owner-switch-receipt", { observedAt: new Date().toISOString(), response: await switchedResponse.json() })
  await expect(page.locator('[data-agent="reviewer"]')).toContainText(modelB)
  expect((await f.read("Will", "/api/todos")).map((row: any) => row.n ?? row.number)).toEqual(before.map((row: any) => row.n ?? row.number))
  const settings = f.sql("SELECT key,value FROM install_settings WHERE key='agent:reviewer'")
  expect(settings).toHaveLength(1)
  expect(settings[0].value.modelId).toBe(modelB)
  await attachJson(info, "reviewer-owner-setting", settings)
  await runSlash(f.members.Alice.page, "/agents")
  await expect(f.members.Alice.page.getByTestId("agent-model-reviewer")).toHaveCount(0)
  await runSlash(f.members.Alice.page, "/agents")
  for (const id of ["planner", "implementer", "reviewer", "app"]) {
   await expect(f.members.Alice.page.locator(`[data-agent="${id}"]`)).toBeVisible()
   await expect(f.members.Alice.page.getByTestId(`agent-model-${id}`)).toHaveCount(0)
  }
  await expect(f.members.Alice.page.locator('[data-agent="reviewer"]')).toContainText(modelB)
  await info.attach("member-agent-card", { body: await f.members.Alice.page.getByTestId("card-agents").innerText(), contentType: "text/plain" })
  const denied = await f.members.Alice.context.request.put("/api/agents/reviewer/model", {
   data: { model: { protocol: "openai-responses", modelId: modelA, credential: "OPENAI_API_KEY" } }
  })
  expect(denied.status()).toBe(403)
  expect((await denied.json()).class).toBe("permission")
  await runSlash(f.members.Ben.page, "/agents")
  await expect(f.members.Ben.page.getByTestId("agent-model-reviewer")).toHaveCount(0)
  const maintainerDenied = await f.members.Ben.context.request.put("/api/agents/reviewer/model", {
   data: { model: { protocol: "openai-responses", modelId: modelA, credential: "OPENAI_API_KEY" } }
  })
  expect(maintainerDenied.status()).toBe(403)
  expect((await maintainerDenied.json()).class).toBe("permission")
  await attachJson(info, "member-model-write-refusal", await denied.json())
  await attachJson(info, "maintainer-model-write-refusal", await maintainerDenied.json())
  const delegated = await f.members.Alice.context.request.put("/api/agents/reviewer/model", {
   headers: { Authorization: `Bearer ${required("SMITHERS_JOURNEY_DELEGATED_TOKEN")}` },
   data: { model: { protocol: "openai-responses", modelId: modelA, credential: "OPENAI_API_KEY" } }
  })
  expect(delegated.status()).toBe(403)
  expect((await delegated.json()).class).toBe("permission")
  await attachJson(info, "delegated-model-write-refusal", await delegated.json())
  expect(f.sql("SELECT value FROM install_settings WHERE key='agent:reviewer'")[0].value.modelId).toBe(modelB)
  const switched = await f.read("Will", "/api/agents")
  expect(switched.agents.find((row: any) => row.id === "reviewer").source).toBe("owner")
  await attachJson(info, "agents-after-switch", switched)
  await expect.poll(async () => {
   const agents = await f.read("Will", "/api/agents")
   return agents.agents.find((row: any) => row.id === "reviewer").runs.some((run: any) =>
    run.model === modelB && !priorReviewerRuns.some((old: any) => old.id === run.id && old.model === modelB) && bindingsBefore.some(binding => binding.binding_id === run.id))
  }, { timeout: 780_000, intervals: [2000, 5000] }).toBe(true)
  const bindingsAfter = f.sql("SELECT id,binding_id,runtime_artifact_digest FROM flow_runtime_host_bindings WHERE binding_kind='mythical-item'")
  for (const binding of bindingsBefore) {
   expect(bindingsAfter.find(row => row.id === binding.id)?.runtime_artifact_digest).toBe(binding.runtime_artifact_digest)
  }
  await attachJson(info, "ongoing-todo-bindings-after-switch", bindingsAfter)
  const beforeY = await f.read("Will", "/api/todos")
  await createTodo(page, "Add a short repository overview to README.md")
  let newTodos: any[] = []
  await expect.poll(async () => {
   const afterY = await f.read("Will", "/api/todos")
   newTodos = afterY.filter((row: any) => !beforeY.some((old: any) => old.n === row.n))
   return newTodos.length
  }, { timeout: 30_000 }).toBe(1)
  const numberY = newTodos[0].n
  expect(Number.isSafeInteger(numberY)).toBe(true)
  const itemY = f.sql(`SELECT id FROM mythical_items WHERE number=${numberY} AND repository_id=(SELECT (value->>'repository_id')::bigint FROM install_settings WHERE key='github.repository')`)
  expect(itemY).toHaveLength(1)
  await expect.poll(async () => {
   const agents = await f.read("Will", "/api/agents")
   return agents.agents.find((row: any) => row.id === "reviewer").runs.some((run: any) =>
    run.model === modelB && run.id === itemY[0].id)
  }, { timeout: 780_000, intervals: [2000, 5000] }).toBe(true)
  // Remove through the same Settings flow a person uses on the install.
  const fastSetting = f.sql("SELECT value FROM install_settings WHERE key='agent:fast'")
  expect(fastSetting).toHaveLength(1)
  const fastCredential = fastSetting[0].value.credential
  expect(fastCredential).toEqual(expect.any(String))
  expect(fastCredential.length).toBeGreaterThan(0)
  const codingSetting = f.sql("SELECT value FROM install_settings WHERE key='agent:coding'")
  expect(codingSetting).toHaveLength(1)
  expect(fastCredential, "Use separate fast and coding keys for the removal journey").not.toBe(codingSetting[0].value.credential)
  await runSlash(page, "/settings")
  const removal = page.waitForResponse(response => new URL(response.url()).pathname === "/api/model/credential" && response.request().method() === "POST")
  await journeyActivate(page.getByTestId("settings-key-remove-fast"))
  const removed = await removal
  expect(removed.request().postDataJSON()).toMatchObject({ action: "remove", name: fastCredential })
  expect(removed.status()).toBe(200)
  expect((await removed.json()).ok).toBe(true)
  await expect(page.getByTestId("settings-key-remove-fast")).toHaveCount(0)
  await attachJson(info, "fast-credential-removal", await removed.json())
  expect((await ask(modelA)).trim()).not.toMatch(/\bDONE[.!]?$/)
  const readInstructions = async () => {
   const response = await page.context().request.get("/api/branches/main/files/.smithers/instructions/app.md")
   expect(response.status()).toBe(200)
   return response.json()
  }
  const original = await readInstructions()
  await journeyActivate(page.locator('[data-agent="app"] [data-flow="files.read"]'))
  await expect(page.getByRole("textbox", { name: ".smithers/instructions/app.md", exact: true }).locator(".cm-line")).toHaveText(original.content.text.split("\n"))
  const beforeInstructions = await f.read("Will", "/api/todos")
  await ask(modelA, 'Update your instructions in .smithers/instructions/app.md to always end answers with the word DONE. Propose a TODO and wait for my confirmation.')
  const proposal = page.locator('.smithers-card[data-kind="confirm"]').filter({ hasText: ".smithers/instructions/app.md" }).last()
  await expect(proposal).toBeVisible()
  await expect(proposal.getByRole("button", { name: "Commit", exact: true })).toBeEnabled()
  expect((await f.read("Will", "/api/todos")).map((row: any) => row.n)).toEqual(beforeInstructions.map((row: any) => row.n))
  expect((await readInstructions()).content.text).toBe(original.content.text)
  await info.attach("instruction-proposal-before-confirmation", { body: await proposal.innerText(), contentType: "text/plain" })
  await journeyActivate(proposal.getByRole("button", { name: "Commit", exact: true }))
  let instructionTodos: any[] = []
  await expect.poll(async () => {
   instructionTodos = (await f.read("Will", "/api/todos")).filter((row: any) =>
    !beforeInstructions.some((old: any) => old.n === row.n))
   return instructionTodos.length
  }, { timeout: 30_000 }).toBe(1)
  await attachJson(info, "confirmed-instruction-todo", instructionTodos[0])
  await attachJson(info, "instruction-todo-after-confirmation", await f.read("Will", "/api/todos"))
  expect((await ask(modelA)).trim()).not.toMatch(/\bDONE[.!]?$/)
  // A person merges the instruction PR; the observer never grants merge authority.
  expect((await readInstructions()).content.text).toBe(original.content.text)
  await expect.poll(async () => (await readInstructions()).content.text, {
   timeout: 900_000, intervals: [1000, 2000]
  }).toContain("always end answers with the word DONE")
  const activated = await readInstructions()
  expect((await ask(modelA)).trim()).toMatch(/\bDONE[.!]?$/)
  expect(activated.digest).not.toBe(original.digest)
  await attachJson(info, "activated-app-instructions", activated)
  await runSlash(page, "/help")
  for (const name of ["model", "model.list", "model.new", "model.edit", "model.save", "model.show", "model.remove", "model.test", "model.assign", "model.compose", "model.ask", "model.fixture"]) {
   await expect(page.locator('.smithers-card[data-kind="commands"]').last().getByText(name, { exact: true })).toHaveCount(0)
  }
  await info.attach("owner-help", { body: await page.locator('.smithers-card[data-kind="commands"]').last().innerText(), contentType: "text/plain" })
  await prepareComposer("/")
  const palette = page.getByTestId("palette")
  await expect(palette).toBeVisible()
  await expect(palette).toContainText("help")
  for (const name of ["model.compose", "model.ask", "model.fixture", "model.save", "model.remove", "model.assign"]) {
   await expect(palette.locator(`[data-flow="${name}"]`)).toHaveCount(0)
  }
  await info.attach("owner-palette", { body: await palette.innerText(), contentType: "text/plain" })
  await prepareComposer("")
  await page.reload()
  await runSlash(page, "/agents")
  await expect(page.locator('[data-agent="reviewer"]')).toContainText(modelB)
  await journeyActivate(page.locator('[data-agent="app"] [data-flow="files.read"]'))
  await expect(page.getByRole("textbox", { name: ".smithers/instructions/app.md", exact: true }).locator(".cm-line")).toHaveText(activated.content.text.split("\n"))
 })
})
