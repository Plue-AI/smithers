import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"
import * as ts from "typescript"
import { CRITICAL_PATHS, DOORS, REAL_HOSTS } from "./types"
import type { CoverageGap, RealE2EEvidenceFile, RealHost, RealScenarioRunEvidence } from "./types"
import type { Deferral } from "./deferrals"

export interface GateFinding {
  readonly severity: "error" | "review"
  readonly code: string
  readonly file: string
  readonly line: number
  readonly message: string
}

export interface ScenarioDeclaration {
  readonly id: string
  readonly file: string
  readonly line: number
  readonly capabilities: readonly string[]
  readonly coverage: readonly string[]
  readonly actions: readonly string[]
  readonly hosts: readonly RealHost[]
  readonly paths: readonly string[]
  readonly doors: readonly string[]
  readonly dimensions: readonly string[]
  readonly completionEvidence: readonly string[]
}

export interface GateReport {
  readonly ok: boolean
  readonly generatedAt: string
  readonly declaredActions: readonly string[]
  readonly scenarios: readonly ScenarioDeclaration[]
  readonly runs: readonly RealScenarioRunEvidence[]
  readonly gaps: readonly CoverageGap[]
  /** Unscenarioed actions the reviewed ledger accounts for; never counted as coverage. */
  readonly deferred: readonly { readonly action: string; readonly reason: Deferral }[]
  readonly findings: readonly GateFinding[]
}

const SPEC = /\.spec\.[cm]?[jt]sx?$/
const SOURCE = /\.[cm]?[jt]sx?$/
const RESERVED_DYNAMIC_ACTION = "repository-flow:*"
const COVERAGE_TOKEN = /^(?:action|host|path|door|dimension|surface|evidence):\S+$/

const validTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) return false
  const date = new Date(`${match[1]}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1]
}

const sourceFile = (file: string): ts.SourceFile => ts.createSourceFile(
  file,
  readFileSync(file, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
)

const lineOf = (source: ts.SourceFile, node: ts.Node): number =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

const strings = (node: ts.Expression | undefined): readonly string[] | undefined => {
  if (!node || !ts.isArrayLiteralExpression(node)) return undefined
  const values: string[] = []
  for (const item of node.elements) {
    if (!ts.isStringLiteralLike(item)) return undefined
    values.push(item.text)
  }
  return values
}

const objectProperty = (node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
  const property = node.properties.find((candidate) =>
    ts.isPropertyAssignment(candidate) &&
    ((ts.isIdentifier(candidate.name) && candidate.name.text === name) ||
      (ts.isStringLiteralLike(candidate.name) && candidate.name.text === name)))
  return property && ts.isPropertyAssignment(property) ? property.initializer : undefined
}

const literal = (node: ts.Expression | undefined): string | undefined =>
  node && ts.isStringLiteralLike(node) ? node.text : undefined

export const declaredFlowNames = (flowNameFile: string): readonly string[] => {
  const source = sourceFile(flowNameFile)
  let result: readonly string[] | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "FLOW_NAMES") {
      let initializer = node.initializer
      if (initializer && ts.isAsExpression(initializer)) initializer = initializer.expression
      result = strings(initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!result?.length) throw new Error(`Could not read FLOW_NAMES from ${flowNameFile}`)
  return [...new Set([...result, ...generatedSearchFlowNames(flowNameFile)])].sort()
}

/** Search factories are built-in actions even though FlowName.ts widens them at runtime. */
const generatedSearchFlowNames = (flowNameFile: string): readonly string[] => {
  const file = join(dirname(flowNameFile), "entries", "search.ts")
  if (!existsSync(file)) return []
  const source = sourceFile(file)
  let declaration: ts.VariableDeclaration | undefined
  const find = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "searchFlows") declaration = node
    ts.forEachChild(node, find)
  }
  find(source)
  const initializer = declaration?.initializer
  const body = initializer && ts.isArrowFunction(initializer) ? initializer.body : undefined
  // Feature gating may filter a literal registry. Inventory all declared names;
  // availability still belongs to the live host's capability evidence.
  const returned = body && ts.isCallExpression(body) && ts.isPropertyAccessExpression(body.expression)
    && body.expression.name.text === "filter" ? body.expression.expression : body
  if (!returned || !ts.isArrayLiteralExpression(returned)) {
    throw new Error(`Cannot inventory generated search actions from ${file}; searchFlows must expose its returned declarations`)
  }
  const names: string[] = []
  for (const item of returned.elements) {
    if (!ts.isCallExpression(item) || !ts.isIdentifier(item.expression) || item.expression.text !== "search") continue
    const name = literal(item.arguments[1])
    if (!name || !/^search\.[a-z][a-z-]*$/.test(name)) throw new Error(`Generated search action in ${file} requires an explicit built-in name`)
    names.push(name)
  }
  if (!names.length) throw new Error(`No generated search actions inventoried from ${file}; review the registry factory before accepting coverage`)
  return names
}

const resolveImport = (from: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined
  const base = resolve(dirname(from), specifier)
  const candidates = extname(base)
    ? [base]
    : [base + ".ts", base + ".tsx", base + ".mts", base + ".cts", join(base, "index.ts"), join(base, "index.tsx")]
  return candidates.find(existsSync)
}

/** Files whose executable code can affect a real spec. Type-only imports are excluded. */
export const executableImportClosure = (specs: readonly string[], boundary: string): readonly string[] => {
  const root = resolve(boundary)
  const pending = specs.map((file) => resolve(file))
  const seen = new Set<string>()
  while (pending.length) {
    const file = pending.pop()!
    const outside = relative(root, file).startsWith("..") || resolve(file) === root
    if (seen.has(file) || outside || !SOURCE.test(file)) continue
    seen.add(file)
    const source = sourceFile(file)
    const visit = (node: ts.Node): void => {
      const staticSpecifier = ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : undefined
      const callSpecifier = ts.isCallExpression(node) &&
        ((node.expression.kind === ts.SyntaxKind.ImportKeyword) || (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : undefined
      const imported = resolveImport(file, staticSpecifier ?? callSpecifier ?? "")
      if (imported) pending.push(imported)
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return [...seen].sort()
}

const callPath = (node: ts.Expression): string => {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return `${callPath(node.expression)}.${node.name.text}`
  return ""
}

const fixtureBindings = new WeakMap<ts.SourceFile, ReadonlySet<string>>()
const testBindings = (source: ts.SourceFile): ReadonlySet<string> => {
  const cached = fixtureBindings.get(source)
  if (cached) return cached
  const names = new Set(["test", "it"])
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        const original = (binding.propertyName ?? binding.name).text
        if (!binding.isTypeOnly && (original === "test" || original === "it" || original.endsWith("Test"))) names.add(binding.name.text)
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) names.add(`${bindings.name.text}.test`)
  }
  // Follow fixture aliases and extend chains, including variants declared
  // inside describe blocks. Their spelling cannot disable admission checks.
  let changed = true
  while (changed) {
    changed = false
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const initializer = node.initializer
        const base = ts.isCallExpression(initializer) && ts.isPropertyAccessExpression(initializer.expression) && initializer.expression.name.text === "extend"
          ? callPath(initializer.expression.expression) : callPath(initializer)
        if (names.has(base) && !names.has(node.name.text)) { names.add(node.name.text); changed = true }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  fixtureBindings.set(source, names)
  return names
}

const canonicalCallPath = (expression: ts.Expression, source: ts.SourceFile): string => {
  const path = callPath(expression)
  for (const name of testBindings(source)) {
    if (path === name || path.startsWith(`${name}.`)) return `test${path.slice(name.length)}`
  }
  return path
}

const forbiddenCalls = new Map<string, string>([
  ["test.skip", "skipped real scenario"], ["test.fixme", "disabled real scenario"],
  ["test.fail", "expected-failure real scenario"], ["test.only", "focused real scenario"],
  ["test.describe.skip", "skipped real scenarios"], ["test.describe.fixme", "disabled real scenarios"],
  ["test.describe.only", "focused real scenarios"],
  ["describe.skip", "skipped real scenario"], ["it.skip", "skipped real scenario"],
  ["vi.mock", "module mock"], ["jest.mock", "module mock"], ["mock.module", "module mock"]
])
const forbiddenMemberCalls = new Map<string, string>([
  ["route", "network interception"], ["unroute", "network interception"],
  ["routeFromHAR", "captured network fixture"], ["routeWebSocket", "websocket interception"]
])

const forbiddenEnv = new Set(["SMITHERS_CHAT_STUB", "SMITHERS_E2E_CAPTURED_TARGETS", "SMITHERS_OFFLINE"])
const refusal = /(?:sign in|not authorized|permission denied|unavailable|unsupported|refus(?:e|al)|could not|can't|cannot)/i

const enclosingTest = (node: ts.Node): ts.CallExpression | undefined => {
  let current: ts.Node | undefined = node
  while (current) {
    if (ts.isCallExpression(current) && ["test", "test.only"].includes(canonicalCallPath(current.expression, current.getSourceFile()))) return current
    current = current.parent
  }
  return undefined
}

const scenarioPathFor = (node: ts.Node): readonly string[] => {
  const details = enclosingTest(node)?.arguments[1]
  if (details && ts.isCallExpression(details) && callPath(details.expression) === "scenario" && details.arguments[1] && ts.isObjectLiteralExpression(details.arguments[1])) {
    return (strings(objectProperty(details.arguments[1], "coverage")) ?? []).filter((token) => token.startsWith("path:")).map((token) => token.slice(5))
  }
  return []
}

/** Only literal text can be refusal copy; identifiers such as `refused.error.message` are not. */
const literalText = (node: ts.Node): string => {
  if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => `${literalText(span.expression)} ${span.literal.text}`)].join(" ")
  const parts: string[] = []
  ts.forEachChild(node, (child) => { parts.push(literalText(child)) })
  return parts.join(" ")
}

/** expect(subject).matcher(...) as [subject, matcher, argument], or undefined. */
const expectation = (node: ts.CallExpression): readonly [ts.Expression, string, ts.Expression | undefined] | undefined => {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined
  const call = node.expression.expression
  if (!ts.isCallExpression(call) || callPath(call.expression) !== "expect" || !call.arguments[0]) return undefined
  return [call.arguments[0], node.expression.name.text, node.arguments[0]]
}

/**
 * A refusal only proves an error/permission boundary when a later top-level
 * statement of the same test shows the boundary held: an observed side-effect
 * list stayed empty, or the real service answered with a 4xx status. Nested
 * helpers and branches do not count because they may never run.
 */
const boundaryHeldAfter = (node: ts.Node): boolean => {
  const test = enclosingTest(node)
  const body = test?.arguments[test.arguments.length - 1]
  if (!body || !(ts.isArrowFunction(body) || ts.isFunctionExpression(body)) || !ts.isBlock(body.body)) return false
  return body.body.statements.some((statement) => {
    if (!ts.isExpressionStatement(statement) || statement.getStart() < node.getEnd()) return false
    const call = ts.isAwaitExpression(statement.expression) ? statement.expression.expression : statement.expression
    const expected = ts.isCallExpression(call) ? expectation(call) : undefined
    if (!expected) return false
    const [subject, matcher, argument] = expected
    if (!argument) return false
    if (matcher === "toEqual") return ts.isArrayLiteralExpression(argument) && argument.elements.length === 0
    if (matcher === "toHaveLength") return ts.isNumericLiteral(argument) && argument.text === "0"
    return matcher === "toBe" && ts.isNumericLiteral(argument) && /^4\d\d$/.test(argument.text) &&
      ts.isCallExpression(subject) && ts.isPropertyAccessExpression(subject.expression) && subject.expression.name.text === "status"
  })
}

const scanFile = (file: string): readonly GateFinding[] => {
  const source = sourceFile(file)
  const serverNames = new Set(["startLocalServer"])
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      if ((binding.propertyName ?? binding.name).text === "startLocalServer") serverNames.add(binding.name.text)
    }
  }
  const findings: GateFinding[] = []
  const add = (severity: GateFinding["severity"], code: string, node: ts.Node, message: string): void => {
    findings.push({ severity, code, file, line: lineOf(source, node), message })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const path = callPath(node.expression)
      if (serverNames.has(path) || path.endsWith(".startLocalServer")) {
        const options = node.arguments[0]
        if (!options || !ts.isObjectLiteralExpression(options) || options.properties.some(ts.isSpreadAssignment)) {
          add("error", "unverified-real-host", node, "Real host options must be explicit so the gate can verify that no built-in service stubs are enabled")
        } else {
          const chat = objectProperty(options, "chatStub")
          if (chat && chat.kind !== ts.SyntaxKind.FalseKeyword) add("error", "forbidden-double", chat, "A real host must explicitly disable chatStub when supplied")
          if (literal(objectProperty(options, "cloudMode")) !== "hybrid") add("error", "forbidden-double", options, "A real host requires cloudMode: hybrid; the server default disables real upstreams")
          for (const name of ["identityUpstream", "cloudApi"]) {
            const upstream = objectProperty(options, name)
            if (upstream?.kind === ts.SyntaxKind.NullKeyword) add("error", "forbidden-double", upstream, `${name}: null selects a built-in service stub`)
          }
        }
      }
      const canonical = canonicalCallPath(node.expression, source)
      const reason = forbiddenCalls.get(canonical) ?? (/^test\.describe\.(?:parallel|serial)\.(?:only|skip|fixme)$/.test(canonical)
        ? "focused or disabled real scenarios" : undefined)
      if (reason) add("error", "forbidden-double", node, `${path} is ${reason}; real E2E code must use the real boundary`)
      if (ts.isPropertyAccessExpression(node.expression)) {
        const memberReason = forbiddenMemberCalls.get(node.expression.name.text)
        if (memberReason) add("error", "forbidden-double", node, `${node.expression.name.text} is ${memberReason}; aliases cannot bypass the real boundary`)
      }
      if (/^(?:expect\([^)]*\)\.)?(?:toBeTruthy|toBeDefined)$/.test(path)) {
        add("review", "ambiguous-assertion", node, `${path} is not completion evidence on its own; reviewer must verify a later state assertion`)
      }
      if (/\.(?:toContainText|toHaveText|toMatch)$/.test(path)) {
        const text = node.arguments.map((arg) => arg.getText(source)).join(" ")
        if (/\/\\s\+\/|\/\.\+\/|not\.toHaveText\(["']{2}/.test(`${path}(${text})`)) {
          add("error", "nonempty-is-not-success", node, "A nonempty-text assertion cannot establish required completion")
        }
        if (refusal.test(node.arguments.map(literalText).join(" "))) {
          const paths = scenarioPathFor(node)
          if (paths.includes("success")) add("error", "refusal-is-not-success", node, "A refusal/failure message cannot satisfy a successful scenario")
          else if (!(paths.includes("error") || paths.includes("permission")) || !boundaryHeldAfter(node)) add("review", "refusal-is-not-success", node, "Refusal assertion is valid only when this error/permission scenario later proves the boundary held: an empty side-effect list or a 4xx service status")
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      callPath(node.expression.expression) === "process" && node.expression.name.text === "env" && forbiddenEnv.has(node.name.text)) {
      add("error", "stub-environment", node, `${node.name.text} enables a fake/offline product seam`)
    }
    if (ts.isStringLiteralLike(node) && /(?:fake|stub|mock)[-_]?(?:api|token|credential|endpoint)/i.test(node.text)) {
      add("error", "fake-value", node, "Fake API, token, credential, or endpoint literal in executable real-suite code")
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

const parseScenario = (file: string, source: ts.SourceFile, node: ts.ObjectLiteralExpression): ScenarioDeclaration | undefined => {
  const real = objectProperty(node, "realScenario")
  if (!real || !ts.isObjectLiteralExpression(real)) return undefined
  const id = literal(objectProperty(real, "id"))
  const capabilities = strings(objectProperty(real, "capabilities"))
  const coverage = strings(objectProperty(real, "coverage"))
  if (!id || !capabilities || !coverage) return {
    id: "<invalid>", file, line: lineOf(source, real), capabilities: capabilities ?? [], coverage: coverage ?? [],
    actions: [], hosts: [], paths: [], doors: [], dimensions: [], completionEvidence: []
  }
  const values = (prefix: string): string[] => coverage.filter((token) => token.startsWith(prefix)).map((token) => token.slice(prefix.length))
  return {
    id, file, line: lineOf(source, real), capabilities, coverage,
    actions: values("action:"), hosts: values("host:") as RealHost[], paths: values("path:"),
    doors: values("door:"), dimensions: values("dimension:"), completionEvidence: values("evidence:")
  }
}

const declaration = (
  file: string,
  source: ts.SourceFile,
  node: ts.Node,
  id: string | undefined,
  capabilities: readonly string[] | undefined,
  coverage: readonly string[] | undefined
): ScenarioDeclaration => {
  const actualCoverage = coverage ?? []
  const values = (prefix: string): string[] => actualCoverage.filter((token) => token.startsWith(prefix)).map((token) => token.slice(prefix.length))
  return {
    id: id !== undefined && capabilities !== undefined && coverage !== undefined ? id : "<invalid>", file, line: lineOf(source, node), capabilities: capabilities ?? [], coverage: actualCoverage,
    actions: values("action:"), hosts: values("host:") as RealHost[], paths: values("path:"),
    doors: values("door:"), dimensions: values("dimension:"), completionEvidence: values("evidence:")
  }
}

const parseScenarioCall = (file: string, source: ts.SourceFile, node: ts.CallExpression): ScenarioDeclaration | undefined => {
  if (callPath(node.expression) !== "scenario") return undefined
  const metadata = node.arguments[1]
  if (!metadata || !ts.isObjectLiteralExpression(metadata)) return declaration(file, source, node, literal(node.arguments[0]), undefined, undefined)
  return declaration(
    file,
    source,
    node,
    literal(node.arguments[0]),
    strings(objectProperty(metadata, "capabilities")),
    strings(objectProperty(metadata, "coverage"))
  )
}

export const scenarioDeclarations = (specs: readonly string[]): readonly ScenarioDeclaration[] => {
  const scenarios: ScenarioDeclaration[] = []
  for (const file of specs) {
    const source = sourceFile(file)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const direct = parseScenarioCall(file, source, node)
        if (direct) scenarios.push(direct)
      }
      if (ts.isCallExpression(node) && canonicalCallPath(node.expression, source) === "test.use" && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const scenario = parseScenario(file, source, node.arguments[0])
        if (scenario) scenarios.push(scenario)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return scenarios
}

const missingPerTestMetadata = (specs: readonly string[]): readonly GateFinding[] => specs.flatMap((file) => {
  const source = sourceFile(file)
  const findings: GateFinding[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ["test", "test.only"].includes(canonicalCallPath(node.expression, source))) {
      const details = node.arguments[1]
      if (!details || !ts.isCallExpression(details) || callPath(details.expression) !== "scenario") {
        findings.push({ severity: "error", code: "missing-per-test-scenario", file, line: lineOf(source, node), message: "Every real test requires scenario(id, metadata) as its Playwright details argument" })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
})

const walkSpecs = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name)
  return entry.isDirectory() ? walkSpecs(path) : SPEC.test(entry.name) ? [path] : []
})

/** Process/worker entry points need not be imported by their launcher. Scan all
 * owned suite helpers too; the coverage tool's own parser fixtures are excluded. */
const walkHelpers = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name)
  if (entry.isDirectory()) return entry.name === "coverage" || entry.name === "node_modules" ? [] : walkHelpers(path)
  return SOURCE.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : []
})

export interface GateOptions {
  readonly realDir: string
  /** Specs owned by exclusive targets, outside this run's obligation catalog. */
  readonly excludedSpecs?: readonly string[]
  readonly flowNameFile: string
  readonly resultsFile?: string
  readonly now?: string
  readonly requireComplete?: boolean
  readonly expectedRevision?: string
  readonly expectedHost?: RealHost
  /** The reviewed ledger of actions with no real scenario (deferrals.ts). */
  readonly deferred?: Readonly<Partial<Record<Deferral, readonly string[]>>>
  /** Actions only a real scenario can account for. */
  readonly releaseCritical?: readonly string[]
}

export const checkRealE2E = ({ realDir, excludedSpecs = [], flowNameFile, resultsFile, now, requireComplete = false, expectedRevision, expectedHost, deferred: ledger = {}, releaseCritical = [] }: GateOptions): GateReport => {
  const specs = walkSpecs(realDir).filter((file) => !file.includes(`${join("coverage", "fixtures")}`) && !excludedSpecs.includes(file))
  const actions = declaredFlowNames(flowNameFile)
  const scenarios = scenarioDeclarations(specs)
  const files = executableImportClosure([...specs, ...walkHelpers(realDir)], resolve(realDir, "../.."))
  const findings = [...files.flatMap(scanFile), ...missingPerTestMetadata(specs)]
  const ids = new Set<string>()
  for (const scenario of scenarios) {
    const add = (code: string, message: string): void => {
      findings.push({ severity: "error", code, file: scenario.file, line: scenario.line, message })
    }
    if (scenario.id === "<invalid>" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(scenario.id)) add("invalid-scenario", "realScenario requires a stable lowercase id and literal arrays")
    if (ids.has(scenario.id)) add("duplicate-scenario", `Duplicate scenario id ${scenario.id}`)
    ids.add(scenario.id)
    if (scenario.capabilities.some((capability) => capability.trim() === "")) add("missing-capability", "Capability entries must name actual bootstrap capabilities; browser-only scenarios may explicitly declare []")
    if (scenario.coverage.some((token) => !COVERAGE_TOKEN.test(token))) add("invalid-coverage-token", "Coverage tokens require a known prefix and nonempty value")
    if (!scenario.actions.length) add("missing-action", "Scenario must name at least one action token")
    if (!scenario.hosts.length || scenario.hosts.some((host) => !(REAL_HOSTS as readonly string[]).includes(host))) add("missing-host", "Scenario must name host:local, host:production, or host:native")
    if (!scenario.paths.length || scenario.paths.some((path) => !(CRITICAL_PATHS as readonly string[]).includes(path))) add("missing-path", "Scenario must name a valid critical path")
    if (!scenario.doors.length || scenario.doors.some((door) => !(DOORS as readonly string[]).includes(door))) add("missing-door", "Scenario must name the exercised door")
    if (scenario.paths.includes("keyboard") && !scenario.dimensions.includes("keyboard")) add("keyboard-dimension", "Keyboard path requires dimension:keyboard")
    if (scenario.paths.includes("success") && !scenario.completionEvidence.length) add("missing-completion-evidence", "Success requires explicit independent completion evidence")
    for (const action of scenario.actions) if (action !== RESERVED_DYNAMIC_ACTION && !actions.includes(action)) add("unknown-action", `Unknown static action ${action}`)
  }
  if (specs.length > 0 && scenarios.length === 0) findings.push({ severity: "error", code: "no-scenarios", file: realDir, line: 1, message: "Real specs exist but declare no realScenario metadata" })

  let runs: RealScenarioRunEvidence[] = []
  if (resultsFile) {
    if (!existsSync(resultsFile)) findings.push({ severity: "error", code: "missing-run-evidence", file: resultsFile, line: 1, message: "Requested executed evidence file does not exist" })
    else {
      try {
        const evidence = JSON.parse(readFileSync(resultsFile, "utf8")) as Partial<RealE2EEvidenceFile>
        if (!Array.isArray(evidence.runs) || !Array.isArray(evidence.reporterErrors) || typeof evidence.suiteStatus !== "string") {
          findings.push({ severity: "error", code: "malformed-run-evidence", file: resultsFile, line: 1, message: "Evidence requires suiteStatus, reporterErrors, and runs" })
        } else {
          runs = evidence.runs
          if (evidence.suiteStatus !== "passed") findings.push({ severity: "error", code: "suite-did-not-pass", file: resultsFile, line: 1, message: `Playwright suite status was ${evidence.suiteStatus}` })
          for (const message of evidence.reporterErrors) findings.push({ severity: "error", code: "reporter-evidence-error", file: resultsFile, line: 1, message })
          for (const run of runs) if (!run.scenarioId || !run.host || !run.status || !/^[0-9a-f]{40,64}$/.test(run.revision) || !validTimestamp(run.startedAt) || !validTimestamp(run.finishedAt) || Date.parse(run.finishedAt) < Date.parse(run.startedAt)) {
            findings.push({ severity: "error", code: "malformed-run", file: resultsFile, line: 1, message: "Every run requires scenario, verified host, explicit status, exact revision, and timestamps" })
          }
          for (const run of runs) {
            if (run.status !== "passed") findings.push({ severity: "error", code: "unsuccessful-attempt", file: resultsFile, line: 1, message: `${run.scenarioId} on ${run.host} had a ${run.status} attempt; a passing retry does not establish reliable coverage` })
            const declaration = scenarios.find((scenario) => scenario.id === run.scenarioId)
            if (!declaration) findings.push({ severity: "error", code: "undeclared-run", file: resultsFile, line: 1, message: `Run ${run.scenarioId} does not match a declared scenario` })
            else if (!declaration.hosts.includes(run.host)) findings.push({ severity: "error", code: "undeclared-run-host", file: resultsFile, line: 1, message: `Run ${run.scenarioId} claims undeclared host ${run.host}` })
            if (!(REAL_HOSTS as readonly string[]).includes(run.host) || !["passed", "failed", "timedOut", "skipped", "interrupted"].includes(run.status)) findings.push({ severity: "error", code: "malformed-run", file: resultsFile, line: 1, message: `Invalid host or verdict for ${run.scenarioId}` })
            if (run.host === "production" && (!run.buildSha || !/^[0-9a-f]{40,64}$/.test(run.buildSha))) findings.push({ severity: "error", code: "missing-production-build", file: resultsFile, line: 1, message: `Production run ${run.scenarioId} requires its deployed build SHA` })
          }
          if (expectedRevision && runs.some((run) => run.revision !== expectedRevision)) findings.push({ severity: "error", code: "unexpected-revision", file: resultsFile, line: 1, message: `Evidence does not exclusively match expected revision ${expectedRevision}` })
          if (expectedHost && runs.some((run) => run.host !== expectedHost)) findings.push({ severity: "error", code: "unexpected-host", file: resultsFile, line: 1, message: `Evidence does not exclusively match expected host ${expectedHost}` })
        }
      } catch (error) {
        findings.push({ severity: "error", code: "malformed-run-evidence", file: resultsFile, line: 1, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  const gaps: CoverageGap[] = []
  const coveredActions = new Set(scenarios.flatMap((scenario) => scenario.actions))
  const deferrals = new Map<string, Deferral>()
  const ledgerFinding = (code: string, message: string): void => { findings.push({ severity: "error", code, file: flowNameFile, line: 1, message }) }
  for (const [reason, entries] of Object.entries(ledger) as [Deferral, readonly string[]][]) for (const action of entries) {
    if (deferrals.has(action)) ledgerFinding("duplicate-deferral", `${action} is deferred more than once`)
    else deferrals.set(action, reason)
  }
  for (const action of deferrals.keys()) {
    if (!actions.includes(action)) ledgerFinding("stale-deferral", `${action} is deferred but is not a built-in action`)
    else if (coveredActions.has(action)) ledgerFinding("stale-deferral", `${action} has a real scenario; delete its deferral`)
    if (releaseCritical.includes(action)) ledgerFinding("critical-action-deferred", `${action} is release-critical; only a real scenario can account for it`)
  }
  const deferred: GateReport["deferred"][number][] = []
  for (const action of actions) {
    if (coveredActions.has(action)) continue
    const reason = deferrals.get(action)
    if (reason !== undefined) { deferred.push({ action, reason }); continue }
    gaps.push({ kind: "action", value: action })
    findings.push({ severity: "error", code: "unscenarioed-action", file: realDir, line: 1, message: `${action} has no real scenario and no reviewed deferral` })
  }
  for (const path of CRITICAL_PATHS) if (!scenarios.some((scenario) => scenario.paths.includes(path))) gaps.push({ kind: "critical-path", value: path })
  // A host-specific receipt proves only that host. Aggregate reports (no expectedHost)
  // must still account for every declared host and all three host dimensions.
  const requiredHosts = expectedHost ? [expectedHost] : REAL_HOSTS
  for (const host of requiredHosts) if (!scenarios.some((scenario) => scenario.hosts.includes(host))) gaps.push({ kind: "host", value: host })
  for (const door of DOORS) if (!scenarios.some((scenario) => scenario.doors.includes(door))) gaps.push({ kind: "door", value: door })
  for (const scenario of scenarios) for (const host of scenario.hosts) {
    if (expectedHost && host !== expectedHost) continue
    const attempts = runs.filter((run) => run.scenarioId === scenario.id && run.host === host && (!expectedRevision || run.revision === expectedRevision) && (!expectedHost || run.host === expectedHost))
    if (attempts.length === 0 || attempts.some((run) => run.status !== "passed")) gaps.push({ kind: "execution", value: host, scenarioId: scenario.id })
  }
  if (requireComplete && gaps.length) findings.push({ severity: "error", code: "incomplete-coverage", file: realDir, line: 1, message: `${gaps.length} declared/action/dimension/execution gaps remain` })
  return { ok: !findings.some((finding) => finding.severity === "error"), generatedAt: now ?? new Date().toISOString(), declaredActions: actions, scenarios, runs, gaps, deferred, findings }
}

export const formatGateReport = (report: GateReport, root: string): string => {
  const errors = report.findings.filter((finding) => finding.severity === "error")
  const reviews = report.findings.filter((finding) => finding.severity === "review")
  const lines = [
    `real E2E quality gate: ${report.ok ? "PASS" : "FAIL"}`,
    `${report.declaredActions.length} built-in actions; ${report.deferred.length} deferred; ${report.scenarios.length} scenarios; ${report.runs.filter((run) => run.status === "passed").length} passed attempts; ${report.runs.filter((run) => run.status !== "passed").length} unsuccessful attempts; ${report.gaps.length} visible gaps`,
    `${errors.length} errors; ${reviews.length} manual-review findings`
  ]
  for (const finding of report.findings) lines.push(`${finding.severity.toUpperCase()} ${finding.code} ${relative(root, finding.file)}:${finding.line} ${finding.message}`)
  return lines.join("\n")
}
