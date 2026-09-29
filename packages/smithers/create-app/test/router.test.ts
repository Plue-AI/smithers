/**
 * The router is the whole authoring contract: where a file sits is the only
 * thing that names it. These tests build throwaway app trees on disk and check
 * what `discover` reads back, because a rule that only holds for this
 * repository's layout is not a rule.
 */
import { afterEach, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, sep } from "node:path"
import ts from "typescript"
import type { AppRoutes } from "../src/app.ts"
import { defaultDirs } from "../src/app.ts"
import { discover, render, renderAll, renderUi, resolveLayer, RouterError, writeRoutes } from "../src/router.ts"
import { appTrees } from "./support/appTree.ts"
import { layers } from "./support/layers.ts"

const { write: appTree, remove: removeTrees } = appTrees("smthrs-router-")
const unwritable: Array<string> = []

afterEach(() => {
  while (unwritable.length > 0) chmodSync(unwritable.pop()!, 0o600)
  removeTrees()
})

/**
 * Every import a generated module declares, as binding and specifier.
 *
 * The golden-string assertions below compare text, so a generated module that
 * text-matches an equally broken expectation still passes. Reading the real
 * import list back is what proves the two properties the generator owes: one
 * binding per routed file, and no specifier the router did not put there.
 */
const importsOf = (source: string): ReadonlyArray<{ readonly binding: string; readonly specifier: string }> => {
  const file = ts.createSourceFile("routes.gen.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  return file.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement)) return []
    const bindings = statement.importClause?.namedBindings
    const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : ""
    // A bare `import "./x"` carries no clause at all, which is exactly the
    // shape an injected specifier takes; it is reported with an empty binding
    // so the assertions below see it.
    if (bindings === undefined || !ts.isNamespaceImport(bindings)) return [{ binding: "", specifier }]
    return [{ binding: bindings.name.text, specifier }]
  })
}

/**
 * What the JavaScript parser says about a generated module, or `""`.
 *
 * `node --check` is the real engine rather than a transpiler: TypeScript's
 * `transpileModule` elides an unused import, which is precisely the duplicate
 * the generator used to emit, and reports nothing. `as const` is the only
 * TypeScript-only syntax either generated file carries, so stripping it leaves
 * a module Node parses as-is.
 */
const parseErrors = (source: string): string => {
  const file = join(appTree({ "generated.mjs": source.replaceAll(" as const", "") }), "generated.mjs")
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" })
  return result.status === 0 ? "" : result.stderr
}

const dirs = defaultDirs

describe("discover", () => {
  it("names pages, panes, and flows by location", () => {
    const root = appTree({
      ...layers,
      "app/layout.tsx": "export default () => null\n",
      "app/page.tsx": "export default () => null\n",
      "app/build/page.tsx": "export default () => null\n",
      "app/operate/transactions/page.tsx": "export default () => null\n",
      "app/panes/balances.tsx": "export const Pane = {}\n",
      "app/panes/tx-receipt.tsx": "export const Pane = {}\n",
      "flows/chat/flow.ts": "export const Flow = {}\n",
      "flows/build/plan/flow.ts": "export const Flow = {}\n",
      // Not routed: no `page.tsx`, no `flow.ts`, wrong directory.
      "app/build/build-view.tsx": "export const View = {}\n",
      "src/api.ts": "export const Routes = {}\n",
      "tools/tevm.ts": "export const tevm = {}\n"
    })
    const routes = discover({ root, dirs })

    expect(routes.layout).toBe("app/layout.tsx")
    expect(routes.pages).toEqual([
      { route: "/build", file: "app/build/page.tsx" },
      { route: "/operate/transactions", file: "app/operate/transactions/page.tsx" },
      { route: "/", file: "app/page.tsx" }
    ])
    expect(routes.panes).toEqual([
      { name: "balances", file: "app/panes/balances.tsx" },
      { name: "tx-receipt", file: "app/panes/tx-receipt.tsx" }
    ])
    expect(routes.flows.map((flow) => flow.id)).toEqual(["build/plan", "chat"])
  })

  it("routes a flow.mdx the same as a flow.ts", () => {
    const root = appTree({ ...layers, "flows/notes/flow.mdx": "# notes\n" })
    expect(discover({ root, dirs }).flows).toEqual([
      { id: "notes", file: "flows/notes/flow.mdx", agent: "AGENT.ts", sandbox: "SANDBOX.ts", tools: "TOOLS.ts" }
    ])
  })

  it("reports no layout as undefined, not as an error", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    expect(discover({ root, dirs }).layout).toBeUndefined()
  })

  it("ignores node_modules and build output", () => {
    const root = appTree({
      ...layers,
      "app/page.tsx": "export default () => null\n",
      "node_modules/pkg/app/panes/fake.tsx": "export const Pane = {}\n",
      "dist/app/page.tsx": "export default () => null\n",
      ".wrangler/app/panes/tmp.tsx": "export const Pane = {}\n"
    })
    const routes = discover({ root, dirs })
    expect(routes.panes).toEqual([])
    expect(routes.pages).toEqual([{ route: "/", file: "app/page.tsx" }])
  })

  it("routes app/panes/<dir>/page.tsx as a page, not as a pane named page", () => {
    const root = appTree({
      ...layers,
      "app/panes/balances.tsx": "export const Pane = {}\n",
      "app/panes/deep/page.tsx": "export default () => null\n",
      // Only the file directly under panes/ is a pane. A nested .tsx that is
      // not a page.tsx is not routed at all.
      "app/panes/chain/balance.tsx": "export const Pane = {}\n"
    })
    const routes = discover({ root, dirs })
    expect(routes.panes).toEqual([{ name: "balances", file: "app/panes/balances.tsx" }])
    expect(routes.pages).toEqual([{ route: "/panes/deep", file: "app/panes/deep/page.tsx" }])
  })

  it("ignores a nested layout.tsx: only the app root has a shell layout", () => {
    const root = appTree({
      ...layers,
      "app/page.tsx": "export default () => null\n",
      "app/nested/page.tsx": "export default () => null\n",
      "app/nested/layout.tsx": "export default () => null\n"
    })
    const routes = discover({ root, dirs })
    expect(routes.layout).toBeUndefined()
    const output = renderUi(routes)
    expect(output).toContain("export const layout = undefined")
    expect(output).not.toContain("app/nested/layout.tsx")
  })

  it("ignores a dangling symlink instead of failing with a raw ENOENT", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    symlinkSync(join(root, "nowhere.tsx"), join(root, "app", "dangling.tsx"))
    expect(discover({ root, dirs }).pages).toEqual([{ route: "/", file: "app/page.tsx" }])
  })

  it("ignores a self-referential directory symlink instead of recursing to ELOOP", { timeout: 5000 }, () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    symlinkSync(join(root, "app"), join(root, "app", "loop"))
    expect(discover({ root, dirs }).pages).toEqual([{ route: "/", file: "app/page.tsx" }])
  })

  it("reads a root that carries a trailing separator the same as the normalized one", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    expect(discover({ root: `${root}${sep}`, dirs })).toEqual(discover({ root, dirs }))
  })

  it("honors non-default dirs", () => {
    const root = appTree({
      ...layers,
      "site/page.tsx": "export default () => null\n",
      "pipelines/chat/flow.ts": "export const Flow = {}\n"
    })
    const routes = discover({ root, dirs: { app: "site", flows: "pipelines", tools: "tools" } })
    expect(routes.pages).toEqual([{ route: "/", file: "site/page.tsx" }])
    expect(routes.flows.map((flow) => flow.id)).toEqual(["chat"])
  })
})

describe("layer resolution", () => {
  it("resolves the nearest ancestor AGENT.ts and merges nothing", () => {
    const root = appTree({
      ...layers,
      "flows/chat/flow.ts": "export const Flow = {}\n",
      "flows/build/AGENT.ts": "export const Agent = {}\n",
      "flows/build/flow.ts": "export const Flow = {}\n",
      "flows/build/plan/flow.ts": "export const Flow = {}\n"
    })
    const byId = new Map(discover({ root, dirs }).flows.map((flow) => [flow.id, flow]))

    expect(byId.get("chat")!.agent).toBe("AGENT.ts")
    // The override applies to its own directory and everything below it.
    expect(byId.get("build")!.agent).toBe("flows/build/AGENT.ts")
    expect(byId.get("build/plan")!.agent).toBe("flows/build/AGENT.ts")
    // Only AGENT.ts was overridden; the other two kinds still resolve to root.
    expect(byId.get("build")!.sandbox).toBe("SANDBOX.ts")
    expect(byId.get("build")!.tools).toBe("TOOLS.ts")
  })

  it("resolves each kind independently", () => {
    const root = appTree({
      ...layers,
      "flows/build/TOOLS.ts": "export const Tools = {}\n",
      "flows/build/flow.ts": "export const Flow = {}\n"
    })
    const flow = discover({ root, dirs }).flows[0]!
    expect(flow).toEqual({
      id: "build",
      file: "flows/build/flow.ts",
      agent: "AGENT.ts",
      sandbox: "SANDBOX.ts",
      tools: "flows/build/TOOLS.ts"
    })
  })

  it("routes a refused tree to its catchTag handler with the code", () => {
    const root = appTree({
      "SANDBOX.ts": layers["SANDBOX.ts"],
      "TOOLS.ts": layers["TOOLS.ts"],
      "flows/chat/flow.ts": "export const Flow = {}\n"
    })
    const handled = Effect.runSync(
      Effect.try({ try: () => discover({ root, dirs }), catch: (cause) => cause as RouterError }).pipe(
        Effect.catchTag("create-app/RouterError", (caught) => Effect.succeed(caught.code))
      )
    )
    expect(handled).toBe("missing_layer")
  })

  it("refuses a flow with no ancestor layer", () => {
    const root = appTree({
      "SANDBOX.ts": layers["SANDBOX.ts"],
      "TOOLS.ts": layers["TOOLS.ts"],
      "flows/chat/flow.ts": "export const Flow = {}\n"
    })
    try {
      discover({ root, dirs })
      expect.unreachable("discover should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError)
      expect((error as RouterError).name).toBe("RouterError")
      expect((error as RouterError).code).toBe("missing_layer")
      expect((error as RouterError).message).toContain("no AGENT.ts found for flows/chat")
      expect((error as RouterError).message).toContain("add one at the app root")
    }
  })

  it("resolves a layer at the root itself", () => {
    const root = appTree(layers)
    expect(resolveLayer(root, root, "AGENT.ts", new Set(["AGENT.ts"]))).toBe("AGENT.ts")
  })

  it("refuses rather than hangs when the root carries a trailing separator", { timeout: 5000 }, () => {
    // `dirname("/")` is `"/"`, and the walk used to stop only on a raw string
    // match with the root, so an unnormalized root spun forever instead of
    // reporting the missing layer. Shell tab completion appends the separator.
    const root = appTree(layers)
    try {
      resolveLayer(`${root}${sep}`, join(root, "flows", "chat"), "TOOLS.ts", new Set(["AGENT.ts"]))
      expect.unreachable("resolveLayer should have thrown")
    } catch (error) {
      expect((error as RouterError).code).toBe("missing_layer")
      expect((error as RouterError).message).toContain("flows/chat")
    }
  })

  it("refuses rather than hangs for a directory outside the root", { timeout: 5000 }, () => {
    const root = appTree(layers)
    try {
      resolveLayer(root, dirname(root), "AGENT.ts", new Set(["AGENT.ts"]))
      expect.unreachable("resolveLayer should have thrown")
    } catch (error) {
      expect((error as RouterError).code).toBe("missing_layer")
      expect((error as RouterError).message).toContain("outside the app root")
    }
  })

  it("refuses rather than hangs for the filesystem root", { timeout: 5000 }, () => {
    try {
      resolveLayer(sep, sep, "AGENT.ts", new Set<string>())
      expect.unreachable("resolveLayer should have thrown")
    } catch (error) {
      expect((error as RouterError).code).toBe("missing_layer")
      expect((error as RouterError).message).toContain("no AGENT.ts found for .")
    }
  })
})

describe("name collisions", () => {
  it("refuses flow.ts and flow.mdx in one directory", () => {
    const root = appTree({
      ...layers,
      "flows/chat/flow.ts": "export const Flow = {}\n",
      "flows/chat/flow.mdx": "# chat\n"
    })
    try {
      discover({ root, dirs })
      expect.unreachable("discover should have thrown")
    } catch (error) {
      expect((error as RouterError).code).toBe("duplicate_name")
      expect((error as RouterError).message).toBe(
        "flows/chat/flow.ts and flows/chat/flow.mdx both resolve to flow:chat"
      )
    }
  })

  it("refuses an uppercase pane file name", () => {
    const root = appTree({ ...layers, "app/panes/Balances.tsx": "export const Pane = {}\n" })
    try {
      discover({ root, dirs })
      expect.unreachable("discover should have thrown")
    } catch (error) {
      expect((error as RouterError).code).toBe("invalid_name")
    }
  })

  it("refuses an uppercase flow directory", () => {
    const root = appTree({ ...layers, "flows/Chat/flow.ts": "export const Flow = {}\n" })
    try {
      discover({ root, dirs })
      expect.unreachable("discover should have thrown")
    } catch (error) {
      expect((error as RouterError).code).toBe("invalid_name")
    }
  })

  it("refuses a page directory segment that is not lowercase kebab-case", () => {
    // The practical trigger is not an attacker: `app/v1.2/page.tsx` was
    // accepted, and its route then collided with `app/v1-2/page.tsx`.
    const root = appTree({ ...layers, "app/v1.2/page.tsx": "export default () => null\n" })
    try {
      discover({ root, dirs })
      expect.unreachable("discover should have thrown")
    } catch (error) {
      expect((error as RouterError).code).toBe("invalid_name")
      expect((error as RouterError).message).toContain("app/v1.2/page.tsx")
    }
  })

  // Windows refuses a double quote in a filename before discovery can read it.
  // The renderer's escaping case below exercises this payload on every host.
  it.skipIf(process.platform === "win32")(
    "refuses a page directory that would close the generated import specifier",
    () => {
      const root = appTree({
        ...layers,
        "app/x\";import \"./evil.ts\";/page.tsx": "export default () => null\n"
      })
      try {
        discover({ root, dirs })
        expect.unreachable("discover should have thrown")
      } catch (error) {
        expect((error as RouterError).code).toBe("invalid_name")
      }
    }
  )

  it("refuses an uppercase page directory segment at any depth", () => {
    const root = appTree({ ...layers, "app/operate/Logs/page.tsx": "export default () => null\n" })
    try {
      discover({ root, dirs })
      expect.unreachable("discover should have thrown")
    } catch (error) {
      expect((error as RouterError).code).toBe("invalid_name")
    }
  })
})

describe("render", () => {
  it("emits routes.gen.ts and routes.ui.gen.ts", () => {
    const root = appTree({
      ...layers,
      "app/page.tsx": "export default () => null\n",
      "app/panes/balances.tsx": "export const Pane = {}\n",
      "flows/build/AGENT.ts": "export const Agent = {}\n",
      "flows/build/flow.ts": "export const Flow = {}\n",
      "flows/chat/flow.ts": "export const Flow = {}\n"
    })
    const expectedRuntime = [
      "// Generated by @smthrs/create-app from the flows and layer files. Do not edit.",
      "// Regenerate with `pnpm routes`; `smithers-build lint '//:routes'` checks for drift.",
      "/* eslint-disable */",
      "",
      "import * as layer0 from \"./AGENT.ts\"",
      "import * as layer1 from \"./SANDBOX.ts\"",
      "import * as layer2 from \"./TOOLS.ts\"",
      "import * as layer3 from \"./flows/build/AGENT.ts\"",
      "import * as flow0 from \"./flows/build/flow.ts\"",
      "import * as flow1 from \"./flows/chat/flow.ts\"",
      "",
      "export const paneNames = [\"balances\"] as const",
      "",
      "export const flows = [",
      "  { id: \"build\", file: \"flows/build/flow.ts\", spec: flow0.Flow, agent: layer3.Agent, " +
      "sandbox: layer1.Sandbox, tools: layer2.Tools },",
      "  { id: \"chat\", file: \"flows/chat/flow.ts\", spec: flow1.Flow, agent: layer0.Agent, " +
      "sandbox: layer1.Sandbox, tools: layer2.Tools },",
      "] as const",
      ""
    ].join("\n")
    const expectedUi = [
      "// Generated by @smthrs/create-app from the app directory. Do not edit.",
      "// Regenerate with `pnpm routes`; `smithers-build lint '//:routes'` checks for drift.",
      "/* eslint-disable */",
      "",
      "import * as pane0 from \"./app/panes/balances.tsx\"",
      "import * as page0 from \"./app/page.tsx\"",
      "import * as flow0 from \"./flows/build/flow.ts\"",
      "import * as flow1 from \"./flows/chat/flow.ts\"",
      "",
      "export const layout = undefined",
      "",
      "export const pages = [",
      "  { route: \"/\", file: \"app/page.tsx\", component: page0.default },",
      "] as const",
      "",
      "export const panes = {",
      "  \"balances\": pane0.Pane,",
      "} as const",
      "",
      "export const flowSummaries = [",
      "  { id: \"build\", file: \"flows/build/flow.ts\", chat: flow0.Flow.chat === true },",
      "  { id: \"chat\", file: \"flows/chat/flow.ts\", chat: flow1.Flow.chat === true },",
      "] as const",
      ""
    ].join("\n")

    const routes = discover({ root, dirs })
    expect(render(routes)).toBe(expectedRuntime)
    expect(renderUi(routes)).toBe(expectedUi)
    expect(renderAll(routes)).toEqual({ "routes.gen.ts": expectedRuntime, "routes.ui.gen.ts": expectedUi })
  })

  it("summarizes every flow in routes.ui.gen.ts without importing a layer or tool module", () => {
    // create-app/performance/3: the aomi browser entry imported `flows` from
    // routes.gen.ts for three strings per flow, and with it every layer file,
    // every tool module, and the harness. The browser table carries the
    // summary itself and reaches only the flow files.
    const root = appTree({
      ...layers,
      "app/page.tsx": "export default () => null\n",
      "flows/build/AGENT.ts": "export const Agent = {}\n",
      "flows/build/flow.ts": "export const Flow = { chat: false }\n",
      "flows/chat/flow.ts": "export const Flow = { chat: true }\n",
      "tools/ui.ts": "export const ui = {}\n"
    })
    const ui = renderUi(discover({ root, dirs }))
    expect(ui).toContain("export const flowSummaries = [")
    expect(ui).toContain("{ id: \"build\", file: \"flows/build/flow.ts\", chat: flow0.Flow.chat === true }")
    expect(ui).toContain("{ id: \"chat\", file: \"flows/chat/flow.ts\", chat: flow1.Flow.chat === true }")
    const specifiers = importsOf(ui).map((entry) => entry.specifier)
    expect(specifiers).toEqual(expect.arrayContaining(["./flows/build/flow.ts", "./flows/chat/flow.ts"]))
    for (const specifier of specifiers) {
      expect(specifier, `${specifier} is a layer file`).not.toMatch(/\/(?:AGENT|SANDBOX|TOOLS)\.ts$/)
      expect(specifier, `${specifier} is a tool module`).not.toMatch(/^\.\/tools\//)
    }
  })

  it("gives two routes that differ only in their separator two distinct bindings", () => {
    // `a-b` and `a/b` are both legal, and every identifier derived from the
    // route mapped them onto one binding: the generated module then declared
    // the same name twice and did not parse, while the generator exited 0.
    const root = appTree({
      ...layers,
      "flows/a-b/flow.ts": "export const Flow = {}\n",
      "flows/a/b/flow.ts": "export const Flow = {}\n",
      "app/a-b/page.tsx": "export default () => null\n",
      "app/a/b/page.tsx": "export default () => null\n",
      "app/panes/a-b.tsx": "export const Pane = {}\n"
    })
    const routes = discover({ root, dirs })
    expect(routes.flows.map((flow) => flow.id)).toEqual(["a-b", "a/b"])
    expect(routes.pages.map((page) => page.route)).toEqual(["/a-b", "/a/b"])

    for (const source of [render(routes), renderUi(routes)]) {
      const declared = importsOf(source)
      expect(declared.length).toBeGreaterThan(0)
      expect(new Set(declared.map((entry) => entry.binding)).size).toBe(declared.length)
      expect(parseErrors(source)).toBe("")
    }
  })

  it("emits every import specifier as an escaped string literal", () => {
    // `discover` refuses these paths, so the renderer is driven directly: the
    // two defenses are independent, and a caller that builds an `AppRoutes` by
    // hand still cannot inject a statement into a generated module.
    const hostile = "app/x\";import \"./evil.ts\";//page.tsx"
    const routes: AppRoutes = {
      layout: undefined,
      pages: [{ route: "/x", file: hostile }],
      panes: [{ name: "x", file: hostile }],
      flows: [{ id: "x", file: hostile, agent: "AGENT.ts", sandbox: "SANDBOX.ts", tools: "TOOLS.ts" }]
    }
    // The hostile path survives whole inside one string literal rather than
    // closing it, so the module declares only the imports the router put there
    // and no `import "./evil.ts"` statement of its own.
    const expected = {
      runtime: ["./AGENT.ts", "./SANDBOX.ts", "./TOOLS.ts", `./${hostile}`],
      ui: [`./${hostile}`, `./${hostile}`, `./${hostile}`]
    }
    for (const [kind, source] of [["runtime", render(routes)], ["ui", renderUi(routes)]] as const) {
      const declared = importsOf(source)
      expect(declared.map((entry) => entry.specifier)).toEqual(expected[kind])
      expect(declared.every((entry) => entry.binding !== "")).toBe(true)
      expect(parseErrors(source)).toBe("")
    }
  })

  it("renders empty tables for an empty app, not a broken file", () => {
    const root = appTree(layers)
    const routes = discover({ root, dirs })
    const runtime = render(routes)
    const ui = renderUi(routes)
    expect(runtime).toContain("export const paneNames = [] as const")
    expect(runtime).toContain("export const flows = [\n] as const")
    expect(ui).toContain("export const layout = undefined")
    expect(ui).toContain("export const pages = [\n] as const")
    expect(ui).toContain("export const panes = {\n} as const")
  })

  it("renders identically for two identical trees", () => {
    const files = {
      ...layers,
      "app/page.tsx": "export default () => null\n",
      "flows/chat/flow.ts": "export const Flow = {}\n"
    }
    const first = render(discover({ root: appTree(files), dirs }))
    const second = render(discover({ root: appTree(files), dirs }))
    expect(first).toBe(second)
  })

  it("exports a layout without shadowing its own import", () => {
    // The namespace import and the export must not share an identifier, or the
    // generated file is a redeclaration TypeScript rejects.
    const root = appTree({ ...layers, "app/layout.tsx": "export default () => null\n" })
    const output = renderUi(discover({ root, dirs }))
    expect(output).toContain("import * as layoutModule from \"./app/layout.tsx\"")
    expect(output).toContain("export const layout = layoutModule.default")
    expect(output).not.toContain("import * as layout from")
  })
})

describe("writeRoutes", () => {
  it("writes both files, then reports them clean on a second run", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const first = writeRoutes({ root, dirs })
    expect(first.files).toEqual({ "routes.gen.ts": "written", "routes.ui.gen.ts": "written" })
    expect(first.stale).toEqual([])
    expect(first.counts).toEqual({ pages: 1, panes: 0, flows: 0 })
    expect(readFileSync(join(root, "routes.ui.gen.ts"), "utf8")).toContain("app/page.tsx")

    const second = writeRoutes({ root, dirs })
    expect(second.files).toEqual({ "routes.gen.ts": "clean", "routes.ui.gen.ts": "clean" })
  })

  it("reports drift and writes nothing in check mode", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const report = writeRoutes({ root, dirs, check: true })
    expect(report.stale).toEqual(["routes.gen.ts", "routes.ui.gen.ts"])
    expect(report.files).toEqual({ "routes.gen.ts": "stale", "routes.ui.gen.ts": "stale" })
    expect(() => readFileSync(join(root, "routes.gen.ts"), "utf8")).toThrow()
  })

  it("reports a checked, already-current tree as clean", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    writeRoutes({ root, dirs })
    const report = writeRoutes({ root, dirs, check: true })
    expect(report.stale).toEqual([])
    expect(report.files).toEqual({ "routes.gen.ts": "clean", "routes.ui.gen.ts": "clean" })
  })

  // Each table is replaced by renaming a staging file into place, so a reader
  // holding the previous file — the Worker bundle, Vite's module graph — sees
  // the whole previous module or the whole next one, never the truncated
  // middle an interrupted in-place write leaves behind. The hard link is the
  // proof: a rename swaps the directory entry for a new inode, so the link
  // still reads what the table held before.
  it("replaces each generated file by renaming a staging file into place", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    writeRoutes({ root, dirs })
    const target = join(root, "routes.ui.gen.ts")
    const before = readFileSync(target, "utf8")
    const held = join(root, "held.gen.ts")
    linkSync(target, held)

    mkdirSync(join(root, "app/panes"), { recursive: true })
    writeFileSync(join(root, "app/panes/balances.tsx"), "export const Pane = {}\n")
    const report = writeRoutes({ root, dirs })

    expect(report.files["routes.ui.gen.ts"]).toBe("written")
    expect(readFileSync(target, "utf8")).toContain("balances")
    expect(readFileSync(held, "utf8")).toBe(before)
    expect(existsSync(`${target}.tmp`)).toBe(false)
  })

  // Writing in place used to mutate whichever table it reached before the
  // filesystem refused, so a refusal between the two left one table new and
  // one stale. Staging every write means a refused tree of files is left
  // exactly as it was.
  it.skipIf(process.getuid?.() === 0)(
    "leaves both tables as they were when the filesystem refuses the write; root bypasses permission bits",
    () => {
      const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
      writeRoutes({ root, dirs })
      const before = {
        "routes.gen.ts": readFileSync(join(root, "routes.gen.ts"), "utf8"),
        "routes.ui.gen.ts": readFileSync(join(root, "routes.ui.gen.ts"), "utf8")
      }

      mkdirSync(join(root, "app/panes"), { recursive: true })
      writeFileSync(join(root, "app/panes/balances.tsx"), "export const Pane = {}\n")
      // Windows honors a file's read-only bit, not a directory's mode bits.
      const staging = join(root, "routes.gen.ts.tmp")
      writeFileSync(staging, "reserved staging file")
      unwritable.push(staging)
      chmodSync(staging, 0o400)

      expect(() => writeRoutes({ root, dirs })).toThrow(/EACCES|EROFS|EPERM/)
      expect(readFileSync(join(root, "routes.gen.ts"), "utf8")).toBe(before["routes.gen.ts"])
      expect(readFileSync(join(root, "routes.ui.gen.ts"), "utf8")).toBe(before["routes.ui.gen.ts"])
    }
  )

  // The second table used to be read, staged, and renamed only after the first
  // was already replaced, so a failure on the second output left the Worker's
  // table and Vite's table from different trees.
  it.each([
    ["the second target is a directory", "routes.ui.gen.ts"],
    ["the second staging path is a directory", "routes.ui.gen.ts.tmp"]
  ])("leaves the first table as it was when %s", (_, blocked) => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    writeRoutes({ root, dirs })
    const before = readFileSync(join(root, "routes.gen.ts"), "utf8")
    if (blocked === "routes.ui.gen.ts") rmSync(join(root, blocked))
    mkdirSync(join(root, blocked, "occupied"), { recursive: true })

    mkdirSync(join(root, "app/panes"), { recursive: true })
    writeFileSync(join(root, "app/panes/balances.tsx"), "export const Pane = {}\n")

    expect(() => writeRoutes({ root, dirs })).toThrow(/EISDIR|EPERM|ENOTEMPTY/)
    expect(readFileSync(join(root, "routes.gen.ts"), "utf8")).toBe(before)
    expect(existsSync(join(root, "routes.gen.ts.tmp"))).toBe(false)
  })
})
