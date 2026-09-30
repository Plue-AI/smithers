import type { APIRequestContext, BrowserContext, Locator, Page, TestInfo } from "@playwright/test"
import { command, expect, realApi } from "../support/test"
import { deletionOutcome, githubCreationBar, TeardownRefusal } from "../support/teardown"
import { readAuthenticatedSession } from "../auth-permissions/profile"
import { finishFirstVisit } from "../support/first-visit"

export const PRODUCTION_REPO = "codeplanesmithers/canary-sandbox"

export const cloudRepoPath = (repo: string, suffix = ""): string => {
  const [owner = "", name = ""] = repo.split("/")
  return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`
}

/** Product repository reads are served by the app's direct repository facade. */
export const repositoryApiPath = (repo: string, suffix = ""): string => {
  const [owner = "", name = ""] = repo.split("/")
  return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`
}

export const bootProductionRepository = async (page: Page, repo = PRODUCTION_REPO): Promise<void> => {
  // The authenticated fixture already opens appEntryPath. Preserve that page
  // and its freshly verified cookie instead of issuing a redundant navigation.
  if (new URL(page.url()).pathname.replace(/\/$/, "") !== `/${repo}`) {
    await page.goto(`/${repo}`, { waitUntil: "domcontentloaded" })
  }
  await finishFirstVisit(page)
  await expect(page).toHaveURL(new RegExp(`/${repo.replace("/", "\\/")}$`))
  await expect(page.getByTestId("transcript")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  const session = await readAuthenticatedSession(page)
  if (process.env.SMITHERS_REAL_AUTH_KIND === "application-token") {
    expect(session?.login).toEqual(expect.any(String))
  } else {
    // The scoped-down account (e2e/README.md): a suite that passes as an admin hides permission bugs.
    expect(session).toEqual({ login: "codeplanesmithers", admin: false })
  }
}

export const enableProductionVerbose = async (page: Page): Promise<void> => {
  const receipts = page.getByText(/^Verbose (?:on|off)(?: —|$)/)
  const toggle = async (): Promise<void> => {
    const before = await receipts.count()
    await command(page, "/verbose")
    await expect(receipts).toHaveCount(before + 1)
  }
  await toggle()
  if ((await receipts.last().textContent())?.startsWith("Verbose off")) await toggle()
  await expect(receipts.last()).toContainText("Verbose on")
}

export const readJson = async <T>(
  page: Page,
  request: APIRequestContext,
  path: string
): Promise<T> => {
  const response = await realApi(page, request, "GET", path)
  expect(response.status(), `GET ${path}`).toBe(200)
  return await response.json() as T
}

export const attachProductionJson = async (testInfo: TestInfo, name: string, value: unknown): Promise<void> => {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json"
  })
}

export type OwnedGitHubRepository = {
  readonly fullName: string
  readonly name: string
  readonly url: string
  readonly page: Page
}

/** Provision the uniquely named source through GitHub's live repository form. */
export const createOwnedGitHubRepository = async (
  context: BrowserContext,
  name: string,
  visibility: "private" | "public" = "private"
): Promise<OwnedGitHubRepository> => {
  if (!/^smithers-e2e-import-[a-z0-9-]+$/.test(name)) {
    throw new Error(`Refusing to create a GitHub repository outside the owned E2E namespace: ${name}`)
  }
  // A run that cannot delete what it owns must not mint more of it. The bar is
  // raised by the first deletion that hit a wall a machine cannot pass, and it
  // names the act that clears it, so this refusal is the same sentence.
  const barred = githubCreationBar.reason()
  if (barred !== undefined) throw new TeardownRefusal("github-sudo-mode", barred)
  const github = await context.newPage()
  const fullName = `codeplanesmithers/${name}`
  const url = `https://github.com/${fullName}`
  const owned = { fullName, name, url, page: github }
  let submitted = false
  try {
    await github.goto("https://github.com/new", { waitUntil: "domcontentloaded" })
    if (new URL(github.url()).hostname !== "github.com" || /^\/(login|session)(\/|$)/.test(new URL(github.url()).pathname)) {
      throw new Error("The sanctioned GitHub session cannot reach the repository creation UI.")
    }
    await expect(github.locator("body")).toContainText("Create a new repository")
    await expect(github.getByRole("button", { name: "codeplanesmithers, Owner (Required)", exact: true })).toBeVisible()

    const nameInput = github.getByLabel(/Repository name/i)
      .or(github.getByRole("textbox", { name: /Repository name/i }))
      .or(github.locator([
        'input[name="repository[name]"]:visible',
        '#repository_name:visible',
        'input[aria-label*="Repository name"]:visible'
      ].join(", ")))
      .first()
    await expect(nameInput).toBeVisible()
    await nameInput.fill(name)

    if (visibility === "private") {
      const privateChoice = github.getByLabel(/^Private/i)
        .or(github.locator('input[type="radio"][value="private"]:visible'))
        .first()
      if (await privateChoice.isVisible().catch(() => false)) {
        await privateChoice.check()
        await expect(privateChoice).toBeChecked()
      }
      else {
        const visibilityButton = github.getByRole("button", { name: "Public", exact: true })
        await expect(visibilityButton).toBeVisible()
        await visibilityButton.click()
        const privateOption = github.getByRole("menuitemradio", { name: /^Private/i })
          .or(github.getByRole("menuitem", { name: /^Private/i }))
          .or(github.getByText("Private", { exact: true }))
          .last()
        await expect(privateOption).toBeVisible()
        await privateOption.click()
        await expect(github.getByRole("button", { name: "Private", exact: true })).toBeVisible()
      }
    }
    const readmeChoice = github.locator('input[name="repository[auto_init]"]:visible').first()
    if (await readmeChoice.count()) {
      await readmeChoice.check()
      await expect(readmeChoice).toBeChecked()
    }
    else {
      const readmeToggle = github.getByRole("button", { name: "Add README", exact: true })
      await expect(readmeToggle).toBeVisible()
      if (await readmeToggle.getAttribute("aria-pressed") !== "true") await readmeToggle.click()
      await expect(readmeToggle).toHaveAttribute("aria-pressed", "true")
    }

    // GitHub renders a Unicode ellipsis while its real availability request is
    // pending. Waiting for an absent ASCII spelling returned immediately and
    // submitted before validation, so the form silently stayed on /new.
    await expect(github.getByText(`${name} is available.`, { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(nameInput).toHaveValue(name)
    const create = github.getByRole("button", { name: /^Create repository$/ }).last()
    await expect(create).toBeEnabled({ timeout: 30_000 })
    // From this point onward cleanup treats the exact full name as possibly
    // existing, even if navigation or a later assertion fails.
    submitted = true
    await create.focus()
    await expect(create).toBeFocused()
    const [creationResponse] = await Promise.all([
      github.waitForResponse((response) => new URL(response.url()).origin === "https://github.com" &&
        new URL(response.url()).pathname === "/repositories" && response.request().method() === "POST", { timeout: 60_000 }),
      github.waitForURL((candidate) => candidate.origin === "https://github.com" && candidate.pathname.replace(/\/$/, "") === `/${fullName}`, { timeout: 60_000 }),
      create.press("Enter")
    ])
    expect(creationResponse.status(), "GitHub must accept the real repository creation request").toBeLessThan(400)
    await expect(github.locator(`a[href="/codeplanesmithers"]:visible`).first()).toBeVisible()
    await expect(github.getByText(visibility === "private" ? "Private" : "Public", { exact: true }).first()).toBeVisible()
    await expect(github.getByRole("link", { name: /^README\.md(?:, \(File\))?$/ }).first()).toBeVisible()
    return owned
  } catch (error) {
    const failureUrl = new URL(github.url())
    const creationFailure = {
      origin: failureUrl.origin,
      path: failureUrl.pathname,
      title: await github.title().catch(() => ""),
      alerts: await github.getByRole("alert").allInnerTexts().catch(() => [])
    }
    const cleanupFailures: unknown[] = []
    if (submitted) {
      try {
        await deleteOwnedGitHubRepository(owned)
      } catch (cleanupError) {
        const probe = await github.goto(url, { waitUntil: "domcontentloaded" }).catch((probeError) => {
          cleanupFailures.push(new Error(`Existence probe for possibly-created ${fullName} failed`, { cause: probeError }))
          return undefined
        })
        if (probe?.status() !== 404) {
          cleanupFailures.push(new Error(`Cleanup of possibly-created ${fullName} was not verified`, { cause: cleanupError }))
        }
      }
    }
    await github.close().catch((closeError) => {
      cleanupFailures.push(new Error(`Closing the GitHub page for ${fullName} failed`, { cause: closeError }))
    })
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], `GitHub repository creation failed and ${fullName} may require cleanup`)
    }
    throw new Error(`GitHub repository creation failed at ${creationFailure.origin}${creationFailure.path}: ${JSON.stringify({ title: creationFailure.title, alerts: creationFailure.alerts })}`, { cause: error })
  }
}

/** Delete only the exact owned source and verify GitHub now returns 404 for it. */
export const deleteOwnedGitHubRepository = async (owned: OwnedGitHubRepository): Promise<void> => {
  if (!owned.fullName.startsWith("codeplanesmithers/smithers-e2e-import-")) {
    throw new Error(`Refusing to delete a GitHub repository outside the owned E2E namespace: ${owned.fullName}`)
  }
  const github = owned.page
  await github.goto(`${owned.url}/settings`, { waitUntil: "domcontentloaded" })
  const deleteDoor = github.getByRole("button", { name: /^Delete this repository$/ }).last()
  await expect(deleteDoor).toBeVisible({ timeout: 30_000 })
  await deleteDoor.click()

  const intent = github.getByRole("button", { name: /^I want to delete this repository$/ }).last()
  if (await intent.isVisible().catch(() => false)) await intent.click()
  const effects = github.getByRole("button", { name: /^I have read and understand these effects$/ }).last()
  if (await effects.isVisible().catch(() => false)) await effects.click()
  const confirmation = github.getByRole("textbox", { name: /To confirm, type/ }).or(github.locator([
    'input[aria-label*="confirm"]:visible',
    'input[aria-label*="repository name"]:visible',
    'input[name="verify"]:visible'
  ].join(", "))).last()
  await expect(confirmation).toBeVisible({ timeout: 30_000 })
  await confirmation.fill(owned.fullName)
  const finalDelete = github.getByRole("button", { name: /^Delete this repository$/ }).last()
  await expect(finalDelete).toBeEnabled({ timeout: 30_000 })
  await finalDelete.click()
  /*
   * GitHub answers the final Delete in one of two ways, and only one of them
   * navigates. When the profile's sudo session has lapsed it renders Confirm
   * access instead and offers a single factor, an emailed code. Waiting on the
   * navigation alone spent 60 seconds on something that could never happen and
   * then reported a library timeout, so both answers are watched and the first
   * one ends the wait: an ordinary deletion costs what it costs, and the wall
   * is named for what it is as soon as it renders.
   */
  try {
    await deletionOutcome({
      repository: owned.fullName,
      navigatedAway: github.waitForURL((candidate) => !candidate.pathname.startsWith(`/${owned.fullName}`), { timeout: 60_000 }),
      sudoConfirmVisible: github.getByRole("heading", { name: /^Confirm access$/ }).first().waitFor({ state: "visible", timeout: 60_000 })
    })
  } catch (error) {
    // Every later scenario would mint a repository this same wall keeps, so the
    // refusal closes the door behind it before it is reported.
    if (error instanceof TeardownRefusal) githubCreationBar.raise(error.message)
    throw error
  }

  const missing = await github.goto(owned.url, { waitUntil: "domcontentloaded" })
  expect(missing?.status()).toBe(404)
}

export const waitForImportJob = async (
  page: Page,
  request: APIRequestContext,
  card: Locator,
  timeout = 240_000
): Promise<Record<string, unknown> | undefined> => {
  const jobLine = card.locator(".world-card-path").filter({ hasText: /^job\s+\S+$/ }).first()
  const terminalBadge = card.getByText(/^(done|failed)$/, { exact: true }).first()
  await expect.poll(async () => {
    const exactJob = await jobLine.textContent().catch(() => null)
    if (exactJob !== null) return exactJob
    return await terminalBadge.textContent().catch(() => null)
  }, { timeout: 30_000, intervals: [250, 500, 1_000] }).toMatch(/^(job\s+\S+|done|failed)$/i)
  const exactJob = await jobLine.textContent().catch(() => null)
  const jobId = exactJob === null ? undefined : /^job\s+(\S+)$/i.exec(exactJob)?.[1]
  if (jobId === undefined) {
    const terminal = (await terminalBadge.textContent())?.trim().toLowerCase()
    if (terminal === "done") return { status: "ready", observed_from: "repo-import-card" }
    if (terminal === "failed") return { status: "failed", observed_from: "repo-import-card" }
    throw new Error("The repository import card exposed neither an exact job id nor a terminal status.")
  }
  return await waitForImportJobId(page, request, jobId, timeout)
}

/** Poll one accepted import job by its response-owned id until Plue settles it. */
export const waitForImportJobId = async (
  page: Page,
  request: APIRequestContext,
  jobId: string,
  timeout = 240_000
): Promise<Record<string, unknown>> => {
  if (jobId === "") throw new Error("Cannot wait for an import job without its accepted id.")
  let terminal: Record<string, unknown> | undefined
  await expect.poll(async () => {
    const response = await realApi(page, request, "GET", `/api/github/import/${encodeURIComponent(jobId)}`)
    if (response.status() !== 200) return `http-${response.status()}`
    const body = await response.json() as Record<string, unknown>
    terminal = body
    return body.status
  }, { timeout, intervals: [1_000, 2_000, 5_000] }).toMatch(/^(ready|failed)$/)
  if (terminal === undefined) throw new Error(`Import job ${jobId} reached no readable terminal answer.`)
  return terminal
}

export type OwnedWorkspaceCleanup = {
  readonly workspaceId: string
  readonly initialStatus: string
  readonly deleteStatus: number
  readonly finalStatus: number
}

/** Delete provider VMs while their repository-scoped metadata still exists. */
export const drainOwnedCloudWorkspaces = async (
  page: Page,
  request: APIRequestContext,
  repo: string
): Promise<ReadonlyArray<OwnedWorkspaceCleanup>> => {
  if (!/^[a-z0-9-]+\/smithers-e2e-import-[a-z0-9-]+$/.test(repo)) {
    throw new Error(`Refusing workspace cleanup outside the owned E2E namespace: ${repo}`)
  }
  expect((await readAuthenticatedSession(page))?.login, "workspace cleanup must retain the fixture owner identity").toBe(repo.split("/")[0])
  const path = cloudRepoPath(repo, "/workspaces")
  const deleted: OwnedWorkspaceCleanup[] = []
  const seen = new Set<string>()
  // Delete the first page, then read it again. Advancing an offset while
  // removing rows would skip workspaces shifted out of a later page.
  for (let batch = 0; batch < 10; batch += 1) {
    const response = await realApi(page, request, "GET", `${path}?limit=100`)
    if (response.status() === 404 && deleted.length === 0) return deleted
    expect(response.status(), `List owned workspaces for ${repo}`).toBe(200)
    const rows = await response.json() as unknown
    expect(Array.isArray(rows), "the real workspace inventory must be an array").toBe(true)
    if ((rows as unknown[]).length === 0) return deleted
    const failures: unknown[] = []
    for (const value of rows as Array<{ readonly id?: unknown; readonly status?: unknown }>) {
      try {
        expect(typeof value?.id, "workspace inventory id").toBe("string")
        const workspaceId = value.id as string
        expect(workspaceId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)
        expect(seen.has(workspaceId), `deleted workspace ${workspaceId} must leave the inventory`).toBe(false)
        const workspacePath = `${path}/${encodeURIComponent(workspaceId)}`
        let initialStatus = ""
        await expect.poll(async () => {
          const current = await realApi(page, request, "GET", workspacePath)
          if (current.status() === 404) { initialStatus = "absent"; return initialStatus }
          expect(current.status(), `Inspect owned workspace ${workspaceId}`).toBe(200)
          const row = await current.json() as { readonly id?: unknown; readonly status?: unknown }
          expect(row.id).toBe(workspaceId)
          expect(typeof row.status).toBe("string")
          initialStatus = row.status as string
          return initialStatus
        }, { timeout: 180_000, intervals: [1_000, 2_000, 5_000] }).toMatch(/^(running|suspended|stopped|failed|absent)$/)
        // Pending/starting VMs may still be created by a detached provisioner.
        // Do not remove their repository or metadata while that is unresolved.
        const deletion = await realApi(page, request, "DELETE", workspacePath)
        expect([204, 404], `Delete provider workspace ${workspaceId}`).toContain(deletion.status())
        let finalStatus = 0
        await expect.poll(async () => {
          finalStatus = (await realApi(page, request, "GET", workspacePath)).status()
          return finalStatus
        }, { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toBe(404)
        deleted.push({ workspaceId, initialStatus, deleteStatus: deletion.status(), finalStatus })
        seen.add(workspaceId)
      } catch (error) {
        failures.push(new Error(`Owned workspace ${String(value?.id)} on ${repo} did not reach verified deletion.`, { cause: error }))
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Preserving ${repo}: workspace cleanup is incomplete; completed deletions: ${JSON.stringify(deleted)}`)
    }
  }
  throw new Error(`Preserving ${repo}: its workspace inventory did not drain within ten bounded batches.`)
}

/** Remove owned provider workspaces before repository storage and DB metadata. */
export const deleteOwnedCloudRepository = async (
  page: Page,
  request: APIRequestContext,
  repo: string
): Promise<{ readonly deleteStatus: number; readonly finalStatus: number; readonly workspaces: ReadonlyArray<OwnedWorkspaceCleanup> }> => {
  if (!/^[a-z0-9-]+\/smithers-e2e-import-[a-z0-9-]+$/.test(repo)) {
    throw new Error(`Refusing to delete a Smithers Cloud repository outside the owned E2E namespace: ${repo}`)
  }
  const workspaces = await drainOwnedCloudWorkspaces(page, request, repo)
  const path = cloudRepoPath(repo)
  const deletion = await realApi(page, request, "DELETE", path)
  expect([204, 404]).toContain(deletion.status())
  let finalStatus = 0
  await expect.poll(async () => {
    finalStatus = (await realApi(page, request, "GET", path)).status()
    return finalStatus
  }, { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toBe(404)
  return { deleteStatus: deletion.status(), finalStatus, workspaces }
}
