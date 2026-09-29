import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { RAW_ERROR_RENDER_ALLOWLIST } from "./RawErrorRenderAllowlist"

/*
 * People never see a raw error message, a stack, or `String(error)`: a failure
 * reaches the screen through `presentUserFailure` (`@smthrs/rpc/UserFailure`)
 * as a plain sentence, with the raw text behind a collapsed Details.
 *
 * This check is lexical, so it counts every error-named `.message`, `.stack`,
 * `String(<error>)` and `errorMessage(` in a UI file. The allowlist holds the
 * sites that predate the rule, per file and by count. A new site fails; a file
 * that dropped a site fails until its entry shrinks, so the list only gets
 * shorter. It reaches empty when every surface uses the presenter.
 */

const SOURCE_ROOT = join(import.meta.dir, "..")
const APP_ROOT = join(SOURCE_ROOT, "..")
const ERROR_NAME = "(?:error|Error|err|cause|reason|failure|Failure|refusal|exception)"
const RAW_ERROR_RENDER = new RegExp(
  [
    `\\b${ERROR_NAME}\\??\\)?\\.message\\b`,
    `\\b${ERROR_NAME}\\??\\)?\\.stack\\b`,
    `\\bString\\(\\s*${ERROR_NAME}\\s*\\)`,
    `\\berrorMessage\\(`
  ].join("|"),
  "g"
)

const uiFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : uiFiles(path)
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [path] : []
  })

const countSites = (source: string): number => source.match(RAW_ERROR_RENDER)?.length ?? 0

const offenders = (): Record<string, number> =>
  Object.fromEntries(
    uiFiles(SOURCE_ROOT)
      .map(path => [relative(APP_ROOT, path).split("\\").join("/"), countSites(readFileSync(path, "utf8"))] as const)
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => a.localeCompare(b))
  )

describe("UI files never render a raw error", () => {
  test("the lexical check sees each shape it bans", () => {
    for (
      const line of [
        "<p>{error.message}</p>",
        "<p>{failure?.message}</p>",
        "{(cause as Error).message}",
        "{String(error)}",
        "{errorMessage(reason)}",
        "<pre>{err.stack}</pre>"
      ]
    ) expect(countSites(line)).toBe(1)
    for (const line of ["{entry.message.text}", "{row?.message}", "{failure.sentence}"]) expect(countSites(line)).toBe(0)
  })

  test("only allowlisted files keep raw error sites, and never more than listed", () => {
    expect(offenders()).toEqual({ ...RAW_ERROR_RENDER_ALLOWLIST })
  })
})
