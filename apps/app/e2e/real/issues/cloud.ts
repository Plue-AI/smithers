import type { APIRequestContext, BrowserContext, Locator, Page, TestInfo } from "@playwright/test"
import { expect, realApi } from "../support/test"
import { fixtureAttachmentName, fixtureRepositoryName } from "../support/values"
import { scenarioOutcome, TEARDOWN_ANNOTATION, TeardownProblem } from "../support/teardown"
import { runSlash } from "./local"
import {
  attachProductionJson,
  bootProductionRepository,
  cloudRepoPath,
  createOwnedGitHubRepository,
  deleteOwnedCloudRepository,
  deleteOwnedGitHubRepository,
  repositoryApiPath,
  waitForImportJob,
  waitForImportJobId,
  type OwnedGitHubRepository
} from "../repositories-github/production"

type ProductFixtures = {
  readonly page: Page
  readonly context: BrowserContext
  readonly request: APIRequestContext
}

export type ImportedIssueFixture = ProductFixtures & {
  readonly repo: string
  /** The owned GitHub source, open in its own page of the signed-in GitHub session. */
  readonly github: OwnedGitHubRepository
  readonly trackIssue: (number: number) => void
  readonly markWorkflowRunSubmitted: () => void
  readonly trackWorkflowRun: (run: TrackedWorkflowRun) => void
}

export type TrackedWorkflowRun = {
  readonly runId: string
  /** The box the run was launched on: every relayed call names it. */
  readonly workspaceId: string
}

export type IssueWire = Record<string, unknown> & {
  readonly number?: unknown
  readonly title?: unknown
  readonly state?: unknown
}

const errorOf = (message: string, cause: unknown): TeardownProblem => new TeardownProblem(message, { cause })
const TERMINAL_RUN_STATUSES = new Set(["cancelled", "completed", "failed"])

export const uniqueRepositoryName = (): string =>
  fixtureRepositoryName(`smithers-e2e-import-s12-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)

const issueNumberFrom = async (response: { readonly json: () => Promise<unknown> }): Promise<number> => {
  const body = await response.json().catch(() => undefined) as IssueWire | undefined
  expect(body?.number).toEqual(expect.any(Number))
  expect(Number.isInteger(body?.number)).toBe(true)
  return body!.number as number
}

export const readIssue = async (
  page: Page,
  request: APIRequestContext,
  repo: string,
  number: number
): Promise<IssueWire> => {
  const response = await realApi(page, request, "GET", repositoryApiPath(repo, `/issues/${number}`))
  expect(response.status()).toBe(200)
  const issue = await response.json() as IssueWire
  expect(issue.number).toBe(number)
  return issue
}

export const readComments = async (
  page: Page,
  request: APIRequestContext,
  repo: string,
  number: number
): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const response = await realApi(page, request, "GET", repositoryApiPath(repo, `/issues/${number}/comments`))
  expect(response.status()).toBe(200)
  const comments = await response.json() as unknown
  expect(Array.isArray(comments)).toBe(true)
  return comments as ReadonlyArray<Record<string, unknown>>
}

export const issueCard = (page: Page, repo: string, number: number): Locator =>
  page.locator('.smithers-card[data-kind="issue"]').filter({ has: page.locator(`article[data-issue="${number}"]`) }).filter({ hasText: repo }).last()

const workflowRunStatus = async (
  page: Page,
  request: APIRequestContext,
  repo: string,
  run: TrackedWorkflowRun
): Promise<string> => {
  const response = await realApi(page, request, "POST", "/api/workflow/rpc", {
    repo,
    procedure: "Projection.Snapshot",
    payload: { selector: { _tag: "run-summary", runId: run.runId } },
    workspaceId: run.workspaceId
  })
  expect(response.status()).toBe(200)
  const body = await response.json() as {
    readonly ok?: unknown
    readonly payload?: { readonly rows?: ReadonlyArray<{ readonly runId?: unknown; readonly status?: unknown }> }
  }
  expect(body.ok).toBe(true)
  const row = body.payload?.rows?.find((candidate) => candidate.runId === run.runId)
  expect(row?.status).toEqual(expect.any(String))
  return row!.status as string
}

const drainWorkflowRun = async (
  page: Page,
  request: APIRequestContext,
  repo: string,
  run: TrackedWorkflowRun
): Promise<string> => {
  const observed = await workflowRunStatus(page, request, repo, run)
  if (TERMINAL_RUN_STATUSES.has(observed)) return observed
  const cancelled = await realApi(page, request, "POST", "/api/workflow/rpc", {
    repo,
    procedure: "Cancel",
    payload: {
      runId: run.runId,
      idempotencyKey: `cancel:${run.runId}`,
      reason: "owned issue E2E cleanup"
    },
    workspaceId: run.workspaceId
  })
  expect(cancelled.status()).toBe(200)
  const receipt = await cancelled.json() as { readonly ok?: unknown }
  expect(receipt.ok).toBe(true)
  let terminal = ""
  await expect.poll(async () => {
    terminal = await workflowRunStatus(page, request, repo, run)
    return terminal
  }, { timeout: 60_000, intervals: [500, 1_000, 2_000] }).toMatch(/^(cancelled|completed|failed)$/)
  return terminal
}

export const createIssueThroughUi = async (
  fixture: ImportedIssueFixture,
  title: string
): Promise<{ readonly number: number; readonly card: Locator }> => {
  const issuePath = repositoryApiPath(fixture.repo, "/issues")
  const posted = fixture.page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === issuePath)
  await runSlash(fixture.page, `/issues.create ${title} ${fixture.repo}`)
  const response = await posted
  expect(response.status()).toBe(201)
  const number = await issueNumberFrom(response)
  fixture.trackIssue(number)
  const card = issueCard(fixture.page, fixture.repo, number)
  await expect(card).toBeVisible()
  await expect(card).toContainText(title)
  return { number, card }
}

/**
 * Give one test an owned GitHub source and its real Smithers Cloud
 * mirror. The callback may create issues; every tracked issue is closed before
 * the mirror and source are deleted, and both repository deletions prove 404.
 */
export const withOwnedImportedRepository = async (
  fixtures: ProductFixtures,
  testInfo: TestInfo,
  body: (fixture: ImportedIssueFixture) => Promise<void>
): Promise<void> => {
  const name = uniqueRepositoryName()
  const sourceRepo = `codeplanesmithers/${name}`
  let repo = sourceRepo
  const sourceVisibility = process.env.SMITHERS_REAL_AUTH_KIND === "application-token" ? "public" : "private"
  const trackedIssues = new Set<number>()
  const trackedWorkflowRuns = new Map<string, TrackedWorkflowRun>()
  let owned: OwnedGitHubRepository | undefined
  let sourceCreated = false
  let importSubmitted = false
  let acceptedImportJobId: string | undefined
  let importSettled = false
  let workflowRunSubmissionAmbiguous = false
  let primaryFailure: unknown
  const cleanupFailures: unknown[] = []

  await attachProductionJson(testInfo, "owned-repository-intent", {
    repo: sourceRepo,
    owner: "codeplanesmithers",
    visibility: sourceVisibility,
    initializedWithReadme: true,
    cleanup: ["close tracked issues", "delete cloud mirror and verify 404", "delete GitHub source and verify 404"]
  })

  try {
    owned = await createOwnedGitHubRepository(fixtures.context, name, sourceVisibility)
    sourceCreated = true
    await bootProductionRepository(fixtures.page, sourceRepo)

    const importPath = "/api/github/import"
    const starting = fixtures.context.waitForEvent("response", { predicate: (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === importPath
    })
    // Once dispatch begins, a lost browser answer could still leave an
    // accepted backend job. Cleanup may delete neither side until that exact
    // response-owned job is known and terminal.
    importSubmitted = true
    await runSlash(fixtures.page, `/repos.import ${sourceRepo}`)
    const start = await starting
    const startBody = await start.json().catch(() => undefined) as {
      readonly importJobId?: unknown
      readonly import_job_id?: unknown
      readonly job_id?: unknown
    } | undefined
    const capturedJobId = startBody?.importJobId ?? startBody?.import_job_id ?? startBody?.job_id
    if (typeof capturedJobId === "string" && capturedJobId !== "") acceptedImportJobId = capturedJobId
    if (acceptedImportJobId === undefined) {
      throw new Error(`The import submission for ${repo} did not return an authoritative job id; cleanup must preserve both repositories.`)
    }
    expect([200, 202]).toContain(start.status())
    const authoritativeJob = await waitForImportJobId(fixtures.page, fixtures.request, acceptedImportJobId)
    importSettled = true
    expect(authoritativeJob.status).toBe("ready")
    const destination = authoritativeJob.repository as { readonly owner?: unknown; readonly name?: unknown } | undefined
    expect(destination?.owner).toEqual(expect.any(String))
    expect(destination?.name).toBe(name)
    repo = `${destination!.owner as string}/${destination!.name as string}`
    const card = fixtures.page.locator('.smithers-card[data-kind="repo-import"]').filter({ hasText: sourceRepo }).last()
    await expect(card).toBeVisible()
    const job = await waitForImportJob(fixtures.page, fixtures.request, card)
    expect(job?.status).toBe("ready")
    await expect(card.getByText("done", { exact: true })).toBeVisible()

    const mirror = await realApi(fixtures.page, fixtures.request, "GET", cloudRepoPath(repo))
    expect(mirror.status()).toBe(200)
    await card.getByRole("button", { name: "Show issues", exact: true }).click()
    const list = fixtures.page.locator('.smithers-card[data-kind="issue-list"]').filter({ hasText: repo }).last()
    await expect(list).toBeVisible()
    await attachProductionJson(testInfo, "owned-repository-import", {
      sourceRepo,
      repo,
      startStatus: start.status(),
      terminalJob: job,
      authoritativeJob,
      mirrorStatus: mirror.status()
    })

    await body({
      ...fixtures,
      repo,
      github: owned,
      trackIssue: (number) => trackedIssues.add(number),
      markWorkflowRunSubmitted: () => { workflowRunSubmissionAmbiguous = true },
      trackWorkflowRun: (run) => {
        trackedWorkflowRuns.set(run.runId, run)
        workflowRunSubmissionAmbiguous = false
      }
    })
  } catch (error) {
    primaryFailure = error
  } finally {
    if (sourceCreated) {
      if (acceptedImportJobId !== undefined && !importSettled) {
        try {
          const terminalImport = await waitForImportJobId(fixtures.page, fixtures.request, acceptedImportJobId)
          importSettled = true
          await attachProductionJson(testInfo, "owned-import-job-cleanup-drain", {
            repo,
            importJobId: acceptedImportJobId,
            terminalImport
          })
        } catch (error) {
          cleanupFailures.push(errorOf(`Draining accepted import job ${acceptedImportJobId} for ${repo} failed`, error))
        }
      }
      let workflowRunsSettled = !workflowRunSubmissionAmbiguous
      if (workflowRunSubmissionAmbiguous) {
        cleanupFailures.push(new TeardownProblem(`A workflow run submission for ${repo} returned no authoritative run id and cannot be drained safely.`))
      }
      for (const run of trackedWorkflowRuns.values()) {
        try {
          const terminalStatus = await drainWorkflowRun(fixtures.page, fixtures.request, repo, run)
          await attachProductionJson(testInfo, fixtureAttachmentName(`owned-workflow-run-cleanup-${run.runId}`), {
            repo,
            runId: run.runId,
            terminalStatus
          })
        } catch (error) {
          workflowRunsSettled = false
          cleanupFailures.push(errorOf(`Draining accepted workflow run ${run.runId} for ${repo} failed`, error))
        }
      }

      const importSafe = !importSubmitted || (acceptedImportJobId !== undefined && importSettled)
      const repositoryDeletionSafe = importSafe && workflowRunsSettled
      if (!repositoryDeletionSafe) {
        await attachProductionJson(testInfo, "owned-repository-cleanup-unresolved", {
          repo,
          importSubmitted,
          acceptedImportJobId: acceptedImportJobId ?? null,
          importSettled,
          workflowRuns: [...trackedWorkflowRuns.values()],
          workflowRunSubmissionAmbiguous,
          workflowRunsSettled,
          skipped: ["close issues", "delete cloud mirror", "delete GitHub source"]
        })
        cleanupFailures.push(new TeardownProblem(`Repository deletion for ${repo} is unsafe while an accepted import or workflow run remains unresolved.`))
      } else {
        for (const number of trackedIssues) {
          try {
            const close = await realApi(fixtures.page, fixtures.request, "PATCH", repositoryApiPath(repo, `/issues/${number}`), { state: "closed" })
            expect([200, 404]).toContain(close.status())
          } catch (error) {
            cleanupFailures.push(errorOf(`Closing owned issue #${number} in ${repo} failed`, error))
          }
        }
        try {
          const cloudCleanup = await deleteOwnedCloudRepository(fixtures.page, fixtures.request, repo)
          await attachProductionJson(testInfo, "owned-cloud-repository-cleanup", { repo, ...cloudCleanup })
        } catch (error) {
          cleanupFailures.push(errorOf(`Cloud cleanup for ${repo} failed`, error))
        }
        if (owned !== undefined) {
          try {
            await deleteOwnedGitHubRepository(owned)
            await attachProductionJson(testInfo, "owned-github-repository-cleanup", { repo, finalStatus: 404 })
          } catch (error) {
            cleanupFailures.push(errorOf(`GitHub cleanup for ${repo} failed`, error))
          }
        }
      }
      if (owned !== undefined && !owned.page.isClosed()) {
        try { await owned.page.close() } catch (error) {
          cleanupFailures.push(errorOf(`Closing the GitHub page for ${repo} failed`, error))
        }
      }
    }
  }

  // The scenario answers for its body; a cleanup that could not finish is filed
  // as a teardown problem, which the real-E2E reporter fails the RUN on.
  const outcome = scenarioOutcome({ repository: repo, bodyError: primaryFailure, teardownFailures: cleanupFailures })
  for (const sentence of outcome.teardown) testInfo.annotations.push({ type: TEARDOWN_ANNOTATION, description: sentence })
  if (outcome.verdict !== undefined) throw outcome.verdict
}
