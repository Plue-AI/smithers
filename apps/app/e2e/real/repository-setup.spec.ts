import { awaitBoot, closeComposer, command, expect, realApi, reloadApp, test } from "./support/test"
import { scenario } from "./coverage/types"
import { fixtureInputText } from "./support/values"

test("public setup drafts for all five jobs retain keyboard edits without starting repository work", scenario("setup.public-drafts-keyboard-reload", {
  capabilities: ["identity", "cloud"],
  description: "Use the actual signed-out app at 320px to open every built-in job, edit its prompt through the keyboard controls, reload each draft, and confirm independent values persist without setup or workflow requests. This proves local draft configuration, not backend job execution.",
  coverage: ["action:issues.setup", "action:review.setup", "action:ci.setup", "action:feature.setup", "action:chores.setup", "action:setup.configure", "action:setup.view", "host:local", "host:production", "path:success", "path:permission", "path:persistence", "path:keyboard", "door:slash", "door:button", "dimension:keyboard", "dimension:narrow-viewport", "dimension:reload", "dimension:signed-out", "evidence:independent-draft-readback-and-no-work-requests"]
}), async ({ page, request }, testInfo) => {
  testInfo.setTimeout(180_000)
  const repo = "smithersai/smithers"
  const jobs = ["issues", "review", "ci", "feature", "chores"] as const
  const work: string[] = []
  page.on("request", entry => {
    const path = new URL(entry.url()).pathname
    if (path.startsWith("/api/repository-setup/") || entry.method() === "POST" && path.startsWith("/api/workflow/")) work.push(path)
  })
  await page.setViewportSize({ width: 320, height: 800 })
  const started = performance.now()
  await page.goto(`/${repo}`, { waitUntil: "domcontentloaded" })
  await awaitBoot(page, "navigate", started)
  expect(await (await realApi(page, request, "GET", "/api/auth/session")).json()).toMatchObject({ status: "signed-out" })
  for (const job of jobs) {
    const value = fixtureInputText(`Review ${job} evidence before changing this repository.`)
    await command(page, `/${job}.setup ${repo}`)
    await closeComposer(page)
    const setup = page.getByTestId(`setup-${job}`)
    await expect(setup).toBeVisible()
    await expect(setup.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
    await expect(setup.getByRole("button", { name: "Inspect repository", exact: true })).toHaveCount(0)
    await setup.getByRole("button", { name: "Prompts", exact: true }).press("Enter")
    const prompt = setup.getByRole("textbox", { name: "Prompt", exact: true })
    await prompt.fill(value)
    await prompt.press("Tab")
    // A subsequent durable view command waits for the queued prompt edit.
    await setup.getByRole("button", { name: "Flows", exact: true }).press("Enter")
    await expect(prompt).toHaveCount(0)
    await setup.getByRole("button", { name: "Prompts", exact: true }).press("Enter")
    await expect(prompt).toHaveValue(value)
    await reloadApp(page)
    await expect(prompt).toHaveValue(value)
    const overflowing = await setup.evaluate(node => [...node.querySelectorAll<HTMLElement>("input, textarea, select, button")]
      .filter(element => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
      .map(element => element.tagName))
    expect(overflowing).toEqual([])
    expect(work).toEqual([])
  }
  // Editing another job must never reuse or replace an earlier job's draft.
  for (const job of jobs) {
    const value = fixtureInputText(`Review ${job} evidence before changing this repository.`)
    await expect(page.getByTestId(`setup-${job}`).getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue(value)
  }
  expect(await (await realApi(page, request, "GET", "/api/auth/session")).json()).toMatchObject({ status: "signed-out" })
  expect(work).toEqual([])
  await testInfo.attach("setup-draft-readback", { contentType: "application/json", body: Buffer.from(JSON.stringify({ jobs, width: 320, workRequests: work })) })
})
