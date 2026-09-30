/**
 * The file router: a filesystem walk that turns an app directory into a route
 * table and renders the two generated files.
 *
 * Nothing here evaluates a module, so the same code runs under plain Node in
 * `bin/routes.mjs`, inside the Vite plugin, and inside a test. The rules are
 * the whole authoring contract, and file location is the only thing that names
 * anything:
 *
 * - `<app>/layout.tsx` is the shell layout, and it is optional. Only the app
 *   root's `layout.tsx` is a shell layout: a nested one is an ordinary file the
 *   router ignores.
 * - `<app>/**\/page.tsx` is the page at `/<dir>`; `<app>/page.tsx` is `/`. Every
 *   directory segment of that route is a route name, so each one must match
 *   {@link RouterErrorCode} `invalid_name`'s lowercase kebab-case grammar.
 * - `<app>/panes/<name>.tsx` is the pane `<name>`, and only at that exact
 *   depth: `<app>/panes/<dir>/page.tsx` is the page `/panes/<dir>`.
 * - `<flows>/**\/flow.ts` is the flow named by its directory, so
 *   `flows/build/plan/flow.ts` is the flow `build/plan`.
 * - `AGENT.ts`, `SANDBOX.ts`, and `TOOLS.ts` are layers for every flow in
 *   their directory and below. The nearest ancestor of each kind wins and
 *   nothing merges, so the app root must provide all three for resolution to
 *   terminate.
 *
 * Symbolic links are neither walked nor routed, so a checkout's dangling or
 * self-referential links cannot fail or wedge a route generation.
 *
 * @since 0.1.0
 */

import * as Data from "effect/Data"
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, posix, relative, resolve, sep } from "node:path"
import { isRouteSegment, routeSegmentGrammar } from "./app.ts"
import type { AppDirs, AppRoutes, FlowRoute, PageRoute, PaneRoute } from "./app.ts"

/**
 * Where to walk and which directories carry the app, the flows, and the tools.
 *
 * @category models
 * @since 0.1.0
 */
export interface RouterOptions {
  readonly root: string
  readonly dirs: AppDirs
}

/**
 * Why the router refused a tree.
 *
 * `missing_layer` is a flow with no ancestor layer file of some kind,
 * `invalid_name` is a
 * pane or flow directory that is not lowercase kebab-case.
 *
 * @category models
 * @since 0.1.0
 */
export type RouterErrorCode = "missing_layer" | "invalid_name"

/**
 * A refused tree, thrown rather than returned because every caller — the bin,
 * the Vite plugin, a test — wants the walk to stop.
 *
 * @category errors
 * @since 0.1.0
 */
export class RouterError extends Data.TaggedError("create-app/RouterError")<{
  readonly code: RouterErrorCode
  readonly message: string
}> {
  /**
   * @category models
   * @since 0.1.0
   */
  override readonly name = "RouterError"
  constructor(code: RouterErrorCode, message: string) {
    super({ code, message })
  }
}

const IGNORED = new Set(["node_modules", ".git", "dist", ".flows", ".wrangler", ".smithers"])
type LayerKind = "AGENT.ts" | "SANDBOX.ts" | "TOOLS.ts"
const toPosix = (path: string): string => path.split(sep).join(posix.sep)

// `withFileTypes` reports each entry's own type, so nothing here follows a
// symbolic link. `statSync` did follow: a dangling link threw a raw ENOENT
// with no route context, a directory link pointing at an ancestor recursed
// until ELOOP, and a link into an external tree was walked in full. Skipping
// links removes all three at once, and the syscall with them.
//
// Directory order is not sorted here: `discover` sorts the whole collected set
// before it routes anything, so the generated tables are already independent
// of what the filesystem hands back.
const walk = (dir: string, visit: (file: string) => void): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, visit)
    else if (entry.isFile()) visit(full)
  }
}

/**
 * Resolves one layer kind for one directory: the nearest `<kind>` at `dir` or
 * any ancestor up to and including `root`.
 *
 * Both paths are normalized before the walk, and `dir` must sit inside `root`.
 * Without that the loop had no stopping condition: it compared raw strings, so
 * a root carrying a trailing separator (which shell tab completion appends)
 * never matched, and `dirname("/")` is `"/"`, so the walk spun forever instead
 * of raising `missing_layer`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolveLayer = (root: string, dir: string, kind: LayerKind, files: ReadonlySet<string>): string => {
  const boundary = resolve(root)
  const start = resolve(dir)
  const label = start === boundary ? "." : toPosix(relative(boundary, start))
  if (start !== boundary && !start.startsWith(`${boundary}${sep}`)) {
    throw new RouterError("missing_layer", `${label} is outside the app root, so no ${kind} can resolve for it`)
  }
  let current = start
  for (;;) {
    const candidate = toPosix(relative(boundary, join(current, kind)))
    if (files.has(candidate)) return candidate
    if (current === boundary) break
    current = dirname(current)
  }
  throw new RouterError(
    "missing_layer",
    `no ${kind} found for ${label} or any ancestor; add one at the app root`
  )
}

/**
 * Walks an app root and returns everything the two generated files are
 * rendered from.
 *
 * @example
 * ```ts
 * import { defaultDirs } from "@smthrs/create-app/app"
 * import { discover } from "@smthrs/create-app/router"
 *
 * const routes = discover({ root: process.cwd(), dirs: defaultDirs })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const discover = (options: RouterOptions): AppRoutes => {
  const { dirs } = options
  // Normalized once, so every `relative` below and every ancestor walk in
  // `resolveLayer` compares the same spelling of the same directory.
  const root = resolve(options.root)
  const files = new Set<string>()
  walk(root, (file) => files.add(toPosix(relative(root, file))))

  const appPrefix = `${dirs.app}/`
  const panesDir = `${dirs.app}/panes`
  const flowsPrefix = `${dirs.flows}/`
  const layout = files.has(`${dirs.app}/layout.tsx`) ? `${dirs.app}/layout.tsx` : undefined

  const pages: Array<PageRoute> = []
  const panes: Array<PaneRoute> = []
  const flows: Array<FlowRoute> = []

  for (const file of [...files].sort()) {
    // Exactly one level below `panes/`, which is what the docstring, the
    // `routes` target's input glob in `package.ts`, and the Vite plugin's
    // watcher all already declare. Matching at any depth made
    // `app/panes/deep/page.tsx` the pane `page` instead of the page
    // `/panes/deep`, and put a routed file outside the target's `data` set.
    if (posix.dirname(file) === panesDir && file.endsWith(".tsx")) {
      const name = posix.basename(file, ".tsx")
      if (!isRouteSegment(name)) {
        throw new RouterError("invalid_name", `pane file name must match ${routeSegmentGrammar}: ${file}`)
      }
      panes.push({ name, file })
      continue
    }
    if (file.startsWith(appPrefix) && posix.basename(file) === "page.tsx") {
      const dir = posix.dirname(file).slice(appPrefix.length - 1)
      const route = dir === "" ? "/" : `/${dir.replace(/^\//, "")}`
      // Every directory segment names the route, so it obeys the same grammar
      // a pane and a flow segment do. Unvalidated, `app/v1.2/page.tsx` was
      // accepted and any character at all reached the generated import.
      if (route !== "/" && !route.slice(1).split("/").every(isRouteSegment)) {
        throw new RouterError("invalid_name", `page directory segments must match ${routeSegmentGrammar}: ${file}`)
      }
      pages.push({ route, file })
      continue
    }
    if (file.startsWith(flowsPrefix) && posix.basename(file) === "flow.ts") {
      const id = posix.dirname(file).slice(flowsPrefix.length)
      if (!id.split("/").every(isRouteSegment)) {
        throw new RouterError("invalid_name", `flow directory segments must match ${routeSegmentGrammar}: ${file}`)
      }
      const dir = join(root, posix.dirname(file))
      flows.push({
        id,
        file,
        agent: resolveLayer(root, dir, "AGENT.ts", files),
        sandbox: resolveLayer(root, dir, "SANDBOX.ts", files),
        tools: resolveLayer(root, dir, "TOOLS.ts", files)
      })
    }
  }
  return { layout, pages, panes, flows }
}

// Import bindings are numbered by position rather than derived from the route,
// because no derivation from the route is injective: `[^A-Za-z0-9] -> "_"`
// mapped the flows `a-b` and `a/b`, and the pages `/a-b`, `/a/b` and `/a_b`,
// onto one binding each, and the generated module then failed to parse while
// the generator reported success.
const binding = (prefix: string, index: number): string => `${prefix}${index}`

// Every specifier is a JSON string literal rather than an interpolated
// template, so no character in a file path can close the literal and inject a
// statement into the generated module.
const specifier = (file: string): string => JSON.stringify(`./${file}`)

const header = (what: string): ReadonlyArray<string> => [
  `// Generated by @smthrs/create-app from ${what}. Do not edit.`,
  "// Regenerate with `pnpm routes`; `smithers-build lint '//:routes'` checks for drift.",
  "/* eslint-disable */",
  ""
]

/**
 * Renders `routes.gen.ts`: every flow with its resolved layers, plus the pane
 * names.
 *
 * The file imports no React and no virtual module, so the Worker bundle and a
 * plain vitest run can both load it without Vite.
 *
 * @category constructors
 * @since 0.1.0
 */
export const render = (routes: AppRoutes): string => {
  const lines: Array<string> = [...header("the flows and layer files")]
  const layerFiles = new Set<string>()
  for (const flow of routes.flows) for (const file of [flow.agent, flow.sandbox, flow.tools]) layerFiles.add(file)
  const layerIds = new Map<string, string>()
  let index = 0
  for (const file of [...layerFiles].sort()) {
    const id = binding("layer", index++)
    layerIds.set(file, id)
    lines.push(`import * as ${id} from ${specifier(file)}`)
  }
  for (const [position, flow] of routes.flows.entries()) {
    lines.push(`import * as ${binding("flow", position)} from ${specifier(flow.file)}`)
  }
  lines.push("")
  lines.push(`export const paneNames = ${JSON.stringify(routes.panes.map((pane) => pane.name))} as const`)
  lines.push("")
  lines.push("export const flows = [")
  for (const [position, flow] of routes.flows.entries()) {
    lines.push(
      `  { id: ${JSON.stringify(flow.id)}, file: ${JSON.stringify(flow.file)}, spec: ${
        binding("flow", position)
      }.default, layer: "layer" in ${binding("flow", position)} ? ${binding("flow", position)}.layer : undefined, ` +
        `agent: ${layerIds.get(flow.agent)}.Agent, sandbox: ${layerIds.get(flow.sandbox)}.Sandbox, tools: ${
          layerIds.get(flow.tools)
        }.Tools },`
    )
  }
  lines.push("] as const")
  lines.push("")
  return lines.join("\n")
}

/**
 * Renders `routes.ui.gen.ts`: the shell layout, the pages, the pane
 * components, and the flow summaries the browser bundle needs.
 *
 * `flowSummaries` is each flow's `id`, `file`, and `chat` flag, read from the
 * flow file alone. The browser table imports no layer file and no tool
 * module: a browser entry that read `flows` from `routes.gen.ts` for those
 * three values pulled every layer, every tool module, and the harness into
 * its bundle.
 *
 * @category constructors
 * @since 0.1.0
 */
export const renderUi = (routes: AppRoutes): string => {
  const lines: Array<string> = [...header("the app directory")]
  for (const [position, pane] of routes.panes.entries()) {
    lines.push(`import * as ${binding("pane", position)} from ${specifier(pane.file)}`)
  }
  if (routes.layout !== undefined) lines.push(`import * as layoutModule from ${specifier(routes.layout)}`)
  for (const [position, page] of routes.pages.entries()) {
    lines.push(`import * as ${binding("page", position)} from ${specifier(page.file)}`)
  }
  for (const [position, flow] of routes.flows.entries()) {
    lines.push(`import * as ${binding("flow", position)} from ${specifier(flow.file)}`)
  }
  lines.push("")
  lines.push(`export const layout = ${routes.layout === undefined ? "undefined" : "layoutModule.default"}`)
  lines.push("")
  lines.push("export const pages = [")
  for (const [position, page] of routes.pages.entries()) {
    lines.push(
      `  { route: ${JSON.stringify(page.route)}, file: ${JSON.stringify(page.file)}, component: ${
        binding("page", position)
      }.default },`
    )
  }
  lines.push("] as const")
  lines.push("")
  lines.push("export const panes = {")
  for (const [position, pane] of routes.panes.entries()) {
    lines.push(`  ${JSON.stringify(pane.name)}: ${binding("pane", position)}.Pane,`)
  }
  lines.push("} as const")
  lines.push("")
  lines.push("export const flowSummaries = [")
  for (const [position, flow] of routes.flows.entries()) {
    lines.push(
      `  { id: ${JSON.stringify(flow.id)}, file: ${JSON.stringify(flow.file)}, chat: ${
        binding("flow", position)
      }.default.chat === true },`
    )
  }
  lines.push("] as const")
  lines.push("")
  return lines.join("\n")
}

/**
 * Both generated files, keyed by their app-root relative path.
 *
 * @category constructors
 * @since 0.1.0
 */
export const renderAll = (routes: AppRoutes): Readonly<Record<string, string>> => ({
  "routes.gen.ts": render(routes),
  "routes.ui.gen.ts": renderUi(routes)
})

/**
 * What one generated file was found to be.
 *
 * `written` and `clean` are the two outcomes of a successful run; `stale` is
 * only reported in check mode, where nothing is written.
 *
 * @category models
 * @since 0.1.0
 */
export type RoutesFileStatus = "written" | "clean" | "stale"

/**
 * What {@link writeRoutes} did, one entry per generated file plus the counts
 * a caller prints.
 *
 * @category models
 * @since 0.1.0
 */
export interface RoutesReport {
  readonly files: Readonly<Record<string, RoutesFileStatus>>
  readonly stale: ReadonlyArray<string>
  readonly counts: { readonly pages: number; readonly panes: number; readonly flows: number }
}

/** One generated table {@link writeRoutes} is about to replace. */
interface PendingTable {
  readonly file: string
  readonly target: string
  readonly next: string
  /** The table's contents before this run, or `undefined` when it did not exist. */
  readonly previous: string | undefined
}

const removeQuietly = (path: string): void => {
  try {
    rmSync(path, { force: true })
  } catch {
    // Cleanup of a staging file must not mask the failure being reported.
  }
}

/**
 * Replaces every pending table, or none of them.
 *
 * The Worker bundle imports one table and Vite the other, so a pair from two
 * different trees is a broken app. Each table is written to a neighbouring
 * staging file first; only when every staging write succeeded are they renamed
 * into place. A rename is atomic per file, so a reader sees a whole module, and
 * a failure on a later rename restores the tables already replaced from the
 * contents read before the run. On any failure the staging files this run
 * wrote are removed; a path it could not write is left alone.
 */
const publishTables = (pending: ReadonlyArray<PendingTable>): void => {
  const staged: Array<PendingTable> = []
  const committed: Array<PendingTable> = []
  try {
    for (const table of pending) {
      writeFileSync(`${table.target}.tmp`, table.next)
      staged.push(table)
    }
    for (const table of pending) {
      renameSync(`${table.target}.tmp`, table.target)
      committed.push(table)
    }
  } catch (cause) {
    for (const table of staged) {
      if (!committed.includes(table)) removeQuietly(`${table.target}.tmp`)
    }
    for (const table of committed.reverse()) {
      try {
        if (table.previous === undefined) rmSync(table.target, { force: true })
        else writeFileSync(table.target, table.previous)
      } catch {
        // The original failure is the one reported; a restore that also fails
        // leaves a table `smithers-routes --check` reports as stale.
      }
    }
    throw cause
  }
}

/**
 * Discovers an app root and writes the two generated files, or reports their
 * drift when `check` is set.
 *
 * This is the whole body of the `smithers-routes` bin and of the Vite plugin's
 * regeneration step, so drift checking and writing cannot diverge.
 *
 * @category constructors
 * @since 0.1.0
 */
export const writeRoutes = (
  options: RouterOptions & { readonly check?: boolean }
): RoutesReport => {
  const routes = discover(options)
  const files: Record<string, RoutesFileStatus> = {}
  const stale: Array<string> = []
  const pending: Array<PendingTable> = []
  // Every current table is read before anything is written, so a target the
  // router cannot read refuses the run with both tables untouched.
  for (const [file, next] of Object.entries(renderAll(routes))) {
    const target = resolve(options.root, file)
    const previous = existsSync(target) ? readFileSync(target, "utf8") : undefined
    if (previous === next) {
      files[file] = "clean"
      continue
    }
    if (options.check === true) {
      files[file] = "stale"
      stale.push(file)
      continue
    }
    pending.push({ file, target, next, previous })
  }
  publishTables(pending)
  for (const table of pending) files[table.file] = "written"
  return {
    files,
    stale,
    counts: { pages: routes.pages.length, panes: routes.panes.length, flows: routes.flows.length }
  }
}
