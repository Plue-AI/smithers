import type { APIRequestContext, BrowserContext, Locator, Page, TestInfo } from "@playwright/test"
import { command, expect, openComposer, realApi } from "../support/test"
import { fixtureAttachmentName, fixtureRepositoryName } from "../support/values"
import { scenarioOutcome, TEARDOWN_ANNOTATION, TeardownProblem } from "../support/teardown"
import { expectFlowOutcome } from "../repositories-github/local"
import {
  attachProductionJson,
  cloudRepoPath,
  createOwnedGitHubRepository,
  deleteOwnedCloudRepository,
  deleteOwnedGitHubRepository,
  enableProductionVerbose,
  repositoryApiPath,
  waitForImportJob,
  waitForImportJobId,
  type OwnedGitHubRepository
} from "../repositories-github/production"

const CANARY_REPOSITORY = "codeplanesmithers/canary-sandbox"

type ImportTerminal = Record<string, unknown> & { readonly status?: unknown }

export type OwnedPullRequestRepo = OwnedGitHubRepository & {
  readonly marker: string
  readonly branch: string
  readonly firstCommit: string
  readonly featureCommit: string
  importSubmitted: boolean
  importRejected: boolean
  importResponseStatus?: number
  acceptedJobId?: string
  importDrained: boolean
  importTerminal?: ImportTerminal
  tipChangeId?: string
  mainChangeId?: string
  mirrorPending?: boolean
  readonly queuedLandings: number[]
}

export type Bookmark = {
  readonly name: string
  readonly target_change_id: string
  readonly target_commit_id: string
  readonly is_tracking_remote?: boolean
}

export type Landing = {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: string
  readonly source_bookmark?: string
  readonly target_bookmark?: string
  readonly change_ids: readonly string[]
  readonly [key: string]: unknown
}

export type Review = {
  readonly type: string
  readonly body: string
  readonly [key: string]: unknown
}

export type Change = {
  readonly change_id: string
  readonly commit_id: string
  readonly description: string
  readonly landed?: {
    readonly landing_request_number?: number
    readonly [key: string]: unknown
  } | null
  readonly [key: string]: unknown
}

export const githubCommitAtBranch = async (github: Page, owned: OwnedGitHubRepository, branch: string): Promise<string> => {
  await github.goto(`${owned.url}/commits/${encodeURIComponent(branch)}`, { waitUntil: "domcontentloaded" })
  const link = github.locator(`a[href^="/${owned.fullName}/commit/"]`).first()
  await expect(link).toBeVisible({ timeout: 30_000 })
  const href = await link.getAttribute("href")
  const sha = href === null ? undefined : /\/commit\/([0-9a-f]{40})(?:$|[/?#])/.exec(href)?.[1]
  expect(sha, `GitHub must expose the exact ${branch} commit SHA`).toMatch(/^[0-9a-f]{40}$/)
  return sha!
}

const createGitHubBranch = async (owned: OwnedGitHubRepository, branch: string): Promise<void> => {
  const github = owned.page
  await github.goto(`${owned.url}/branches`, { waitUntil: "domcontentloaded" })
  const newBranch = github.getByRole("button", { name: /^New branch$/ })
    .or(github.getByRole("link", { name: /^New branch$/ }))
    .first()
  await expect(newBranch).toBeVisible()
  await newBranch.click()
  const dialog = github.getByRole("dialog").last()
  const surface = await dialog.isVisible().catch(() => false) ? dialog : github.locator("body")
  const name = surface.getByRole("textbox", { name: "New branch name", exact: true })
  await expect(name).toBeVisible()
  await name.fill(branch)
  const create = surface.getByRole("button", { name: /^Create (?:new )?branch$/ })
  await expect(create).toBeEnabled()
  const created = github.waitForResponse(response =>
    response.request().method() === "POST" && new URL(response.url()).pathname.includes(owned.fullName))
  await create.click()
  expect((await created).ok(), "GitHub must acknowledge branch creation before navigating").toBe(true)
  await expect(dialog).toBeHidden()
  const branchPage = await github.goto(`${owned.url}/tree/${encodeURIComponent(branch)}`, { waitUntil: "domcontentloaded" })
  expect(branchPage?.status()).toBe(200)
}

const commitGitHubFile = async (
  owned: OwnedGitHubRepository,
  branch: string,
  path: string,
  content: string,
  message: string
): Promise<string> => {
  const github = owned.page
  await github.goto(`${owned.url}/new/${encodeURIComponent(branch)}`, { waitUntil: "domcontentloaded" })
  const filename = github.getByRole("textbox", { name: "File name", exact: true })
  await expect(filename).toBeVisible({ timeout: 30_000 })
  await filename.fill(path)

  const editor = github.getByRole("textbox", { name: /^Editing .*file contents/ })
  await expect(editor).toBeVisible()
  await editor.fill(content)

  const openCommit = github.getByRole("button", { name: /^Commit changes(?:…|\.\.\.)?$/ }).first()
  await expect(openCommit).toBeEnabled()
  await openCommit.click()
  const dialog = github.getByRole("dialog").last()
  await expect(dialog).toBeVisible()
  const summary = dialog.getByRole("textbox", { name: "Commit message", exact: true })
  await expect(summary).toBeVisible()
  await summary.fill(message)
  const commit = dialog.getByRole("button", { name: /^Commit changes$/ }).last()
  await expect(commit).toBeEnabled()
  await commit.click()
  await github.waitForURL((candidate) => !candidate.pathname.includes(`/new/${branch}`), { timeout: 60_000 })
  return githubCommitAtBranch(github, owned, branch)
}

const requireImportPreflight = async (
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo
): Promise<void> => {
  const statusPath = cloudRepoPath(CANARY_REPOSITORY, "/github-app-status")
  await openComposer(page)
  await enableProductionVerbose(page)
  const checking = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === statusPath)
  await command(page, `/github.app ${CANARY_REPOSITORY}`)
  const checked = await checking
  expect(checked.status()).toBe(200)
  await expectFlowOutcome(page, "github.app", CANARY_REPOSITORY, "executed")
  const response = await realApi(page, request, "GET", statusPath)
  expect(response.status()).toBe(200)
  const status = await response.json() as Record<string, unknown>
  await attachProductionJson(testInfo, "pull-request-import-preflight", status)
  expect(status.github_app_configured, "The production GitHub App must be configured before an owned repository is created.").toBe(true)
  expect(status.github_app_installed, "The production GitHub App must be installed before an owned repository is created.").toBe(true)
  const inventoryResponse = await realApi(page, request, "GET", "/api/user/github-app/installations")
  expect(inventoryResponse.status()).toBe(200)
  const inventory = await inventoryResponse.json() as { repos?: Array<{ fullName: string; installationId: number }> }
  expect(typeof inventory.repos?.find(repo => repo.fullName === CANARY_REPOSITORY)?.installationId).toBe("number")
}

/** Create the private GitHub fixture through UI only, after a no-mutation App preflight. */
export const provisionOwnedPullRequestRepo = async (
  page: Page,
  request: APIRequestContext,
  context: BrowserContext,
  login: string,
  testInfo: TestInfo,
  purpose: string
): Promise<OwnedPullRequestRepo> => {
  expect(login).toBe("codeplanesmithers")
  await requireImportPreflight(page, request, testInfo)
  const marker = `${purpose}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const name = fixtureRepositoryName(`smithers-e2e-import-pr-${marker}`)
  const fullName = `${login}/${name}`
  const branch = `pr-${marker}`
  await attachProductionJson(testInfo, "owned-pull-request-intent", { fullName, branch, purpose, created: false, imported: false })

  let github: OwnedGitHubRepository | undefined
  const githubCreateTransport: Array<{
    readonly phase: "request" | "response"
    readonly method: string
    readonly path: string
    readonly navigation: boolean
    readonly resourceType: string
    readonly status?: number
  }> = []
  const recordRequest = (request: import("@playwright/test").Request): void => {
    const url = new URL(request.url())
    if (url.hostname !== "github.com" || request.method() !== "POST") return
    githubCreateTransport.push({
      phase: "request",
      method: request.method(),
      path: url.pathname,
      navigation: request.isNavigationRequest(),
      resourceType: request.resourceType()
    })
  }
  const recordResponse = (response: import("@playwright/test").Response): void => {
    const request = response.request()
    const url = new URL(response.url())
    if (url.hostname !== "github.com" || request.method() !== "POST") return
    githubCreateTransport.push({
      phase: "response",
      method: request.method(),
      path: url.pathname,
      navigation: request.isNavigationRequest(),
      resourceType: request.resourceType(),
      status: response.status()
    })
  }
  context.on("request", recordRequest)
  context.on("response", recordResponse)
  try {
    github = await createOwnedGitHubRepository(context, name)
    await createGitHubBranch(github, branch)
    const firstCommit = await commitGitHubFile(
      github,
      branch,
      `src/first-${marker}.txt`,
      `first fixture ${marker}\n`,
      `Add first fixture ${marker}`
    )
    const featureCommit = await commitGitHubFile(
      github,
      branch,
      `docs/second-${marker}.md`,
      `# Second fixture ${marker}\n`,
      `Add second fixture ${marker}`
    )
    expect(featureCommit).not.toBe(firstCommit)
    await attachProductionJson(testInfo, "owned-pull-request-github-source", {
      fullName,
      branch,
      visibility: "private",
      firstCommit,
      featureCommit,
      createTransport: githubCreateTransport
    })
    return {
      ...github,
      marker,
      branch,
      firstCommit,
      featureCommit,
      importSubmitted: false,
      importRejected: false,
      importDrained: false,
      queuedLandings: []
    }
  } catch (error) {
    const failures: unknown[] = []
    try {
      await attachProductionJson(testInfo, "owned-pull-request-github-create-failure", {
        fullName,
        branch,
        createTransport: githubCreateTransport
      })
    } catch (evidenceError) {
      failures.push(evidenceError)
    }
    if (github === undefined) {
      if (failures.length > 0) throw new AggregateError([error, ...failures], `Provisioning ${fullName} failed before returning its GitHub page`)
      throw error
    }
    try {
      await deleteOwnedGitHubRepository(github)
    } catch (cleanupError) {
      failures.push(cleanupError)
    }
    try {
      await github.page.close()
    } catch (closeError) {
      failures.push(closeError)
    }
    throw failures.length === 0
      ? error
      : new AggregateError([error, ...failures], `Provisioning ${fullName} failed and cleanup was incomplete`)
  } finally {
    context.off("request", recordRequest)
    context.off("response", recordResponse)
  }
}

/** Import through /repos.import, drain the real job, and bind imported refs to GitHub SHAs. */
export const importOwnedPullRequestRepo = async (
  page: Page,
  request: APIRequestContext,
  owned: OwnedPullRequestRepo
): Promise<void> => {
  const importing = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/cloud/api/github/import").then(async response => ({
      response, start: await response.json() as Record<string, unknown>
    }))
  owned.importSubmitted = true
  await command(page, `/repos.import ${owned.fullName}`)
  const { response, start } = await importing
  owned.importResponseStatus = response.status()
  // A status code alone does not prove no job was accepted. In particular,
  // conflicts can describe an existing import; only its server terminal ID drains it.
  owned.importRejected = false
  owned.acceptedJobId = typeof start?.importJobId === "string" && start.importJobId !== "" ? start.importJobId : undefined
  expect(response.status()).toBeGreaterThanOrEqual(200)
  expect(response.status()).toBeLessThan(300)
  expect(owned.acceptedJobId).toBeDefined()
  await expectFlowOutcome(page, "repos.import", owned.fullName, "executed")
  const card = page.getByTestId(`card-repo-import-${owned.fullName}`)
  await expect(card).toContainText(owned.fullName)
  await expect(card.getByText("done", { exact: true })).toBeVisible({ timeout: 240_000 })
  owned.importTerminal = await waitForImportJobId(page, request, owned.acceptedJobId!) as ImportTerminal
  owned.importDrained = owned.importTerminal.status === "ready" || owned.importTerminal.status === "failed"
  if (owned.importTerminal !== undefined) expect(owned.importTerminal.status).toBe("ready")

  const bookmarks = await readBookmarks(page, request, owned)
  const main = bookmarks.find((bookmark) => bookmark.name === "main")
  const feature = bookmarks.find((bookmark) => bookmark.name === owned.branch)
  expect(main).toBeDefined()
  expect(feature).toBeDefined()
  expect(feature?.target_commit_id, "The imported feature ref must equal GitHub's exact branch SHA.").toBe(owned.featureCommit)
  expect(feature?.target_change_id).not.toBe(main?.target_change_id)
  owned.tipChangeId = feature!.target_change_id
  owned.mainChangeId = main!.target_change_id
}

const requireTip = (owned: OwnedPullRequestRepo): string => {
  if (owned.tipChangeId === undefined) throw new Error(`${owned.fullName} has not completed its import readback`)
  return owned.tipChangeId
}

export const createPullRequestFixture = async (
  page: Page,
  request: APIRequestContext,
  owned: OwnedPullRequestRepo,
  title: string
): Promise<{ readonly number: number }> => {
  const response = await realApi(page, request, "POST", repositoryApiPath(owned.fullName, "/landings"), {
    title, body: "", source_bookmark: owned.branch, target_bookmark: "main", change_ids: [requireTip(owned)]
  })
  expect(response.status()).toBe(201)
  const list = await readJson<readonly Landing[]>(page, request, `${repositoryApiPath(owned.fullName, "/landings")}?limit=100`)
  const matches = list.filter((landing) => landing.title === title)
  expect(matches).toHaveLength(1)
  await command(page, `/prs.view ${matches[0]!.number} ${owned.fullName}`)
  await expect(landingDetail(page, matches[0]!.number)).toBeVisible()
  return { number: matches[0]!.number }
}

export const landingList = (page: Page, fullName: string): Locator =>
  page.locator(`.smithers-card[data-kind="pr-list"]`).filter({ hasText: fullName }).last()

export const landingDetail = (page: Page, number: number): Locator =>
  page.locator(`article[data-landing="${number}"]`).last()

export { enableProductionVerbose, expectFlowOutcome }

const readJson = async <T>(page: Page, request: APIRequestContext, path: string): Promise<T> => {
  const response = await realApi(page, request, "GET", path)
  expect(response.status(), `GET ${path}`).toBe(200)
  return await response.json() as T
}

export const readBookmarks = async (
  page: Page,
  request: APIRequestContext,
  owned: Pick<OwnedPullRequestRepo, "fullName">
): Promise<Bookmark[]> => {
  const body = await readJson<{ readonly items?: readonly Bookmark[] }>(page, request, `${repositoryApiPath(owned.fullName, "/bookmarks")}?limit=100`)
  expect(Array.isArray(body.items)).toBe(true)
  return [...(body.items ?? [])]
}

export const readLanding = (
  page: Page,
  request: APIRequestContext,
  owned: Pick<OwnedPullRequestRepo, "fullName">,
  number: number
): Promise<Landing> => readJson(page, request, repositoryApiPath(owned.fullName, `/landings/${number}`))

export const readReviews = (
  page: Page,
  request: APIRequestContext,
  owned: Pick<OwnedPullRequestRepo, "fullName">,
  number: number
): Promise<Review[]> => readJson(page, request, `${repositoryApiPath(owned.fullName, `/landings/${number}/reviews`)}?limit=100`)

export const readChange = (
  page: Page,
  request: APIRequestContext,
  owned: Pick<OwnedPullRequestRepo, "fullName">,
  changeId = requireTip(owned as OwnedPullRequestRepo)
): Promise<Change> => readJson(page, request, repositoryApiPath(owned.fullName, `/changes/${encodeURIComponent(changeId)}`))

export const readChecks = async (
  page: Page,
  request: APIRequestContext,
  owned: OwnedPullRequestRepo
): Promise<readonly Record<string, unknown>[]> => {
  const tip = requireTip(owned)
  const listPath = repositoryApiPath(owned.fullName, `/commits/${encodeURIComponent(tip)}/statuses`)
  return readJson(page, request, `${listPath}?limit=100`)
}

export const queueLandingThroughAPI = async (
  page: Page,
  request: APIRequestContext,
  owned: OwnedPullRequestRepo,
  number: number
): Promise<Landing> => {
  const change = await readChange(page, request, owned)
  owned.queuedLandings.push(number)
  const response = await realApi(page, request, "PUT", repositoryApiPath(owned.fullName, `/landings/${number}/land`), {
    commit_id: change.commit_id
  })
  expect(response.status()).toBe(202)
  return await response.json() as Landing
}

export const trackLandingQueue = (owned: OwnedPullRequestRepo, number: number): void => {
  if (!owned.queuedLandings.includes(number)) owned.queuedLandings.push(number)
}

export const waitForLandingState = async (
  page: Page,
  request: APIRequestContext,
  owned: OwnedPullRequestRepo,
  number: number,
  state: string
): Promise<Landing> => {
  let landing: Landing | undefined
  await expect.poll(async () => {
    landing = await readLanding(page, request, owned, number)
    return landing.state
  }, { timeout: 180_000, intervals: [1_000, 2_000, 5_000] }).toBe(state)
  return landing!
}

export const attachPullRequestEvidence = (
  testInfo: TestInfo,
  name: string,
  value: unknown
): Promise<void> => attachProductionJson(testInfo, fixtureAttachmentName(`pull-request-${name}`), value)

export const withOwnedPullRequestRepo = async <T>(
  page: Page,
  request: APIRequestContext,
  context: BrowserContext,
  login: string,
  testInfo: TestInfo,
  purpose: string,
  run: (owned: OwnedPullRequestRepo) => Promise<T>
): Promise<T> => {
  const owned = await provisionOwnedPullRequestRepo(page, request, context, login, testInfo, purpose)
  let value: T | undefined
  let scenarioFailure: unknown
  try {
    value = await run(owned)
  } catch (error) {
    scenarioFailure = error
  }
  let cleanupFailure: unknown
  try {
    await cleanupOwnedPullRequestRepo(page, request, owned, testInfo)
  } catch (error) {
    cleanupFailure = error
  }
  // The scenario answers for its body; a cleanup that could not finish is filed
  // as a teardown problem, which the real-E2E reporter fails the RUN on.
  const outcome = scenarioOutcome({
    repository: owned.fullName,
    bodyError: scenarioFailure,
    teardownFailures: cleanupFailure === undefined ? [] : [cleanupFailure]
  })
  for (const sentence of outcome.teardown) testInfo.annotations.push({ type: TEARDOWN_ANNOTATION, description: sentence })
  if (outcome.verdict !== undefined) throw outcome.verdict
  return value as T
}

/** Drain import work, attempt each eligible deletion independently, verify absence, and record any orphan. */
export const cleanupOwnedPullRequestRepo = async (
  page: Page,
  request: APIRequestContext,
  owned: OwnedPullRequestRepo,
  testInfo: TestInfo
): Promise<void> => {
  const failures: unknown[] = []
  let terminal = owned.importTerminal
  let importDrained = !owned.importSubmitted || owned.importDrained
  let landingsDrained = true
  const card = page.getByTestId(`card-repo-import-${owned.fullName}`)
  if (owned.importSubmitted && !importDrained) {
    try {
      terminal ??= owned.acceptedJobId !== undefined
        ? await waitForImportJobId(page, request, owned.acceptedJobId, 60_000) as ImportTerminal
        : await (async () => {
            await expect(card, `exact import card for ${owned.fullName}`).toHaveCount(1)
            return await waitForImportJob(page, request, card, 60_000) as ImportTerminal | undefined
          })()
      const cardOnly = terminal?.observed_from === "repo-import-card"
      importDrained = !cardOnly && (terminal?.status === "ready" || terminal?.status === "failed")
      if (!importDrained) failures.push(new TeardownProblem(`Import job for ${owned.fullName} did not drain, so the repository it imported into is preserved.`))
    } catch (error) {
      failures.push(error)
    }
  }

  for (const number of owned.queuedLandings) {
    try {
      await expect.poll(async () => (await readLanding(page, request, owned, number)).state, {
        timeout: 180_000,
        intervals: [1_000, 2_000, 5_000]
      }).toMatch(/^(merged|failed|closed)$/)
    } catch (error) {
      landingsDrained = false
      failures.push(new TeardownProblem(`Landing job #${number} for ${owned.fullName} did not drain, so the repository it lands into is preserved.`, { cause: error }))
    }
  }

  let cloudDeleted = !owned.importSubmitted
  let githubDeleted = false
  if (owned.mirrorPending) {
    failures.push(new TeardownProblem(`Mirror on ${owned.fullName} has no terminal receipt, so the repository and everything that depends on it are preserved.`))
  } else if (importDrained && landingsDrained) {
    const cleanup = await Promise.allSettled([
      owned.importSubmitted ? deleteOwnedCloudRepository(page, request, owned.fullName) : Promise.resolve(undefined),
      deleteOwnedGitHubRepository(owned)
    ])
    if (cleanup[0].status === "fulfilled") cloudDeleted = true
    else failures.push(cleanup[0].reason)
    if (cleanup[1].status === "fulfilled") githubDeleted = true
    else failures.push(cleanup[1].reason)
  } else {
    const github = await Promise.allSettled([deleteOwnedGitHubRepository(owned)])
    if (github[0].status === "fulfilled") githubDeleted = true
    else failures.push(github[0].reason)
    try {
      if (owned.acceptedJobId !== undefined) terminal = await waitForImportJobId(page, request, owned.acceptedJobId, 60_000) as ImportTerminal
      else if (await card.count() === 1) terminal = await waitForImportJob(page, request, card, 60_000) as ImportTerminal | undefined
      const cardOnly = terminal?.observed_from === "repo-import-card"
      importDrained = !cardOnly && (terminal?.status === "ready" || terminal?.status === "failed")
    } catch (error) {
      failures.push(error)
    }
    if (importDrained && landingsDrained && owned.importSubmitted) {
      try {
        await deleteOwnedCloudRepository(page, request, owned.fullName)
        cloudDeleted = true
      } catch (error) {
        failures.push(error)
      }
    }
  }

  await owned.page.close().catch((error) => failures.push(error))
  const orphans = [
    ...(!githubDeleted ? [{ service: "github", repository: owned.fullName }] : []),
    ...(!cloudDeleted ? [{ service: "smithers-cloud", repository: owned.fullName }] : [])
  ]
  await attachProductionJson(testInfo, "pull-request-cleanup", {
    repository: owned.fullName,
    importSubmitted: owned.importSubmitted,
    importRejected: owned.importRejected,
    importResponseStatus: owned.importResponseStatus,
    acceptedJobId: owned.acceptedJobId,
    importDrained,
    landingsDrained,
    terminal,
    githubDeleted,
    cloudDeleted,
    orphans,
    failures: failures.map(String)
  })
  if (failures.length > 0 || orphans.length > 0) {
    throw new AggregateError(failures, `Cleanup for ${owned.fullName} left ${orphans.length} recorded orphan(s)`)
  }
}
