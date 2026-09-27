import { enqueuedEventType } from "@smthrs/control/Steering"
import { createHash } from "node:crypto"
import { SetupDraftSchema, storedSetupCandidate, type SetupDraft } from "@smthrs/rpc/RepositorySetup"
import { scenario } from "./coverage/types"
import { fixtureInputText } from "./support/values"
import { closeComposer, command, expect, realApi, reloadApp, test } from "./support/test"
import { authenticatedTest } from "./auth-permissions/profile"
import {
  attachProductionJson,
  bootProductionRepository,
  cloudRepoPath,
  enableProductionVerbose,
  PRODUCTION_REPO,
  repositoryApiPath,
  readJson
} from "./repositories-github/production"
import { workflowTest } from "./flow-execution/fixture"
import { acceptedRunId, exactRunId, gatewayCall, runSummary, waitForTerminalRun, type RunTracker } from "./flow-execution/production"
import {
  bootRunWorkbench,
  productionRepository,
  runCard,
  runCards,
  waitForGatewayProcedure,
  workflowRpcPosts
} from "./run-inspection/ui"
import { awaitSeededFlow, FAILED_FLOW, measureWorkspaceHost, PIN_FILES, readWorkspaceText, restartWorkspaceHost, SEEDED_FLOW, writeSeededFlow } from "./run-inspection/seeded-flow"
import { captureRevisions, enrichedEvidence, hostProducer, MODULE_COMMIT, moduleEvidence, reloadBootEvidence } from "./run-inspection/revisions"
import { moduleMeaning } from "./run-inspection/module-evidence"
import { assertSuccessfulEdit, journalMeaning, requireLaterPhase } from "./run-inspection/semantic"
import { compareEmptyTimeline, compareMeaning, gatherEvidence, inspectKeyboard, inspectRunning, launchSubject, readFinalOutput, readJournal } from "./run-inspection/exercise"

test.setTimeout(120_000)
test.use({ actionTimeout: 20_000 })
authenticatedTest.setTimeout(180_000)
authenticatedTest.use({ actionTimeout: 30_000 })
workflowTest.setTimeout(12 * 60_000)
workflowTest.use({ actionTimeout: 30_000 })

type ProjectionRow = Readonly<Record<string, unknown>>

const projectionRows = (answer: { readonly payload?: unknown }): ReadonlyArray<ProjectionRow> => {
  const rows = (answer.payload as { readonly rows?: unknown } | undefined)?.rows
  expect(Array.isArray(rows), "the gateway projection must carry a rows array").toBe(true)
  return rows as ReadonlyArray<ProjectionRow>
}

const bootOwnedWorkflow = async (page: Parameters<typeof bootProductionRepository>[0], repo: string, workspaceId: string): Promise<void> => {
  await bootProductionRepository(page, repo)
  await enableProductionVerbose(page)
  await command(page, `/box.view ${workspaceId}`)
  await expect(page.getByTestId(`card-workspace-${workspaceId}`)).toBeVisible()
  await closeComposer(page)
  await command(page, `/repo.select ${repo}#workspace:${workspaceId}`)
  await closeComposer(page)
}

const createFlowRun = async (
  page: Parameters<typeof bootProductionRepository>[0],
  repo: string,
  marker: string,
  tracker: RunTracker
): Promise<{ readonly card: ReturnType<typeof runCards>; readonly runId: string }> => {
  const accepted = acceptedRunId(page, repo, tracker)
  await command(page, `/flow.create create a flow named ${marker} that accepts one text input and returns that text unchanged ${repo}`)
  const runId = await accepted
  await closeComposer(page)
  const card = runCard(page, runId)
  expect(await exactRunId(card)).toBe(runId)
  return { card, runId }
}

test("signed-out run inspection parks durably before any workspace RPC", scenario("runs.permission-open-durable", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:runs.open", "action:auth.prompt", "host:production", "path:permission", "path:persistence",
    "door:slash", "dimension:signed-out-run-id", "dimension:no-workspace-rpc", "dimension:reload",
    "evidence:auth-session-sign-in-card-and-network"
  ],
  description: "Ask to inspect a named run while signed out, require a durable sign-in step, and prove the browser never asks a workspace gateway about that run."
}), async ({ page, request }) => {
  await bootRunWorkbench(page)
  const session = await realApi(page, request, "GET", "/api/auth/session")
  expect(session.status()).toBe(200)
  expect(await session.json()).toEqual({ status: "signed-out" })
  const rpc = workflowRpcPosts(page)

  const requestedRun = `owned-but-absent-${Date.now()}`
  await command(page, `/runs.open ${requestedRun} ${productionRepository}`)
  const signIn = page.locator('button[data-flow="auth.sign-in"]:visible').last()
  await expect(signIn).toBeVisible()
  await expect(runCards(page)).toHaveCount(0)
  expect(rpc).toEqual([])

  await reloadApp(page)
  await expect(page.locator('button[data-flow="auth.sign-in"]:visible').last()).toBeVisible()
  await expect(runCards(page)).toHaveCount(0)
  expect(await (await realApi(page, request, "GET", "/api/auth/session")).json()).toEqual({ status: "signed-out" })
  expect(rpc).toEqual([])
})

test("signed-out run attention cannot enumerate workspace state", scenario("runs.permission-attention-no-enumeration", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:runs.attention", "action:auth.prompt", "host:production", "path:permission", "door:slash",
    "dimension:signed-out-attention", "dimension:no-workspace-enumeration",
    "evidence:sign-in-card-and-absent-projection-rpc"
  ],
  description: "Open the attention inbox while signed out and require authentication to stop before any workspace-runs or approvals projection is requested."
}), async ({ page, request }) => {
  await bootRunWorkbench(page)
  expect(await (await realApi(page, request, "GET", "/api/auth/session")).json()).toEqual({ status: "signed-out" })
  const rpc = workflowRpcPosts(page)

  await command(page, `/runs.attention ${productionRepository}`)
  await expect(page.locator('button[data-flow="auth.sign-in"]:visible').last()).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="run-list"]')).toHaveCount(0)
  await expect(page.locator('.smithers-card[data-kind="approvals-inbox"]')).toHaveCount(0)
  expect(rpc).toEqual([])
})

authenticatedTest("the canary GitHub App is installed before an owned workflow fixture is attempted", scenario("runs.github-app-fixture-readiness", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:github.app", "host:production", "path:success", "door:slash",
    "dimension:owned-workflow-prerequisite", "dimension:github-app-installed",
    "evidence:ui-card-and-status-readback"
  ],
  description: "Read the existing canary repository's GitHub App state through the UI and API so a private workflow fixture is never knowingly attempted while installation wiring is unavailable."
}), async ({ page, request }, testInfo) => {
  await bootProductionRepository(page)
  await enableProductionVerbose(page)
  const statusPath = cloudRepoPath(PRODUCTION_REPO, "/github-app-status")
  const statusResponse = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === statusPath)
  await command(page, `/github.app ${PRODUCTION_REPO}`)
  expect((await statusResponse).status()).toBe(200)
  const status = await readJson<{
    readonly github_app_installed?: unknown
    readonly github_app_configured?: unknown
    readonly installation_id?: unknown
  }>(page, request, statusPath)
  await attachProductionJson(testInfo, "run-fixture-github-app-readiness", { repo: PRODUCTION_REPO, status })
  await closeComposer(page)
  const card = page.getByTestId(`card-connector-setup-github-${PRODUCTION_REPO}`)
  await expect(card).toBeVisible()
  await expect(card).toContainText(/GitHub App installed.*configured/)
  expect(status.github_app_installed).toBe(true)
  expect(status.github_app_configured).toBe(true)
  const inventory = await readJson<{
    readonly repos?: ReadonlyArray<{ readonly fullName: string; readonly installationId: number }>
  }>(page, request, "/api/user/github-app/installations")
  expect(typeof inventory.repos?.find(repo => repo.fullName === PRODUCTION_REPO)?.installationId).toBe("number")
})

workflowTest("a completed provider run exposes its real trace, transcript, events, handoff, and durable selection", scenario("runs.inspect-completed-trace-durable", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:flow.create", "action:runs.steps", "action:runs.logs", "action:runs.events",
    "action:runs.trace.view", "action:runs.trace.filter", "action:runs.trace.select", "action:runs.trace.live", "action:runs.handoff",
    "host:production", "path:success", "path:persistence", "path:keyboard", "door:slash", "door:button",
    "dimension:real-provider", "dimension:completed-run", "dimension:keyboard", "dimension:timeline", "dimension:transcript",
    "dimension:raw-events", "dimension:handoff", "dimension:live-tail", "dimension:reload", "evidence:gateway-projections-and-durable-card"
  ],
  description: "Run the real create-flow provider to completion, compare the embedded inspection facets with gateway projections, then reload its persisted trace selection and editable handoff."
}), async ({ page, request, workflowRepo }, testInfo) => {
  const repo = workflowRepo.repo
  await bootOwnedWorkflow(page, repo, workflowRepo.workspaceId)
  const marker = fixtureInputText(`s16-inspect-${Date.now().toString(36)}`)
  const launched = await createFlowRun(page, repo, marker, workflowRepo)

  const terminal = await waitForTerminalRun(page, request, repo, launched.runId, 9 * 60_000, workflowRepo.workspaceId)
  expect(terminal.status).toBe("completed")
  const card = runCard(page, launched.runId)
  await expect(card.getByTestId(`run-outcome-${launched.runId}`)).toHaveAttribute("data-phase", "completed", { timeout: 60_000 })

  const eventsAnswer = await gatewayCall(page, request, repo, "Projection.Snapshot", {
    selector: { _tag: "run-events", runId: launched.runId }
  }, workflowRepo.workspaceId)
  const transcriptAnswer = await gatewayCall(page, request, repo, "Projection.Snapshot", {
    selector: { _tag: "transcript", runId: launched.runId }
  }, workflowRepo.workspaceId)
  const events = projectionRows(eventsAnswer)
  const transcript = projectionRows(transcriptAnswer)
  expect(events.length, "a completed real engine run must have a journal").toBeGreaterThan(0)
  expect(transcript.length, "the provider-backed run must record at least one transcript row").toBeGreaterThan(0)

  const trace = card.getByTestId(`run-trace-${launched.runId}`)
  const timeline = trace.getByRole("button", { name: "Details", exact: true })
  await timeline.focus()
  await expect(timeline).toBeFocused()
  await timeline.press("Enter")
  await expect(trace).toHaveAttribute("data-view", "timeline")
  const tree = trace.getByRole("list", { name: "Call tree" })
  await expect(tree.locator("[data-trace-span]")).not.toHaveCount(0)
  const all = trace.locator('[data-filter="all"]')
  const model = trace.locator('[data-filter="model"]')
  await model.click()
  await expect(model).toHaveAttribute("data-on", "true")
  await all.click()
  await expect(all).toHaveAttribute("data-on", "true")

  // CallTree emits depth for every span; depth zero is the run root.
  const selectable = tree.locator('[data-trace-span][data-depth]:not([data-depth="0"])').first()
  await expect(selectable).toBeVisible()
  const selectedSpan = await selectable.getAttribute("data-trace-span")
  expect(selectedSpan).toBeTruthy()
  await selectable.focus()
  await selectable.press("Enter")
  await expect(selectable).toHaveAttribute("aria-pressed", "true")
  await expect(card.getByTestId(`run-trace-pane-${launched.runId}`)).toHaveAttribute("data-span", selectedSpan!)

  await card.getByTestId(`flow-run-facet-transcript-${launched.runId}`).click()
  const transcriptList = card.getByTestId(`flow-run-transcript-${launched.runId}`)
  await expect(transcriptList.locator("li")).toHaveCount(transcript.length)

  await card.getByTestId(`flow-run-facet-events-${launched.runId}`).click()
  const eventList = card.getByTestId(`flow-run-events-${launched.runId}`)
  await expect(eventList.locator("li")).toHaveCount(events.length)
  const firstEventKind = events.map((event) => event.kind).find((kind): kind is string => typeof kind === "string")
  expect(firstEventKind, "the projected journal must name its event kinds").toBeDefined()
  await expect(eventList).toContainText(firstEventKind!)

  await card.getByTestId(`flow-run-facet-steps-${launched.runId}`).click()
  await card.getByRole("button", { name: "Prepare handoff", exact: true }).click()
  const handoff = page.locator('form[data-flow-name="chat.copy-message"]').last()
  await expect(handoff).toBeVisible()
  const handoffText = handoff.locator("textarea")
  await expect(handoffText).toHaveValue(new RegExp(`Repository: ${repo.replace("/", "\\/")}`))
  await expect(handoffText).toHaveValue(new RegExp(`Run: ${launched.runId}`))
  await expect(handoffText).toHaveValue(/Run phase: completed/)

  await reloadApp(page)
  const restored = runCard(page, launched.runId)
  await expect(restored).toBeVisible()
  await expect(restored.getByTestId(`run-trace-${launched.runId}`)).toHaveAttribute("data-view", "timeline")
  await expect(restored.getByTestId(`run-trace-pane-${launched.runId}`)).toHaveAttribute("data-span", selectedSpan!)
  const latest = restored.getByRole("button", { name: "Latest", exact: true })
  await latest.focus()
  await expect(latest).toBeFocused()
  await latest.press("Enter")
  await expect(latest).toBeHidden()
  await reloadApp(page)
  // The card restores after the boot, so require it before reading what it does
  // not show; an absence read from an empty transcript is true of every run.
  await expect(runCard(page, launched.runId)).toBeVisible()
  await expect(runCard(page, launched.runId).getByRole("button", { name: "Latest", exact: true })).toBeHidden()
  await attachProductionJson(testInfo, "completed-run-inspection", {
    repo, marker, runId: launched.runId, terminal, selectedSpan, events, transcript
  })
})

workflowTest("a successful prompt run matches its journal while live and after keyboard scrubbing", scenario("runs.timeline-phase-strip-scrub-durable", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:box.view", "action:box.terminal", "action:box.suspend", "action:box.resume", "action:repo.select",
    "action:flow.run", "action:runs.trace.select", "action:runs.trace.live", "action:runs.trace.view",
    "host:production", "path:success", "path:persistence", "path:keyboard", "door:slash", "door:button",
    "dimension:real-provider", "dimension:real-pty", "dimension:keyboard", "dimension:repository-owned-prompt-flow", "dimension:completed-run",
    "dimension:timeline", "dimension:phase-strip", "dimension:frame-lines", "dimension:scrub-cursor", "dimension:live-run",
    "dimension:later-phase-door", "dimension:reload", "dimension:verified-edit", "dimension:milestone-cluster-keyboard",
    "dimension:pointer-scrub", "dimension:readable-widths", "evidence:gateway-journal-frames-and-durable-cursor"
  ],
  description: "Compare live and settled timeline meanings with independent calls and outcomes, require distinct read/write/test phases and an exact workspace-file append, and reload keyboard selections. Archive frontend and measured host revisions; report unavailable producer evidence explicitly."
}), async ({ page, request, workflowRepo }, testInfo) => {
  testInfo.setTimeout(40 * 60_000)
  const { repo, workspaceId } = workflowRepo
  expect(workspaceId).toBeDefined()
  await bootOwnedWorkflow(page, repo, workspaceId)
  await captureRevisions(page, testInfo, "timeline-initial-revisions")
  const marker = fixtureInputText(`s16-timeline-${Date.now().toString(36)}`)
  await writeSeededFlow(page, request, repo, workspaceId, marker)
  const before = await readWorkspaceText(page, request, repo, workspaceId, "README.md")
  await restartWorkspaceHost(page, request, repo, workspaceId)
  await awaitSeededFlow(page, request, repo, workspaceId)
  const host = await captureRevisions(page, testInfo)
  const measured = await measureWorkspaceHost(page, request, repo, workspaceId)
  await attachProductionJson(testInfo, "timeline-workspace-host", { repo, workspaceId, measured, host, measuredAfterResume: true })
  if (host.pin._tag === "HostPinRead") expect(measured.sha256, "the executing workspace contains the pinned host artifact after resume").toBe(host.pin.sha256)
  await command(page, `/repo.select ${repo}#workspace:${workspaceId}`)
  await closeComposer(page)
  const subject = await launchSubject(page, workflowRepo, SEEDED_FLOW, { args: marker }, testInfo)
  try {
    await inspectRunning(page, request, workflowRepo, subject, testInfo, host.frontendRevision)
    const terminal = await waitForTerminalRun(page, request, repo, subject.runId, 9 * 60_000, workspaceId)
    const rows = await readJournal(page, request, workflowRepo, subject.runId)
    const after = await readWorkspaceText(page, request, repo, workspaceId, "README.md")
    await attachProductionJson(testInfo, "timeline-edit-readback", { repo, workspaceId, runId: subject.runId, terminal, marker, before, after })
    assertSuccessfulEdit(terminal.status, before, after, marker)
    const files = await Promise.all(PIN_FILES.map(async path => ({ path, content: await readWorkspaceText(page, request, repo, workspaceId, path) })))
    await attachProductionJson(testInfo, "timeline-pin-file-readbacks", files)
    for (const file of files) expect(file.content).toBe(`${marker}\n`)
    const expected = journalMeaning(rows)
    requireLaterPhase(expected)
    expect(expected.bands.map(band => band.phase)).toEqual(expect.arrayContaining(["researching", "implementing", "testing"]))
    const rendered = await compareMeaning(subject.card, subject.trace, expected)
    await attachProductionJson(testInfo, "timeline-semantic-comparison", { expected, rendered, terminal })
    await inspectKeyboard(page, subject, rows, testInfo, host.frontendRevision)
    await subject.card.screenshot({ path: testInfo.outputPath("timeline-completed.png") })
    await testInfo.attach("timeline-completed", { path: testInfo.outputPath("timeline-completed.png"), contentType: "image/png" })
  } finally {
    await gatherEvidence(testInfo, async () => {
      await reloadBootEvidence(testInfo)
      const rows = await readJournal(page, request, workflowRepo, subject.runId)
      await attachProductionJson(testInfo, "timeline-subject-journal", { repo, workspaceId, runId: subject.runId, events: rows })
      await enrichedEvidence(testInfo, host.pin, rows)
    })
  }
})

workflowTest("a budget-failed prompt run shows its recorded failure without claiming an edit", scenario("runs.timeline-failed-prompt-evidence", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:box.view", "action:box.terminal", "action:box.suspend", "action:box.resume", "action:repo.select", "action:flow.run",
    "host:production", "path:error", "door:slash", "dimension:real-provider", "dimension:failed-run",
    "dimension:repository-owned-prompt-flow", "dimension:timeline", "evidence:failed-journal-and-unchanged-file"
  ],
  description: "Run a separate prompt subject whose real work exceeds its budget, compare its failed header, frame meanings and terminal pin to the gateway journal, and prove README stayed unchanged."
}), async ({ page, request, workflowRepo }, testInfo) => {
  testInfo.setTimeout(40 * 60_000)
  const { repo, workspaceId } = workflowRepo
  expect(workspaceId).toBeDefined()
  await bootOwnedWorkflow(page, repo, workspaceId)
  await captureRevisions(page, testInfo, "timeline-initial-revisions")
  await writeSeededFlow(page, request, repo, workspaceId, fixtureInputText(`failure-${Date.now().toString(36)}`))
  const before = await readWorkspaceText(page, request, repo, workspaceId, "README.md")
  await restartWorkspaceHost(page, request, repo, workspaceId)
  await awaitSeededFlow(page, request, repo, workspaceId)
  const host = await captureRevisions(page, testInfo)
  const measured = await measureWorkspaceHost(page, request, repo, workspaceId)
  await attachProductionJson(testInfo, "timeline-workspace-host", { repo, workspaceId, measured, host, measuredAfterResume: true })
  if (host.pin._tag === "HostPinRead") expect(measured.sha256, "the executing workspace contains the pinned host artifact after resume").toBe(host.pin.sha256)
  await command(page, `/repo.select ${repo}#workspace:${workspaceId}`)
  await closeComposer(page)
  const subject = await launchSubject(page, workflowRepo, FAILED_FLOW, { args: "Observe the declared budget failure." }, testInfo)
  try {
    const terminal = await waitForTerminalRun(page, request, repo, subject.runId, 4 * 60_000, workspaceId)
    const rows = await readJournal(page, request, workflowRepo, subject.runId)
    const after = await readWorkspaceText(page, request, repo, workspaceId, "README.md")
    await attachProductionJson(testInfo, "timeline-failed-readback", { repo, workspaceId, runId: subject.runId, terminal, before, after })
    expect(terminal.status).toBe("failed")
    expect(after).toBe(before)
    const failure = rows.find(({ kind: journalKind }) => journalKind === "control.run.failed")
    expect(failure).toBeDefined()
    expect((failure?.payload as Record<string, unknown>)?.cause, "the failed-run label requires the recorded budget cause").toMatch(/BudgetExceeded|ms budget/)
    const expected = journalMeaning(rows)
    expect(expected.frames.length).toBeGreaterThan(0)
    expect(expected.lines.length).toBeGreaterThan(0)
    const rendered = await compareMeaning(subject.card, subject.trace, expected)
    expect(expected.pins).toContainEqual(expect.objectContaining({ label: "failed" }))
    await attachProductionJson(testInfo, "timeline-failed-semantic-comparison", { expected, rendered, terminal })
  } finally {
    await gatherEvidence(testInfo, async () => {
      await reloadBootEvidence(testInfo)
      const rows = await readJournal(page, request, workflowRepo, subject.runId)
      await attachProductionJson(testInfo, "timeline-subject-journal", { repo, workspaceId, runId: subject.runId, events: rows })
      await enrichedEvidence(testInfo, host.pin, rows)
    })
  }
})

workflowTest("an ordinary module run reports recorded step evidence or its pinned host limitation", scenario("runs.timeline-ordinary-module-evidence", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:box.view", "action:box.terminal", "action:repo.select", "action:flow.run",
    "host:production", "path:success", "door:slash", "dimension:real-provider", "dimension:ordinary-module-flow",
    "dimension:host-revision-evidence", "evidence:recorded-module-step-trail-or-host-predates-commit"
  ],
  description: "Launch the registered repository issues module through the ordinary UI in an owned workspace. Compare recorded step meanings at completion when the host contains the producer, and while live when the run is still running at a comparable boundary; archive a typed host limitation or a typed unexercised live claim otherwise. Verify two source-grounded research results and that README stays unchanged."
}), async ({ page, request, workflowRepo }, testInfo) => {
  testInfo.setTimeout(30 * 60_000)
  const { repo, workspaceId } = workflowRepo
  expect(workspaceId).toBeDefined()
  await bootOwnedWorkflow(page, repo, workspaceId)
  const host = await captureRevisions(page, testInfo)
  const measured = await measureWorkspaceHost(page, request, repo, workspaceId)
  await attachProductionJson(testInfo, "timeline-workspace-host", { repo, workspaceId, measured, host })
  if (host.pin._tag === "HostPinRead") expect(measured.sha256).toBe(host.pin.sha256)
  const producer = hostProducer(host.pin, MODULE_COMMIT)
  const catalog = await gatewayCall(page, request, repo, "List", { _tag: "flows" }, workspaceId)
  await attachProductionJson(testInfo, "timeline-module-catalog", catalog.payload)
  expect((catalog.payload as { items: { flowId: string }[] }).items.map(one => one.flowId)).toContain("repository-jobs/issues")
  const before = await readWorkspaceText(page, request, repo, workspaceId, "README.md")
  await command(page, `/repo.select ${repo}#workspace:${workspaceId}`)
  await closeComposer(page)
  const bookmarks = await readJson<{ items: { name: string; target_commit_id: string }[] }>(page, request, repositoryApiPath(repo, "/bookmarks"))
  const sourceRevision = bookmarks.items.find(bookmark => bookmark.name === "main")?.target_commit_id
  expect(sourceRevision).toMatch(/^[0-9a-f]{40}$/)
  const configuration: SetupDraft = {
    steps: ["research", "followup"].map(id => ({ id, name: id, mode: "automatic", prompt: "Answer with README.md's exact first line and cite README.md. The supplied source contains everything needed. Leave question empty and reproduction null." })),
    checks: [], cases: [], replies: "draft", landing: "ask", scope: "future", label: "", schedule: "", choreEvent: "none",
    budgetMinutes: 8, connectIssues: false, trialTitle: "README question", trialBody: ""
  }
  // The pinned host includes trial fields in its candidate identity; current hosts retain that format too.
  const { choreEvent: _choreEvent, ...legacyDraft } = SetupDraftSchema.parse(configuration)
  const digest = createHash("sha256").update(JSON.stringify({ repo, job: "issues", revision: 1, draft: legacyDraft })).digest("hex")
  expect(storedSetupCandidate({ repo, job: "issues", revision: 1, draft: configuration }, digest)).toBe(true)
  const input = { repo, job: "issues" as const, revision: 1, digest,
    sourceRevision, configuration,
    event: { source: "smithers-cloud", type: "issues", action: "opened", deliveryKey: crypto.randomUUID(),
      payload: { issue: { title: "What is README.md's exact first line?", body: "Answer from README.md and cite it. Do not change files or propose changes." } } } }
  const subject = await launchSubject(page, workflowRepo, "repository-jobs/issues", input, testInfo)
  try {
    /*
     * This module has no duration floor: every one of its steps is one model
     * turn, and the only structurally long phases the repository job graph
     * owns are human gates and durable sleeps, which park the run rather than
     * keep it running. So a live boundary is taken when the run offers one and
     * named unexercised when it does not, and never assumed.
     */
    const live = producer === "HostContainsCommit"
      ? await inspectRunning(page, request, workflowRepo, subject, testInfo, host.frontendRevision, moduleMeaning, false, "report")
      : undefined
    const terminal = await waitForTerminalRun(page, request, repo, subject.runId, 10 * 60_000, workspaceId)
    const rows = await readJournal(page, request, workflowRepo, subject.runId)
    const after = await readWorkspaceText(page, request, repo, workspaceId, "README.md")
    await attachProductionJson(testInfo, "timeline-module-readback", { repo, workspaceId, runId: subject.runId, input, terminal, before, after })
    expect(terminal.status).toBe("completed")
    expect(after).toBe(before)
    // The gateway records this module's final output as a JSON document, not as a decoded object.
    const document = await readFinalOutput(page, request, workflowRepo, subject.runId)
    const output = JSON.parse(document) as { status: string; eventKey: string; publicActions: unknown[]
      digest: string; repo: string; job: string; revision: number; sourceRevision: string
      results: { stepId: string; status: string; summary: string; output: { citations: string[]; question: string; reproduction: unknown } }[] }
    expect(output.status).toBe("completed")
    expect(output.eventKey).toBe(input.event.deliveryKey)
    expect(output.publicActions).toEqual([])
    // The recorded invocation identity, so this output cannot belong to another request.
    expect({ digest: output.digest, repo: output.repo, job: output.job, revision: output.revision })
      .toEqual({ digest: input.digest, repo: input.repo, job: input.job, revision: input.revision })
    // The run answers with the revision it actually read, which need not be the bookmark that was asked for.
    expect(output.sourceRevision).toMatch(/^[0-9a-f]{40}$/)
    expect(output.results.map(result => result.stepId).sort()).toEqual(["followup", "research"])
    for (const result of output.results) {
      expect(result.status).toBe("completed")
      expect(result.summary).toContain(before.split("\n")[0])
      expect(result.output.citations).toContain("README.md")
      expect(result.output.question).toBe("")
      expect(result.output.reproduction).toBeNull()
    }
    const expected = moduleMeaning(rows)
    // A host that carries the producer must record this module's steps; only an older one may read empty.
    if (producer === "HostContainsCommit") {
      expect(expected.frames.length).toBeGreaterThanOrEqual(2)
      // Each frame is placed by the invocation that recorded it, so two steps
      // cannot be folded into one timeline by a shared frame number.
      expect(expected.frames.every(frame => frame.node.startsWith("step:")),
        "a module frame is named by its recorded step scope").toBe(true)
      expect(new Set(expected.frames.map(frame => frame.node)).size).toBe(expected.frames.length)
    }
    const rendered = expected.frames.length === 0
      ? await compareEmptyTimeline(subject.card, subject.trace, expected)
      : await compareMeaning(subject.card, subject.trace, expected)
    await attachProductionJson(testInfo, "timeline-module-semantic-comparison", { expected, rendered, terminal, live,
      recordedFrames: expected.frames.length, host: host.pin, producer })
    await subject.card.screenshot({ path: testInfo.outputPath("timeline-module.png") })
    await testInfo.attach("timeline-module", { path: testInfo.outputPath("timeline-module.png"), contentType: "image/png" })
  } finally {
    await gatherEvidence(testInfo, async () => {
      await reloadBootEvidence(testInfo)
      const rows = await readJournal(page, request, workflowRepo, subject.runId)
      await attachProductionJson(testInfo, "timeline-module-journal", { repo, workspaceId, runId: subject.runId, events: rows })
      await moduleEvidence(testInfo, host.pin, rows)
      await enrichedEvidence(testInfo, host.pin, rows)
    })
  }
})

workflowTest("live message, thinking, and tool steering persist as real control events across reconnect", scenario("runs.live-steering-durable-reconnect", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:flow.create", "action:runs.steer", "action:runs.thinking", "action:runs.tools",
    "host:production", "path:success", "path:persistence", "door:slash",
    "dimension:real-provider", "dimension:live-run", "dimension:durable-reconnect",
    "dimension:message-steer", "dimension:thinking-steer", "dimension:tools-steer",
    "evidence:accepted-rpc-and-durable-control-events"
  ],
  description: "Launch an owned provider run, steer its live engine through three typed UI commands, prove their exact server-authored event ids, then reconnect to the same persisted run."
}), async ({ page, request, workflowRepo }, testInfo) => {
  const repo = workflowRepo.repo
  await bootOwnedWorkflow(page, repo, workflowRepo.workspaceId)
  const marker = fixtureInputText(`s16-steer-${Date.now().toString(36)}`)
  const launched = await createFlowRun(page, repo, marker, workflowRepo)
  const liveStatuses = new Set(["accepted", "running", "parked", "waiting-approval"])
  let liveBefore: ReturnType<typeof runSummary> = undefined
  await expect.poll(async () => {
    const answer = await gatewayCall(page, request, repo, "Projection.Snapshot", {
      selector: { _tag: "run-summary", runId: launched.runId }
    }, workflowRepo.workspaceId)
    liveBefore = runSummary(answer)
    return typeof liveBefore?.status === "string" && liveStatuses.has(liveBefore.status)
  }, { timeout: 60_000, intervals: [250, 500, 1_000] }).toBe(true)

  const steer = async (
    commandText: string,
    expected: Readonly<Record<string, unknown>>
  ): Promise<{
    readonly messageId: string
    readonly idempotencyKey: string
    readonly request: Readonly<Record<string, unknown>>
  }> => {
    const responsePromise = waitForGatewayProcedure(page, "Steer", repo)
    await command(page, commandText)
    const response = await responsePromise
    const requestBody = response.request().postDataJSON() as {
      readonly repo?: unknown
      readonly workspaceId?: unknown
      readonly payload?: {
        readonly runId?: unknown
        readonly idempotencyKey?: unknown
        readonly message?: Readonly<Record<string, unknown>>
      }
    }
    const message = requestBody.payload?.message
    const messageId = message?.messageId
    expect(typeof messageId).toBe("string")
    const messagePrefix = `steer-${launched.runId}-`
    expect(messageId).toMatch(new RegExp(`^${messagePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.+`))
    const nonce = String(messageId).slice(messagePrefix.length)
    const idempotencyKey = `steer:${launched.runId}:${nonce}`
    expect(requestBody.repo).toBe(repo)
    expect(requestBody.workspaceId).toBe(workflowRepo.workspaceId)
    expect(requestBody.payload).toMatchObject({ runId: launched.runId, message: expected })
    expect(requestBody.payload?.idempotencyKey).toBe(idempotencyKey)
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      payload: { _tag: "Accepted", receiptId: idempotencyKey, runId: launched.runId }
    })
    return { messageId: String(messageId), idempotencyKey, request: requestBody }
  }

  const message = await steer(`/runs.steer ${launched.runId} preserve the exact ${marker} flow contract`, {
    runId: launched.runId, kind: "Message", body: `preserve the exact ${marker} flow contract`
  })
  const thinking = await steer(`/runs.thinking ${launched.runId} low`, {
    runId: launched.runId, kind: "Thinking", thinking: "low"
  })
  const tools = await steer(`/runs.tools ${launched.runId} bash`, {
    runId: launched.runId, kind: "Tools", toolNames: ["bash"]
  })
  const accepted = [message, thinking, tools]

  let controlEvents: ReadonlyArray<ProjectionRow> = []
  await expect.poll(async () => {
    const answer = await gatewayCall(page, request, repo, "Projection.Snapshot", {
      selector: { _tag: "run-events", runId: launched.runId }
    }, workflowRepo.workspaceId)
    controlEvents = projectionRows(answer).filter((event) => event.kind === enqueuedEventType)
    const ids = controlEvents.map((event) => (event.payload as ProjectionRow | undefined)?.messageId)
    return ids
  }, { timeout: 60_000, intervals: [250, 500, 1_000] }).toEqual(expect.arrayContaining(accepted.map((entry) => entry.messageId)))
  for (const entry of accepted) {
    const persisted = controlEvents.find((event) =>
      (event.payload as ProjectionRow | undefined)?.messageId === entry.messageId
    )
    expect(persisted, `server journal must record steer ${entry.messageId}`).toBeDefined()
    const payload = persisted!.payload as ProjectionRow
    const requestMessage = ((entry.request.payload as ProjectionRow).message as ProjectionRow)
    expect(payload).toMatchObject({
      runId: launched.runId,
      messageId: entry.messageId,
      kind: requestMessage.kind,
      createdAt: requestMessage.createdAt
    })
  }

  await reloadApp(page)
  const restored = runCard(page, launched.runId)
  await expect(restored).toBeVisible()
  expect(await exactRunId(restored)).toBe(launched.runId)
  const afterReconnect = await gatewayCall(page, request, repo, "Projection.Snapshot", {
    selector: { _tag: "run-summary", runId: launched.runId }
  }, workflowRepo.workspaceId)
  expect(runSummary(afterReconnect)?.runId).toBe(launched.runId)
  await attachProductionJson(testInfo, "live-steering-reconnect", {
    repo, marker, runId: launched.runId, liveBefore, accepted, controlEvents,
    afterReconnect: runSummary(afterReconnect)
  })
})

workflowTest("run again creates a second real execution and both appear in the server-backed completed list", scenario("runs.rerun-completed-list-open", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:flow.create", "action:runs.rerun", "action:runs.list", "action:runs.open", "host:production",
    "path:success", "path:keyboard", "door:slash", "door:button", "dimension:real-provider",
    "dimension:rerun-new-id", "dimension:completed-filter", "dimension:keyboard", "dimension:server-backed-list",
    "evidence:two-terminal-projections-and-run-list"
  ],
  description: "Complete an owned provider run, keyboard-run it again from its card, prove a distinct accepted id executes, and open both exact ids from the completed run list."
}), async ({ page, request, workflowRepo }, testInfo) => {
  const repo = workflowRepo.repo
  await bootOwnedWorkflow(page, repo, workflowRepo.workspaceId)
  const marker = fixtureInputText(`s16-rerun-${Date.now().toString(36)}`)
  const first = await createFlowRun(page, repo, marker, workflowRepo)
  const firstTerminal = await waitForTerminalRun(page, request, repo, first.runId, 9 * 60_000, workflowRepo.workspaceId)
  expect(firstTerminal.status).toBe("completed")
  const firstCard = runCard(page, first.runId)
  await expect(firstCard.getByTestId(`run-outcome-${first.runId}`)).toHaveAttribute("data-phase", "completed", { timeout: 60_000 })

  const rerunResponse = acceptedRunId(page, repo, workflowRepo)
  const rerun = firstCard.getByTestId(`flow-run-rerun-${first.runId}`)
  await rerun.focus()
  await expect(rerun).toBeFocused()
  await rerun.press("Enter")
  const secondRunId = await rerunResponse
  expect(secondRunId).not.toBe(first.runId)
  await expect(runCard(page, secondRunId)).toBeVisible({ timeout: 60_000 })
  const secondTerminal = await waitForTerminalRun(page, request, repo, secondRunId, 9 * 60_000, workflowRepo.workspaceId)
  expect(secondTerminal.status).toBe("completed")
  expect(secondTerminal.flowId).toBe(firstTerminal.flowId)

  await command(page, `/runs.list completed ${firstTerminal.flowId} ${repo}`)
  await closeComposer(page)
  const list = page.locator('.smithers-card[data-kind="run-list"]').last()
  await expect(list).toBeVisible()
  await expect(list.getByTestId(`runs-open-${first.runId}`)).toBeVisible()
  await expect(list.getByTestId(`runs-open-${secondRunId}`)).toBeVisible()
  await list.getByTestId(`runs-open-${first.runId}`).click()
  await expect(runCard(page, first.runId)).toBeVisible()

  const listed = await gatewayCall(page, request, repo, "Projection.Snapshot", { selector: { _tag: "workspace-runs" } }, workflowRepo.workspaceId)
  const ids = projectionRows(listed).filter((row) => row.status === "completed" && row.flowId === firstTerminal.flowId).map((row) => row.runId)
  expect(ids).toEqual(expect.arrayContaining([first.runId, secondRunId]))
  await attachProductionJson(testInfo, "rerun-completed-list", {
    repo, marker, first: firstTerminal, second: secondTerminal, completedIds: ids
  })
})

workflowTest("stop all cancels two live owned runs, leaves a terminal sibling unchanged, and terminal resume is refused", scenario("runs.stop-all-owned-live-scope", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:flow.create", "action:runs.list", "action:flow.run.stop-all", "action:runs.resume",
    "action:flow.run.stop",
    "host:production", "path:error",
    "door:slash", "door:button", "dimension:real-provider", "dimension:multiple-live-runs",
    "dimension:owned-workspace-scope", "dimension:terminal-sibling", "dimension:terminal-drain",
    "evidence:pre-and-post-workspace-projections"
  ],
  description: "Cancel one owned run, launch two more, stop the private workspace through its run-list button, prove both live ids cancel while the terminal sibling stays unchanged, and require the gateway's typed refusal when the UI tries to resume a terminal id."
}), async ({ page, request, workflowRepo }, testInfo) => {
  const repo = workflowRepo.repo
  await bootOwnedWorkflow(page, repo, workflowRepo.workspaceId)
  const terminalMarker = fixtureInputText(`s16-terminal-${Date.now().toString(36)}`)
  const terminalSibling = await createFlowRun(page, repo, terminalMarker, workflowRepo)
  await terminalSibling.card.getByTestId(`flow-run-stop-${terminalSibling.runId}`).click()
  const terminalBefore = await waitForTerminalRun(page, request, repo, terminalSibling.runId, 180_000, workflowRepo.workspaceId)
  expect(terminalBefore.status).toBe("cancelled")

  const firstMarker = fixtureInputText(`s16-stop-a-${Date.now().toString(36)}`)
  const secondMarker = fixtureInputText(`s16-stop-b-${Date.now().toString(36)}`)
  const first = await createFlowRun(page, repo, firstMarker, workflowRepo)
  const second = await createFlowRun(page, repo, secondMarker, workflowRepo)
  expect(new Set([terminalSibling.runId, first.runId, second.runId]).size).toBe(3)

  let beforeWorkspaceRows: ReadonlyArray<ProjectionRow> = []
  let beforeRows: ReadonlyArray<ProjectionRow> = []
  await expect.poll(async () => {
    const before = await gatewayCall(page, request, repo, "Projection.Snapshot", { selector: { _tag: "workspace-runs" } }, workflowRepo.workspaceId)
    beforeWorkspaceRows = projectionRows(before)
    beforeRows = beforeWorkspaceRows.filter((row) => row.runId === first.runId || row.runId === second.runId)
    return beforeRows.map((row) => row.runId)
  }, { timeout: 60_000, intervals: [500, 1_000, 2_000] }).toEqual(expect.arrayContaining([first.runId, second.runId]))
  const liveStatuses = new Set(["accepted", "running", "parked", "waiting-approval"])
  const liveIds = beforeRows.filter((row) => typeof row.status === "string" && liveStatuses.has(row.status)).map((row) => String(row.runId))
  expect(liveIds, "both exact owned runs must still be live to exercise multi-run stop-all").toEqual(
    expect.arrayContaining([first.runId, second.runId])
  )
  expect(liveIds).toHaveLength(2)

  await command(page, `/runs.list ${repo}`)
  await closeComposer(page)
  const list = page.locator('.smithers-card[data-kind="run-list"]').last()
  await expect(list).toBeVisible()
  for (const runId of liveIds) await expect(list.getByTestId(`runs-open-${runId}`)).toBeVisible()
  const stopAll = list.getByTestId("run-list-stop-all")
  await expect(stopAll).toHaveText(`Stop all ${liveIds.length}`)
  await stopAll.click()

  const stopped = []
  for (const runId of liveIds) {
    const terminal = await waitForTerminalRun(page, request, repo, runId, 180_000, workflowRepo.workspaceId)
    expect(terminal.status, `run ${runId} was live at the stop-all snapshot`).toBe("cancelled")
    stopped.push(terminal)
    await expect(runCard(page, runId).getByTestId(`run-outcome-${runId}`)).toHaveAttribute("data-phase", "cancelled", { timeout: 60_000 })
  }
  const after = await gatewayCall(page, request, repo, "Projection.Snapshot", { selector: { _tag: "workspace-runs" } }, workflowRepo.workspaceId)
  const afterWorkspaceRows = projectionRows(after)
  const afterRows = afterWorkspaceRows.filter((row) => liveIds.includes(String(row.runId)))
  expect(afterRows).toHaveLength(liveIds.length)
  expect(afterRows.every((row) => row.status === "cancelled")).toBe(true)
  const terminalAfter = await gatewayCall(page, request, repo, "Projection.Snapshot", {
    selector: { _tag: "run-summary", runId: terminalSibling.runId }
  }, workflowRepo.workspaceId)
  expect(runSummary(terminalAfter)).toMatchObject({ runId: terminalSibling.runId, status: "cancelled" })

  const terminalRunId = liveIds[0]!
  const resumeResponse = waitForGatewayProcedure(page, "Resume", repo)
  await command(page, `/runs.resume ${terminalRunId}`)
  const refusedResponse = await resumeResponse
  expect(refusedResponse.status()).toBe(200)
  const refused = await refusedResponse.json() as {
    readonly ok?: unknown
    readonly error?: { readonly message?: unknown; readonly detail?: unknown }
  }
  expect(refused.ok, "the gateway must refuse resuming a terminal run").toBe(false)
  expect(typeof refused.error?.message).toBe("string")
  expect(JSON.stringify(refused.error?.detail), "the resume refusal must retain the gateway's typed Terminal fault").toMatch(/terminal/i)
  await expect(page.getByTestId("transcript")).toContainText(String(refused.error!.message))
  const stillTerminal = await gatewayCall(page, request, repo, "Projection.Snapshot", {
    selector: { _tag: "run-summary", runId: terminalRunId }
  }, workflowRepo.workspaceId)
  expect(runSummary(stillTerminal)).toMatchObject({ runId: terminalRunId, status: "cancelled" })
  const afterResume = await gatewayCall(page, request, repo, "Projection.Snapshot", {
    selector: { _tag: "workspace-runs" }
  }, workflowRepo.workspaceId)
  const afterResumeRows = projectionRows(afterResume)
  expect(afterResumeRows.filter((row) => String(row.runId) === terminalRunId)).toEqual([
    expect.objectContaining({ runId: terminalRunId, status: "cancelled" })
  ])
  expect(afterResumeRows.filter((row) => liveIds.includes(String(row.runId)))).toHaveLength(liveIds.length)
  await attachProductionJson(testInfo, "stop-all-owned-runs", {
    repo, acceptedIds: [terminalSibling.runId, first.runId, second.runId], terminalBefore,
    liveIds, beforeRows, beforeWorkspaceRows, stopped, afterRows, afterWorkspaceRows,
    terminalAfter: runSummary(terminalAfter), resumeRefusal: refused, afterResumeRows
  })
})
