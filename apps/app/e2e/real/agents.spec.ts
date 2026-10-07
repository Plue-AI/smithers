import type { Page } from "@playwright/test"
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
 test.setTimeout(1_800_000)
 await withReference(browser, info, async f => {
  const page = f.members.Will.page
  const modelA = required("SMITHERS_AGENT_MODEL_A")
  const modelB = required("SMITHERS_AGENT_MODEL_B")
  const modelF = required("SMITHERS_AGENT_MODEL_F")
  await runSlash(page, "/agents")
  for (const [id, label, model] of [
   ["planner", "Planner agent", modelA], ["implementer", "Implementer agent", modelA],
   ["reviewer", "Reviewer agent", modelA], ["app", "App agent", modelF]
  ]) {
   const row = page.locator(`[data-agent="${id}"]`)
   await expect(row).toContainText(label!)
   await expect(row).toContainText(model!)
   await expect(row.locator('[data-flow="files.read"]')).toBeVisible()
  }
  const install = await f.read("Will", "/api/install")
  expect(install.models.map((row: any) => row.role)).toEqual(["fast", "coding", "jev"])
  await runSlash(page, "/settings")
  for (const label of ["Fast model", "Coding model", "Decisions"])
   await expect(page.getByText(label, { exact: true }).last()).toBeVisible()
  await runSlash(page, "/agents")
  const before = await f.read("Will", "/api/todos")
  await page.getByTestId("agent-model-reviewer").press("Enter")
  await page.getByLabel("Model", { exact: true }).last().fill(modelB)
  await page.getByRole("button", { name: "Save", exact: true }).last().press("Enter")
  await expect(page.locator('[data-agent="reviewer"]')).toContainText(modelB)
  expect((await f.read("Will", "/api/todos")).map((row: any) => row.n ?? row.number)).toEqual(before.map((row: any) => row.n ?? row.number))
  const settings = f.sql("SELECT key,value FROM install_settings WHERE key='agent:reviewer'")
  expect(settings).toHaveLength(1)
  expect(settings[0].value.modelId).toBe(modelB)
  await attachJson(info, "reviewer-owner-setting", settings)
  await runSlash(f.members.Alice.page, "/agents")
  await expect(f.members.Alice.page.getByTestId("agent-model-reviewer")).toHaveCount(0)
  const denied = await f.members.Alice.context.request.put("/api/agents/reviewer/model", {
   data: { model: { protocol: "openai-responses", modelId: modelA, credential: "OPENAI_API_KEY" } }
  })
  expect(denied.status()).toBe(403)
  expect((await denied.json()).class).toBe("permission")
  const delegated = await f.members.Alice.context.request.put("/api/agents/reviewer/model", {
   headers: { Authorization: `Bearer ${required("SMITHERS_JOURNEY_DELEGATED_TOKEN")}` },
   data: { model: { protocol: "openai-responses", modelId: modelA, credential: "OPENAI_API_KEY" } }
  })
  expect(delegated.status()).toBe(403)
  expect((await delegated.json()).class).toBe("permission")
  const switched = await f.read("Will", "/api/agents")
  expect(switched.agents.find((row: any) => row.id === "reviewer").source).toBe("owner")
  await attachJson(info, "agents-after-switch", switched)
  await expect.poll(async () => {
   const agents = await f.read("Will", "/api/agents")
   return agents.agents.find((row: any) => row.id === "reviewer").runs.some((run: any) => run.model === modelB)
  }, { timeout: 780_000, intervals: [2000, 5000] }).toBe(true)
  const readInstructions = async () => {
   const response = await page.context().request.get("/api/branches/main/files/.smithers/instructions/app.md")
   expect(response.status()).toBe(200)
   return response.json()
  }
  const original = await readInstructions()
  await page.locator('[data-agent="app"] [data-flow="files.read"]').press("Enter")
  await expect(page.getByText(original.content.text, { exact: true }).last()).toBeVisible()
  await createTodo(page, 'Update .smithers/instructions/app.md to always end answers with the word DONE')
  // A person merges the instruction PR; the observer never grants merge authority.
  expect((await readInstructions()).content.text).toBe(original.content.text)
  await expect.poll(async () => (await readInstructions()).content.text, {
   timeout: 900_000, intervals: [1000, 2000]
  }).toContain("always end answers with the word DONE")
  const activated = await readInstructions()
  expect(activated.digest).not.toBe(original.digest)
  await attachJson(info, "activated-app-instructions", activated)
  await page.reload()
  await runSlash(page, "/agents")
  await expect(page.locator('[data-agent="reviewer"]')).toContainText(modelB)
  await page.locator('[data-agent="app"] [data-flow="files.read"]').press("Enter")
  await expect(page.getByRole("textbox", { name: ".smithers/instructions/app.md", exact: true })).toContainText(activated.content.text)
 })
})
