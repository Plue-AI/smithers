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

/** SQL is observation only. psql connects to the reference install, never the
 * VM's fixture database; every query runs in a read-only transaction. */
export const observe = (query: string): any[] => JSON.parse(execFileSync("psql", [
  required("SMITHERS_JOURNEY_DATABASE_URL"), "-XAt", "-v", "ON_ERROR_STOP=1", "-c",
  `BEGIN READ ONLY; SELECT coalesce(json_agg(observation), '[]'::json) FROM (${query}) observation; COMMIT;`
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").find(line => line.startsWith("[")) ?? "null")

export const withReference = async (browser: Browser, info: TestInfo, body: (fixture: Reference) => Promise<void>): Promise<void> => {
  const origin = referenceOrigin()
  const repo = required("SMITHERS_JOURNEY_REPOSITORY")
  if (!/^smithers-mvp-canary\/[a-zA-Z0-9._-]+$/.test(repo)) throw new JourneyUnavailable("Use an owned smithers-mvp-canary scratch repository")
  const contexts: BrowserContext[] = []
  const members = {} as Record<Actor, Member>
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
      await page.goto(`${origin}/${repo}`)
      await awaitBoot(page)
      members[actor] = { context, page }
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
      return result
    }
    await body({ repo, members, info, github, read, sql: observe })
  } finally {
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
export const home = (page: Page) => page.locator('.smithers-card.mvp-home').last()
export const openTodo = async (page: Page, n: number): Promise<void> => { await runSlash(page, `/todo ${n}`); await expect(todoCard(page, n)).toBeVisible() }
export const createTodo = async (page: Page, prompt: string): Promise<void> => {
  await command(page, `/todo.new ${prompt}`)
  await page.getByRole("button", { name: "Commit", exact: true }).last().click()
}
export { attachJson, runSlash, realApi, expect }
