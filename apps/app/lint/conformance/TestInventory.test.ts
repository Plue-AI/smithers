import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import type { PlaywrightTestConfig } from "@playwright/test"
import playwright from "../../playwright.config"
import playwrightSite from "../../playwright.site.config"
import playwrightReal from "../../playwright.real.config"
import playwrightLocal from "../../playwright.local.config"
import playwrightProof from "../../playwright.proof.config"
import playwrightGraph from "../../playwright.graph.config"
import playwrightShowcase from "../../playwright.showcase.config"

const app = fileURLToPath(new URL("../../", import.meta.url))
const root = fileURLToPath(new URL("../../../../", import.meta.url))
const read = (path: string) => readFileSync(join(app, path), "utf8")
const scripts: Record<string, string> = JSON.parse(read("package.json")).scripts
const testFile = /\.(test|spec)\.[cm]?[jt]sx?$/
const files = execFileSync("rg", ["--files", "apps/app"], {
  cwd: root, encoding: "utf8"
}).trim().split("\n").map((path) => path.slice("apps/app/".length)).filter((path) => testFile.test(path))

// Evaluate the real declaration in Node, outside the application's type graph.
const inspectTarget = (body: string) => JSON.parse(execFileSync("node", ["--input-type=module", "-e", `
  import { Package } from "./PACKAGE.ts"
  import { metadata } from "@smthrs/targets/Target"
  import * as Input from "@smthrs/targets/Input"
  const unit = metadata(Package.unitTests)
  ${body}
`], { cwd: app, encoding: "utf8", timeout: 120_000 }))

const bunPaths = (command: string | undefined): string[] => command?.startsWith("bun test ")
  ? command.slice("bun test ".length).split(/\s+/) : []
// The package now delegates to the target runner; read that authority once.
const unitPaths: string[] = scripts.test === "smthrs test //apps/app:unitTests"
  ? inspectTarget('console.log(JSON.stringify(unit.attrs.runner.paths))') : bunPaths(scripts.test)
const selected = (path: string, paths: readonly string[]) => paths.some((entry) => path === entry || path.startsWith(`${entry}/`))

// The real lane is a directly executable script; `test:e2e:real` only names it.
// Admit only its actual Playwright invocation, never a comment/config mention.
const invokesRealPlaywright = (source: string): boolean => {
  const parsed = ts.createSourceFile("run-real-e2e.ts", source, ts.ScriptTarget.Latest, true)
  let found = false
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "run" &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "pnpm" &&
      node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1])) {
      const args = node.arguments[1].elements
      found ||= ["exec", "playwright", "test", "--config", "playwright.real.config.ts"].every((value, index) =>
        args[index] !== undefined && ts.isStringLiteral(args[index]) && args[index].text === value)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return found
}
const realRunner = invokesRealPlaywright(read("scripts/run-real-e2e.ts"))

/*
 * The required PR browser tiers are steps of scripts/run-pr-e2e.mjs, the
 * browserE2e target CI executes. A package.json alias or a comment runs
 * nothing, so admit only the runner's literal argv arrays, matched exactly:
 * an extra argument such as --grep would narrow the tier.
 */
const ciSteps = (source: string): string[][] => {
  const parsed = ts.createSourceFile("run-pr-e2e.mjs", source, ts.ScriptTarget.Latest, true)
  const steps: string[][] = []
  const visit = (node: ts.Node) => {
    if (ts.isArrayLiteralExpression(node) && node.elements.length > 0 && node.elements.every(ts.isStringLiteral))
      steps.push(node.elements.map((element) => (element as ts.StringLiteral).text))
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return steps
}
const runsStep = (steps: readonly string[][], argv: readonly string[]): boolean =>
  steps.some((step) => step.length === argv.length && step.every((value, index) => value === argv[index]))
const prSteps = ciSteps(read("scripts/run-pr-e2e.mjs"))
const playwrightStep = ["exec", "playwright", "test"]
const siteStep = [...playwrightStep, "--config", "playwright.site.config.ts"]
const graphStep = [...playwrightStep, "--config", "playwright.graph.config.ts"]
const showcaseStep = [...playwrightStep, "--config", "playwright.showcase.config.ts"]
const matches = (path: string, patterns: string | RegExp | readonly (string | RegExp)[]): boolean =>
  (Array.isArray(patterns) ? patterns : [patterns]).some((pattern) =>
    typeof pattern === "string" ? new Bun.Glob(pattern).match(path) : pattern.test(path))
const playwrightOwns = (path: string, config: PlaywrightTestConfig): boolean =>
  (config.projects ?? [{}]).some(project =>
    selected(path, [project.testDir ?? config.testDir!]) &&
    matches(path, project.testMatch ?? config.testMatch ?? /\.(spec|test)\.[cm]?[jt]sx?$/) &&
    !matches(path, project.testIgnore ?? config.testIgnore ?? []))

// Registration names the selected wrapper, but ownership also requires its
// executable Bun test argv to reach the exact child. Module mocks need this
// process isolation; the child results are asserted by the unit wrappers.
const isolatedWrappers: Readonly<Record<string, string>> = {
  "e2e/fixtures/unit-entrypoints/AppIsland.child.test.tsx": "src/mainview/AppEntrypoints.test.ts",
  "e2e/fixtures/unit-entrypoints/AppIslandFallback.child.test.tsx": "src/mainview/AppEntrypoints.test.ts",
  "e2e/fixtures/unit-entrypoints/Main.child.test.tsx": "src/mainview/AppEntrypoints.test.ts",
  "e2e/fixtures/unit-entrypoints/Serve.child.test.ts": "src/bun/ServeEntrypoint.test.ts",
}

// Only two declared wrapper shapes are admitted: a literal child URL, or a
// relative URL drawn from literal test.each(cases) rows. No general evaluation.
const isolatedTestPaths = (text: string): string[] => {
  const source = ts.createSourceFile("wrapper.ts", text, ts.ScriptTarget.Latest, true)
  const nodes: ts.Node[] = []
  const visit = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, visit) }
  visit(source)
  const unassert = (node: ts.Expression): ts.Expression => ts.isAsExpression(node) ? unassert(node.expression) : node
  const enclosingFunction = (node: ts.Node): ts.Node | undefined => {
    for (let parent = node.parent; parent; parent = parent.parent)
      if (ts.isFunctionLike(parent)) return parent
    return undefined
  }
  const declarations = nodes.filter(ts.isVariableDeclaration)
  const tableRows = (expression: ts.Expression | undefined): ts.ArrayLiteralExpression | undefined => {
    if (!expression) return undefined
    if (ts.isIdentifier(expression)) {
      const name = expression.text
      expression = declarations.find(node => ts.isIdentifier(node.name) && node.name.text === name && !enclosingFunction(node))?.initializer
      if (!expression) return undefined
    }
    const rows = unassert(expression)
    return ts.isArrayLiteralExpression(rows) ? rows : undefined
  }
  const paths: string[] = []
  for (const call of nodes.filter(ts.isCallExpression)) {
    if (call.expression.getText(source) !== "spawnSync" || call.arguments[0]?.getText(source) !== "process.execPath") continue
    const callback = enclosingFunction(call)
    if (!callback || !ts.isArrowFunction(callback) || !ts.isCallExpression(callback.parent)) continue
    const testCall = callback.parent.expression
    if (testCall.getText(source) !== "test" &&
      !(ts.isCallExpression(testCall) && testCall.expression.getText(source) === "test.each")) continue
    if (ts.isCallExpression(testCall) && !tableRows(testCall.arguments[0])?.elements.length) continue
    const args = call.arguments[1]
    if (!args || !ts.isArrayLiteralExpression(args) || args.elements.length !== 2) continue
    const [mode, child] = args.elements
    if (!mode || !ts.isStringLiteral(mode) || mode.text !== "test" || !child || !ts.isIdentifier(child)) continue
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== child.text || !declaration.initializer) continue
      const scope = enclosingFunction(declaration)
      if (scope && scope !== enclosingFunction(call)) continue
      const initializer = declaration.initializer
      if (!ts.isCallExpression(initializer) || initializer.expression.getText(source) !== "fileURLToPath" || initializer.arguments.length !== 1) continue
      const url = initializer.arguments[0]!
      if (!ts.isNewExpression(url) || url.expression.getText(source) !== "URL" || url.arguments?.length !== 2 ||
        url.arguments[1]!.getText(source) !== "import.meta.url") continue
      const input = url.arguments[0]!
      if (ts.isStringLiteral(input)) { paths.push(input.text); continue }
      if (!ts.isIdentifier(input) || !scope || !ts.isArrowFunction(scope)) continue
      const index = scope.parameters.findIndex(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === input.text)
      const invocation = scope.parent
      if (index < 0 || !ts.isCallExpression(invocation) || !ts.isCallExpression(invocation.expression) ||
        invocation.expression.expression.getText(source) !== "test.each") continue
      const rows = tableRows(invocation.expression.arguments[0])
      if (!rows) continue
      for (const row of rows.elements) {
        if (!ts.isArrayLiteralExpression(row)) continue
        const value = row.elements[index]
        if (value && ts.isStringLiteral(value)) paths.push(value.text)
      }
    }
  }
  return paths
}
const isolatedUnitOwns = (child: string, wrapper: string, source: string): boolean =>
  selected(wrapper, unitPaths) && isolatedTestPaths(source).some(path =>
    relative(app, resolve(app, dirname(wrapper), path)).replaceAll("\\", "/") === child)

interface ExclusiveRunner {
  readonly exclusive: boolean
  readonly env: Record<string, string>
  readonly runner: { readonly name: string; readonly entry: { readonly path: string }; readonly args: readonly string[] }
}
const exclusiveRunners: ExclusiveRunner[] = inspectTarget(`console.log(JSON.stringify([
  Package.viewStories, Package.journeyJ1Activation, Package.journeyTodoFromIssue,
  Package.journeyTodoNeedsYou, Package.journeyTodoEvidence, Package.journeyTodoMerge
].map(target => metadata(target).attrs)))`)

// Read only the actual Bun.spawn argv. The J2 wrapper interpolates its one
// validated positional argument; no mention in comments or unused arrays counts.
const spawnArgv = (source: string, argument: string | undefined): string[][] => {
  const tree = ts.createSourceFile("runner.ts", source, ts.ScriptTarget.Latest, true)
  const result: string[][] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "Bun.spawn" &&
      node.arguments[0] && ts.isArrayLiteralExpression(node.arguments[0])) {
      const values = node.arguments[0].elements.map(element => {
        if (ts.isStringLiteral(element)) return element.text
        if (argument !== undefined && ts.isTemplateExpression(element) && element.templateSpans.length === 1 &&
          element.templateSpans[0]!.expression.getText(tree) === "spec")
          return element.head.text + argument + element.templateSpans[0]!.literal.text
        return undefined
      })
      if (values.every((value): value is string => value !== undefined)) result.push(values)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return result
}
const runnerEvidence = (source: string): { forwarding: boolean; journeyEnv: boolean } => {
  const tree = ts.createSourceFile("runner.ts", source, ts.ScriptTarget.Latest, true)
  let forwarding = false, journeyEnv = false
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "Bun.spawn" &&
      node.arguments[0] && ts.isArrayLiteralExpression(node.arguments[0])) {
      const args = node.arguments[0].elements
      forwarding ||= args.length === 2 && args[0]?.getText(tree) === "command" &&
        ts.isSpreadElement(args[1]!) && args[1]!.expression.getText(tree) === "commandArgs"
      const options = node.arguments[1]
      if (options && ts.isObjectLiteralExpression(options)) {
        const env = options.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(tree) === "env")
        if (env && ts.isPropertyAssignment(env) && ts.isObjectLiteralExpression(env.initializer))
          journeyEnv ||= env.initializer.properties.some(property => ts.isPropertyAssignment(property) &&
            property.name.getText(tree) === "SMITHERS_JOURNEY" && property.initializer.getText(tree) === "`${spec}.spec.ts`")
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return { forwarding, journeyEnv }
}
const exclusiveOwns = (path: string, target: ExclusiveRunner, source: string): boolean => {
  if (!target.exclusive || target.runner.name !== "entrypoint") return false
  const entry = target.runner.entry.path
  if (entry === "scripts/run-view-stories.ts") return target.env.SMITHERS_VIEW_STORIES === "1" &&
    target.env.SMITHERS_E2E_BROWSER === "chromium" && target.env.SMITHERS_VIEW_STORY_FILTER === "" &&
    target.runner.args.length === 0 && path === "e2e/playwright/view-stories.spec.ts" &&
    runsStep(spawnArgv(source, undefined), ["pnpm", "exec", "playwright", "test", "--config", "playwright.config.ts", path])
  if (entry === "scripts/run-real-e2e.ts") return target.runner.args.length === 1 &&
    target.runner.args[0] === "j1-activation.spec.ts" && target.env.SMITHERS_JOURNEY === target.runner.args[0] &&
    path === `e2e/real/${target.runner.args[0]}` && invokesRealPlaywright(source) &&
    runnerEvidence(source).forwarding
  if (entry === "scripts/run-journey-j2.ts") return target.runner.args.length === 1 &&
    path === `e2e/real/${target.runner.args[0]}.spec.ts` &&
    runsStep(spawnArgv(source, target.runner.args[0]), ["pnpm", "exec", "playwright", "test", "--config", "playwright.real.config.ts", path]) &&
    runnerEvidence(source).journeyEnv
  return false
}

const owners = (path: string): string[] => {
  const result: string[] = []
  if (selected(path, unitPaths)) result.push("unit")
  const wrapper = isolatedWrappers[path]
  if (wrapper && isolatedUnitOwns(path, wrapper, read(wrapper))) result.push("isolated unit child")
  if (selected(path, bunPaths(scripts["lint:conformance"]))) result.push("conformance lint")
  if (selected(path, bunPaths(scripts["test:e2e:auth"]))) result.push("browser OAuth")
  if (selected(path, bunPaths(scripts["test:e2e:probes"]))) result.push("probe helpers")
  if (selected(path, bunPaths(scripts["test:e2e:graph-lifecycle"]))) result.push("graph lifecycle")
  if (runsStep(prSteps, playwrightStep) && playwrightOwns(path, playwright)) result.push("Playwright")
  if (runsStep(prSteps, siteStep) && playwrightOwns(path, playwrightSite)) result.push("Playwright site")
  if (realRunner && playwrightOwns(path, playwrightReal)) result.push("Playwright real")
  if (scripts["test:e2e:local"] === "playwright test --config playwright.local.config.ts" && playwrightOwns(path, playwrightLocal)) result.push("Playwright local")
  if (scripts["test:e2e:proof"] === "playwright test --config playwright.proof.config.ts" && playwrightOwns(path, playwrightProof)) result.push("Playwright proof")
  if (runsStep(prSteps, graphStep) && playwrightOwns(path, playwrightGraph)) result.push("Playwright graph")
  if (runsStep(prSteps, showcaseStep) && playwrightOwns(path, playwrightShowcase)) result.push("Playwright showcase")
  if (exclusiveRunners.some(target => exclusiveOwns(path, target, read(target.runner.entry.path)))) result.push("exclusive Playwright")
  return result
}

test("exclusive browser ownership requires the exported target and executable selection", () => {
  const paths = ["e2e/playwright/view-stories.spec.ts", "e2e/real/j1-activation.spec.ts",
    "e2e/real/todo-from-issue.spec.ts", "e2e/real/todo-needs-you.spec.ts",
    "e2e/real/todo-evidence.spec.ts", "e2e/real/todo-merge.spec.ts"]
  expect(exclusiveRunners).toHaveLength(paths.length)
  for (const target of exclusiveRunners) {
    const source = read(target.runner.entry.path)
    const owned = paths.filter(path => exclusiveOwns(path, target, source))
    expect(owned).toHaveLength(1)
    const path = owned[0]!
    expect(owners(path)).toEqual(["exclusive Playwright"])
    expect(exclusiveOwns(path, { ...target, exclusive: false }, source)).toBe(false)
    expect(exclusiveOwns(path, target, `// ${source.replaceAll("\n", "\n// ")}`)).toBe(false)
    expect(exclusiveOwns(path, target, source.replaceAll('"playwright"', '"unused"'))).toBe(false)
    expect(exclusiveOwns(path, target, source.replaceAll('Bun.spawn(', 'unused('))).toBe(false)
    expect(exclusiveOwns("e2e/real/Unassigned.spec.ts", target, source)).toBe(false)
    if (target.runner.entry.path === "scripts/run-view-stories.ts")
      expect(exclusiveOwns(path, { ...target, env: {} }, source)).toBe(false)
    else
      expect(exclusiveOwns(path, { ...target, runner: { ...target.runner, args: ["Unassigned"] } }, source)).toBe(false)
  }
})

test("every app test belongs to an executable runner", () => {
  expect(files.length).toBeGreaterThan(100)
  expect(files.filter((path) => owners(path).length === 0)).toEqual([])
  expect(owners("e2e/native/CloudAuthFragment.test.ts")).toEqual(["browser OAuth"])
  // A Bun test that launches Chromium belongs to the tier that installs it,
  // never to the hermetic unit gate.
  expect(owners("e2e/probes/app-interactive-styles.test.ts")).toEqual(["probe helpers"])
  expect(owners("scripts/canary-browser.test.ts")).toContain("unit")
  expect(owners("scripts/headless-page.test.ts")).toContain("unit")
  // The literal pin is a lint target with its own runner, never the unit gate.
  expect(owners("lint/conformance/LiteralPin.test.ts")).toEqual(["conformance lint"])
  expect(owners("e2e/site/landing-start.spec.ts")).toEqual(["Playwright site"])
  expect(owners("e2e/real/chat-tools.spec.ts")).toEqual(["Playwright real"])
  expect(owners("e2e/real/models.spec.ts")).toEqual(["Playwright real"])
  expect(owners("e2e/local/setup-no-github.spec.ts")).toEqual(["Playwright local"])
  // The proof tier records journeys on the real bundle; no default run selects it.
  expect(owners("e2e/proof/j1.spec.ts")).toEqual(["Playwright proof"])
  expect(owners("scripts/proof-install.test.ts")).toEqual(["unit"])
  // The real tier's coverage gate is its own source, tested by Bun rather than
  // driven by Playwright, so the unit suite owns it.
  expect(owners("e2e/real/coverage/gate.test.ts")).toEqual(["unit"])
  // So is the real tier's model provider: a Bun test of the process Playwright launches.
  expect(owners("e2e/real/support/model-provider.test.ts")).toEqual(["unit"])
  expect(owners("e2e/real/auth-permissions/profile.test.ts")).toEqual(["unit"])
  expect(owners("e2e/real/Unassigned.test.ts")).toEqual([])
  expect(owners("e2e/site/Unassigned.test.ts")).toEqual([])
  expect(owners("e2e/Unassigned.spec.ts")).toEqual([])
  expect(owners("e2e/native/Unassigned.test.ts")).toEqual([])
  expect(owners("e2e/packaged/Unassigned.test.ts")).toEqual([])
  expect(owners("e2e/playwright/native/Unassigned.spec.ts")).toEqual([])
})

test("isolated child ownership follows executable selected wrappers", () => {
  for (const [child, wrapper] of Object.entries(isolatedWrappers)) {
    const source = read(wrapper)
    expect(owners(child)).toEqual(["isolated unit child"])
    expect(isolatedUnitOwns(child, "e2e/unselected.test.ts", source)).toBe(false)
    expect(isolatedUnitOwns(child, wrapper, source.replaceAll("['test', child]", "['run', child]"))).toBe(false)
    const name = child.slice(child.lastIndexOf("/") + 1)
    expect(isolatedUnitOwns(child, wrapper, source.replaceAll(name, "Unregistered.child.test.ts"))).toBe(false)
    expect(isolatedUnitOwns(child, wrapper, `// ${source.replaceAll("\n", "\n// ")}`)).toBe(false)
    expect(isolatedUnitOwns(child, wrapper, `const unused = ${JSON.stringify(name)}`)).toBe(false)
    expect(isolatedUnitOwns(child, wrapper, source.replaceAll("spawnSync(", "unused("))).toBe(false)
    expect(isolatedUnitOwns(child, wrapper, source.replaceAll("test.each(", "test.skip.each("))).toBe(false)
    expect(isolatedUnitOwns(child, wrapper, source.replaceAll("test.each(cases)", "test.each([])")
      .replace("test.each([['visible'], ['hidden']] as const)", "test.each([])"))).toBe(false)
  }
  expect(owners("e2e/fixtures/unit-entrypoints/Unregistered.child.test.ts")).toEqual([])
})

// A Bun test that boots the flow-graph host or gateway runs for minutes, binds
// a fixed port and writes a probe into the checkout: never the hermetic unit gate.
test("a test that boots a flow-graph server belongs to the graph lifecycle tier", () => {
  const bootsGraphServer = /["'`]scripts\/flow-graph-e2e-(host\.ts|gateway\.mts)["'`]/
  const booting = files.filter((path) => bootsGraphServer.test(read(path)))
  expect([...booting].sort()).toEqual(["e2e/graph/lifecycle/gateway.test.ts", "e2e/graph/lifecycle/host.test.ts"])
  for (const path of booting) expect(owners(path)).toEqual(["graph lifecycle"])
})

test("real runner ownership comes from executable argv, not prose or a different config", () => {
  expect(realRunner).toBe(true)
  expect(scripts["test:e2e:real"]).toBe("bun scripts/run-real-e2e.ts")
  expect(invokesRealPlaywright('// run("pnpm", ["exec", "playwright", "test", "--config", "playwright.real.config.ts"])')).toBe(false)
  expect(invokesRealPlaywright('run("pnpm", ["exec", "playwright", "test", "--config", "playwright.site.config.ts"])')).toBe(false)
  expect(invokesRealPlaywright('run("pnpm", ["exec", "playwright", "test", "--config", "playwright.real.config.ts", ...args])')).toBe(true)
})

test("CI browser ownership comes from the PR runner's argv, not an alias or prose", () => {
  expect(runsStep(prSteps, playwrightStep)).toBe(true)
  expect(runsStep(prSteps, siteStep)).toBe(true)
  expect(runsStep(prSteps, graphStep)).toBe(true)
  expect(runsStep(ciSteps('// ["exec", "playwright", "test", "--config", "playwright.site.config.ts"]'), siteStep)).toBe(false)
  expect(runsStep(ciSteps('const steps = [["run", "test:e2e:site"]]'), siteStep)).toBe(false)
  expect(runsStep(ciSteps('const steps = [["exec", "playwright", "test", "--config", "playwright.site.config.ts", "--grep", "x"]]'), siteStep)).toBe(false)
  expect(runsStep(ciSteps('const steps = [["exec", "playwright", "test", "--config", "playwright.site.config.ts"]]'), siteStep)).toBe(true)
})

test("the target unit gate matches package discovery and CI executes the browser OAuth, probe and graph lifecycle lanes", () => {
  const paths = inspectTarget('console.log(JSON.stringify(unit.attrs.runner.paths))')
  expect(paths).toEqual(unitPaths)
  expect(paths).toContain("scripts")
  expect(scripts["test:e2e:auth"]).toBe("bun test e2e/native/CloudAuthFragment.test.ts")
  expect(scripts["test:e2e:probes"]).toBe("bun test e2e/probes")
  expect(read("scripts/run-pr-e2e.mjs")).toContain('["run", "test:e2e:auth"]')
  expect(read("scripts/run-pr-e2e.mjs")).toContain('["run", "test:e2e:probes"]')
  expect(scripts["test:e2e:graph-lifecycle"]).toBe("bun test e2e/graph/lifecycle")
  expect(read("scripts/run-pr-e2e.mjs")).toContain('["run", "test:e2e:graph-lifecycle"]')
  expect(inspectTarget('console.log(JSON.stringify(metadata(Package.browserE2e).attrs.runner.entry.path))'))
    .toBe("scripts/run-pr-e2e.mjs")
}, 240_000)

test("the conformance lint gate matches package discovery", () => {
  expect(inspectTarget('console.log(JSON.stringify(metadata(Package.conformance).attrs.runner.paths))'))
    .toEqual(bunPaths(scripts["lint:conformance"]))
}, 240_000)

test("unit inputs include inspected sources, harnesses and configs", () => {
  const inputs: string[] = inspectTarget(`
    const paths = []
    const seen = new Set()
    const collect = async (target) => {
      if (seen.has(target)) return
      seen.add(target)
      for (const input of target.inputs) {
        if (input._tag === "Glob") paths.push(...await Input.expandGlob(${JSON.stringify(root)}, target.attrs.cwd, input))
        else if (input._tag === "File") paths.push(Input.resolvePath(target.attrs.cwd, input.path))
      }
      for (const dependency of target.dependencies) await collect(metadata(dependency))
    }
    await collect(unit)
    console.log(JSON.stringify(paths))
  `)
  for (const path of [
    "scripts/canary-browser.ts", "scripts/run-pr-e2e.mjs", "scripts/run-real-e2e.ts", "scripts/README.md",
    "PACKAGE.ts", "package.json", "tsconfig.json", "vite.config.ts", "playwright.config.ts", "playwright.site.config.ts", "playwright.real.config.ts",
    "postcss.config.js", "tailwind.config.js"
  ]) expect(inputs).toContain(`apps/app/${path}`)
  for (const path of ["package.json", "pnpm-lock.yaml", "packages/rpc/src/Cards.ts", "packages/rpc/fixtures/force/graph.json",
    "packages/smithers/ui/src/cn.ts", "packages/smithers/gateway/src/GatewayProjection.ts"])
    expect(inputs).toContain(path)
}, 240_000)

test("a script-only edit changes the unit gate's digested inputs", () => {
  // A disposable workspace uses the real target inputs and planner digest, not a
  // second hand-maintained approximation of the cache key. Never mutate this checkout.
  const result = inspectTarget(`
    import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
    import { tmpdir } from "node:os"
    import { join } from "node:path"
    const workspace = await mkdtemp(join(tmpdir(), "ui-unit-inputs-"))
    try {
      await mkdir(join(workspace, "apps/app/scripts"), { recursive: true })
      const script = join(workspace, "apps/app/scripts/canary-browser.ts")
      await writeFile(script, "export const revision = 1")
      const digest = async () => {
        const paths = []
        for (const input of unit.inputs) {
          if (input._tag === "Glob") paths.push(...await Input.expandGlob(workspace, "apps/app", input))
          else if (input._tag === "File") paths.push(input.path.startsWith("//") ? input.path.slice(2) : "apps/app/" + input.path)
        }
        return Input.digestFiles(workspace, paths, { concurrency: 1 })
      }
      const before = await digest()
      await writeFile(script, "export const revision = 2")
      console.log(JSON.stringify({ before, after: await digest() }))
    } finally { await rm(workspace, { recursive: true, force: true }) }
  `)
  expect(result.before).not.toEqual(result.after)
}, 240_000)

test("the documented checklist entry point writes dry-run reports from either directory", () => {
  const output = mkdtempSync(join(tmpdir(), "ui-checklist-entry-"))
  try {
    for (const [directory, name] of [[root, "root"], [app, "app"]] as const) {
      const out = join(output, name)
      execFileSync("pnpm", ["run", "checklist", "--", "--dry-run", "--out", out], {
        cwd: directory, encoding: "utf8", timeout: 60_000
      })
      const report = JSON.parse(readFileSync(join(out, "launch-checklist-report.json"), "utf8"))
      expect(report.rows.length).toBeGreaterThan(0)
      expect(report.rows.every((row: { status: string }) => row.status === "skipped-dry-run")).toBe(true)
      expect(readFileSync(join(out, "launch-checklist-report.md"), "utf8")).toContain("A-1")
    }
  } finally { rmSync(output, { recursive: true, force: true }) }
}, 240_000)

test("the runbook distinguishes failed, prerequisite-skipped and probe-undecided exit codes", () => {
  const runbook = read("scripts/README.md")
  expect(runbook).toMatch(/\| `0` \|[^\n]*prerequisite/)
  expect(runbook).toMatch(/\| `1` \|[^\n]*fail/)
  expect(runbook).toMatch(/\| `2` \|[^\n]*probe-undecided/)
  expect(runbook).toContain("skipped-dry-run")
})
