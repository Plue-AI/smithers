/**
 * The body of the `smithers-routes` executable.
 *
 * The logic lives here rather than in `bin/routes.mjs` for two reasons. A
 * spawned child process is not instrumented by the coverage provider, so
 * argument parsing and exit codes written in the bin could never be held to
 * the package's thresholds. And Node refuses to strip types from any file
 * under `node_modules`, so the bin has to be a shim that prefers the built
 * `dist/esm/routesBin.js` over this source; keeping it a shim keeps that
 * choice the only thing it does.
 *
 * @since 0.1.0
 */

import { defaultDirs } from "./app.ts"
import type { RouterOptions, RoutesReport } from "./router.ts"
import { writeRoutes } from "./router.ts"

/**
 * Where one invocation writes its two output streams.
 *
 * The bin binds these to `console.log` and `console.error`; a test binds them
 * to arrays and reads back exactly what a user would see.
 *
 * @category models
 * @since 0.1.0
 */
export interface RoutesBinIo {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

/**
 * What {@link runRoutesBin} runs against.
 *
 * @category models
 * @since 0.1.0
 */
export interface RoutesBinOptions {
  readonly io: RoutesBinIo
  /** The directory `--root` defaults to. Defaults to `process.cwd()`. */
  readonly cwd?: string
  /**
   * The router entry point. Defaults to {@link writeRoutes}.
   *
   * A caller overrides it to observe how the bin reports a failure the
   * filesystem cannot be made to produce on demand, which is the same seam
   * `CachedModelTestOptions.routes` opens for the test harness.
   */
  readonly write?: (options: RouterOptions & { readonly check?: boolean }) => RoutesReport
}

/**
 * The `smithers-routes` usage text.
 *
 * @category models
 * @since 0.1.0
 */
export const usage = [
  "usage: smithers-routes [--check] [--root <dir>] [--app <dir>] [--flows <dir>] [--tools <dir>]",
  "",
  "  --check  report drift instead of writing; exit 1 when a file is stale",
  "",
  "Every flag takes either form: `--root <dir>` or `--root=<dir>`."
].join("\n")

type FlagValue = { readonly ok: true; readonly value: string } | { readonly ok: false }

/**
 * Reads one flag in both the spaced and the `=` form.
 *
 * The `=` form used to be dropped on the floor: `--root=/x` matched no
 * `indexOf("--root")`, so the run silently used the working directory instead
 * of the root the caller named.
 */
const flag = (argv: ReadonlyArray<string>, name: string, fallback: string): FlagValue => {
  const prefix = `--${name}=`
  const equals = argv.find((argument) => argument.startsWith(prefix))
  if (equals !== undefined) {
    const value = equals.slice(prefix.length)
    return value === "" ? { ok: false } : { ok: true, value }
  }
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return { ok: true, value: fallback }
  const value = argv[index + 1]
  if (value === undefined || value.startsWith("--")) return { ok: false }
  return { ok: true, value }
}

/**
 * Runs one `smithers-routes` invocation and returns the process exit code.
 *
 * 0 is a written or clean tree, 1 is drift under `--check` or a refused tree,
 * and 2 is a flag given without a value.
 *
 * @example
 * ```ts
 * import { runRoutesBin } from "@smthrs/create-app/routesBin"
 *
 * const lines: Array<string> = []
 * const code = runRoutesBin(["--check"], { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) } })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const runRoutesBin = (argv: ReadonlyArray<string>, options: RoutesBinOptions): number => {
  const { io } = options
  if (argv.includes("--help") || argv.includes("-h")) {
    io.out(usage)
    return 0
  }

  const root = flag(argv, "root", options.cwd ?? process.cwd())
  const app = flag(argv, "app", defaultDirs.app)
  const flows = flag(argv, "flows", defaultDirs.flows)
  const tools = flag(argv, "tools", defaultDirs.tools)
  if (!root.ok) {
    io.err("--root expects a value")
    return 2
  }
  if (!app.ok) {
    io.err("--app expects a value")
    return 2
  }
  if (!flows.ok) {
    io.err("--flows expects a value")
    return 2
  }
  if (!tools.ok) {
    io.err("--tools expects a value")
    return 2
  }

  const check = argv.includes("--check")
  const write = options.write ?? writeRoutes
  let report: RoutesReport
  try {
    report = write({
      root: root.value,
      dirs: { app: app.value, flows: flows.value, tools: tools.value },
      check
    })
  } catch (cause) {
    io.err(cause instanceof Error ? cause.message : String(cause))
    return 1
  }

  if (check) {
    for (const file of report.stale) io.err(`${file} is out of date; run \`pnpm routes\``)
    return report.stale.length === 0 ? 0 : 1
  }

  const { flows: flowCount, pages, panes } = report.counts
  io.out(`routes: ${pages} pages, ${panes} panes, ${flowCount} flows`)
  return 0
}
