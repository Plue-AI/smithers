import { expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test"
// Share the isolated persistent WebKit context; it supplies real OPFS and
// contains no API or product doubles. Chromium keeps its standard context.
import { test as base } from "../../playwright/browserTest"
import { appEntryPath } from "./app-entry"
import { realHost } from "./host"

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

const selectedApiOrigin = (page: Page): string =>
  new URL(process.env.SMITHERS_REAL_API_ORIGIN ?? page.url()).origin

/** A Plue application token is a bearer; an owner token uses the owner backend's `token` scheme. */
const applicationAuthorization = (): string | undefined => {
  const kind = process.env.SMITHERS_REAL_AUTH_KIND
  if (kind !== "application-token" && kind !== "owner-token") return undefined
  const name = process.env.SMITHERS_REAL_AUTH_ENVIRONMENT?.trim()
  if (!name || !/^[A-Z][A-Z0-9_]+$/.test(name)) {
    throw new Error(`${kind} auth requires SMITHERS_REAL_AUTH_ENVIRONMENT.`)
  }
  const token = process.env[name]?.trim()
  if (!token) throw new Error(`${name} is required for ${kind} auth.`)
  return `${kind === "owner-token" ? "token" : "Bearer"} ${token}`
}

const requireSameOrigin = (page: Page, target: URL): void => {
  const current = new URL(page.url())
  const apiOrigin = selectedApiOrigin(page)
  if (!/^https?:$/.test(current.protocol) || apiOrigin !== target.origin) {
    throw new Error(`realApi refuses an undeclared API origin: page=${current.origin}, api=${apiOrigin}, request=${target.origin}`)
  }
}

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
  // A cookie session's mutation carries the double-submit CSRF pair the app sends; the API refuses it otherwise.
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())
  const csrf = mutation
    ? (await page.context().cookies(target.origin)).find((cookie) => cookie.name === "__csrf")?.value
    : undefined
  return page.context().request.fetch(target.toString(), {
    method,
    ...(token || authorization || csrf ? { headers: {
      ...(token ? { "x-smithers-local-session": token } : {}),
      ...(authorization ? { authorization } : {}),
      ...(csrf ? { Origin: target.origin, "X-CSRF-Token": csrf } : {})
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

/**
 * Wait for the app past its signup: Chat's button, or the first-run card
 * holding it, is on screen.
 *
 * Chat's button alone was this signal until the hosted web app began to
 * withhold it while the first-run card waits for the first registered job,
 * the card's dismissal or a sent message (`firstJobPending`,
 * `src/mainview/App.tsx`; apps/app/AGENTS.md First-run). The signup renders
 * neither, so a scenario stranded there still reds here. Opening Chat needs
 * neither: `openComposer` presses Command-K, which works throughout.
 *
 * Call it after a boot wait; the default budget is the assertion default, so
 * chrome that went missing reds fast rather than spending the boot's.
 */
export const appReady = async (page: Page, timeout?: number): Promise<void> => {
  const chat = page.getByRole("button", { name: "Chat", exact: true })
  const firstRun = page.locator('[data-testid="setup-checklist"]:visible')
  await expect(chat.or(firstRun).first(), "Chat or the first-run card holding it must be on screen")
    .toBeVisible(timeout === undefined ? {} : { timeout })
}

/** Open the transient Command-K composer and wait for its real input focus. */
export const openComposer = async (page: Page): Promise<void> => {
  // The booted view binds Command-K; a press into the boot skeleton is lost.
  await expect(page.locator(BOOTED_SELECTOR).first(), "the app must finish booting before Chat opens")
    .toBeAttached({ timeout: BOOT_TIMEOUT_MS })
  const input = page.getByTestId("composer-input")
  const closed = !(await input.isVisible()) || await input.evaluate((element) => element.closest('[inert], [aria-hidden="true"]') !== null)
  if (closed) await page.keyboard.press("ControlOrMeta+k")
  // A visible guide composer can be unfocused after interacting with a card.
  // Focus its real input; Command-K would instead toggle the guide dock closed.
  else if (!(await input.evaluate((element) => element === document.activeElement))) await input.click()
  await expect(input).toBeVisible()
  await expect(input).toBeFocused()

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
export const test = base.extend<RealFixtures>({
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
    const verifiedHost = realHost(body)
    if (verifiedHost !== "local" && verifiedHost !== "production") {
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
    if (verifiedHost === "local" && !token &&
      process.env.SMITHERS_REAL_AUTH_KIND !== "owner-token" &&
      process.env.SMITHERS_REAL_AUTH_KIND !== "application-token") {
      throw new Error("Local real host preflight found no configured authentication.")
    }
    if (verifiedHost === "local") {
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
    try {
      await use()
    } finally {
      await testInfo.attach("real-network-statuses", { body: JSON.stringify(events, null, 2), contentType: "application/json" })
    }
  }, { auto: true }]
})
