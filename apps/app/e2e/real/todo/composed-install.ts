import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { chromium, type BrowserContext, type Page } from "@playwright/test"
import { awaitBoot, command, expect } from "../support"
import { observeAt } from "./reference"
import { registerKeyboardJourney } from "../support/keyboard-journey-input"

export type ComposedActor = "Will" | "Ben"

/**
 * The composed install a backend driver (packages/backend
 * TestTodo*JourneyComposedInstall) serves and describes in
 * SMITHERS_JOURNEY_COMPOSED_HOST: the production router, PostgreSQL, live
 * channel and app, with each member's browser session.
 */
export type ComposedInstall = {
  readonly origin: string
  readonly repository: string
  readonly pages: Record<ComposedActor, Page>
  /** One read-only query against the install's PostgreSQL. */
  readonly sql: (query: string) => any[]
  /** Keeps a JSON value or a page screenshot in the run's evidence directory. */
  readonly keep: (name: string, value: unknown) => void
  readonly snapshot: (name: string, page: Page) => Promise<void>
}

type Descriptor = {
  readonly origin: string
  readonly repository: string
  readonly database: string
  readonly evidence: string
  readonly members: Record<ComposedActor, ReadonlyArray<{ readonly name: string; readonly value: string }>>
}

export const withComposedInstall = async (body: (install: ComposedInstall) => Promise<void>): Promise<void> => {
  const path = process.env.SMITHERS_JOURNEY_COMPOSED_HOST
  if (!path) throw new Error("SMITHERS_JOURNEY_COMPOSED_HOST names the composed install; run this from its backend driver")
  const host = JSON.parse(readFileSync(path, "utf8")) as Descriptor
  const theme = process.env.SMITHERS_JOURNEY_THEME
  if (theme !== undefined && theme !== "light" && theme !== "dark") throw new Error("SMITHERS_JOURNEY_THEME must be light or dark")
  mkdirSync(host.evidence, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const contexts: BrowserContext[] = []
  const keyboard = new Map<ComposedActor, ReturnType<typeof registerKeyboardJourney>>()
  const keep = (name: string, value: unknown) => writeFileSync(join(host.evidence, `${name}.json`), JSON.stringify(value, null, 2))
  try {
    const pages = {} as Record<ComposedActor, Page>
    for (const actor of ["Will", "Ben"] as const) {
      const context = await browser.newContext({ baseURL: host.origin, recordVideo: { dir: join(host.evidence, `video-${actor}`) } })
      contexts.push(context)
      await context.addCookies(host.members[actor].map(cookie => ({ ...cookie, url: host.origin, httpOnly: cookie.name !== "__csrf" })))
      const page = await context.newPage()
      // Supplemental composed-install proof; never reference-host qualification.
      if (process.env.SMITHERS_JOURNEY_KEYBOARD === "1") {
        const keys = registerKeyboardJourney(page, host.origin)
        keyboard.set(actor, keys)
        await keys.ready()
      }
      await page.goto(`${host.origin}/${host.repository}`)
      await awaitBoot(page)
      if (theme && await page.locator("html").getAttribute("data-theme") !== theme) await command(page, "/theme")
      if (theme) await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      pages[actor] = page
    }
    await body({
      origin: host.origin, repository: host.repository, pages,
      sql: query => observeAt(host.database, query),
      keep,
      snapshot: async (name, page) => { await page.screenshot({ path: join(host.evidence, `${name}.png`) }) }
    })
    for (const keys of keyboard.values()) if (keys.snapshot().inputs.length) keys.finish()
  } finally {
    for (const [actor, keys] of keyboard) keep(`keyboard-${actor}`, keys.snapshot())
    for (const context of contexts) await context.close()
    await browser.close()
  }
}
