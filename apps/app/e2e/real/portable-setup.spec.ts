import { createHash, randomUUID } from "node:crypto"
import { SetupOperationResponseSchema } from "@smthrs/rpc/RepositorySetup"
import { authenticatedTest } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { attachJson, runSlash } from "./issues/local"
import { pushMainFiles, withOwnedRepository } from "./portable/owned-repository"
import { finishFirstVisit } from "./support/first-visit"
import { awaitBoot, expect, openComposer, productUrl, realApi, reloadApp } from "./support/test"

authenticatedTest.setTimeout(300_000)

authenticatedTest("repository inspection survives reload and keeps Chat usable until the actual job completes", scenario("setup.inspect-recovery", {
  capabilities: ["identity", "cloud"],
  description: "Inspect an owned repository through the real setup dispatcher, keep Chat usable during execution, deduplicate repeated input, reconnect after reload, and verify the captured source and terminal receipt before keyboard re-inspection.",
  coverage: ["action:setup.run", "action:issues.setup", "host:local", "host:production", "path:success", "path:persistence", "path:keyboard", "door:slash", "door:button", "dimension:reload", "dimension:keyboard", "dimension:background-work", "evidence:setup-terminal-receipt-and-captured-source"]
}), async ({ page, request }, testInfo) => {
  await withOwnedRepository(page, request, async repo => {
    const marker = randomUUID()
    const readme = `# Setup inspection\n\nRepository proof: ${marker}\n`
    await pushMainFiles(page, request, repo, { "README.md": readme })
    const admitted: string[] = []
    page.on("request", sent => {
      if (sent.method() === "POST" && new URL(sent.url()).pathname === "/api/repository-setup/inspect") {
        admitted.push(sent.postDataJSON().requestId)
      }
    })
    const started = performance.now()
    await page.goto(productUrl(page, `/${repo.fullName}`), { waitUntil: "domcontentloaded" })
    await awaitBoot(page, "navigate", started)
    await finishFirstVisit(page)
    const launch = page.waitForResponse(response => response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/repository-setup/inspect")
    void launch.catch(() => undefined)
    await runSlash(page, `/issues.setup ${repo.fullName}`)
    const accepted = await launch
    expect(accepted.status()).toBe(202)
    const initial = SetupOperationResponseSchema.parse(await accepted.json())
    expect(initial.receipt?.phase).toBe("queued")
    const setup = page.getByTestId("setup-issues")
    const observe = async () => {
      const response = await realApi(page, request, "GET", `/api/repository-setup/observe?${new URLSearchParams({ repo: repo.fullName, job: "issues", requestId: initial.requestId })}`)
      expect([200, 202]).toContain(response.status())
      return SetupOperationResponseSchema.parse(await response.json())
    }
    await expect.poll(async () => (await observe()).receipt?.phase, { timeout: 120_000 }).toBe("running")
    const running = await observe()
    expect(running.receipt?.runId).toEqual(expect.any(String))
    await expect(setup.locator("footer")).toContainText("Running")
    const toast = page.locator('[data-toast-status="running"]').filter({ hasText: "Handle issues" })
    await expect(toast).toBeVisible()
    // Repeating the same act joins the durable request; it must not launch twice.
    const cardId = `setup:${encodeURIComponent(repo.fullName.split("/")[0]!)}:${encodeURIComponent(repo.fullName)}:issues`
    await runSlash(page, `/setup.run ${JSON.stringify({ cardId, operation: "inspect" })}`)
    // Chat stays usable while the job runs. Before the first job registers the
    // hosted app holds Chat's button, so Command-K is the door.
    await openComposer(page)
    const composer = page.getByTestId("composer-input")
    await composer.fill(`Keep this draft while inspecting ${marker}`)
    await expect(composer).toHaveValue(`Keep this draft while inspecting ${marker}`)
    expect((await observe()).receipt?.phase).toBe("running")
    await composer.press("Escape")
    await reloadApp(page)
    await expect(setup).toBeVisible()
    await expect(setup.locator("footer")).toContainText("Running")
    await expect(toast).toBeVisible()
    expect((await observe()).receipt?.runId).toBe(running.receipt!.runId)
    expect(admitted).toEqual([initial.requestId])

    await expect.poll(async () => (await observe()).receipt?.phase, { timeout: 120_000 }).toBe("completed")
    const completed = await observe()
    expect(completed.receipt).toMatchObject({ requestId: initial.requestId, runId: running.receipt!.runId, operation: "inspect" })
    // Inspection snapshots the box's working copy, including host preparation.
    // Its immutable capture can differ from the pushed parent commit.
    expect(completed.receipt?.sourceRevision).toMatch(/^[0-9a-f]{40}$/)
    expect(completed.inspection?.suggestedDraft.cases.length).toBeGreaterThan(0)
    for (const item of completed.inspection!.suggestedDraft.cases) {
      expect(JSON.parse(item.input).sourceRevision).toBe(completed.receipt!.sourceRevision)
    }
    expect(completed.inspection?.sources).toContainEqual(expect.objectContaining({ path: "README.md", status: "read", revision: createHash("sha256").update(readme).digest("hex") }))
    await expect(setup.getByRole("button", { name: "Inspect repository", exact: true })).toBeEnabled()
    await expect(toast).toHaveCount(0)
    await setup.getByText("Repository evidence", { exact: true }).press("Enter")
    await expect(setup.locator("details").filter({ hasText: "Repository evidence" })).toContainText("README.md · read")
    await attachJson(testInfo, "completed-setup-inspection", completed)

    const repeated = page.waitForResponse(response => response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/repository-setup/inspect")
    void repeated.catch(() => undefined)
    await setup.getByRole("button", { name: "Inspect repository", exact: true }).press("Enter")
    const again = SetupOperationResponseSchema.parse(await (await repeated).json())
    expect(again.requestId).not.toBe(initial.requestId)
    await expect.poll(async () => {
      const response = await realApi(page, request, "GET", `/api/repository-setup/observe?${new URLSearchParams({ repo: repo.fullName, job: "issues", requestId: again.requestId })}`)
      return SetupOperationResponseSchema.parse(await response.json()).receipt?.phase
    }, { timeout: 120_000 }).toBe("completed")
    expect(admitted).toEqual([initial.requestId, again.requestId])
  })
})
