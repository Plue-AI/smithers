import { fixtureRepositoryName } from "../support/values"
import type { APIRequestContext, BrowserContext, Page, TestInfo } from "@playwright/test"
import { authenticatedTest } from "../auth-permissions/profile"
import { closeComposer, command, expect, realApi } from "../support/test"
import { scenarioOutcome, TEARDOWN_ANNOTATION, TeardownProblem } from "../support/teardown"
import {
  attachProductionJson,
  bootProductionRepository,
  enableProductionVerbose,
  cloudRepoPath,
  createOwnedGitHubRepository,
  deleteOwnedCloudRepository,
  deleteOwnedGitHubRepository,
  waitForImportJobId,
  type OwnedGitHubRepository
} from "../repositories-github/production"
import { gatewayCall, runSummary, waitForTerminalRun, type RunSummary, type RunTracker } from "./production"

export type OwnedWorkflowRepository = RunTracker & {
  readonly repo: string
  readonly repositoryId: number
  /** The box every flow call on this repository names. */
  readonly workspaceId: string
  readonly gatewayId?: string
  readonly runs: Set<string>
}

type WorkflowFixtures = { readonly workflowRepo: OwnedWorkflowRepository; readonly provisionCodingGateway: boolean }

const importRepository = async (
  page: Page,
  request: APIRequestContext,
  repo: string,
  testInfo: TestInfo,
  observed: (status: number, jobId?: string) => void
): Promise<{ readonly jobId: string; readonly terminal: Record<string, unknown> }> => {
  const [owner, name] = repo.split("/")
  const start = await realApi(page, request, "POST", "/api/github/import", { owner, repo: name })
  const body = await start.json().catch(() => undefined) as Record<string, unknown> | undefined
  const jobId = typeof body?.importJobId === "string" && body.importJobId !== "" ? body.importJobId : undefined
  observed(start.status(), jobId)
  await attachProductionJson(testInfo, "workflow-fixture-import-start", { repo, status: start.status(), jobId, jobStatus: body?.status, ...(start.ok() ? {} : { refusal: body }) })
  expect(start.status(), `import ${repo}`).toBeGreaterThanOrEqual(200)
  expect(start.status(), `import ${repo}`).toBeLessThan(300)
  expect(jobId, "the import service must return the exact accepted job id").toBeDefined()
  const terminal = await waitForImportJobId(page, request, jobId!, 240_000)
  expect(terminal.status).toBe("ready")
  return { jobId: jobId!, terminal }
}

const provisionRepository = async (
  page: Page,
  request: APIRequestContext,
  repo: string,
  workspaceId: string,
  testInfo: TestInfo
): Promise<{ readonly workspaceId: string; readonly gatewayId?: string }> => {
  const deadline = Date.now() + 180_000
  let last: Record<string, unknown> | undefined
  do {
    const response = await realApi(page, request, "POST", "/api/workflow/provision", { repo, workspaceId })
    last = await response.json().catch(() => ({ message: "Non-JSON provision response" })) as Record<string, unknown>
    expect(response.status(), `provision ${repo}: ${JSON.stringify(last)}`).toBe(200)
    if (last.status === "ready") {
      const result = {
        workspaceId: typeof last.workspaceId === "string" ? last.workspaceId : workspaceId,
        ...(typeof last.gatewayId === "string" ? { gatewayId: last.gatewayId } : {})
      }
      await attachProductionJson(testInfo, "workflow-fixture-provision", { repo, ...last })
      return result
    }
    if (last.status !== "provisioning") break
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  } while (Date.now() < deadline)
  throw new Error(`Workflow fixture ${repo} did not provision: ${JSON.stringify(last)}`)
}

const deleteGitHub = async (owned: OwnedGitHubRepository): Promise<void> => {
  await deleteOwnedGitHubRepository(owned)
  await owned.page.close()
}

/** The runs one owned repository accepted, and the box they ran on once it is known. */
type OwnedRuns = RunTracker & { readonly repo: string; readonly runs: Set<string>; readonly workspaceId?: string }

export const drainRuns = async (
  page: Page,
  request: APIRequestContext,
  owned: OwnedRuns
): Promise<ReadonlyArray<RunSummary>> => {
  const terminal: RunSummary[] = []
  const failures: unknown[] = []
  for (const runId of owned.runs) {
    try {
      const workspaceId = owned.workspaceId
      if (workspaceId === undefined) throw new Error(`Owned run ${runId} names no box to read it from.`)
      const current = await gatewayCall(page, request, owned.repo, "Projection.Snapshot", {
        selector: { _tag: "run-summary", runId }
      }, workspaceId)
      let row = runSummary(current)
      if (row === undefined) throw new Error(`Owned run ${runId} disappeared before cleanup.`)
      if (row.runId !== runId) throw new Error(`Projection for owned run ${runId} returned row ${row.runId}.`)
      if (!/^(completed|failed|cancelled)$/.test(row.status)) {
        await gatewayCall(page, request, owned.repo, "Cancel", {
          runId,
          idempotencyKey: `cancel:${runId}`,
          reason: "owned real E2E fixture cleanup"
        }, workspaceId)
        row = await waitForTerminalRun(page, request, owned.repo, runId, 120_000, workspaceId)
      }
      terminal.push(row)
    } catch (error) {
      failures.push(new TeardownProblem(`Owned run ${runId} did not drain, so the repository it belongs to is preserved.`, { cause: error }))
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `Not every owned run on ${owned.repo} reached a terminal projection; preserving its dependencies.`)
  return terminal
}

const setup = async (
  page: Page,
  request: APIRequestContext,
  context: BrowserContext,
  testInfo: TestInfo,
  provisionCodingGateway: boolean
): Promise<{ readonly owned: OwnedGitHubRepository; readonly fixture: OwnedWorkflowRepository }> => {
  await bootProductionRepository(page)
  const name = fixtureRepositoryName(`smithers-e2e-import-s15-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const owned = await createOwnedGitHubRepository(context, name)
  let importJobId: string | undefined
  let importStatus: number | undefined
  let importAttempted = false
  try {
    await attachProductionJson(testInfo, "workflow-fixture-owned-source", {
      repo: owned.fullName,
      githubUrl: owned.url,
      cleanupNamespace: "codeplanesmithers/smithers-e2e-import-*"
    })
    importAttempted = true
    const imported = await importRepository(page, request, owned.fullName, testInfo, (status, accepted) => {
      importStatus = status
      if (accepted !== undefined) importJobId = accepted
    })
    const workspaceId = imported.terminal.workspace_id
    expect(typeof workspaceId, "import must name its real workspace").toBe("string")
    // Import completion names the accepted workspace; VM creation continues
    // in the background. Provider operations require its real running receipt.
    await expect.poll(async () => {
      const response = await realApi(page, request, "GET", cloudRepoPath(owned.fullName, `/workspaces/${workspaceId}`))
      expect(response.status()).toBe(200)
      const row = await response.json() as { readonly status?: unknown; readonly failure_message?: unknown }
      if (row.status === "failed") throw new Error(`Workspace provisioning failed: ${String(row.failure_message)}`)
      return row.status
    }, { timeout: 180_000, intervals: [1_000, 2_000, 5_000] }).toBe("running")
    const provisioned = provisionCodingGateway
      ? await provisionRepository(page, request, owned.fullName, workspaceId as string, testInfo)
      : { workspaceId: workspaceId as string }
    expect(provisioned.workspaceId).toBe(workspaceId)
    await enableProductionVerbose(page)
    const cloud = await realApi(page, request, "GET", cloudRepoPath(owned.fullName))
    expect(cloud.status(), `Cloud repository ${owned.fullName}`).toBe(200)
    const cloudRepository = await cloud.json() as { readonly id?: unknown }
    expect(typeof cloudRepository.id, "Cloud repository id").toBe("number")
    await attachProductionJson(testInfo, "workflow-fixture-ready", {
      repo: owned.fullName,
      importJobId: imported.jobId,
      terminal: imported.terminal,
      provisioned,
      cloud: cloudRepository
    })
    return { owned, fixture: { repo: owned.fullName, repositoryId: cloudRepository.id as number, ...provisioned, runs: new Set(), ambiguities: [] } }
  } catch (error) {
    const failures: unknown[] = []
    let authoritative = false
    if (importJobId !== undefined) {
      try { await waitForImportJobId(page, request, importJobId, 120_000); authoritative = true } catch (cleanupError) { failures.push(cleanupError) }
    } else if (!importAttempted) {
      authoritative = true
    }
    if (!authoritative) {
      failures.push(new Error(`Preserved ${owned.fullName}: import ${importAttempted ? "returned no authoritative accepted job id" : "was not observed"}; GitHub and Cloud state remain for diagnosis.`))
      try {
        await attachProductionJson(testInfo, "workflow-fixture-preserved", {
          repo: owned.fullName,
          githubUrl: owned.url,
          importStatus,
          importJobId,
          reason: "The import result or its accepted job did not reach an authoritative terminal state; dependencies were preserved."
        })
      } catch (attachmentError) {
        failures.push(attachmentError)
      }
    } else {
      const deletions = await Promise.allSettled([
        deleteGitHub(owned),
        deleteOwnedCloudRepository(page, request, owned.fullName)
      ])
      for (const deletion of deletions) if (deletion.status === "rejected") failures.push(deletion.reason)
    }
    if (failures.length > 0) throw new AggregateError([error, ...failures], `Workflow fixture setup failed and cleanup for ${owned.fullName} was incomplete.`)
    throw error
  }
}

/**
 * Drains the scenario's runs, then deletes the Cloud repository and its GitHub
 * source. Anything unresolved preserves both and is filed as a teardown problem.
 */
const settle = async (
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  owned: OwnedGitHubRepository,
  fixture: OwnedRuns,
  bodyError: unknown
): Promise<void> => {
  const cleanupFailures: unknown[] = []
  let runs: ReadonlyArray<RunSummary> = []
  let drained = false
  try {
    runs = await drainRuns(page, request, fixture)
    drained = true
  } catch (error) {
    cleanupFailures.push(error)
  }

  let githubDeleted = false
  let cloudDeleted: unknown
  if (drained && fixture.ambiguities.length === 0) {
    const deletions = await Promise.allSettled([
      deleteOwnedCloudRepository(page, request, fixture.repo),
      deleteGitHub(owned)
    ])
    if (deletions[0]?.status === "fulfilled") cloudDeleted = deletions[0].value
    else cleanupFailures.push(deletions[0]?.reason)
    if (deletions[1]?.status === "fulfilled") githubDeleted = true
    else cleanupFailures.push(deletions[1]?.reason)
  } else {
    cleanupFailures.push(new TeardownProblem(`Preserved ${fixture.repo} because ${fixture.ambiguities.length > 0 ? fixture.ambiguities.join(" ") : "not every accepted run reached terminal"}.`))
  }
  await attachProductionJson(testInfo, "workflow-fixture-cleanup", {
    repo: fixture.repo, trackedRunIds: [...fixture.runs], ambiguities: fixture.ambiguities,
    runs, drained, githubDeleted, cloudDeleted,
    preserved: !drained || fixture.ambiguities.length > 0,
    // The filed sentence names what is left behind; the words a library threw
    // about its own internals are kept here, where a trace reader finds them.
    cleanupFailures: cleanupFailures.map(String)
  })
  /*
   * The scenario answers for its body. A cleanup that could not finish is
   * filed as a teardown problem, where the real-E2E reporter folds it into
   * the run's reporter errors and the coverage gate fails the RUN — so the
   * leak is still loud, and a proof that ran to completion is not reported
   * as a failure because the housekeeping after it hit an account wall.
   */
  const outcome = scenarioOutcome({ repository: fixture.repo, bodyError, teardownFailures: cleanupFailures })
  for (const sentence of outcome.teardown) testInfo.annotations.push({ type: TEARDOWN_ANNOTATION, description: sentence })
  if (outcome.verdict !== undefined) throw outcome.verdict
}

export const workflowTest = authenticatedTest.extend<WorkflowFixtures>({
  provisionCodingGateway: [true, { option: true }],
  workflowRepo: async ({ page, request, context, provisionCodingGateway }, use, testInfo) => {
    const { owned, fixture } = await setup(page, request, context, testInfo, provisionCodingGateway)
    let bodyError: unknown
    try {
      await use(fixture)
    } catch (error) {
      bodyError = error
    }
    await settle(page, request, testInfo, owned, fixture, bodyError)
  }
})

/** A GitHub source Smithers has never imported; the scenario records the box its run names. */
export type ColdWorkflowRepository = RunTracker & {
  readonly repo: string
  readonly runs: Set<string>
  workspaceId?: string
}

/** Owns a fresh GitHub source and nothing else: the scenario's own import and run are the first. */
export const coldWorkflowTest = authenticatedTest.extend<{ readonly coldRepo: ColdWorkflowRepository }>({
  coldRepo: async ({ page, context, request }, use, testInfo) => {
    await bootProductionRepository(page)
    const name = fixtureRepositoryName(`smithers-e2e-import-cold-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const owned = await createOwnedGitHubRepository(context, name)
    const fixture: ColdWorkflowRepository = { repo: owned.fullName, runs: new Set(), ambiguities: [] }
    let bodyError: unknown
    try {
      await attachProductionJson(testInfo, "cold-fixture-owned-source", {
        repo: owned.fullName,
        githubUrl: owned.url,
        cleanupNamespace: "codeplanesmithers/smithers-e2e-import-*"
      })
      await use(fixture)
    } catch (error) {
      bodyError = error
    }
    await settle(page, request, testInfo, owned, fixture, bodyError)
  }
})

/** Read-only catalog canaries use an explicitly configured existing gateway.
 * They never delete its repository/workspace or accept a coding run. Fresh
 * imports remain the independently owned fixture for lifecycle/mutation tests.
 */
export const configuredGatewayTest = authenticatedTest.extend<{ workflowRepo: OwnedWorkflowRepository }>({
  workflowRepo: async ({ page, request }, use, testInfo) => {
    const repo = process.env.SMITHERS_REAL_CONFIGURED_REPO
    const workspaceId = process.env.SMITHERS_REAL_CONFIGURED_WORKSPACE
    if (!repo || !workspaceId) throw new Error("SMITHERS_REAL_CONFIGURED_REPO and SMITHERS_REAL_CONFIGURED_WORKSPACE must name the canary's prepared coding workspace.")
    if (!repo.startsWith("codeplanesmithers/")) throw new Error("Configured gateway canaries require the saved test account's repository.")
    await bootProductionRepository(page, repo)
    const repository = await realApi(page, request, "GET", cloudRepoPath(repo))
    expect(repository.status()).toBe(200)
    const repositoryId = (await repository.json() as { id: number }).id
    const workspace = await realApi(page, request, "GET", cloudRepoPath(repo, `/workspaces/${workspaceId}`))
    expect(workspace.status()).toBe(200)
    expect(await workspace.json()).toMatchObject({ id: workspaceId, repository_id: repositoryId })
    const provisioned = await provisionRepository(page, request, repo, workspaceId, testInfo)
    await enableProductionVerbose(page)
    await command(page, `/box.view ${workspaceId}`)
    await expect(page.getByTestId(`card-workspace-${workspaceId}`)).toBeVisible()
    await closeComposer(page)
    await command(page, `/repo.select ${repo}#workspace:${workspaceId}`)
    await closeComposer(page)
    await use({ repo, repositoryId, ...provisioned, runs: new Set(), ambiguities: [] })
  }
})
