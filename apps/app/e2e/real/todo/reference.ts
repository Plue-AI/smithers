import { createHash } from "node:crypto"
import { registerKeyboardJourney, journeyActivate } from "../support/keyboard-journey-input"
import { execFileSync } from "node:child_process"
import type { Browser, BrowserContext, Page, TestInfo } from "@playwright/test"
import { awaitBoot, command, expect, realApi } from "../support"
import { attachJson, runSlash } from "../issues/local"

/** A prepared one-repository install, not a product fixture API. Sessions are
 * real GitHub logins saved on the second Mac. The owner installs the App on a
 * fresh scratch repository before running these destructive canaries. */
export class JourneyUnavailable extends Error {
  readonly code = "journey_prerequisite_missing"
  readonly class = "factory"
  constructor(message: string) { super(message); this.name = "JourneyUnavailable" }
}
export const required = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) throw new JourneyUnavailable(`${name} is required for C-J2 reference-host automation`)
  return value
}
export const referenceOrigin = (): string => {
  const url = new URL(required("SMITHERS_REAL_BASE_URL"))
  if (!/^https?:$/.test(url.protocol)) throw new JourneyUnavailable("Reference install must have an HTTP origin")
  return url.origin
}
export type Actor = "Will" | "Ben" | "Alice"
export type Member = { context: BrowserContext; page: Page }
export type Reference = {
  repo: string; members: Record<Actor, Member>; info: TestInfo
  github: (actor: Actor, method: string, path: string, data?: unknown) => Promise<unknown>
  read: (actor: Actor, path: string) => Promise<any>
  sql: (query: string) => any[]
}

/** SQL is observation only: every query runs in a read-only transaction.
 * jsonb_agg prints one line; json_agg breaks lines between rows. */
export const observeAt = (database: string, query: string): any[] => JSON.parse(execFileSync("psql", [
  database, "-XAt", "-v", "ON_ERROR_STOP=1", "-c",
  `BEGIN READ ONLY; SELECT coalesce(jsonb_agg(observation), '[]'::jsonb) FROM (${query}) observation; COMMIT;`
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").find(line => line.startsWith("[")) ?? "null")
/** psql connects to the reference install, never the VM's fixture database. */
export const observe = (query: string): any[] => observeAt(required("SMITHERS_JOURNEY_DATABASE_URL"), query)

export const withReference = async (browser: Browser, info: TestInfo, body: (fixture: Reference) => Promise<void>): Promise<void> => {
  const origin = referenceOrigin()
  const repo = required("SMITHERS_JOURNEY_REPOSITORY")
  if (!/^smithers-mvp-canary\/[a-zA-Z0-9._-]+$/.test(repo)) throw new JourneyUnavailable("Use an owned smithers-mvp-canary scratch repository")
  const contexts: BrowserContext[] = []
  const members = {} as Record<Actor, Member>
  const keyboard = new Map<Actor, ReturnType<typeof registerKeyboardJourney>>()
  const theme = process.env.SMITHERS_JOURNEY_THEME
  if (theme !== undefined && theme !== "light" && theme !== "dark") throw new JourneyUnavailable("SMITHERS_JOURNEY_THEME must be light or dark")
  if (process.env.SMITHERS_JOURNEY_KEYBOARD !== undefined && process.env.SMITHERS_JOURNEY_KEYBOARD !== "1") throw new JourneyUnavailable("SMITHERS_JOURNEY_KEYBOARD must be 1 or absent")
  let capture = 0
  const captured = new Map<string, string>()
  const captureReady = new Set<Actor>()
  const captureCards = async (actor: Actor) => {
    if (!theme || !captureReady.has(actor)) return
    const page = members[actor].page
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
    const cards = page.locator(".smithers-card:visible")
    for (const [index, card] of (await cards.all()).entries()) {
      // Hash only for deduplication; never retain field values or markup as logs.
      const digest = createHash("sha256").update(await card.evaluate(element => JSON.stringify({
        html: element.outerHTML,
        fields: Array.from(element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select"))
          .map(field => ({ value: field.value, checked: field instanceof HTMLInputElement ? field.checked : undefined,
            selected: field instanceof HTMLSelectElement ? field.selectedIndex : undefined, focused: field === document.activeElement }))
      }))).digest("hex")
      const key = `${actor}:${index}:${await card.getAttribute("data-testid")}:${await card.getAttribute("data-kind")}`
      if (captured.get(key) === digest) continue
      await info.attach(`card-${theme}-${actor}-${++capture}`, { body: await card.screenshot(), contentType: "image/png" })
      captured.set(key, digest)
    }
  }
  const checkpoint = async (actor: Actor) => {
    const keys = keyboard.get(actor)
    if (keys?.snapshot().inputs.some(input => input.result === "allowed")) await keys.observe()
    await captureCards(actor)
  }
  try {
    const status = execFileSync(required("SMITHERS_JOURNEY_SMTHRS"), ["host", "status", "--json"], { encoding: "utf8" })
    const host = JSON.parse(status)
    expect(host.commit).toBe(required("SMITHERS_REAL_E2E_BUILD_SHA"))
    expect(host.version).toEqual(expect.any(String))
    await attachJson(info, "install-version-commit", host)
    for (const actor of ["Will", "Ben", "Alice"] as const) {
      const context = await browser.newContext({ baseURL: origin, storageState: required(`SMITHERS_JOURNEY_${actor.toUpperCase()}_SESSION`),
        recordVideo: { dir: info.outputPath(`video-${actor}`) } })
      contexts.push(context)
      await context.tracing.start({ screenshots: true, snapshots: true })
      const page = await context.newPage()
      if (process.env.SMITHERS_JOURNEY_KEYBOARD === "1") keyboard.set(actor, registerKeyboardJourney(page, origin, () => captureCards(actor)))
      await keyboard.get(actor)?.ready()
      await page.goto(`${origin}/${repo}`)
      await awaitBoot(page)
      members[actor] = { context, page }
      if (theme && await page.locator("html").getAttribute("data-theme") !== theme) await runSlash(page, "/theme")
      if (theme) await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      captureReady.add(actor)
    }
    const github = async (actor: Actor, method: string, path: string, data?: unknown): Promise<any> => {
      const response = await members[actor].context.request.fetch(`https://api.github.com/repos/${repo}${path}`, {
        method, headers: { Authorization: `Bearer ${required(`SMITHERS_JOURNEY_${actor.toUpperCase()}_GITHUB_TOKEN`)}`,
          Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, ...(data === undefined ? {} : { data })
      })
      expect(response.ok(), `GitHub ${method} ${path}: ${response.status()}`).toBe(true)
      return response.status() === 204 ? null : response.json()
    }
    const read = async (actor: Actor, path: string): Promise<any> => {
      const page = members[actor].page
      const response = await realApi(page, page.context().request, "GET", path)
      expect(response.status(), path).toBe(200)
      const result = await response.json()
      await attachJson(info, `api-${actor}-${path.replace(/\W/g, "-")}`, result)
      await checkpoint(actor)
      return result
    }
    await body({ repo, members, info, github, read, sql: observe })
    for (const actor of ["Will", "Ben", "Alice"] as const) {
      await checkpoint(actor)
      const keys = keyboard.get(actor)
      if (keys?.snapshot().inputs.length) keys.finish()
    }
  } finally {
    for (const [actor, keys] of keyboard) await attachJson(info, `keyboard-${actor}`, keys.snapshot())
    for (const [index, context] of contexts.entries()) {
      await context.tracing.stop({ path: info.outputPath(`member-${index}.zip`) })
      await context.close()
    }
  }
}

export const seedIssueSeven = async (f: Reference): Promise<void> => {
  expect(await f.github("Ben", "GET", "/issues?state=all")).toEqual([])
  for (let number = 1; number <= 7; number++) {
    const issue = await f.github("Ben", "POST", "/issues", { title: number === 7 ? "Retry webhooks" : `Fixture ${number}`,
      body: number === 7 ? "Webhooks fail on 502" : "Scratch fixture" }) as { number: number }
    expect(issue.number).toBe(number)
  }
  for (const body of ["Observed on staging", "retry at most 5 times with jittered backoff", "Please investigate"]) {
    await f.github("Ben", "POST", "/issues/7/comments", { body })
  }
}
export const todoCard = (page: Page, n: number) => page.locator('.smithers-card[data-kind="todo"]').filter({ hasText: new RegExp(`\\bT${n}\\b`) }).last()
export const home = (page: Page) => page.locator('.smithers-card.home').last()
export const openTodo = async (page: Page, n: number): Promise<void> => { await runSlash(page, `/todo ${n}`); await expect(todoCard(page, n)).toBeVisible() }
export const createTodo = async (page: Page, prompt: string): Promise<void> => {
  await command(page, `/todo.new ${prompt}`)
  await journeyActivate(page.getByRole("button", { name: "Commit", exact: true }).last())
}
export { attachJson, runSlash, realApi, expect }
