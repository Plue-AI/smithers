import { expect } from "@playwright/test"
import { showcase } from "../showcase"
import { runningBox } from "../../playwright/cloudFixture"

const REPO = "smithersai/smithers"
const gate = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

export default showcase({
  id: "background-work",
  order: 50,
  title: "Background work",
  summary: "A flow launch returns at once; its toast runs until the job really finishes.",
  flows: ["flow.run", "runs.rerun"],
  run: async ({ page, app, backend }) => {
    const preparation = gate(), launch = gate(), rerunPreparation = gate()
    let complete = false
    let rerunComplete = false
    let rerunProvisions = 0
    let runs = 0
    await backend.cloud({ capabilities: ["agent", "identity", "cloud", "cloud.pat"], workspaces: [runningBox(REPO)] })
    await backend.route(url => url.pathname === "/api/workflow/provision", async route => {
      if (runs > 0) { rerunProvisions += 1; await rerunPreparation.promise }
      else await preparation.promise
      await route.fulfill({ json: { status: "ready" } })
    })
    await backend.route(url => url.pathname === "/api/workflow/rpc", async route => {
      const call = route.request().postDataJSON() as { procedure: string; payload: { selector?: { _tag: string } } }
      let payload: unknown = {}
      if (call.procedure === "Plan") payload = { planId: "plan-background", digest: "digest", envelope: { capabilities: [], flows: [], budget: {} } }
      if (call.procedure === "Run") { await launch.promise; runs += 1; payload = { runId: runs === 1 ? "run-review-70" : "run-review-72" } }
      const runId = (call.payload.selector as { runId?: string } | undefined)?.runId ?? "run-review-70"
      const done = runId === "run-review-70" ? complete : rerunComplete
      if (call.procedure === "Projection.Snapshot") payload = { rows: call.payload.selector?._tag === "run-summary" ? [{
        runId, flowId: "review-pr", status: done ? "completed" : "running", createdAt: 1, updatedAt: done ? 3 : 2,
        turns: 3, calls: 7, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0, inputTokens: 1, outputTokens: 1,
        verdict: done ? "Done" : "Running", diagnosis: "Recorded status"
      }] : [] }
      await route.fulfill({ json: { ok: true, payload } })
    })

    await app.open("/")
    await expect(page.getByTestId("composer-input")).toBeAttached()
    await app.slash(`/flow.run review-pr ${REPO} {"args":"PR #70"}`)
    const card = page.locator('[data-kind="run-trace"]')
    await expect(card).toContainText("Requested")
    const toast = page.locator('.mvp-notify .mvp-notice[data-tone="live"]').filter({ hasText: "review-pr" })
    await expect(toast).toBeVisible()
    await app.beat(1200)

    // Chat stays usable while the launch waits on its workspace.
    await app.press("ControlOrMeta+k")
    const input = page.getByTestId("composer-input")
    await app.type(input, "Chat stays usable meanwhile")
    await expect(input).toHaveValue("Chat stays usable meanwhile")
    await expect(input).toBeEditable()
    await app.beat(800)
    await input.fill("")
    await app.closeComposer()
    await app.show(card)
    await expect(toast).toBeVisible()
    await app.beat(1000)

    preparation.release()
    await app.beat(900)
    launch.release()
    await expect(card).toHaveAttribute("data-run-id", "run-review-70")
    await expect(toast).toBeVisible()
    await app.beat(2500)

    complete = true
    // The notice settles with the run (the 300 ms law): done, then the card reads Done.
    const completed = page.locator('.mvp-notify .mvp-notice[data-tone="done"]').filter({ hasText: "review-pr" })
    await expect(completed).toBeVisible({ timeout: 15_000 })
    await expect(card).toContainText("Done")
    await app.show(card)

    // Run again: the same flow and input, a new run and a new card.
    const rerun = card.first().getByRole("button", { name: "Run again" })
    try {
      await rerun.focus()
      await page.keyboard.press("Enter")
      await expect.poll(() => rerunProvisions).toBe(1)
      await expect(card).toHaveCount(2)
      await expect(card.last()).toContainText("Requested")
      await expect(toast).toBeVisible()
      await page.keyboard.press("ControlOrMeta+k")
      await input.fill("Chat during rerun preparation")
      await expect(input).toBeEditable()
      await page.keyboard.press("Escape")
      await rerun.focus()
      await page.keyboard.press("Enter")
      await expect(card).toHaveCount(2)
      expect(runs).toBe(1)
      await page.reload()
      await expect.poll(() => rerunProvisions).toBe(2)
      await expect(card).toHaveCount(2)
      await expect(toast).toBeVisible()
    } finally { rerunPreparation.release() }
    const again = page.locator('[data-kind="run-trace"][data-run-id="run-review-72"]')
    await expect(again).toContainText("Running", { timeout: 15_000 })
    await app.show(again)
    await expect(toast).toBeVisible()
    expect(runs).toBe(2)
    rerunComplete = true
    await expect(again).toContainText("Done", { timeout: 15_000 })
    await expect(toast).toHaveCount(0)
  }
})
