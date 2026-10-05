/**
 * The proof tier's fixtures (EVIDENCE-CONTRACT.md). Each spec file is one
 * journey with one test, and gets its own install: the real server bundle,
 * the GitHub fake (Maya owns maya/demo; Ben maintains it and Alice writes to
 * it on GitHub) and real models, whose keys Maya types on the Model access
 * card. Outside actors (a teammate opening an issue) act on the fake through
 * `install.fake`; everything a person does goes through the app.
 *
 *   person("maya" | "alice" | "ben")   a page in that person's own recorded
 *                                       browser context; Maya's opens the
 *                                       setup link, the others sign in with
 *                                       GitHub at the install's address
 *   proofStep(featureId, fn, options)  one test.step per feature, with a
 *                                       full-page screenshot attached under
 *                                       the feature id; a failure is recorded
 *                                       and the journey goes on
 *   setUp(page)                         the J1 setup card, step by step
 *
 * Environment: PROOF_BUNDLE (a built apps/app/.native, e.g.
 * ~/lanes/proof-bundle/current; default this checkout's at HEAD),
 * PROOF_KEYS_FILE (0600 NAME=value lines; default
 * ~/.config/smithers-proof/keys.env), PROOF_MODELS=standin (the loopback model
 * stand-in, for debugging a spec without spending; never for a recording),
 * PROOF_PORTS_LOCK (a lock directory to hold while the install binds 4000,
 * 4001 and 2222) and PROOF_LANE (the lock owner's name).
 */
import { test as base, expect, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test"
import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { launcherArgs, ProofLedger, readKeys, redact, releaseLock, takeLock, type Keys } from "../../scripts/proof-install"
import { isManifest } from "../local/github-route"

export { expect }
/** The install's address on this Mac: setup's Address step ("This Mac only") names it. */
export const APP = "http://localhost:4000"
const APP_ORIGINS = [APP, "http://127.0.0.1:4000"]
export type Name = "maya" | "alice" | "ben"
/** Each person's GitHub account on the fake: Maya owns the repository. */
export const PEOPLE: Record<Exclude<Name, "maya">, { readonly id: number; readonly permission: "maintain" | "write" }> = {
  ben: { id: 201, permission: "maintain" },
  alice: { id: 202, permission: "write" }
}
/** The coding model Maya picks on the AI Gateway (the M3 real walk's). */
export const CODING_MODEL = "anthropic/claude-sonnet-4.5"

export interface Install {
  readonly setupURL: string
  readonly fakeURL: string
  readonly home: string
  /** The GitHub fake's owner login (Maya's) and her repository. */
  readonly owner: string
  readonly repo: string
  /** The server bundle's revision. */
  readonly revision: string
  readonly models: "real" | "standin"
  /** The keys Maya types on the Model access card (the stand-in's one key when PROOF_MODELS=standin). */
  readonly keys: { readonly fast: string; readonly coding: string; readonly decisions: string; readonly codingModel: string }
  /** GitHub as the outside actors use it. */
  readonly fake: Fake
}
export interface Fake {
  /** Every write the install made on GitHub (method, path, status). */
  readonly writes: () => Promise<ReadonlyArray<{ method: string; path: string; status: number }>>
  /** A person opens an issue on the repository and answers its number. */
  readonly openIssue: (login: string, title: string, body: string) => Promise<number>
  /** A person comments on an issue. */
  readonly comment: (login: string, number: number, body: string) => Promise<number>
}
export interface ProofStepOptions {
  /** The page to screenshot; default the page person() returned last. */
  readonly page?: Page
  /** Features this step needs: when one did not pass, the step records "blocked by <id>" without running. */
  readonly needs?: readonly string[]
  readonly timeout?: number
}
export type ProofStep = (featureId: string, fn: () => Promise<void>, options?: ProofStepOptions) => Promise<boolean>

const app = resolve(__dirname, "../..")
const lockDir = process.env.PROOF_PORTS_LOCK
const models = process.env.PROOF_MODELS === "standin" ? "standin" : "real"

const readRun = (path: string) => {
  try { return JSON.parse(readFileSync(path, "utf8")) as { setupURL: string; fakeURL: string; home: string; owner: string; repo: string; revision: string; modelKey?: string } }
  catch { return undefined }
}

/** Boots one install from the bundle and waits for its setup link; stop() ends it and deletes its data. */
const boot = async (info: TestInfo, keys: Keys | undefined): Promise<{ install: Install; stop: () => Promise<void>; log: string }> => {
  const out = info.outputPath("install"), log = info.outputPath("install.log")
  const bundle = process.env.PROOF_BUNDLE ? realpathSync(resolve(process.env.PROOF_BUNDLE)) : undefined
  const fd = openSync(log, "w", 0o600)
  let child: ChildProcess
  try {
    child = spawn("bun", launcherArgs({ out, models, owner: "maya", ...(bundle ? { bundle } : {}) }), { cwd: app, stdio: ["ignore", fd, fd] })
  } finally { closeSync(fd) }
  let exited: number | null | undefined
  child.on("exit", code => { exited = code })
  const stop = async () => {
    if (exited !== undefined) return
    child.kill("SIGTERM")
    // The launcher stops the backend gracefully, then removes the install's data and its layer snapshots.
    for (let waited = 0; exited === undefined && waited < 90_000; waited += 250) await new Promise(r => setTimeout(r, 250))
    if (exited === undefined) child.kill("SIGKILL")
  }
  const started = Date.now()
  for (;;) {
    const run = readRun(join(out, "run.json"))
    if (run) {
      const fakeURL = run.fakeURL
      const post = async (path: string, body: unknown) => {
        const response = await fetch(`${fakeURL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        if (response.status >= 300) throw new Error(`GitHub fake ${path} answered ${response.status}: ${await response.text()}`)
        return response.status === 204 ? undefined : await response.json()
      }
      for (const [login, person] of Object.entries(PEOPLE)) await post("/_fake/collaborators", { id: person.id, login, permission: person.permission })
      const standin = run.modelKey ?? ""
      const install: Install = {
        ...run, models,
        keys: keys ? { fast: keys.CEREBRAS_API_KEY, coding: keys.AI_GATEWAY_API_KEY, decisions: keys.AI_GATEWAY_API_KEY, codingModel: CODING_MODEL }
          : { fast: standin, coding: standin, decisions: standin, codingModel: "e2e-answers" },
        fake: {
          writes: async () => (await fetch(`${fakeURL}/_fake/writes`)).json(),
          openIssue: async (login, title, body) => (await post("/_fake/issues", { repo: run.repo, login, title, body })).number,
          comment: async (login, number, body) => (await post("/_fake/comments", { repo: run.repo, login, number, body })).id
        }
      }
      return { install, stop, log }
    }
    if (exited !== undefined || Date.now() - started > 5 * 60_000) {
      await stop()
      const tail = redact(readFileSync(log, "utf8"), keys ?? {}).split("\n").slice(-30).join("\n")
      throw new Error(`the install did not boot (${exited === undefined ? "no setup link after 5 min" : `launcher exited ${exited}`}):\n${tail}`)
    }
    await new Promise(r => setTimeout(r, 500))
  }
}

/** A browser context that reaches only the install and the GitHub fake, and records a video. */
const personContext = async (browser: Browser, info: TestInfo, who: Name, install: Install, aborted: string[]): Promise<BrowserContext> => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: info.outputPath(`video-${who}`), size: { width: 1280, height: 800 } } })
  await context.route(/^https?:\/\//, async route => {
    const request = route.request(), url = new URL(request.url())
    if ([...APP_ORIGINS, install.fakeURL].includes(url.origin)) return route.continue()
    // GitHub's App manifest page is the fake's; avatars are images on github.com.
    if (isManifest(request.method(), request.url())) return route.fulfill({ response: await route.fetch({ url: install.fakeURL + url.pathname + url.search, maxRedirects: 0 }) })
    if (/^https:\/\/(avatars\.githubusercontent\.com|github\.com\/[a-z\d-]+\.png)/i.test(request.url())) return route.fulfill({ status: 404 })
    aborted.push(`${who} ${request.method()} ${url.origin}${url.pathname}`)
    await route.abort()
  })
  return context
}

/** Who signs in where: Maya through the setup card (or GitHub once set up), the others with GitHub at the address. */
const signIn = async (page: Page, who: Exclude<Name, "maya">) => {
  await page.goto(`${APP}/api/auth/github`)
  await page.getByRole("link", { name: `Authorize as ${who}`, exact: true }).click()
  await page.waitForURL(url => APP_ORIGINS.includes(url.origin) && !url.pathname.startsWith("/api/"))
  await expect(page.getByTestId("composer-input")).toBeAttached({ timeout: 30_000 })
}

export const test = base.extend<{ install: Install; person: (who: Name) => Promise<Page>; proofStep: ProofStep }, {}>({
  install: [async ({}, use, info) => {
    const keys = models === "real" ? readKeys(process.env.PROOF_KEYS_FILE ?? join(homedir(), ".config/smithers-proof/keys.env")) : undefined
    if (lockDir) await takeLock(lockDir, { lane: process.env.PROOF_LANE ?? "proof", onWait: owner => console.log(`waiting for the ports lock: ${owner}`) })
    try {
      const { install, stop, log } = await boot(info, keys)
      try { await use(install) } finally {
        await stop()
        // The launcher's log (the backend's own) is evidence; keys never are.
        writeFileSync(log, redact(readFileSync(log, "utf8"), keys ?? {}), { mode: 0o600 })
        await info.attach("install.log", { path: log, contentType: "text/plain" })
      }
    } finally { if (lockDir) releaseLock(lockDir) }
  }, { timeout: 100 * 60_000 }],
  person: async ({ browser, install }, use, info) => {
    const people = new Map<Name, Page>(), aborted: string[] = []
    await use(async who => {
      const known = people.get(who)
      if (known) return known
      const context = await personContext(browser, info, who, install, aborted)
      const page = await context.newPage()
      if (who === "maya") await page.goto(install.setupURL)
      else await signIn(page, who)
      people.set(who, page)
      current = page
      return page
    })
    for (const [who, page] of people) {
      await page.context().close()
      const video = page.video()
      if (video) await info.attach(`video-${who}`, { path: await video.path(), contentType: "video/webm" })
    }
    if (aborted.length) await info.attach("aborted-requests", { body: aborted.join("\n"), contentType: "text/plain" })
  },
  proofStep: async ({ person, install }, use, info) => {
    void person // the page proofStep screenshots is the one person() returned last
    const secrets = { AI_GATEWAY_API_KEY: install.keys.coding, CEREBRAS_API_KEY: install.keys.fast }
    const ledger = new ProofLedger()
    await use(async (id, fn, options = {}) => {
      ledger.begin(id)
      const blocker = ledger.blocker(options.needs ?? [])
      const errors = info.errors.length, began = Date.now()
      let error: string | undefined
      try {
        await base.step(id, async () => {
          if (blocker) throw new Error(`blocked by ${blocker}`)
          await fn()
        }, options.timeout ? { timeout: options.timeout } : undefined)
        // A soft assertion inside the step fails it without throwing.
        if (info.errors.length > errors) error = info.errors.at(-1)?.message ?? "soft assertion failed"
      } catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }
      const status = blocker ? "blocked" : error === undefined ? "passed" : "failed"
      ledger.record(id, status)
      const page = options.page ?? current
      if (page && !page.isClosed()) {
        const path = info.outputPath("proof", `${id}.png`)
        try { await page.screenshot({ path, fullPage: true }); await info.attach(id, { path, contentType: "image/png" }) } catch {}
      }
      if (error !== undefined) error = redact(error, secrets)
      const ms = Date.now() - began
      info.annotations.push({ type: "proof", description: JSON.stringify({ id, status, ms, ...(error ? { error: error.split("\n")[0] } : {}) }) })
      // One line per feature as it settles, so a long journey can be followed live.
      console.log(`proof ${id} ${status} ${Math.round(ms / 1000)} s${error ? `: ${error.split("\n")[0]}` : ""}`)
      // The journey goes on; the test still fails for any step that did not pass.
      if (status !== "passed" && info.errors.length === errors) expect.soft(error, `proof step ${id} ${status}`).toBeUndefined()
      return status === "passed"
    })
  }
})
let current: Page | undefined

/** Waits for a setup step's served state, then for the card to show it. */
const stepDone = async (page: Page, id: string, timeout: number) => {
  const started = Date.now()
  for (;;) {
    const response = await page.request.get(`${APP}/api/install`)
    const step = response.ok() ? (await response.json()).steps?.find((s: { id: string }) => s.id === id) : undefined
    if (step?.state === "done") break
    if (step?.state === "failed") throw new Error(`setup step ${id} failed: ${JSON.stringify(step.error ?? step)}`)
    if (Date.now() - started > timeout) throw new Error(`setup step ${id} is still ${step?.state ?? `unread (${response.status()})`} after ${Math.round(timeout / 1000)} s`)
    await page.waitForTimeout(1_000)
  }
  // Machine ready closes setup: the card may already have given way to Home.
  await expect(setupCard(page).locator(`[data-step="${id}"][data-state="done"]`).or(page.getByRole("button", { name: "New TODO", exact: true }))).toBeVisible({ timeout: 10_000 })
}
export const setupCard = (page: Page) => page.locator('[aria-label="Set up Smithers"]').first()
const press = (page: Page, name: string) => setupCard(page).getByRole("button", { name, exact: true }).first().click()

/** The J1 setup card, one function per step, as Maya does it; j1.spec.ts proves each, other journeys call setUp. */
export const setupSteps = {
  address: async (page: Page) => {
    await expect(setupCard(page)).toBeVisible({ timeout: 30_000 })
    await press(page, "This Mac only")
    await stepDone(page, "address", 15_000)
  },
  app: async (page: Page, install: Install) => {
    await setupCard(page).getByLabel("Owner", { exact: true }).last().fill(install.owner)
    await press(page, "Create GitHub App")
    await page.getByRole("link", { name: "Create GitHub App", exact: true }).click()
    await stepDone(page, "app_manifest", 30_000)
  },
  signIn: async (page: Page) => {
    await press(page, "Sign in")
    await page.getByRole("link", { name: "Authorize", exact: true }).click()
    await stepDone(page, "sign_in", 30_000)
  },
  repository: async (page: Page, install: Install) => {
    await setupCard(page).getByLabel("Repository", { exact: true }).last().selectOption({ label: install.repo })
    await press(page, "Repository")
    await stepDone(page, "repository", 30_000)
  },
  models: async (page: Page, install: Install) => {
    const card = setupCard(page).locator('[data-step="models"]')
    const role = (label: string) => card.locator(".setup-model").filter({ has: page.getByText(label, { exact: true }) })
    const fast = role("Fast model"), coding = role("Coding model"), decisions = role("Decisions")
    await fast.getByLabel("Cerebras key", { exact: true }).fill(install.keys.fast)
    await fast.getByRole("button", { name: "Save", exact: true }).click()
    await expect(fast).toHaveAttribute("data-state", "saved", { timeout: 30_000 })
    await coding.getByLabel("Provider", { exact: true }).selectOption({ label: "AI Gateway" })
    await coding.getByLabel("Model", { exact: true }).fill(install.keys.codingModel)
    await coding.getByLabel("API key", { exact: true }).fill(install.keys.coding)
    await coding.getByRole("button", { name: "Save", exact: true }).click()
    await expect(coding).toHaveAttribute("data-state", "saved", { timeout: 30_000 })
    await decisions.getByLabel("AI Gateway key", { exact: true }).fill(install.keys.decisions)
    await decisions.getByRole("button", { name: "Save", exact: true }).click()
    await expect(decisions).toHaveAttribute("data-state", "saved", { timeout: 30_000 })
    await press(page, "Model access")
    await stepDone(page, "models", 60_000)
  },
  source: async (page: Page) => {
    await press(page, "Mirror")
    await stepDone(page, "source", 3 * 60_000)
  },
  /** Starts the first machine image unless it is already preparing; questions work meanwhile. */
  startMachine: async (page: Page): Promise<void> => {
    const state = (await (await page.request.get(`${APP}/api/install`)).json()).steps?.find((s: { id: string }) => s.id === "machine")?.state
    if (state !== "running" && state !== "done") await press(page, "Build image")
  },
  machine: async (page: Page, install: Install): Promise<void> => {
    await setupSteps.startMachine(page)
    await stepDone(page, "machine", 20 * 60_000)
    // Machine ready names real layers this install built for main.
    const dir = join(install.home, "state/microvm/layers")
    const layers = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(dir, name), "utf8"))) : []
    expect(layers.map((layer: { kind: string; main: boolean }) => [layer.kind, layer.main])).toEqual(expect.arrayContaining([["toolchain", true], ["dependencies", true]]))
  }
}
/** Setup through the card in one go, for journeys after J1. */
export const setUp = async (page: Page, install: Install) => {
  await setupSteps.address(page)
  await setupSteps.app(page, install)
  await setupSteps.signIn(page)
  await setupSteps.repository(page, install)
  await setupSteps.models(page, install)
  await setupSteps.source(page)
  await setupSteps.machine(page, install)
}

/** Types a line into the composer and sends it, opening Chat first when it is closed. */
export const say = async (page: Page, text: string) => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await input.fill(text)
  await input.press("Enter")
}
