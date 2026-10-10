import { randomUUID } from "node:crypto"

/*
 * The owner's J1 setup walk (mvp.md J1 step 2) over the install's own HTTP
 * doors, as the setup card sends it: Address, the GitHub App through the
 * app-manifest flow, the owner's GitHub sign-in, the repository, Model access,
 * Source ready and Machine ready. GitHub is the repository-owned GitHub fake
 * (packages/backend/cmd/githubfake) and every model the loopback stand-in
 * (e2e/real/support/model-provider.ts), as in the local no-GitHub walk
 * (scripts/run-local-no-github.ts). Nothing here writes product state: the
 * owner, the roster, the GitHub App and the repository are what setup makes.
 */

export interface InstallResponse {
  readonly status: number
  readonly text: string
  readonly location?: string
}

const SAFE_METHODS = new Set(["GET", "HEAD"])

/** The `name=value` pair a Set-Cookie header sets; attributes are this single-origin harness's concern only. */
export const setCookiePair = (header: string): readonly [string, string] | undefined => {
  const pair = header.split(";", 1)[0]!
  const at = pair.indexOf("=")
  if (at <= 0) return undefined
  return [pair.slice(0, at).trim(), pair.slice(at + 1).trim()]
}

/**
 * One browser at the install's public origin. Requests connect to the
 * install's private backend address and name the public host, the way the
 * development server relays them (scripts/dev-backend-proxy.ts). It keeps the
 * cookies the install sets and sends the app's double-submit CSRF header on
 * every write.
 */
export class InstallBrowser {
  private readonly cookies = new Map<string, string>()

  constructor(private readonly backend: string, readonly origin: string) {}

  cookie(name: string): string | undefined { return this.cookies.get(name) }

  async request(method: string, path: string, body?: unknown): Promise<InstallResponse> {
    const target = new URL(path, this.origin)
    if (target.origin !== new URL(this.origin).origin) throw new Error(`${path} leaves the install origin`)
    const headers = new Headers({ "X-Forwarded-Host": target.host, "Idempotency-Key": randomUUID() })
    if (this.cookies.size > 0) headers.set("Cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "))
    if (!SAFE_METHODS.has(method)) {
      headers.set("Origin", this.origin)
      const csrf = this.cookies.get("__csrf")
      if (csrf !== undefined) headers.set("X-CSRF-Token", csrf)
    }
    if (body !== undefined) headers.set("Content-Type", "application/json")
    const response = await fetch(new URL(`${target.pathname}${target.search}`, this.backend), {
      method, headers, redirect: "manual", ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    for (const header of response.headers.getSetCookie()) {
      const pair = setCookiePair(header)
      if (pair === undefined) continue
      if (pair[1] === "" || /;\s*max-age=(?:0|-\d+)/i.test(header)) this.cookies.delete(pair[0])
      else this.cookies.set(pair[0], pair[1])
    }
    const location = response.headers.get("location") ?? undefined
    return { status: response.status, text: await response.text(), ...(location === undefined ? {} : { location }) }
  }

  async expect(method: string, path: string, status: number, body?: unknown): Promise<InstallResponse> {
    const response = await this.request(method, path, body)
    if (response.status !== status) throw new Error(`${method} ${path} answered ${response.status}, not ${status}: ${response.text.slice(0, 500)}`)
    return response
  }
}

const decodeHtml = (value: string): string => value
  .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&#34;", "\"").replaceAll("&quot;", "\"")
  .replaceAll("&#39;", "'").replaceAll("&amp;", "&")

/** The target of the anchor labelled `label` in a provider page, as GitHub's consent pages offer one. */
export const anchorTarget = (html: string, label: string): string => {
  for (const match of html.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)) {
    if (decodeHtml(match[2]!) === label) return decodeHtml(match[1]!)
  }
  throw new Error(`the provider page offers no "${label}" link: ${html.slice(0, 300)}`)
}

/** GitHub's manifest page, served by the fake: the app hands it a browser form POST (flows/cardActions.ts submitGitHubAppManifest). */
export const fakeManifestURL = (actionURL: string, fakeURL: string): string => {
  const target = new URL(actionURL)
  if (target.origin !== "https://github.com" || !/^\/(?:organizations\/[A-Za-z0-9-]+\/)?settings\/apps\/new$/.test(target.pathname)) {
    throw new Error(`setup handed off to an unexpected GitHub page: ${actionURL}`)
  }
  return `${fakeURL}${target.pathname}${target.search}`
}

interface InstallStep { readonly id: string; readonly state: string; readonly error?: unknown }

const steps = async (browser: InstallBrowser): Promise<readonly InstallStep[]> =>
  (JSON.parse((await browser.expect("GET", "/api/install", 200)).text) as { readonly steps: readonly InstallStep[] }).steps

/** Waits for one step's background work; a failed or blocked step fails the walk with its own error. */
export const waitStep = async (browser: InstallBrowser, id: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let last: InstallStep | undefined
  while (Date.now() < deadline) {
    last = (await steps(browser)).find(step => step.id === id)
    if (last?.state === "done") return
    if (last?.state === "failed" || last?.state === "blocked") throw new Error(`setup step ${id} ${last.state}: ${JSON.stringify(last.error)}`)
    await Bun.sleep(250)
  }
  throw new Error(`setup step ${id} is still ${last?.state ?? "missing"} after ${timeoutMs} ms`)
}

/** A step starts once the one before it is done; the background job that finishes it can land just after the read. */
const startStep = async (browser: InstallBrowser, id: string, body: unknown): Promise<void> => {
  const deadline = Date.now() + 30_000
  for (;;) {
    const response = await browser.request("POST", `/api/install/setup/${id}`, body)
    if (response.status === 202) return
    if (response.status !== 409 || !response.text.includes("previous setup step is incomplete") || Date.now() > deadline) {
      throw new Error(`POST /api/install/setup/${id} answered ${response.status}: ${response.text.slice(0, 500)}`)
    }
    await Bun.sleep(250)
  }
}

export interface SetupWalk {
  readonly backend: string
  readonly origin: string
  /** The `setup_urls` link the backend printed. */
  readonly setupURL: string
  readonly fakeURL: string
  /** The fake's owner account; the installed repository is `<owner>/demo`. */
  readonly owner: string
  /** The one key the model stand-in accepts; every role's key in Model access. */
  readonly modelKey: string
  /** The coding model the stand-in answers (e2e/real/support/model-provider-behaviors.ts PROVIDER_MODEL). */
  readonly codingModel: string
}

/** The owner's session after setup: the browser that signed in, holding its session cookie. */
export const walkSetup = async (walk: SetupWalk): Promise<InstallBrowser> => {
  const browser = new InstallBrowser(walk.backend, walk.origin)
  const link = new URL(walk.setupURL)
  await browser.expect("GET", `/setup${link.search}`, 303)
  // "This Mac only" (mvp.md J1 step 2.1): the loopback bind the card offers, with the install's public origin.
  // A loopback bind opens no listener of its own (services/install_address.go), so the launcher's address stays.
  await startStep(browser, "address", { bind: "127.0.0.1:4000", origins: [walk.origin] })
  await waitStep(browser, "address", 30_000)

  const handoff = JSON.parse((await browser.expect("POST", "/api/install/setup/app", 200, { owner: walk.owner })).text) as {
    readonly action_url: string; readonly manifest: Readonly<Record<string, unknown>>
  }
  const manifestPage = await fetch(fakeManifestURL(handoff.action_url, walk.fakeURL), {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ manifest: JSON.stringify(handoff.manifest) })
  })
  const manifestHtml = await manifestPage.text()
  if (manifestPage.status !== 200) throw new Error(`the GitHub fake refused the App manifest: ${manifestPage.status} ${manifestHtml}`)
  await browser.expect("GET", anchorTarget(manifestHtml, "Create GitHub App"), 303)
  await waitStep(browser, "app_manifest", 30_000)

  await startStep(browser, "sign_in", {})
  const authorize = await browser.expect("GET", "/api/auth/github", 302)
  if (authorize.location === undefined || !authorize.location.startsWith(`${walk.fakeURL}/login/oauth/authorize`)) {
    throw new Error(`sign-in did not hand off to the GitHub fake: ${authorize.location}`)
  }
  const consent = await fetch(authorize.location, { redirect: "manual" })
  const consentHtml = await consent.text()
  if (consent.status !== 200) throw new Error(`the GitHub fake refused the sign-in: ${consent.status} ${consentHtml}`)
  await browser.expect("GET", anchorTarget(consentHtml, "Authorize"), 302)
  if (browser.cookie("smithers_session") === undefined) throw new Error("GitHub sign-in set no session cookie")
  await waitStep(browser, "sign_in", 30_000)

  await startStep(browser, "repository", { repository: `${walk.owner}/demo` })
  await waitStep(browser, "repository", 60_000)

  // Model access as the setup card saves it (state/seams/InstallSeam.ts saveInstallModelKey): the fast model on
  // Cerebras, coding and Decisions on one AI Gateway key, each at the stand-in.
  for (const [name, origin] of [["CEREBRAS_API_KEY", "https://api.cerebras.ai"], ["AI_GATEWAY_API_KEY", "https://ai-gateway.vercel.sh"]] as const) {
    const saved = JSON.parse((await browser.expect("POST", "/api/model/credential", 200,
      { requestId: randomUUID(), name, action: "enroll", origin, value: walk.modelKey })).text) as { readonly ok?: boolean }
    if (saved.ok !== true) throw new Error(`Model access refused ${name}`)
  }
  await browser.expect("PUT", "/api/model/default", 200, {
    model: { protocol: "openai-chat", modelId: walk.codingModel, credential: "AI_GATEWAY_API_KEY", baseUrl: "https://ai-gateway.vercel.sh" }
  })
  await startStep(browser, "models", {})
  await waitStep(browser, "models", 60_000)

  await startStep(browser, "source", {})
  await waitStep(browser, "source", 3 * 60_000)
  // Machine ready on the test backend's trusted-process machine images (compose trusted_process_machines.go, #3781):
  // the base image only, so it proves setup admission and persistence, not an image build.
  await startStep(browser, "machine", {})
  await waitStep(browser, "machine", 3 * 60_000)
  return browser
}
