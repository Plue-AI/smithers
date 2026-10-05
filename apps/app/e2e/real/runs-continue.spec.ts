/*
 * runs.continue on a real guard park (#3203): a repository-owned flow with a
 * one-token `park` budget parks its run on a Runaway guard. The run card
 * offers Continue and Stop for that incident. A continue that names another
 * request submits nothing and leaves the park pending. Continue submits the
 * incident's own published approval payload, the workspace records the
 * decision, and the run leaves that park; continuing the decided request
 * again submits nothing. Stop settles the run.
 */
import type { APIRequestContext, Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { closeComposer, command, expect } from "./support/test"
import { attachProductionJson, bootProductionRepository, enableProductionVerbose } from "./repositories-github/production"
import { workflowTest } from "./flow-execution/fixture"
import { gatewayCall, waitForTerminalRun } from "./flow-execution/production"
import type { OwnedWorkflowRepository } from "./flow-execution/fixture"
import { workflowRpcPosts } from "./run-inspection/ui"
import { awaitSeededFlow, GUARD_FLOW, restartWorkspaceHost, writeSeededFlow } from "./run-inspection/seeded-flow"
import { captureRevisions } from "./run-inspection/revisions"
import { gatherEvidence, launchSubject, readJournal } from "./run-inspection/exercise"
import { fixtureInputText } from "./support/values"

workflowTest.setTimeout(40 * 60_000)
workflowTest.use({ actionTimeout: 30_000 })

type Gate = { readonly requestId: string; readonly status: "pending" | "approved" | "denied" }

const budgetGates = async (page: Page, request: APIRequestContext, owned: OwnedWorkflowRepository, runId: string): Promise<ReadonlyArray<Gate>> => {
  const answer = await gatewayCall(page, request, owned.repo, "Projection.Snapshot", { selector: { _tag: "approvals", runId } }, owned.workspaceId)
  const rows = (answer.payload as { readonly rows?: unknown })?.rows
  expect(Array.isArray(rows), `approval projection for ${runId}`).toBe(true)
  return (rows as ReadonlyArray<Record<string, unknown>>).flatMap(row =>
    row.runId === runId && typeof row.requestId === "string" && row.requestId.startsWith(`budget/${runId}/`) &&
      (row.status === "pending" || row.status === "approved" || row.status === "denied")
      ? [{ requestId: row.requestId, status: row.status }] : [])
}

const moved = new Set(["control.run.resumed", "control.run.completed", "control.run.failed", "control.run.cancelled"])

/** Waits for the approvals read one runs.continue makes for this run. */
const approvalsRead = (page: Page, runId: string) => page.waitForResponse(response => {
  if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/workflow/rpc") return false
  const body = response.request().postDataJSON() as { readonly procedure?: unknown; readonly payload?: { readonly selector?: { readonly _tag?: unknown; readonly runId?: unknown } } } | null
  return body?.procedure === "Projection.Snapshot" && body.payload?.selector?._tag === "approvals" && body.payload.selector.runId === runId
})

workflowTest("Continue answers a real guard park through its own request and refuses any other", scenario("runs.continue-guard-park", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:runs.continue", "action:flow.run", "action:flow.run.stop", "action:box.view", "action:box.terminal",
    "action:box.suspend", "action:box.resume", "action:repo.select",
    "host:production", "path:success", "path:error", "door:button", "door:slash",
    "dimension:real-provider", "dimension:repository-owned-prompt-flow", "dimension:guard-incident",
    "dimension:stale-request-refusal", "dimension:exact-run-id",
    "evidence:approval-submit-receipt-approved-projection-and-journal"
  ],
  description: "Park a repository-owned flow on its one-token park budget, refuse a continue for another request without submitting, Continue the incident through its published payload, read the approved decision back from the projection and journal, refuse the decided request, and Stop the run."
}), async ({ page, request, workflowRepo }, testInfo) => {
  const { repo, workspaceId } = workflowRepo
  expect(workspaceId).toBeDefined()
  await bootProductionRepository(page, repo)
  await enableProductionVerbose(page)
  await command(page, `/box.view ${workspaceId}`)
  await expect(page.getByTestId(`card-workspace-${workspaceId}`)).toBeVisible()
  await closeComposer(page)
  await writeSeededFlow(page, request, repo, workspaceId, fixtureInputText(`guard-${Date.now().toString(36)}`))
  await restartWorkspaceHost(page, request, repo, workspaceId)
  await awaitSeededFlow(page, request, repo, workspaceId, GUARD_FLOW)
  const host = await captureRevisions(page, testInfo)
  await command(page, `/repo.select ${repo}#workspace:${workspaceId}`)
  await closeComposer(page)
  const posts = workflowRpcPosts(page)
  const subject = await launchSubject(page, workflowRepo, GUARD_FLOW, { args: "Print README.md's first line." }, testInfo)
  const { runId, card } = subject
  try {
    // The guard parks the run on one pending request of its own.
    let parked: Gate | undefined
    await expect.poll(async () => {
      parked = (await budgetGates(page, request, workflowRepo, runId)).find(gate => gate.status === "pending")
      return parked?.requestId
    }, { message: "the one-token budget must park the run on a pending budget request", timeout: 6 * 60_000, intervals: [1_000, 2_000, 5_000] })
      .toMatch(new RegExp(`^budget/${runId}/`))
    const incident = parked!.requestId
    const outcome = card.getByTestId(`run-outcome-${runId}`)
    await expect(outcome).toContainText("Runaway", { timeout: 60_000 })
    const continueButton = card.getByTestId(`flow-run-continue-${runId}`)
    await expect(continueButton).toBeVisible()
    await expect(card.getByTestId(`flow-run-stop-${runId}`)).toBeVisible()

    // A continue for another request submits nothing and the park stays pending.
    const unrelated = `budget/${runId}/${"0".repeat(64)}`
    const beforeUnrelated = posts.filter(procedure => procedure === "Approval.Submit").length
    const read = approvalsRead(page, runId)
    await command(page, `/runs.continue ${runId} ${unrelated}`)
    await read
    await closeComposer(page)
    expect(posts.filter(procedure => procedure === "Approval.Submit")).toHaveLength(beforeUnrelated)
    expect((await budgetGates(page, request, workflowRepo, runId)).find(gate => gate.requestId === incident)?.status).toBe("pending")

    // Continue submits the incident's own published payload, approved, once.
    const submitted = page.waitForResponse(response => {
      if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/workflow/rpc") return false
      const body = response.request().postDataJSON() as { readonly procedure?: unknown; readonly payload?: { readonly target?: { readonly requestId?: unknown } } } | null
      return body?.procedure === "Approval.Submit" && body.payload?.target?.requestId === incident
    })
    await continueButton.click()
    const response = await submitted
    const submission = response.request().postDataJSON() as {
      readonly repo?: unknown; readonly workspaceId?: unknown
      readonly payload?: { readonly decision?: unknown; readonly target?: { readonly _tag?: unknown; readonly runId?: unknown } }
    }
    const receipt = await response.json() as { readonly ok?: unknown; readonly payload?: { readonly decision?: { readonly _tag?: unknown } } }
    expect(response.status()).toBe(200)
    expect(receipt.ok).toBe(true)
    expect(["Accepted", "AlreadyApplied"]).toContain(receipt.payload?.decision?._tag)
    expect(submission.repo).toBe(repo)
    expect(submission.workspaceId).toBe(workspaceId)
    expect(submission.payload?.decision).toBe("approve")
    expect(submission.payload?.target).toMatchObject({ _tag: "Node", runId })
    expect(posts.filter(procedure => procedure === "Approval.Submit")).toHaveLength(beforeUnrelated + 1)

    // The workspace records the decision and the run leaves that park.
    await expect.poll(async () => (await budgetGates(page, request, workflowRepo, runId)).find(gate => gate.requestId === incident)?.status,
      { message: "the continued request must read back approved", timeout: 60_000, intervals: [500, 1_000, 2_000] }).toBe("approved")
    let journal: Awaited<ReturnType<typeof readJournal>> = []
    await expect.poll(async () => {
      journal = await readJournal(page, request, workflowRepo, runId)
      const approvedAt = journal.findIndex(row => row.kind === "control.approval.approved" && JSON.stringify(row.payload).includes(incident))
      return approvedAt >= 0 && journal.slice(approvedAt + 1).some(row => moved.has(String(row.kind)) ||
        (row.kind === "control.approval.requested" && !JSON.stringify(row.payload).includes(incident)))
    }, { message: "the journal must record the approval and the run moving past its park", timeout: 3 * 60_000, intervals: [1_000, 2_000, 5_000] }).toBe(true)

    // Continuing the decided request again submits nothing.
    const beforeStale = posts.filter(procedure => procedure === "Approval.Submit").length
    const staleRead = approvalsRead(page, runId)
    await command(page, `/runs.continue ${runId} ${incident}`)
    await staleRead
    await closeComposer(page)
    expect(posts.filter(procedure => procedure === "Approval.Submit")).toHaveLength(beforeStale)

    await attachProductionJson(testInfo, "runs-continue-guard-park", {
      repo, workspaceId, runId, incident, unrelated, host: host.pin, frontendRevision: host.frontendRevision,
      receipt: receipt.payload?.decision?._tag, gates: await budgetGates(page, request, workflowRepo, runId)
    })
  } finally {
    await gatherEvidence(testInfo, async () => {
      const stop = card.getByTestId(`flow-run-stop-${runId}`)
      if (await stop.isVisible()) await stop.click()
      const terminal = await waitForTerminalRun(page, request, repo, runId, 5 * 60_000, workspaceId)
      const rows = await readJournal(page, request, workflowRepo, runId)
      await attachProductionJson(testInfo, "runs-continue-journal", { repo, workspaceId, runId, terminal, events: rows })
    })
  }
})
