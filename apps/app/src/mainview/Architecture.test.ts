import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import ts from "typescript"

/** Type-only imports do not give a View runtime authority. */
const runtimeDependencies = (source: string): string[] => {
  const tree = ts.createSourceFile("view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const dependencies: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      if (
        !clause?.isTypeOnly && (!bindings || !ts.isNamedImports(bindings) || clause?.name ||
          bindings.elements.length === 0 || bindings.elements.some((binding) => !binding.isTypeOnly))
      ) {
        dependencies.push(node.moduleSpecifier.text)
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (
        !node.isTypeOnly && (!node.exportClause || !ts.isNamedExports(node.exportClause) ||
          node.exportClause.elements.some((binding) => !binding.isTypeOnly))
      ) dependencies.push(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) && !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      dependencies.push(node.moduleReference.expression.text)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const argument = node.arguments[0]
      if (argument && ts.isStringLiteralLike(argument)) dependencies.push(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return dependencies
}

const authorityModule = (path: string): boolean =>
  /(?:^|[/@._-])(?:topics?|stores?|controllers?|commands?)(?:[/._-]|$)/i.test(path) ||
  /(?:AppStore|AppController|RpcClient|RPCClient|TopicClient|FlowAction|FlowArgs|Flows|FlowRegistry)(?:\.[cm]?[jt]sx?)?$/
    .test(path) ||
  /(?:^|\/)[A-Za-z]*(?:Client|Store|Controller|Commands?)(?:\.[cm]?[jt]sx?)?$/.test(path) ||
  /@tanstack\/(?:react-query|query-core|react-db|db)(?:\/|$)/.test(path) ||
  /@electric-sql\/(?:client|react)(?:\/|$)/.test(path) ||
  /(?:^|[/._-])(?:rpc|api)[/_-]client(?:[/._-]|$)/i.test(path)

const directAuthorityCalls = (source: string): string[] => {
  const tree = ts.createSourceFile("view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const violations: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined
      const prohibited = name !== undefined &&
        /^(?:fetch|WebSocket|EventSource|subscribe|useQuery|useLiveQuery|useMutation|createRpcClient|createRPCClient|createTRPCClient|runCommand|runSlashCommand)$/
          .test(name)
      const authorityReceiver = ts.isPropertyAccessExpression(callee) &&
        /^(?:controller|store|rpc|client)$/.test(callee.expression.getText(tree))
      if (prohibited || authorityReceiver) violations.push(callee.getText(tree))
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return violations
}

const viewAuthorityViolations = (
  entry: string,
  read: (path: string) => string,
  locate: (specifier: string, from: string) => string | undefined
): string[] => {
  const visited = new Set<string>()
  const violations: string[] = []
  const visit = (path: string, chain: string[]): void => {
    if (visited.has(path)) return
    visited.add(path)
    const source = read(path)
    violations.push(...directAuthorityCalls(source).map((callee) => [...chain, `${callee}()`].join(" → ")))
    for (const specifier of runtimeDependencies(source)) {
      const target = locate(specifier, path)
      const next = [...chain, specifier]
      if (authorityModule(specifier) || (target !== undefined && authorityModule(target))) {
        violations.push(next.join(" → "))
      } else if (target !== undefined) visit(target, next)
    }
  }
  visit(entry, [entry])
  return violations
}

describe("props-only View imports (C-UI-08)", () => {
  test("all card and shared UI Views have no direct or transitive runtime authority", async () => {
    const repository = resolve(import.meta.dir, "../../../..")
    const options: ts.CompilerOptions = {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext
    }
    const locate = (specifier: string, from: string): string | undefined => {
      const resolved = ts.resolveModuleName(specifier, from, options, ts.sys).resolvedModule?.resolvedFileName
      if (!resolved) return undefined
      const target = realpathSync(resolved)
      return target.startsWith(`${repository}/`) && !target.includes("/node_modules/") && !target.endsWith(".d.ts")
        ? target
        : undefined
    }
    const violations: string[] = []
    const selected: string[] = []
    for (
      const directory of [resolve(import.meta.dir, "cards/views"), resolve(repository, "packages/smithers/ui/src")]
    ) {
      if (!existsSync(directory)) continue // Design adds card Views in its own tickets.
      for await (const path of new Bun.Glob(directory.endsWith("cards/views") ? "**/*.{ts,tsx}" : "**/{*View,actor-chip,state-word}.tsx").scan({ cwd: directory, absolute: true })) {
        if (/\.(test|stories)\.tsx?$/.test(path)) continue
        selected.push(path)
        violations.push(...viewAuthorityViolations(path, (file) => readFileSync(file, "utf8"), locate))
      }
    }
    for (const name of ["ActorChip.tsx", "StateWord.tsx", "actorName.ts"]) expect(selected).toContain(resolve(import.meta.dir, "cards/views", name))
    for (const name of ["actor-chip.tsx", "state-word.tsx"]) {
      const path = resolve(repository, "packages/smithers/ui/src", name)
      if (existsSync(path)) expect(selected).toContain(path)
      expect(viewAuthorityViolations(path, () => 'import { store } from "./state/Store"', () => undefined).length).toBeGreaterThan(0)
    }
    expect(violations).toEqual([])
  })

  test("runtime imports, barrel exports, dynamic imports and require cannot hide authority", () => {
    const modules: Record<string, string> = {
      View: "import { Button } from \"./button\"; import \"./styles\"",
      "./button": "export { wrapper } from \"./barrel\"",
      "./barrel": "export * from \"./nested\"",
      "./nested": "import { store } from \"./state/AppStore\"; import(\"./topics/home\"); require(\"./rpc/client\")",
      "./styles": "import \"./button\""
    }
    expect(
      viewAuthorityViolations(
        "View",
        (path) => modules[path]!,
        (specifier) => specifier in modules ? specifier : undefined
      )
    )
      .toEqual([
        "View → ./button → ./barrel → ./nested → ./state/AppStore",
        "View → ./button → ./barrel → ./nested → ./topics/home",
        "View → ./button → ./barrel → ./nested → ./rpc/client"
      ])
  })

  test("schema and type-only imports are allowed, including individual type bindings and cycles", () => {
    const modules: Record<string, string> = {
      View:
        "import type { Store } from \"./store\"; import { type Controller } from \"./controller\"; export type { Command } from \"./commands\"; import { HomeModel } from \"@smthrs/rpc/HomeCard\"; import \"./presentation\"",
      "@smthrs/rpc/HomeCard": "export const HomeModel = {}",
      "./presentation": "export * from \"./loop\"",
      "./loop": "export * from \"./presentation\""
    }
    expect(
      viewAuthorityViolations(
        "View",
        (path) => modules[path]!,
        (specifier) => specifier in modules ? specifier : undefined
      )
    ).toEqual([])
    expect(runtimeDependencies("import { type Store, state } from \"./store\"; import \"./controller\"")).toEqual([
      "./store",
      "./controller"
    ])
  })

  test("a harmless import alias is rejected when resolution reaches an authority module", () => {
    expect(
      viewAuthorityViolations("View", () => "import { state } from \"@alias/state\"", () => "/app/state/AppStore.ts")
    )
      .toEqual(["View → @alias/state"])
  })

  test("import-free network, topic, client and command calls cannot give a View authority", () => {
    for (
      const source of [
        "fetch(\"/api\")",
        "window.fetch(\"/api\")",
        "globalThis.fetch(\"/api\")",
        "new WebSocket(\"wss://example.invalid\")",
        "new EventSource(\"/topics\")",
        "topic.subscribe(listener)",
        "subscribe(\"home\", listener)",
        "useLiveQuery(query)",
        "useQuery({ queryFn: load })",
        "controller.retry()",
        "store.update(value)",
        "rpc.call(\"todo.retry\")",
        "client.request(input)",
        "runCommand(\"todo.retry\")"
      ]
    ) expect(viewAuthorityViolations("View", () => source, () => undefined).length).toBeGreaterThan(0)
    expect(
      viewAuthorityViolations(
        "View",
        () =>
          "values.map((value) => value.label); onAction(action.tag); onView({ maximized: true }); useMemo(() => model.title, [model])",
        () => undefined
      )
    ).toEqual([])
    expect(
      viewAuthorityViolations(
        "View",
        () => "const [highlight, dispatch] = useReducer(reducer, 0); dispatch({ type: \"next\" })",
        () => undefined
      )
    ).toEqual([])
  })

  test("query and collection runtime packages are authority even through a presentation wrapper", () => {
    const modules: Record<string, string> = {
      View: "import \"./wrapper\"",
      "./wrapper":
        "import { useQuery } from \"@tanstack/react-query\"; import { useLiveQuery } from \"@tanstack/react-db\""
    }
    expect(
      viewAuthorityViolations(
        "View",
        (path) => modules[path]!,
        (specifier) => specifier in modules ? specifier : undefined
      )
    ).toEqual([
      "View → ./wrapper → @tanstack/react-query",
      "View → ./wrapper → @tanstack/react-db"
    ])
  })
})

const productionComponents = async (): Promise<ReadonlyArray<{ readonly path: string; readonly source: string }>> => {
  const files: Array<{ readonly path: string; readonly source: string }> = []
  const glob = new Bun.Glob("**/*.tsx")
  for await (const path of glob.scan({ cwd: import.meta.dir, absolute: true })) {
    if (path.endsWith(".test.tsx") || path.includes("/fixtures/")) continue
    files.push({ path, source: await readFile(path, "utf8") })
  }
  return files
}

describe("React architecture boundaries", () => {
  test("components do not acquire domain effects", async () => {
    const offenders = (await productionComponents())
      .filter(({ source }) =>
        /React\.useEffect\s*\(/.test(source) ||
        /import\s*\{[^}]*\buseEffect\b[^}]*\}\s*from\s*["']react["']/.test(source)
      )
      .map(({ path }) => path.slice(import.meta.dir.length + 1))
    expect(offenders).toEqual([])
  })

  test("components mutate through controllers, never the store dispatcher", async () => {
    const offenders = (await productionComponents())
      .filter(({ source }) => /\b(?:controller\.)?store\.dispatch\s*\(/.test(source))
      .map(({ path }) => path.slice(import.meta.dir.length + 1))
    expect(offenders).toEqual([])
  })

  test("components do not depend on the concrete AppStore module", async () => {
    const offenders = (await productionComponents())
      .filter(({ source }) => /from\s+["'][^"']*state\/AppStore["']/.test(source))
      .map(({ path }) => path.slice(import.meta.dir.length + 1))
    expect(offenders).toEqual([])
  })
})

/*
 * Review finding ui-cards-tabs/maintainability/4: Timestamps.ts opens with
 * "One timestamp vocabulary for the whole app", but the cards had hand-rolled
 * five duration formatters, four `shortId` copies and three ISO slicers, two
 * of which rounded differently from the rest. A card that needs one of these
 * words imports it; it does not write its own.
 */
const productionSources = async (): Promise<ReadonlyArray<{ readonly path: string; readonly source: string }>> => {
  const files: Array<{ readonly path: string; readonly source: string }> = []
  for (const pattern of ["**/*.ts", "**/*.tsx"]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: import.meta.dir, absolute: true })) {
      if (
        path.endsWith(".test.ts") || path.endsWith(".test.tsx") || path.endsWith("/Timestamps.ts") ||
        path.endsWith("/state/ids.ts")
      ) continue
      files.push({ path, source: await readFile(path, "utf8") })
    }
  }
  return files
}

const writing = async (rule: RegExp): Promise<ReadonlyArray<string>> =>
  (await productionSources())
    .filter(({ source }) => rule.test(source))
    .map(({ path }) => path.slice(import.meta.dir.length + 1))

describe("one timestamp and id vocabulary", () => {
  test("nobody hand-rolls a duration formatter", async () => {
    expect(await writing(/const\s+(?:duration|elapsed)Label\s*=/)).toEqual([])
  })

  test("nobody hand-rolls the short-id rule", async () => {
    expect(await writing(/\.length\s*>\s*12\s*\?[^\n]*\.slice\(0,\s*8\)/)).toEqual([])
  })

  test("nobody hand-rolls the recorded-stamp slice", async () => {
    expect(await writing(/\.replace\("T",\s*" "\)\s*\.?\s*\n?\s*\.slice\(0,\s*16\)/)).toEqual([])
  })
})
