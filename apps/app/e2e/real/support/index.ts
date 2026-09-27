import { expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test"
// Share the isolated persistent WebKit context; it supplies real OPFS and
// contains no API or product doubles. Chromium keeps its standard context.
import { test as base } from "../../playwright/browserTest"
import { cp, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { spawn } from "node:child_process"
import { nativeTarget } from "../native-target"
import { appEntryPath } from "./app-entry"

export { appEntryPath, expect }

export type RealScenarioMetadata = {
  /** Stable lower-case identifier, shared by local proof and production canary evidence. */
  readonly id: string
  /** Capabilities which must be advertised by the real host's /api/bootstrap response. */
  readonly capabilities: readonly string[]
  /** Machine tokens such as action:repo.open, path:success, door:slash, dimension:keyboard. */
  readonly coverage: readonly string[]
  readonly description?: string
}

export type OwnedLocalRepo = {
  readonly root: string
  readonly path: string
  readonly name: string
}

export type OwnedLocalRepoOptions = {
  readonly name?: string
  readonly fixture?: string
  readonly files?: Readonly<Record<string, string>>
}

type RegisteredRepo = { readonly id: string; readonly path?: string }
type Lifecycle = {
  readonly request: APIRequestContext
  readonly baseURL: URL
  readonly sessionToken?: string
  readonly authorization?: string
  readonly ptys: Set<string>
  readonly repos: Map<string, RegisteredRepo>
  readonly localRepos: Set<string>
}

let activeLifecycle: Lifecycle | undefined
// Playwright loads this package as CommonJS; __dirname follows its compiled module.
const supportDir = __dirname
const appDir = resolve(supportDir, "../../..")
const defaultFixture = join(supportDir, "../../fixtures/repo-plugin")
const fixtureRoot = resolve(supportDir, "../../fixtures")

const nativeCDPEndpoint = process.env.SMITHERS_REAL_NATIVE_CDP_ENDPOINT?.trim()
const nativeWindowUrl = process.env.SMITHERS_REAL_NATIVE_WINDOW_URL?.trim()
const nativeTargetId = process.env.SMITHERS_REAL_NATIVE_TARGET_ID?.trim()
const selectedBase = nativeCDPEndpoint === undefined || nativeCDPEndpoint === "" ? base : base.extend({
  browser: [async ({ playwright }, use) => {
    const browser = await playwright.chromium.connectOverCDP(nativeCDPEndpoint)
    await use(browser)
    // Electrobun owns the browser process. Its launcher performs teardown.
  }, { scope: "worker" }],
  context: async ({ browser }, use) => {
    if (!nativeWindowUrl || !nativeTargetId) {
      throw new Error("Native CDP attachment requires the packaged window URL and CDP target ID.")
    }
    const target = await nativeTarget(browser.contexts(), nativeWindowUrl, nativeTargetId)
    await use(target.context)
  },
  page: async ({ context }, use) => {
    if (!nativeWindowUrl || !nativeTargetId) {
      throw new Error("Native CDP attachment requires the packaged window URL and CDP target ID.")
    }
    await use((await nativeTarget([context], nativeWindowUrl, nativeTargetId)).page)
  }
})

const run = async (command: string, args: readonly string[], cwd: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => { stderr += chunk })
    child.once("error", reject)
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr.trim()}`)))
  })
}

const requireLifecycle = (): Lifecycle => {
  if (!activeLifecycle) throw new Error("A real E2E resource can only be registered while a test is running.")
  return activeLifecycle
}

const selectedApiOrigin = (page: Page): string =>
  new URL(process.env.SMITHERS_REAL_API_ORIGIN ?? page.url()).origin

const applicationAuthorization = (): string | undefined => {
  if (process.env.SMITHERS_REAL_AUTH_KIND !== "application-token") return undefined
  const name = process.env.SMITHERS_REAL_AUTH_ENVIRONMENT?.trim()
  if (!name || !/^[A-Z][A-Z0-9_]+$/.test(name)) {
    throw new Error("Application-token auth requires SMITHERS_REAL_AUTH_ENVIRONMENT.")
  }
  const token = process.env[name]?.trim()
  if (!token) throw new Error(`${name} is required for application-token auth.`)
  return `Bearer ${token}`
}

const requireSameOrigin = (page: Page, target: URL): void => {
  const current = new URL(page.url())
  const apiOrigin = selectedApiOrigin(page)
  if (!/^https?:$/.test(current.protocol) || apiOrigin !== target.origin) {
    throw new Error(`realApi refuses an undeclared API origin: page=${current.origin}, api=${apiOrigin}, request=${target.origin}`)
  }
}

const isDescendant = (root: string, candidate: string): boolean => candidate.startsWith(`${root}${sep}`)

const authorizedFetch = (
  lifecycle: Pick<Lifecycle, "request" | "baseURL" | "sessionToken" | "authorization">,
  method: string,
  path: string,
  data?: unknown
): Promise<APIResponse> => lifecycle.request.fetch(new URL(path, lifecycle.baseURL).toString(), {
  method,
    ...(lifecycle.sessionToken || lifecycle.authorization ? { headers: {
      ...(lifecycle.sessionToken ? { "x-smithers-local-session": lifecycle.sessionToken } : {}),
      ...(lifecycle.authorization ? { authorization: lifecycle.authorization } : {})
    } } : {}),
  ...(data === undefined ? {} : { data })
})

/** Make an authenticated API call to the origin currently loaded in the product page. */
export const realApi = async (
  page: Page,
  _request: APIRequestContext,
  method: string,
  path: string,
  data?: unknown
): Promise<APIResponse> => {
  const target = new URL(path, selectedApiOrigin(page))
  requireSameOrigin(page, target)
  // Cloud pages use their browser session and do not carry the local host's
  // session tag. Read the optional tag without waiting for one to appear.
  const token = await page.evaluate(() =>
    document.querySelector('meta[name="smithers-local-session"]')?.getAttribute("content") ?? null)
  const authorization = applicationAuthorization()
  const ownerMutation = process.env.SMITHERS_REAL_AUTH_KIND === "owner-session" && !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())
  const csrf = ownerMutation
    ? (await page.context().cookies(target.origin)).find((cookie) => cookie.name === "__csrf")?.value
    : undefined
  if (ownerMutation && !csrf) throw new Error("Owner session has no CSRF cookie for the requested mutation.")
  return page.context().request.fetch(target.toString(), {
    method,
    ...(token || authorization || ownerMutation ? { headers: {
      ...(token ? { "x-smithers-local-session": token } : {}),
      ...(authorization ? { authorization } : {}),
      ...(ownerMutation ? { Origin: target.origin, "X-CSRF-Token": csrf! } : {})
    } } : {}),
    ...(data === undefined ? {} : { data })
  })
}

export const productUrl = (page: Page, path: string): string => {
  const current = page.url()
  const origin = /^https?:\/\//.test(current)
    ? current
    : process.env.SMITHERS_REAL_BASE_URL ?? base.info().project.use.baseURL
  if (!origin) throw new Error("The product page has no HTTP origin for navigation.")
  return new URL(path, origin).toString()
}

export const openApp = async (page: Page): Promise<void> => {
  await page.goto(productUrl(page, appEntryPath()))
}

/** What a measured boot followed: a fresh load of the app, or a reload of the page already on it. */
export type BootKind = "navigate" | "reload"
export const BOOT_KINDS = ["navigate", "reload"] as const

/** One measured boot: when it was taken, what it followed, and how long the booted view took to appear. */
export type ReloadBootTiming = { readonly at: string; readonly kind: BootKind; readonly ms: number }

const measuredReloadBoots: ReloadBootTiming[] = []

/**
 * The one bound every boot wait uses.
 *
 * The persistent production profile reached its booted view in 12 to 72 s, and
 * a fresh navigation climbs the same way, so both waits are held to the same
 * measured budget rather than to Playwright's 15 s assertion default.
 */
export const BOOT_TIMEOUT_MS = 120_000

/**
 * Every boot this worker measured, oldest first.
 *
 * Each boot records what the run actually cost, so a scenario can archive the
 * distribution and the next person to touch the budget above reads this run's
 * evidence rather than repeating the measurement.
 */
export const reloadBootTimings = (): ReadonlyArray<ReloadBootTiming> => measuredReloadBoots

/**
 * What a booted view looks like, in either layout a restore can produce.
 *
 * Either half alone is a partial reading of the product. The transcript is
 * what the chat layout renders, but it is not always the layout: every tab
 * body stays mounted and the inactive ones carry `hidden`, the main body with
 * the transcript inside it included (`src/mainview/App.tsx:516`,
 * `src/mainview/tabs/TabBodies.tsx:43`). A reload that restores a durable card
 * or terminal tab therefore leaves the transcript attached and not busy but
 * hidden for as long as that tab is active, so a visibility wait there waits
 * for a signal the layout cannot produce. Reading only the active tab body
 * would be the mirror mistake.
 *
 * Neither half exists inside the boot skeleton, which is the whole page while
 * the view chunk loads and the store opens (`role="status"`,
 * `aria-label="Loading view"`, `src/mainview/ViewSkeleton.tsx:2`): both the
 * transcript and every tab body render under the view this skeleton stands in
 * for. So this is false for exactly as long as the app is still booting, true
 * the moment either layout is up, and needs no marker the product does not
 * already carry.
 *
 * `aria-busy` is the transcript's own streaming state
 * (`src/mainview/App.tsx:550`), so a restore that resumes a streaming turn
 * reads as booted through the tab-body half rather than stalling.
 */
export const BOOTED_SELECTOR =
  ':is([data-testid="transcript"][aria-busy="false"], [data-testid^="tab-body-"]:not([hidden]))'

/**
 * Wait for the app to finish booting before anything on it is read, and record
 * what that wait cost.
 *
 * A navigation resolves while the app is still fetching its view chunk and
 * opening its store, so an assertion made straight afterwards spends its whole
 * budget inside the boot skeleton and then reports the element it wanted as
 * missing, where the product had simply not rendered yet. Two production
 * attempts of the run-timeline scenario failed exactly there, both with
 * `status "Loading view"` as the entire page.
 *
 * `BOOTED_SELECTOR` above is what this waits for, attached rather than
 * visible: visibility is the wrong question for a layout that keeps its
 * inactive bodies mounted and hidden. It is one locator and one budget, not a
 * fallback tried after the first has spent its own, so a boot that never
 * finishes still reds as fast as it ever did, and it says the boot did not
 * finish rather than blaming the thing being read.
 *
 * Pass `startedAt`, a `performance.now()` reading taken before the navigation,
 * to measure the whole navigate-to-boot rather than its tail.
 *
 * A boot that never finished is not a boot time, so a timed-out wait records
 * nothing and fails as before.
 */
export const awaitBoot = async (
  page: Page,
  kind: BootKind = "navigate",
  startedAt: number = performance.now(),
  timeout = BOOT_TIMEOUT_MS
): Promise<void> => {
  await expect(page.locator(BOOTED_SELECTOR).first(), `the app must finish booting after a ${kind}`).toBeAttached({ timeout })
  measuredReloadBoots.push({ at: new Date().toISOString(), kind, ms: Math.round(performance.now() - startedAt) })
}

/** Reload, then wait for the booted view. */
export const reloadApp = async (page: Page, timeout = BOOT_TIMEOUT_MS): Promise<void> => {
  const startedAt = performance.now()
  await page.reload({ waitUntil: "domcontentloaded" })
  await awaitBoot(page, "reload", startedAt, timeout)
}

/** Open the transient Command-K composer and wait for its real input focus. */
export const openComposer = async (page: Page): Promise<void> => {
  const input = page.getByTestId("composer-input")
  const closed = !(await input.isVisible()) || await input.evaluate((element) => element.closest('[inert], [aria-hidden="true"]') !== null)
  if (closed) await page.keyboard.press("ControlOrMeta+k")
  // A visible guide composer can be unfocused after interacting with a card.
  // Focus its real input; Command-K would instead toggle the guide dock closed.
  else if (!(await input.evaluate((element) => element === document.activeElement))) await input.click()
  await expect(input).toBeVisible()
  if (nativeCDPEndpoint) {
    // A hidden CEF window cannot reliably become the OS key window. Assert
    // that the product opened an interactive composer; fill and press below
    // prove its input accepts the command.
    await expect.poll(() => input.evaluate((element) => element.closest('[inert], [aria-hidden="true"]') === null)).toBe(true)
  } else {
    await expect(input).toBeFocused()
  }
}

/** Submit one slash command or natural-language turn through the visible composer. */
export const command = async (page: Page, text: string): Promise<void> => {
  await openComposer(page)
  const input = page.getByTestId("composer-input")
  await input.fill(text)
  await input.press("Enter")
}

/** Dismiss the composer unless a confirmation dialog already owns keyboard input. */
export const closeComposer = async (page: Page): Promise<void> => {
  const input = page.getByTestId("composer-input")
  const modal = page.locator('.sui-dialog-content[role="dialog"]:visible').first()
  const inactive = async (): Promise<boolean> => !(await input.isVisible()) || await modal.isVisible()
  const waitForInactive = async (): Promise<boolean> => {
    try {
      await expect.poll(inactive, { timeout: 750 }).toBe(true)
      return true
    } catch {
      return false
    }
  }
  // Enter closes a command composer itself. Let that state transition and its
  // dock animation settle before emitting any new physical Escape. A modal
  // is also an inactive composer: it is now the top keyboard layer, and a
  // further Escape would correctly cancel that dialog.
  if (await waitForInactive()) return
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.keyboard.press("Escape")
    if (await waitForInactive()) return
  }
  await expect(input).toBeHidden()
}

/**
 * Create a disposable, runner-local repository with a real jj store.
 * External canaries must use a server-side disposable repository instead.
 */
export const createOwnedLocalRepo = async (options: OwnedLocalRepoOptions = {}): Promise<OwnedLocalRepo> => {
  if (process.env.SMITHERS_REAL_BASE_URL) {
    throw new Error("createOwnedLocalRepo is local-only; an external canary must provision a repository visible to its host.")
  }
  const lifecycle = requireLifecycle()
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-real-e2e-repo-")))
  const name = options.name ?? "real-e2e-repository"
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name === "." || name === "..") {
    await rm(root, { recursive: true, force: true })
    throw new Error(`Owned repository name must be one safe path component: ${JSON.stringify(name)}`)
  }
  const path = join(root, name)
  try {
    if (options.fixture === "none") await mkdir(path, { recursive: true })
    else {
      const fixture = resolve(options.fixture ?? defaultFixture)
      if (!isDescendant(fixtureRoot, fixture)) throw new Error(`Repository fixture must be inside ${fixtureRoot}.`)
      await cp(fixture, path, {
        recursive: true,
        filter: (entry) => ![".git", ".jj", ".flows", "node_modules"].includes(basename(entry))
      })
    }
    for (const [relative, contents] of Object.entries(options.files ?? {})) {
      const destination = resolve(path, relative)
      if (!isDescendant(path, destination)) throw new Error(`Owned repository file escapes its root: ${JSON.stringify(relative)}`)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, contents)
    }
    await run("jj", ["git", "init", "--no-colocate", path], appDir)
    lifecycle.localRepos.add(root)
    return { root, path, name }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

export const cleanupOwnedLocalRepo = async (repo: OwnedLocalRepo): Promise<void> => {
  const lifecycle = requireLifecycle()
  if (!lifecycle.localRepos.has(repo.root)) throw new Error(`Refusing cleanup of an unregistered directory: ${repo.root}`)
  if (!isDescendant(repo.root, repo.path)) throw new Error(`Refusing cleanup for an invalid owned repository path: ${repo.path}`)
  lifecycle.localRepos.delete(repo.root)
  await rm(repo.root, { recursive: true, force: true })
}

export const registerOwnedPty = (id: string): void => { requireLifecycle().ptys.add(id) }
export const registerOwnedRepo = (repo: RegisteredRepo): void => { requireLifecycle().repos.set(repo.id, repo) }

const validateScenario = (value: RealScenarioMetadata | undefined): RealScenarioMetadata => {
  if (!value || !/^[a-z0-9][a-z0-9._-]+$/.test(value.id)) {
    throw new Error("Every real E2E test must set realScenario with a stable lower-case id.")
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.some((item) => !item.trim())) throw new Error(`Real scenario ${value.id} requires an explicit capabilities array; browser-only scenarios may declare [].`)
  if (value.coverage.length === 0 || value.coverage.some((token) => !/^(action|path|door|dimension|surface|host|evidence):[^:]+/.test(token))) {
    throw new Error(`Real scenario ${value.id} must declare prefixed coverage tokens.`)
  }
  return value
}

const scenarioFromAnnotations = (
  annotations: readonly { readonly type: string; readonly description?: string }[],
  fallback: RealScenarioMetadata | undefined
): RealScenarioMetadata => {
  const declaredId = annotations.find((annotation) => annotation.type === "real-scenario")?.description
  if (!declaredId) return validateScenario(fallback)
  const descriptions = annotations.find((annotation) => annotation.type === "real-description")?.description
  return validateScenario({
    id: declaredId,
    capabilities: annotations
      .filter((annotation) => annotation.type === "real-capability")
      .flatMap((annotation) => annotation.description ? [annotation.description] : []),
    coverage: annotations
      .filter((annotation) => annotation.type === "real-coverage")
      .flatMap((annotation) => annotation.description ? [annotation.description] : []),
    ...(descriptions ? { description: descriptions } : {})
  })
}

type RealFixtures = { readonly realScenario: RealScenarioMetadata | undefined; readonly _realLifecycle: void }

/**
 * Prefer a unique per-test `scenario(id, metadata)` details object from
 * ../coverage/types. `test.use({ realScenario })` remains a suite-level
 * fallback for a describe containing exactly one scenario.
 */
export const test = selectedBase.extend<RealFixtures>({
  realScenario: [undefined, { option: true }],
  _realLifecycle: [async ({ page, realScenario }, use, testInfo) => {
    const scenario = scenarioFromAnnotations(testInfo.annotations, realScenario)
    if (!testInfo.annotations.some((annotation) => annotation.type === "real-scenario")) {
      testInfo.annotations.push({ type: "real-scenario", description: scenario.id })
      if (scenario.description) testInfo.annotations.push({ type: "real-description", description: scenario.description })
      for (const capability of scenario.capabilities) testInfo.annotations.push({ type: "real-capability", description: capability })
      for (const coverage of scenario.coverage) testInfo.annotations.push({ type: "real-coverage", description: coverage })
    }

    const request = page.context().request
    const rendererBaseURL = new URL(testInfo.project.use.baseURL ?? page.url())
    const baseURL = new URL(process.env.SMITHERS_REAL_API_ORIGIN ?? rendererBaseURL)
    const html = await request.get(new URL(appEntryPath(), rendererBaseURL).toString(), { headers: { Accept: "text/html" } })
    if (!html.ok()) throw new Error(`Real host document preflight failed: HTTP ${html.status()}`)
    const token = /<meta\s+name=["']smithers-local-session["']\s+content=["']([^"']+)["']/i.exec(await html.text())?.[1]
    const authorization = applicationAuthorization()
    const bootstrap = await request.get(new URL("/api/bootstrap", baseURL).toString(), {
      ...(token || authorization ? { headers: {
        ...(token ? { "x-smithers-local-session": token } : {}),
        ...(authorization ? { authorization } : {})
      } } : {})
    })
    if (!bootstrap.ok()) throw new Error(`Real host bootstrap preflight failed: HTTP ${bootstrap.status()} ${await bootstrap.text()}`)
    const body = await bootstrap.json() as { host?: unknown; authFlow?: unknown; capabilities?: unknown; buildSha?: unknown }
    // Every web origin is `host: "cloud"`; the hosted deployment signs in by redirect, a self-hosted one with owner credentials.
    const verifiedHost = body.host === "cloud" ? (body.authFlow === "redirect" ? "production" : "local") : body.host
    if (verifiedHost !== "local" && verifiedHost !== "production" && verifiedHost !== "native") {
      throw new Error(`Real host bootstrap returned an unsupported host identity: ${JSON.stringify(body.host)}`)
    }
    const expectedHost = process.env.SMITHERS_REAL_E2E_HOST
    if (expectedHost && expectedHost !== verifiedHost) {
      throw new Error(`Real host identity mismatch: expected ${expectedHost}, bootstrap verified ${verifiedHost}.`)
    }
    testInfo.annotations.push({ type: "real-host-verified", description: verifiedHost })
    if (verifiedHost === "production") {
      if (typeof body.buildSha !== "string" || !/^[0-9a-f]{40,64}$/.test(body.buildSha)) throw new Error("Production bootstrap did not identify the deployed build SHA.")
      if (body.buildSha !== process.env.SMITHERS_REAL_E2E_BUILD_SHA) throw new Error("Production build changed since preflight; restart the canary against a consistent deployment.")
      testInfo.annotations.push({ type: "real-build-sha", description: body.buildSha })
    }
    if (body.host === "local" && !token &&
      process.env.SMITHERS_REAL_AUTH_KIND !== "owner-session" &&
      process.env.SMITHERS_REAL_AUTH_KIND !== "application-token") {
      throw new Error("Local real host preflight found no configured authentication.")
    }
    if (body.host === "local") {
      const health = await request.get(new URL("/api/health", baseURL).toString())
      if (!health.ok()) throw new Error(`Local real host health preflight failed: HTTP ${health.status()} ${await health.text()}`)
    }
    const advertised = Array.isArray(body.capabilities) ? body.capabilities.filter((item): item is string => typeof item === "string") : []
    const missing = scenario.capabilities.filter((capability) => !advertised.includes(capability))
    if (missing.length > 0) throw new Error(`Real scenario ${scenario.id} requires unavailable capabilities: ${missing.join(", ")}. Advertised: ${advertised.join(", ")}`)

    const events: Array<{ readonly method: string; readonly path: string; readonly status: number }> = []
    page.on("response", (response) => {
      const url = new URL(response.url())
      if (url.pathname.startsWith("/api/")) events.push({ method: response.request().method(), path: url.pathname, status: response.status() })
    })
    const lifecycle: Lifecycle = {
      request,
      baseURL,
      ...(token ? { sessionToken: token } : {}),
      ...(authorization ? { authorization } : {}),
      ptys: new Set(),
      repos: new Map(),
      localRepos: new Set()
    }
    if (activeLifecycle) throw new Error("The real E2E lifecycle requires workers=1 and fullyParallel=false.")
    activeLifecycle = lifecycle
    try {
      await use()
    } finally {
      const failures: string[] = []
      for (const id of lifecycle.ptys) {
        try {
          const deleted = await authorizedFetch(lifecycle, "DELETE", `/api/pty/${encodeURIComponent(id)}`)
          if (!deleted.ok()) throw new Error(`DELETE returned HTTP ${deleted.status()}`)
        }
        catch (error) { failures.push(`PTY ${id}: ${String(error)}`) }
      }
      for (const repo of lifecycle.repos.values()) {
        try {
          const closed = await authorizedFetch(lifecycle, "POST", "/api/repo/close", { repoId: repo.id })
          if (!closed.ok()) throw new Error(`close returned HTTP ${closed.status()}`)
        }
        catch (error) { failures.push(`repository ${repo.id}${repo.path ? ` (${repo.path})` : ""}: ${String(error)}`) }
      }
      if (lifecycle.ptys.size > 0) {
        try {
          const response = await authorizedFetch(lifecycle, "GET", "/api/pty")
          if (!response.ok()) throw new Error(`GET returned HTTP ${response.status()}`)
          const body = await response.json() as { sessions?: Array<{ sessionId?: string }> }
          const remaining = (body.sessions ?? []).map((session) => session.sessionId).filter((id): id is string => typeof id === "string")
            .filter((id) => lifecycle.ptys.has(id))
          if (remaining.length > 0) throw new Error(`sessions remain: ${remaining.join(", ")}`)
        } catch (error) { failures.push(`PTY verification: ${String(error)}`) }
      }
      if (lifecycle.repos.size > 0) {
        try {
          const response = await authorizedFetch(lifecycle, "GET", "/api/repos")
          if (!response.ok()) throw new Error(`GET returned HTTP ${response.status()}`)
          const body = await response.json() as { repos?: Array<{ id?: string }> }
          const remaining = (body.repos ?? []).map((repo) => repo.id).filter((id): id is string => typeof id === "string")
            .filter((id) => lifecycle.repos.has(id))
          if (remaining.length > 0) throw new Error(`repositories remain: ${remaining.join(", ")}`)
        } catch (error) { failures.push(`repository verification: ${String(error)}`) }
      }
      for (const root of lifecycle.localRepos) {
        try { await rm(root, { recursive: true, force: true }) }
        catch (error) { failures.push(`directory ${root}: ${String(error)}`) }
      }
      activeLifecycle = undefined
      await testInfo.attach("real-network-statuses", { body: JSON.stringify(events, null, 2), contentType: "application/json" })
      if (failures.length > 0) throw new Error(`Real E2E resource cleanup failed:\n${failures.join("\n")}`)
    }
  }, { auto: true }]
})
