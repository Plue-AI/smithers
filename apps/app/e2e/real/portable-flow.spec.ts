import { randomUUID } from "node:crypto"
import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { awaitBoot, expect, productUrl, realApi } from "./support/test"
import { runSlash } from "./issues/local"
import { finishFirstVisit } from "./support/first-visit"
import { pushMainFiles, runningWorkspace, withOwnedRepository } from "./portable/owned-repository"
import { readWorkspaceText } from "./run-inspection/seeded-flow"

authenticatedTest.setTimeout(420_000)

/** A project flow the box's coding host serves from the repository's own checkout. */
const proofFlow = (marker: string): string => [
  "---",
  "description: Write a proof file in the box.",
  'capabilities: ["fs:read:**", "fs:write:**"]',
  "model: coding/implement",
  "budget:",
  "  tokens: 60000",
  "  milliseconds: 240000",
  "---",
  "",
  `Write the file flow-proof.txt containing exactly the line ${JSON.stringify(marker)} followed by a newline, read it back, and finish.`,
  ""
].join("\n")

authenticatedTest("an owned repository runs a declared Flow on its box and exposes its durable result", scenario("flows.product-run", {
  capabilities: ["identity", "cloud"],
  coverage: ["action:box.view", "action:flow.list", "action:flow.run", "host:local", "host:production", "path:success", "door:slash", "surface:flow-api", "dimension:default-box", "evidence:accepted-run-terminal-projection-and-box-file"]
}), async ({ page, request }) => {
  await withOwnedRepository(page, request, async (repo) => {
    const marker = randomUUID()
    await pushMainFiles(page, request, repo, { "flows/proof/flow.mdx": proofFlow(marker) })
    await runningWorkspace(page, request, repo, async (workspaceId) => {
      const startedAt = performance.now()
      await page.goto(productUrl(page, `/${repo.fullName}`), { waitUntil: "domcontentloaded" })
      await awaitBoot(page, "navigate", startedAt)
      await finishFirstVisit(page)

      // The app has loaded the new box (viewing it does not select it).
      await runSlash(page, `/box.view ${workspaceId}`)
      await expect(page.getByTestId(`card-workspace-${workspaceId}`)).toBeVisible({ timeout: 60_000 })
      // No box is selected: the run binds to the repository's one running box.
      const accepted = page.waitForResponse((response) => {
        if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/workflow/rpc") return false
        const body = response.request().postDataJSON() as { readonly procedure?: string; readonly repo?: string }
        return body.procedure === "Run" && body.repo === repo.fullName
      }, { timeout: 240_000 })
      await runSlash(page, `/flow.run proof ${repo.fullName} {}`)
      const response = await accepted
      expect((response.request().postDataJSON() as { readonly workspaceId?: string }).workspaceId).toBe(workspaceId)
      expect(response.status()).toBe(200)
      const run = await response.json() as { readonly ok?: boolean; readonly payload?: { readonly runId?: string } }
      expect(run.ok).toBe(true)
      expect(run.payload?.runId).toEqual(expect.any(String))

      const list = await realApi(page, request, "POST", "/api/workflow/rpc", {
        repo: repo.fullName, workspaceId, procedure: "List", payload: { _tag: "flows" }
      })
      expect(list.status()).toBe(200)
      const catalog = await list.json() as { readonly ok?: boolean; readonly payload?: { readonly items?: ReadonlyArray<{ readonly flowId?: string }> } }
      expect(catalog.ok).toBe(true)
      expect(catalog.payload?.items?.map(({ flowId }) => flowId), "the box's coding host serves the declared project flow").toContain("proof")

      await expect.poll(async () => {
        const projection = await realApi(page, request, "POST", "/api/workflow/rpc", {
          repo: repo.fullName, workspaceId, procedure: "Projection.Snapshot",
          payload: { selector: { _tag: "run-summary", runId: run.payload!.runId } }
        })
        expect(projection.status()).toBe(200)
        const body = await projection.json() as { readonly ok?: boolean; readonly payload?: { readonly rows?: ReadonlyArray<{ readonly status?: string }> } }
        expect(body.ok).toBe(true)
        return body.payload?.rows?.[0]?.status
      }, { timeout: 300_000, intervals: [1_000, 2_000, 5_000] }).toBe("completed")
      // The run card in the transcript reaches the same terminal state.
      await expect(page.locator(`.smithers-card[data-kind="run-trace"][data-run-id="${run.payload!.runId}"]`))
        .toHaveAttribute("data-status", "acted", { timeout: 60_000 })
      expect(await readWorkspaceText(page, request, repo.fullName, workspaceId, "flow-proof.txt")).toContain(marker)
    })
  })
})

authenticatedTest("a flow list with no box of the repository asks for one instead of answering empty", scenario("flows.product-no-box", {
  capabilities: ["identity", "cloud"],
  coverage: ["action:flow.list", "host:local", "host:production", "path:error", "door:slash", "dimension:no-box", "evidence:failure-toast-and-no-relay-call"]
}), async ({ page, request }) => {
  await withOwnedRepository(page, request, async (repo) => {
    const relayed: Array<string> = []
    page.on("request", (sent) => {
      if (new URL(sent.url()).pathname.startsWith("/api/workflow/")) relayed.push(sent.url())
    })
    const startedAt = performance.now()
    await page.goto(productUrl(page, `/${repo.fullName}`), { waitUntil: "domcontentloaded" })
    await awaitBoot(page, "navigate", startedAt)
    await finishFirstVisit(page)
    await runSlash(page, `/flow.list ${repo.fullName}`)
    await expect(page.locator('[data-toast-status="failed"]').filter({ hasText: `Open a box of ${repo.fullName} first` })).toBeVisible()
    expect(relayed).toEqual([])
  })
})
