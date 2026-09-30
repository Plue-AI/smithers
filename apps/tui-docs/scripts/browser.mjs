/** Picks the Chromium the recorder and browser tests launch. */
import { accessSync, constants, statSync } from "node:fs"
import { delimiter, join } from "node:path"
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
/**
 * `CHROME_BIN` for a direct run, Google Chrome on macOS, else the first `chromium` on `PATH`.
 * Target runs pass only `PATH` through, so the Cloud machine's system Chromium is found there.
 * With none of these, Playwright launches its own downloaded build.
 */
export function launchOptions(env = process.env, platform = process.platform) {
  if (env.CHROME_BIN) return { headless: true, executablePath: env.CHROME_BIN }
  if (platform === "darwin") return { headless: true, executablePath: macChrome }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, "chromium")
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return { headless: true, executablePath: candidate }
    } catch {}
  }
  return { headless: true }
}
