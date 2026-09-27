import { test as base, type Page } from "@playwright/test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export * from "@playwright/test"

// macOS WebKit uses Option-Tab to include links and controls without changing
// the user's keyboard preferences. Keep this explicit at traversal call sites.
// https://developer.apple.com/documentation/webkit/wkpreferences/tabfocuseslinks
export const controlTabKey = (page: Page, backwards = false): string => {
  const key = backwards ? "Shift+Tab" : "Tab"
  return process.platform === "darwin" && page.context().browser()?.browserType().name() === "webkit"
    ? `Alt+${key}`
    : key
}

// WebKit's private contexts cannot open OPFS. Each durable-app test gets its
// own temporary profile; Chromium keeps Playwright's standard context.
export const test = base.extend({
  context: async ({ browserName, context, playwright, launchOptions, headless }, use) => {
    if (browserName !== "webkit") {
      await use(context)
      return
    }
    const profile = await mkdtemp(join(tmpdir(), "smithers-webkit-test-"))
    let persistent: Awaited<ReturnType<typeof playwright.webkit.launchPersistentContext>> | undefined
    try {
      // Playwright Test applies configured context options and records traces
      // for manually launched contexts too.
      persistent = await playwright.webkit.launchPersistentContext(profile, {
        ...launchOptions,
        headless,
        // The macOS embedder leaves OPFS outside userDataDir. Isolate its
        // CoreFoundation storage home too, or fresh profiles share databases.
        ...(process.platform === "darwin" ? { env: {
          ...process.env, ...launchOptions.env, CFFIXED_USER_HOME: profile
        } } : {})
      })
      for (const page of persistent.pages()) await page.close()
      await use(persistent)
    } finally {
      try { await persistent?.close() } finally { await rm(profile, { recursive: true, force: true }) }
    }
  }
})
