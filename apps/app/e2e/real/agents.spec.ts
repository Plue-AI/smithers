import { AGENT_ROLES } from "@smthrs/rpc/AgentRoles"
import type { Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { closeComposer, command, expect, reloadApp, test } from "./support"
import { openApp, awaitBoot } from "./support"
const boot = async (page: Page) => { const at = performance.now(); await openApp(page); await awaitBoot(page, "navigate", at) }

const BUILTIN_ROLE_IDS = AGENT_ROLES.map((role) => role.id)

const agentsCard = (page: Page) => page.getByTestId("card-agents")
const cards = (page: Page) => page.locator(".smithers-card")
const agentRows = (page: Page) => agentsCard(page).locator("[data-testid=\"agents-list\"] > li.agent-row")

/** The rendered rows lead with the shipped role catalog, in its order, each with its label and its runs door. */
const expectBuiltinRoles = async (page: Page): Promise<void> => {
  await expect(agentsCard(page)).toHaveAttribute("data-kind", "agents")
  await expect.poll(() => agentRows(page).evaluateAll((rows, ids) => rows.map((row) => row.getAttribute("data-agent")).slice(0, ids.length), BUILTIN_ROLE_IDS))
    .toEqual(BUILTIN_ROLE_IDS)
  for (const role of AGENT_ROLES) {
    const row = agentRows(page).and(page.locator(`[data-agent="${role.id}"]`))
    await expect(row.locator("strong")).toHaveText(role.label)
    await expect(row).toContainText(role.model.label)
    await expect(row.getByTestId(`agent-runs-${role.id}`)).toBeVisible()
  }
}

test("/agent.list opens one durable Agents card that survives a reload", scenario("agents.list-doors-reload", {
  capabilities: [],
  coverage: [
    "action:agent.list", "host:local", "path:success", "path:persistence",
    "door:slash", "dimension:reload", "evidence:persisted-card-after-reload"
  ]
}), async ({ page }) => {
  await boot(page)
  await expect(agentsCard(page)).toHaveCount(0)

  await command(page, "/agent.list")
  await closeComposer(page)
  await expectBuiltinRoles(page)

  // A later card takes the tail; a second /agent.list brings the same Agents card back to it instead of adding a second.
  await command(page, "/account.show")
  await closeComposer(page)
  await expect(cards(page).last()).toHaveAttribute("data-kind", "account")
  await command(page, "/agent.list")
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
