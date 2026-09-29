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
 * `String(<error>)` and `errorMessage(` in a UI (`.tsx`) or logic (`.ts`)
 * file, and in a UI file every JSX child that prints an error-named string
 * (`{payload.error}`, `{observationError}`). Logic files count too because a
 * seam's or controller's string is what a toast, a card or the transcript
 * shows. Raw text for diagnostics goes through `failureDetail`
 * (`@smthrs/rpc/UserFailure`), a refusal's words through `refusalLine`
 * (`@smthrs/rpc/RefusalCopy`), and an authored sentence through its
 * registry. The allowlist holds the
 * sites that predate the rule, per file and by count. A new site fails; a file
 * that dropped a site fails until its entry shrinks, so the list only gets
 * shorter. It reaches empty when every surface uses the presenter.
 */

const SOURCE_ROOT = join(import.meta.dir, "..")
/* Logic files are scanned where the renderer lives; the Bun host answers HTTP and logs, it renders nothing. */
const VIEW_ROOT = import.meta.dir
const APP_ROOT = join(SOURCE_ROOT, "..")
const ERROR_NAME = "(?:error|Error|err|cause|reason|failure|Failure|refusal|Refusal|exception)"
/* A JSX child: not an attribute value, a call argument, a destructure or an import. */
const JSX_CHILD = "(?<![=(,]\\s*)(?<!\\b(?:const|let|var|import|type|return|export)\\s+)"
/* An expression that reads raw error text, in any file. */
const RAW_ERROR_TEXT = [
  `\\b\\w*${ERROR_NAME}\\??\\)?\\.message\\b`,
  `\\b\\w*${ERROR_NAME}\\??\\)?\\.stack\\b`,
  `\\bString\\(\\s*${ERROR_NAME}\\s*\\)`,
  `\\berrorMessage\\(`
]
const RAW_ERROR_EXPRESSION = new RegExp(RAW_ERROR_TEXT.join("|"), "g")
const RAW_ERROR_RENDER = new RegExp(
  [
    ...RAW_ERROR_TEXT,
    `${JSX_CHILD}\\{\\s*[\\w.?]*\\.(?:error|syncError|decisionError|refusal)\\s*\\}`,
    `${JSX_CHILD}\\{\\s*\\w*(?:[eE]rror|[rR]efusal)\\s*\\}`
  ].join("|"),
  "g"
)

const uiFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : uiFiles(path)
    if (/\.test\.tsx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) return []
    return entry.name.endsWith(".tsx") || (entry.name.endsWith(".ts") && path.startsWith(VIEW_ROOT)) ? [path] : []
  })

/*
 * The one module whose job is raw text: the client error reporter serializes a
 * thrown value's name, message and stack into a diagnostic report and renders
 * nothing. It is not a legacy site; a test below keeps its text out of view by
 * proving only the operational reporter imports it.
 */
const RAW_DETAIL_SINK = "src/mainview/state/ClientErrors.ts"

const countSites = (source: string): number => source.match(RAW_ERROR_RENDER)?.length ?? 0
/* A logic file has no JSX children; `{ error }` there is an object shorthand, not a render. */
const countExpressionSites = (source: string): number => source.match(RAW_ERROR_EXPRESSION)?.length ?? 0
const sitesIn = (path: string): number =>
  (path.endsWith(".tsx") ? countSites : countExpressionSites)(readFileSync(path, "utf8"))

const offenders = (): Record<string, number> =>
  Object.fromEntries(
    uiFiles(SOURCE_ROOT)
      .map(path => [relative(APP_ROOT, path).split("\\").join("/"), sitesIn(path)] as const)
      .filter(([path, count]) => count > 0 && path !== RAW_DETAIL_SINK)
      .sort(([a], [b]) => a.localeCompare(b))
  )

describe("UI and logic files never show a raw error", () => {
  test("the lexical check sees each shape it bans", () => {
    for (
      const line of [
        "<p>{error.message}</p>",
        "<p>{failure?.message}</p>",
        "{(cause as Error).message}",
        "{String(error)}",
        "{errorMessage(reason)}",
        "<pre>{err.stack}</pre>",
        "<p>{codeError.message}</p>",
        "{terminalRefusal.message}",
        "<p>{payload.error}</p>",
        "<span>{sync.resolution.error}</span>",
        "<p>{observationError}</p>",
        "<p>{error}</p>",
        "<p>{refusal}</p>",
        "<span>{github.syncError}</span>"
      ]
    ) expect(countSites(line)).toBe(1)
    for (
      const line of [
        "{entry.message.text}",
        "{row?.message}",
        "{failure.sentence}",
        "<UpgradeDoor refusal={refusal} />",
        "const { error } = this.state",
        "import { type Refusal } from \"x\"",
        "describedFailure(tag, copy, payload.error)",
        "{payload.error === undefined ? null : x}"
      ]
    ) expect(countSites(line)).toBe(0)
  })

  test("a logic file counts raw error text but not an object shorthand", () => {
    for (
      const line of [
        "return { status: \"failed\", error: settled.failure.message }",
        "const shown = error instanceof Error ? error.message : \"x\"",
        "new Error(String(cause))",
        "message: errorMessage(error).slice(0, 1024)"
      ]
    ) expect(countExpressionSites(line)).toBeGreaterThan(0)
    for (const line of ["return { error }", "const { error } = outcome", "readErrorMessage(response, fallback)", "failureDetail(error)"]) {
      expect(countExpressionSites(line)).toBe(0)
    }
  })

  test("the reporter's raw text reaches only the operational reporter, never a surface", () => {
    const importers = uiFiles(SOURCE_ROOT)
      .filter(path => /\bdiagnosticText\b/.test(readFileSync(path, "utf8")))
      .map(path => relative(APP_ROOT, path).split("\\").join("/"))
      .sort()
    expect(importers).toEqual([RAW_DETAIL_SINK, "src/mainview/state/OperationalFailures.ts"])
  })

  test("only allowlisted files keep raw error sites, and never more than listed", () => {
    expect(offenders()).toEqual({ ...RAW_ERROR_RENDER_ALLOWLIST })
  })
})
