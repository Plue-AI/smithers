/*
 * The Playwright T1 web server: builds the SPA into dist/ (skip with
 * SMITHERS_SKIP_SPA_BUILD=1 when dist/ is already fresh), then runs
 * an isolated test host in this process so Playwright's shutdown kills the
 * origin. Production serve.ts intentionally uses the real host; this does not.
 */
import { fileURLToPath } from "node:url"
import { startBrowserTestHost } from "../../scripts/browser-test-host"

const UI_DIR = fileURLToPath(new URL("../../", import.meta.url))

if (process.env.SMITHERS_SKIP_SPA_BUILD !== "1") {
  console.log("[webserver] vite build")
  const build = Bun.spawn(["pnpm", "exec", "vite", "build", "--configLoader", "runner"], {
    cwd: UI_DIR,
    stdout: "inherit",
    stderr: "inherit"
  })
  const code = await build.exited
  if (code !== 0) {
    console.error(`[webserver] vite build exited ${code}`)
    process.exit(code)
  }
}

const server = await startBrowserTestHost(fileURLToPath(new URL("../../dist/", import.meta.url)))
let shutdown: Promise<void> | undefined
const stop = () => shutdown ??= server.stop().then(() => { process.exit(0) }, () => {
  console.error("The browser-test server could not close its owned fixture.")
  process.exit(1)
})
process.on("SIGINT", () => { void stop() })
process.on("SIGTERM", () => { void stop() })
