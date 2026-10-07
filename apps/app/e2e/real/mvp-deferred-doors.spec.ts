import { authenticatedTest as test } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { awaitBoot, closeComposer, command, expect, openApp, openComposer } from "./support"
import type { ProviderJournalEntry } from "./support/model-provider-behaviors"

// Reviewed literals: never derive the oracle from the registry or cuts manifest.
const deferred = [
  "billing.balance", "billing.plans", "billing.upgrade", "billing.portal",
  "cloud.prompt", "cloud.sign-in", "cloud.sign-out", "repo.choose", "repo.create",
  "repo.select", "repo.overview", "repo.update", "repos.import", "repos.import.retry",
  "flow.repo.choose", "triggers.list", "triggers.register", "triggers.pause",
  "triggers.run", "triggers.approve", "triggers.resume", "sync.ops.show-more",
  "box.facet", "box.egress", "box.services", "box.images", "egress.allow",
  "egress.session", "runs.signal", "prs.review", "review.request", "review.unrequest",
  "review.since-mine", "review.done", "review.ack", "review.reopen", "issue.repro",
  "issue.poc", "issue.add-flow", "issue.flows"
] as const

// Run against an isolated install configured with support/model-provider.ts.
// No browser routing, seeded DesignWorld, or synthetic disclosure substitutes
// for the production app turn and the host's model request.
test("the install has no deferred shell, discovery or app-agent door", scenario("mvp.deferred-doors", {
  capabilities: ["install"],
  coverage: ["action:help", "action:chat.send", "action:palette.open", "host:local", "door:slash", "door:button", "door:agent", "path:success", "dimension:deferred-doors", "evidence:production-model-disclosure"]
}), async ({ page, request }, info) => {
  expect(process.env.SMITHERS_REAL_BASE_URL, "requires an isolated production install").toBeTruthy()
  const journalURL = process.env.SMITHERS_DEFERRED_PROVIDER_JOURNAL_URL
  expect(journalURL, "requires the install's loopback model provider journal").toBeTruthy()
  const bootstrap = await request.get("/api/bootstrap")
  expect(bootstrap.status()).toBe(200)
  expect((await bootstrap.json()).capabilities).toContain("install")
  const start = performance.now()
  await openApp(page)
  await awaitBoot(page, "navigate", start)
  expect((await page.request.get("/api/user")).status(), "requires an authenticated install member").toBe(200)
  const assertNoShellDoor = async () => {
    for (const id of deferred) await expect(page.locator(`[data-flow="${id}"]:visible`)).toHaveCount(0)
    for (const kind of ["balance", "billing-plans", "anonymous-ceiling", "repository-choice"])
      await expect(page.locator(`.smithers-card[data-kind="${kind}"]:visible`)).toHaveCount(0)
    await expect(page.getByTestId("anonymous-ceiling")).toHaveCount(0)
    await expect(page.getByTestId("repository-choice")).toHaveCount(0)
  }
  await assertNoShellDoor()
  await openComposer(page)
  const input = page.getByTestId("composer-input")
  await input.fill("/")
  const palette = page.getByTestId("palette")
  await expect(palette).toBeVisible()
  // Positive control: an empty or broken palette cannot pass absence.
  await expect(palette).toContainText("help")
  for (const id of deferred) expect(await palette.textContent()).not.toContain(`/${id}`)
  for (const query of ["billing", "triggers", "repo.choose", "box.images", "runs.signal", "review.request", "issue.repro"]) {
    await input.fill(`/${query}`)
    for (const id of deferred) expect((await palette.locator('[role="option"]').allTextContents()).join("\n")).not.toContain(`/${id}`)
    for (const id of deferred) await expect(palette.locator(`[data-flow="${id}"]`)).toHaveCount(0)
  }
  await closeComposer(page)
  await command(page, "/help")
  const help = page.getByRole("article", { name: "Commands", exact: true }).last()
  await expect(help).toBeVisible()
  await expect(help).toContainText("/help")
  for (const id of deferred) expect(await help.textContent()).not.toContain(`/${id}`)
  const readJournal = async (): Promise<ProviderJournalEntry[]> => {
    const response = await request.get(journalURL!)
    expect(response.status()).toBe(200)
    return await response.json() as ProviderJournalEntry[]
  }
  const before = (await readJournal()).length
  await command(page, "What commands can you run here?")
  await expect.poll(async () => (await readJournal()).slice(before).some(entry => entry.toolNames?.includes("commands") && (entry.disclosedCommands?.length ?? 0) > 0)).toBe(true)
  const turns = (await readJournal()).slice(before).filter(entry => entry.toolNames?.includes("commands"))
  expect(turns.length).toBeGreaterThan(0)
  for (const turn of turns) {
    expect(turn.authorized).toBe(true)
    expect(turn.disclosedCommands?.length).toBeGreaterThan(0)
    for (const id of deferred) expect(turn.disclosedCommands).not.toContain(id)
  }
  await info.attach("app-agent-disclosure", { body: JSON.stringify(turns), contentType: "application/json" })
  await expect(page.getByTestId("transcript")).toHaveAttribute("aria-busy", "false")
  await assertNoShellDoor()
})
