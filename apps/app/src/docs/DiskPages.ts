/*
 * The page files read from disk, keyed exactly as bundled.ts's
 * import.meta.glob keys them (`./pages/<slug>.md`). Bun's test runner has no
 * import.meta.glob, so the suites build the docs from this; the browser build
 * never imports it.
 */
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const PAGES = fileURLToPath(new URL("./pages/", import.meta.url))

export const diskPageFiles = (): Readonly<Record<string, string>> =>
  Object.fromEntries(
    readdirSync(PAGES)
      .filter((file) => file.endsWith(".md"))
      .sort()
      .map((file) => [`./pages/${file}`, readFileSync(`${PAGES}${file}`, "utf8")])
  )
