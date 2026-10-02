/*
 * The literal pin.
 *
 * A test suite asserts against the application with string literals, and a
 * string literal is invisible to the compiler. On 2026-08-15 a `command`→`flow`
 * rename orphaned nineteen literals in `scripts/worker-e2e.ts` and seventeen
 * `data-command` selectors across four browser scripts. Everything still
 * compiled, every suite still passed, and for three days the suite proved
 * nothing: nine `card.kind === "workflow-run"` comparisons could no longer be
 * true, and a stub emitting a tool call for `workflow.create` disarmed the very
 * substitution guard that section existed to prove.
 *
 * A one-off sweep fixes that Tuesday. This test fixes the class: it derives the
 * vocabularies from the application, extracts the literals from the suites, and
 * fails by name when one no longer resolves.
 *
 * It lives under `lint/conformance/` and runs in the conformance gate.
 */
import { describe, expect, test } from "bun:test"
import { relative } from "node:path"
import { RUN_LAUNCH_COMMANDS } from "../../src/mainview/state/RunClaims"
import { fixtureRepositoryName } from "../../e2e/real/support/values"
import {
  dataAttributesIn,
  DOTTED_IDENTIFIER,
  extractLiterals,
  FILE_NAME,
  literalsUnder,
  nearest,
  sourceFiles
} from "./Literals"
import { type Violation, violationsOf, type Vocabularies } from "./Rules"
import {
  assertsAgainstTheApp,
  cardIdPrefixes,
  cardKinds,
  cardObjectFields,
  composedDottedHeads,
  declaredFlowNames,
  E2E,
  emittedDataAttributes,
  idVocabularySegments,
  manifestFlowNames,
  productDottedIdentifiers,
  productSourceFiles,
  productStringLiterals,
  SCRIPTS,
  stampedDataAttributes,
  UI_APP,
  UI_SRC
} from "./Vocabulary"

/*
 * The trees under test: standalone runners and checklist probes in
 * `scripts/`, and browser, graph, real and packaged suites in `e2e/`.
 */
const TREES = [SCRIPTS, E2E] as const

const shortPath = (file: string): string => relative(UI_APP, file)

/** An allowlist entry: a literal, the file it sits in, and why it does not resolve. */
interface Excuse {
  readonly literal: string
  /** Path relative to `apps/app`. */
  readonly file: string
  readonly reason: string
}

/*
 * Literals that legitimately name nothing in the application.
 *
 * Every entry is a literal the app never owned: a CSS selector, a file or
 * bundle name, an id a test double invents for itself, a member of a different
 * union, or a value the assertion exists to prove is absent. An entry with no
 * reason fails, and an entry that stops matching a real literal fails, so the
 * list cannot outlive what it excuses.
 */
const RESOLVES_ELSEWHERE: ReadonlyArray<Excuse> = [
  {
    literal: "chat",
    file: "e2e/playwright/reaction-owner.spec.ts",
    reason: "The issue DTO's kind (packages/rpc/src/Cards.ts `kind: z.enum([\"issue\", \"chat\"])`), not a card kind: the wire issue shares id, title and body with a card frame."
  },
  {
    literal: "owner-session",
    file: "scripts/run-mode-matrix.ts",
    reason: "Mode-matrix credential kind, declared by the matrix fixture contract, not a card kind."
  },
  {
    literal: "browser-profile",
    file: "scripts/run-mode-matrix.ts",
    reason: "Mode-matrix credential kind, declared by the matrix fixture contract, not a card kind."
  },
  {
    literal: "flows.harness.step-fact.v1",
    file: "e2e/real/run-inspection/module-evidence.ts",
    reason: "The module checkpoint envelope is declared by packages/smithers/flows/journal/src/StepFact.ts, outside the app vocabulary."
  },
  {
    literal: "flows.harness.step-fact.v1",
    file: "e2e/real/run-inspection/revisions.ts",
    reason: "The capability attachment counts the native checkpoint envelope declared by packages/smithers/flows/journal/src/StepFact.ts."
  },
  {
    literal: "flows.harness.step-fact.v1",
    file: "e2e/real/coverage/timeline-semantic.test.ts",
    reason: "The oracle tests the journal package's native module checkpoint wire format, outside the app vocabulary."
  },
  {
    literal: "flows.harness.call-fact.v1",
    file: "e2e/real/run-inspection/semantic.ts",
    reason: "The native call envelope is declared in the packages/smithers harness and gateway, outside the app vocabulary; the independent oracle reads that wire format."
  },
  {
    literal: "flows.harness.call-fact.v1",
    file: "e2e/real/coverage/timeline-semantic.test.ts",
    reason: "Native gateway call facts exercise the harness wire format outside the app vocabulary, including cursor positions before duplicate telemetry."
  },
  {
    literal: "smthrs-flow-graph-",
    file: "e2e/graph/lifecycle/gateway.test.ts",
    reason: "the scratch directory `BridgedEngineRun` mkdtemps its two SQLite files into, which this suite counts under its own TMPDIR and asserts removed when the host stops; a directory prefix, never a card id"
  },
  {
    literal: "main.home",
    file: "e2e/site/landing-start.spec.ts",
    reason: "CSS selector for the Astro landing's main.home in apps/site/src/pages/index.astro, outside the app vocabulary; the browser assertion requires the element to be visible"
  },
  {
    literal: "data-arrived",
    file: "e2e/site/landing-tagline.spec.ts",
    reason: "the attribute the Astro landing's script sets (headline.dataset.arrived in apps/site/src/pages/index.astro) when the tagline arrives through the view transition; set by the site, not rendered by the app"
  },
  {
    literal: "stub-call-",
    file: "e2e/support/ChatStub.ts",
    reason: "the call_id the chat stub invents for its own tool_call frame; the app keys the card by its record id (`toolcall-`), never by call_id"
  },
  {
    literal: "demo.v2",
    file: "e2e/playwright/cloudFixture.spec.ts",
    reason: "test repository basename containing a dot; the fixture preserves its full identity"
  },
  {
    literal: "section.smithers-card",
    file: "e2e/playwright/control-focus.spec.ts",
    reason: "tag and class composed by the geometry probe from the real card element, not a flow id"
  },
  {
    literal: "storage-test-",
    file: "e2e/playwright/storage-refusal.spec.ts",
    reason: "test-owned request IDs on the shipped SQLite worker protocol, not application card IDs"
  },
  {
    literal: "smithers-mvp-quarantine.private-test",
    file: "e2e/playwright/storage-refusal.spec.ts",
    reason: "an intentionally invented historical quarantine key; recovery must enumerate unknown original keys, not only a current vocabulary"
  },
  {
    literal: "flow.ghost",
    file: "scripts/launch-checklist/Probes.test.ts",
    reason: "a flow name this unit test invents to exercise the unnamed-affordance rule, never sent to the app"
  },
  {
    literal: "promotional",
    file: "scripts/launch-checklist/Rows.ts",
    reason: "the billing grant kind the checklist reads back from its own /api/billing audit row; it is an upstream grant kind, never a card kind"
  },
  {
    literal: "navigation-storage-",
    file: "e2e/real/navigation-frames/storage.ts",
    reason: "test-owned request IDs on the shipped SQLite worker protocol; the worker echoes them for request correlation and they are never card IDs"
  }
]

/*
 * Literals that ARE orphans, deferred rather than excused.
 *
 * These are open defects of the same class this pin exists to catch, found by
 * running it. They are listed here so the pin can guard everything else in
 * those files instead of staying red, and each carries an inverted assertion
 * below: the moment the product emits the attribute (or the probe stops asking
 * for it), the entry stops matching and this suite fails until it is deleted.
 */
const KNOWN_ORPHANS: ReadonlyArray<Excuse> = []

const ALLOWLIST: ReadonlyArray<Excuse> = [...RESOLVES_ELSEWHERE, ...KNOWN_ORPHANS]

const excuses = (violation: Violation, list: ReadonlyArray<Excuse>): ReadonlyArray<Excuse> =>
  list.filter((entry) => entry.literal === violation.value && entry.file === shortPath(violation.file))

const manifest = await manifestFlowNames()
const vocabularies: Vocabularies = {
  flowNames: declaredFlowNames(),
  cardKinds: cardKinds(),
  cardIdPrefixes: cardIdPrefixes(),
  dataAttributes: new Set([...emittedDataAttributes(), ...stampedDataAttributes(TREES)]),
  dottedIdentifiers: productDottedIdentifiers(),
  composedDottedHeads: composedDottedHeads(),
  productStringLiterals: productStringLiterals(),
  cardObjectFields: cardObjectFields(),
  idVocabularySegments: idVocabularySegments()
}
// These files parse test topology, select scenarios, or test those parsers.
// Their identifiers and credential/driver kinds belong to the harness schema.
// Scenario bodies and browser helpers remain scanned for app vocabulary.
const sourceParserFiles = new Set([
  "e2e/real/coverage/gate.ts", "e2e/real/coverage/gate.test.ts",
  "e2e/real/coverage/matrix.ts", "e2e/real/coverage/matrix.test.ts",
  "e2e/real/coverage/selection.test.ts"
])
/*
 * The fixture graph's own node addresses are not app vocabulary.
 *
 * `e2e/graph/workspace.ts` writes down the eleven ids the engine derives from
 * the fixture flow's structure, so the Chromium tier can read them back off
 * the drawn graph rather than recompute them from the builder the app reads
 * them through. They are dotted, they are data, and no product source spells
 * one — which is the rule's whole premise, so the rule cannot judge them. Only
 * `dotted-identifier` is lifted here: a flow id, a card kind or a `data-*`
 * selector in that file still rots the same way every other suite's does.
 */
const engineDerivedIds = new Set(["e2e/graph/workspace.ts"])
const literals = literalsUnder(TREES).filter(literal => !sourceParserFiles.has(shortPath(literal.file)))
const violations = literals
  .flatMap((literal) => [...violationsOf(literal, vocabularies)])
  .filter((violation) =>
    violation.rule !== "dotted-identifier" || !engineDerivedIds.has(shortPath(violation.file))
  )

describe("the vocabularies are derived from the app and are never empty", () => {
  /*
   * A conformance pin whose derivation returns nothing passes vacuously: with
   * no vocabulary, no literal can be orphaned. That is this lane's own version
   * of the defect it exists to close, so every derived set carries a floor.
   * The idiom and the numbers follow registry.test.ts's "every registered flow
   * leads its own name's listing", which walks the real catalog through the
   * controller behind `expect(listed.length).toBeGreaterThan(40)`.
   */
  test("the product source corpus is the whole app", () => {
    // 325 files today, the app's own source and the shared wire model, with
    // every test and fixture dropped. A corpus that collapses below half the
    // app is a broken path, not a smaller app.
    expect(productSourceFiles().length).toBeGreaterThan(60)
  })

  test("the discovery excludes the app's own test files", () => {
    /*
     * The authority answers "does the app still spell this name", so a file
     * that only asserts against the app cannot be part of it. Leaving the
     * unit tests in kept a retired name alive for as long as one stale test
     * mentioned it, which is the rename this pin exists to catch. The second
     * expectation is the floor under the first: the tests are really there
     * to exclude, so a corpus with none of them is an exclusion and not a
     * broken path.
     */
    expect(productSourceFiles().filter((file) => assertsAgainstTheApp(file))).toEqual([])
    expect(sourceFiles(UI_SRC).filter((file) => assertsAgainstTheApp(file)).length).toBeGreaterThan(100)
  })

  test("every card kind the wire model declares is derived", () => {
    // 28 today, one per shipped card; the union has never been below the
    // ten waves' worth of cards that shipped by Wave 10.
    expect(vocabularies.cardKinds.size).toBeGreaterThan(20)
    // Derived from the schema, so this is a spot check on the derivation
    // itself rather than a second hand-written list.
    expect(vocabularies.cardKinds.has("run-trace")).toBe(true)
    expect(vocabularies.cardKinds.has("flow-run")).toBe(false)
    expect(vocabularies.cardKinds.has("workflow-run")).toBe(false)
  })

  test("the flow declarations and the rendered manifest agree", () => {
    // 88 declared (base plus the admin plugin), 70 in a non-admin session's
    // manifest. registry.test.ts already refuses a catalog below 40.
    expect(vocabularies.flowNames.size).toBeGreaterThan(60)
    expect(manifest.size).toBeGreaterThan(40)
    // The manifest is what App.tsx renders into data-flows. A name that
    // reaches the shell but is declared nowhere would make the DOM and the
    // declarations disagree, and every selector pinned to the declarations
    // would then be checkable against the wrong set.
    expect([...manifest].filter((name) => !vocabularies.flowNames.has(name))).toEqual([])
  })

  test("the run-launch claim names registered flows", () => {
    // The 2026-08-15 rename's worst single casualty: a stub emitted a tool
    // call for `workflow.create` while RunClaims listed `flow.create`, so
    // nothing was ever claimed and the substitution guard never armed. A
    // launch name that is not a flow can claim nothing.
    expect(RUN_LAUNCH_COMMANDS.length).toBeGreaterThan(0)
    expect(RUN_LAUNCH_COMMANDS.filter((name) => !vocabularies.flowNames.has(name))).toEqual([])
  })

  test("the DOM attribute contract is derived from what the app renders", () => {
    // 77 today across the app's components and @smthrs/ui. The app's own
    // .tsx files alone carry 17.
    expect(vocabularies.dataAttributes.size).toBeGreaterThan(30)
    expect(vocabularies.dataAttributes.has("data-flow")).toBe(true)
    expect(vocabularies.dataAttributes.has("data-flows")).toBe(true)
    // PressActions writes this through toggleAttribute, including key release.
    expect(vocabularies.dataAttributes.has("data-pressed")).toBe(true)
    expect(vocabularies.dataAttributes.has("data-command")).toBe(false)
  })

  test("the card id prefixes and dotted identifiers are derived", () => {
    // 186 prefixes and 477 dotted identifiers today.
    expect(vocabularies.cardIdPrefixes.size).toBeGreaterThan(10)
    expect(vocabularies.cardIdPrefixes.has("flow-run-")).toBe(true)
    expect(vocabularies.dottedIdentifiers.size).toBeGreaterThan(100)
    expect(vocabularies.dottedIdentifiers.has("flow.create")).toBe(true)
    expect(vocabularies.dottedIdentifiers.has("workflow.create")).toBe(false)
  })
})

describe("the extraction reaches every tree and every rule fires", () => {
  /*
   * The second half of the vacuity guard. Derived vocabularies with nothing to
   * check against them pass just as emptily, so each rule's input population
   * carries its own floor: a rule that silently stops matching anything is a
   * rule that has stopped working.
   */
  test("every tree is scanned", () => {
    // 57 files today: the runners and doubles, the harness and its suites,
    // and the checklist. Other lanes add files, so the count drifts up; the
    // floors below are what a broken path or a lost tree trips.
    for (const tree of TREES) expect(sourceFiles(tree).length).toBeGreaterThan(5)
    expect(TREES.flatMap((tree) => [...sourceFiles(tree)]).length).toBeGreaterThan(30)
    // 2198 literals today (the web e2e suites and the wrangler doubles left
    // with the local-app cut; the Playwright specs and the checklist remain).
    expect(literals.length).toBeGreaterThan(1000)
  })

  const population = (predicate: (literal: (typeof literals)[number]) => number): number =>
    literals.reduce((total, literal) => total + predicate(literal), 0)

  test("each rule has literals to check", () => {
    // Today (local-app cut): 68 dotted identifiers. Each floor is roughly
    // half of what the trees carry, so ordinary churn does not trip it but a
    // rule that stops matching does.
    expect(
      population((literal) =>
        literal.form === "string" && DOTTED_IDENTIFIER.test(literal.value) && !FILE_NAME.test(literal.value) ? 1 : 0
      )
    ).toBeGreaterThan(30)
    expect(population((literal) => dataAttributesIn(literal.value).length)).toBeGreaterThan(30)
    /*
     * The card-kind comparisons, the [data-kind]/[data-flow] selector values
     * and the id prefixes were carried by the web e2e suites, which left with
     * the local-app cut (LOCAL-APP.md). The rules stay armed; their floors
     * return with the M1/M2 Playwright specs that assert cards and tabs.
     */
  })

})

describe("every literal the suites assert against still resolves", () => {
  test("no orphaned literal outside the allowlist", () => {
    const unexcused = violations.filter((violation) => excuses(violation, ALLOWLIST).length === 0)
    const report = unexcused.map((violation) =>
      `${shortPath(violation.file)}:${violation.line}  [${violation.rule}] ${violation.message}`
    )
    // Printing every orphan at once is the point: a rename orphans a family
    // of literals, and fixing them one failure per run is how the sweep gets
    // abandoned halfway.
    expect(report).toEqual([])
  })

  test("every allowlist entry carries a reason", () => {
    const reasonless = ALLOWLIST.filter((entry) => entry.reason.trim().length < 20)
    expect(reasonless.map((entry) => `${entry.file}: ${entry.literal}`)).toEqual([])
  })

  test("no literal is excused twice", () => {
    /*
     * One (literal, file) pair, one entry. A second entry for the same pair is
     * a spare licence: the staleness test above is satisfied by whichever of
     * the two still matches, so the extra one can never expire and the next
     * literal to land on that name inherits it in silence. A merge put a
     * second `smthrs-flow-graph-` entry on this list and nothing failed.
     */
    const seen = new Map<string, number>()
    for (const entry of ALLOWLIST) {
      const pair = `${entry.file}: ${entry.literal}`
      seen.set(pair, (seen.get(pair) ?? 0) + 1)
    }
    expect([...seen].filter(([, count]) => count > 1).map(([pair]) => pair)).toEqual([])
  })

  test("no allowlist entry outlives the literal it excuses", () => {
    const stale = ALLOWLIST.filter((entry) =>
      !violations.some((violation) => violation.value === entry.literal && shortPath(violation.file) === entry.file)
    )
    // A stale entry is a licence nobody is using — and the next literal to
    // land on that name inherits it silently.
    expect(stale.map((entry) => `${entry.file}: ${entry.literal}`)).toEqual([])
  })

  test("every deferred orphan is still an orphan", () => {
    // The inverted assertion, copied from packages/smithers/flows'
    // vitestCoverageIsolation deferral sets: the day the product emits the
    // attribute, this entry stops matching and the test above fails until
    // the entry is deleted. A deferral that cannot expire is a permanent
    // exception wearing a temporary label.
    for (const entry of KNOWN_ORPHANS) {
      const matched = violations.filter((violation) =>
        violation.value === entry.literal && shortPath(violation.file) === entry.file
      )
      expect(matched.length, `${entry.file}: ${entry.literal} is fixed — delete its KNOWN_ORPHANS entry`)
        .toBeGreaterThan(0)
    }
  })

  test("the allowlist stays small enough to read", () => {
    // Past a couple of dozen the pin has the wrong shape and the right
    // answer is to narrow a rule, not to add another line here.
    expect(ALLOWLIST.length).toBeLessThanOrEqual(24)
  })
})

test("composed form test ids require both live prefixes and a registered flow", () => {
  const literal = extractLiterals("/fixture/form.spec.ts", 'page.getByTestId("card-form-issue.add-flow")')[0]!
  expect(violationsOf(literal, vocabularies)).toEqual([])
  for (const prefix of ["card-", "form-"]) {
    const cardIdPrefixes = new Set([...vocabularies.cardIdPrefixes].filter(value => value !== prefix))
    expect(violationsOf(literal, { ...vocabularies, cardIdPrefixes }).map(violation => violation.rule))
      .toEqual(["dotted-identifier"])
  }
  const flowNames = new Set([...vocabularies.flowNames].filter(value => value !== "issue.add-flow"))
  expect(violationsOf(literal, { ...vocabularies, flowNames }).map(violation => violation.rule))
    .toEqual(["dotted-identifier"])
  for (const source of [
    'page.getByTestId("card-form-issue.retired-flow")',
    'page.getByTestId("invented-form-issue.add-flow")',
    'controller.runCommand("card-form-issue.add-flow")',
    'page.locator("main.retired-class")'
  ]) {
    expect(extractLiterals("/fixture/form.spec.ts", source).flatMap(value => [...violationsOf(value, vocabularies)]).length)
      .toBeGreaterThan(0)
  }
})

test("real scenario IDs do not excuse product assertions", () => {
  const check = (source: string) => extractLiterals("/app/e2e/real/probe.spec.ts", source)
    .flatMap(literal => [...violationsOf(literal, vocabularies)])
  const imports = 'import { scenario as evidence } from "./coverage/types";'
  expect(check(imports + 'evidence("workflow.create", { coverage: [] });')).toEqual([])
  for (const statement of [
    'runCommand("workflow.create")',
    'page.locator("[data-flow=\\\"workflow.create\\\"]")',
    'value.startsWith("flow-fixture-")',
    'other({name: `flow-fixture-${nonce}`})',
    'scenario("workflow.create", {})'
  ]) expect(check(imports + statement).length).toBeGreaterThan(0)
  expect(check('import { scenario } from "./unrelated"; scenario("workflow.create", {})').length).toBeGreaterThan(0)
  expect(check('import { scenario } from "./coverage/types"; scenario("case", { flow: "workflow.create" })').length).toBeGreaterThan(0)
  expect(check(imports + 'function nested(evidence) { evidence("workflow.create", {}) }').length).toBeGreaterThan(0)
  expect(check(imports + 'function nested() { function evidence() {} evidence("workflow.create", {}) }').length).toBeGreaterThan(0)
  expect(check(imports + 'try {} catch(evidence) { evidence("workflow.create", {}) }').length).toBeGreaterThan(0)
})

test("fixture value provenance is import-bound and cannot hide nested or aliased product claims", () => {
  const check = (source: string) => extractLiterals("/app/e2e/real/probe.spec.ts", source)
    .flatMap(literal => [...violationsOf(literal, vocabularies)])
  const imports = 'import { fixtureCommentBody as comment, fixtureRepositoryName as repository, fixtureAttachmentName as attachment } from "./support/values"; import { attachProductionJson as evidence } from "./repositories-github/production";'
  expect(check(imports + [
    'const body = comment(`practice-comment-${nonce}`); textbox.fill(body); expect(card).toContainText(body);',
    'const name = repository(`smithers-e2e-import-pr-${nonce}`);',
    'const uniqueRepositoryName = () => repository(`smithers-e2e-import-s12-${nonce}`);',
    'evidence(testInfo, attachment(`owned-workflow-run-cleanup-${runId}`), { runId });'
  ].join("\n"))).toEqual([])
  for (const source of [
    'const body = comment(`workflow-run-${nonce}`); const alias = body; page.getByTestId(alias);',
    'const body = comment("workflow.create"); runCommand(body);',
    'runCommand(comment("workflow.create"));',
    'page.getByTestId(repository(`workflow-run-${nonce}`));',
    'card.id.startsWith(comment("workflow-run-"));',
    'page.locator(attachment("[data-flow=\\\"workflow.create\\\"]"));',
    'const body = comment("[data-kind=\\\"workflow-run\\\"]");',
    'const body = comment("[data-command]");',
    'const frame = { id: "x", kind: comment("workflow-run"), title: "x", status: "active" };',
    'function nested(comment) { const value = comment(`workflow-run-${nonce}`) }',
    'function nested() { function comment() {} const value = comment(`workflow-run-${nonce}`) }',
    'try {} catch (comment) { const value = comment(`workflow-run-${nonce}`) }',
    'other(testInfo, attachment(`workflow-run-${nonce}`), {});',
    'evidence(testInfo, attachment(`workflow-run-${nonce}`), { kind: "workflow-run", id: "x", title: "x", status: "active" });'
  ]) expect(check(imports + source).length, source).toBeGreaterThan(0)
  expect(check('import { fixtureCommentBody as comment } from "./unrelated"; const body = comment(`workflow-run-${nonce}`);').length).toBeGreaterThan(0)
  expect(fixtureRepositoryName("smithers-e2e-import-s12-abc-123")).toBe("smithers-e2e-import-s12-abc-123")
  for (const name of ["canary-sandbox", "../smithers-e2e-import-x", "smithers-e2e-import-"]) {
    expect(() => fixtureRepositoryName(name)).toThrow("owned cleanup namespace")
  }
})

test("fixture workflow input and protocol IDs preserve explicit product checks", () => {
  const check = (source: string) => extractLiterals("/app/e2e/real/probe.spec.ts", source)
    .flatMap(literal => [...violationsOf(literal, vocabularies)])
  const imports = 'import { fixtureInputText as input, fixtureProtocolId as protocol } from "./support/values";'
  expect(check(imports + 'const text = input(`s15-input-${nonce}`); field.fill(text); const response = { sessionId: protocol(`session-${id}`) };')).toEqual([])
  for (const statement of [
    'const id = protocol(`missing-card-${nonce}`); const alias = id; page.getByTestId(alias);',
    'const name = input("workflow.create"); runCommand(name);',
    'runCommand(input("workflow.create"));',
    'page.locator(protocol("[data-kind=\\\"workflow-run\\\"]"));',
    'const card = { kind: input("workflow-run"), id: "x", title: "x", status: "active" };',
    'function nested(input) { const text = input(`missing-card-${nonce}`) }',
    'function nested() { function protocol() {} const id = protocol(`missing-card-${nonce}`) }',
    'try {} catch (protocol) { const id = protocol(`missing-card-${nonce}`) }'
  ]) expect(check(imports + statement).length, statement).toBeGreaterThan(0)
  const inputClaim = 'const text = input(`missing-card-${nonce}`);'
  expect(check('import { fixtureInputText as input } from "./support/values";' + inputClaim)).toEqual([])
  expect(check('import { fixtureInputText as input } from "./unrelated";' + inputClaim).map(violation => violation.rule))
    .toContain("card-id-prefix")
})

test("fixture input provenance follows a local factory's selected return field", () => {
  const check = (source: string) => extractLiterals("/app/e2e/real/probe.spec.ts", source)
    .flatMap(literal => [...violationsOf(literal, vocabularies)])
  const imports = 'import { fixtureInputText as input } from "./support/values";'
  expect(check(imports + [
    'const make = async (text, serverId) => { await submit(text); const id = await accepted(serverId); return { text, id }; };',
    'const text = input(`missing-card-${nonce}`); const row = await make(text, observedId);',
    'page.getByTestId(row.id);'
  ].join("\n"))).toEqual([])
  for (const factory of [
    'const make = (text) => ({ id: text });',
    'const make = async (text) => { const alias = text; return { id: alias }; };',
    'const make = (text) => { const id = decorate(text); return { id }; };',
    'const make = (text) => ({ text, id: text });',
    'const make = (text) => { runCommand(text); return { id: observedId }; };',
    'const make = (text) => { if (flag) return { id: text }; return { id: observedId }; };',
    'const make = (text) => ({ id: observedId, ...text });',
    'const make = (text) => external(text);',
    'import { make } from "./external";'
  ]) {
    const source = imports + factory + 'const text = input(`missing-card-${nonce}`); const row = await make(text); page.getByTestId(row.id);'
    expect(check(source).length, factory).toBeGreaterThan(0)
  }
  expect(check(imports + 'const make = (text) => ({ id: text }); const text = input(`missing-card-${nonce}`); const a = make(observedId); const b = make(text); page.getByTestId(a.id); page.getByTestId(b.id);').length).toBeGreaterThan(0)
  expect(check(imports + 'const text = input(`missing-card-${nonce}`); const row = { id: text }; page.getByTestId(row.id);').length).toBeGreaterThan(0)
  expect(check(imports + 'const text = input(`missing-card-${nonce}`); page.getByTestId(decorate(text));').length).toBeGreaterThan(0)
  expect(check(imports + 'const make = () => { const text = input(`missing-card-${nonce}`); return { id: text }; }; const row = make(); page.getByTestId(row.id);').length).toBeGreaterThan(0)
})

test("canonical card prefixes preserve opaque API repository suffix provenance", () => {
  const check = (source: string, file = "/app/e2e/real/probe.spec.ts") => extractLiterals(file, source)
    .flatMap(literal => [...violationsOf(literal, vocabularies)])
  const imports = 'import { fixtureProtocolId as protocol } from "./support/values";'
  const repository = 'const name = protocol(`smithers-e2e-secrets-${nonce}`);'
  expect(vocabularies.cardIdPrefixes.has("card-")).toBe(true)
  expect(vocabularies.cardIdPrefixes.has("secrets-")).toBe(true)
  for (const lookup of [
    'page.getByTestId(`card-secrets-${name}`);',
    'const repo = `${username}/${name}`; page.getByTestId(`card-secrets-${repo}`);',
    'const alias = name; const id = `card-secrets-${alias}`; page.getByTestId(id);',
    'function select(repo) { page.getByTestId(`card-secrets-${repo}`); } select(name);',
    'const make = (repo) => ({ id: `card-secrets-${repo}` }); const row = make(name); page.getByTestId(row.id);'
  ]) expect(check(imports + repository + lookup), lookup).toEqual([])
  expect(check('import { fixtureProtocolId as protocol } from "../support/values";' + repository +
    'page.getByTestId(`card-secrets-${name}`);', "/app/e2e/real/nested/probe.spec.ts")).toEqual([])
})

test("opaque suffix provenance requires every composed prefix to be emitted by product source", () => {
  const source = 'import { fixtureProtocolId as protocol } from "./support/values";' +
    'const name = protocol(`smithers-e2e-secrets-${nonce}`); page.getByTestId(`card-secrets-${name}`);'
  const check = (text: string, vocabulary = vocabularies) => extractLiterals("/app/e2e/real/probe.spec.ts", text)
    .flatMap(literal => [...violationsOf(literal, vocabulary)])
  for (const head of ["card-missing-", "canary-probe-", "card-secrets-extra-"]) {
    expect(check(source.replace("card-secrets-${name}", head + "${name}"))
      .some(violation => violation.value === "smithers-e2e-secrets-" && violation.rule === "card-id-prefix"), head).toBe(true)
  }
  for (const removed of ["card-", "secrets-"]) {
    const prefixes = new Set(vocabularies.cardIdPrefixes)
    prefixes.delete(removed)
    expect(check(source, { ...vocabularies, cardIdPrefixes: prefixes })
      .some(violation => violation.value === "smithers-e2e-secrets-")).toBe(true)
  }
  expect(check(source + 'page.getByTestId(`canary-probe-${name}`);')
    .some(violation => violation.value === "smithers-e2e-secrets-")).toBe(true)
})

test("direct and mixed product uses cannot inherit a composed suffix exemption", () => {
  const imports = 'import { fixtureProtocolId as protocol } from "./support/values";'
  const repository = 'const name = protocol(`smithers-e2e-secrets-${nonce}`);'
  const composed = 'page.getByTestId(`card-secrets-${name}`);'
  for (const direct of [
    'page.getByTestId(name);',
    'const alias = name; page.getByTestId(alias);',
    'runCommand(name);',
    'row.id.startsWith(name);',
    'row.id.endsWith(name);',
    'page.locator(name);'
  ]) for (const uses of [direct, composed + direct, direct + composed]) {
    const violations = extractLiterals("/app/e2e/real/probe.spec.ts", imports + repository + uses)
      .flatMap(literal => [...violationsOf(literal, vocabularies)])
    expect(violations.some(violation => violation.value === "smithers-e2e-secrets-"), uses).toBe(true)
  }
  const unbackedImport = imports.replace("./support/values", "./unrelated")
  expect(extractLiterals("/app/e2e/real/probe.spec.ts", unbackedImport + repository + composed)
    .flatMap(literal => [...violationsOf(literal, vocabularies)]).length).toBeGreaterThan(0)
})

test("extracts rendered selectors from JSX attributes and nested components", () => {
  const source = [
    'const controls = <section data-testid="agent-session-header">',
    '  <p>session {sessionId} · {repo}</p>{live ? (<div><Button data-testid={`agent-session-stop-${sessionId}`}>Stop</Button></div>) : null}{running ? (<Button data-testid={`flow-run-stop-${runId}`}>Stop</Button>) : null}',
    '</section>'
  ].join("\n")
  const selectors = new Set(["agent-session-header", "agent-session-stop-", "flow-run-stop-"])
  expect(extractLiterals("/fixture/controls.tsx", source)
    .filter(literal => selectors.has(literal.value))
    .map(({ value, form, line }) => ({ value, form, line }))).toEqual([
    { value: "agent-session-header", form: "string", line: 1 },
    { value: "agent-session-stop-", form: "template-head", line: 2 },
    { value: "flow-run-stop-", form: "template-head", line: 2 }
  ])
})

test("keeps TypeScript generic arrows parseable in .ts files", () => {
  const source = 'const identity = <T>(value: T): T => value; const id = identity(`flow-run-stop-${runId}`);'
  expect(extractLiterals("/fixture/identity.ts", source)
    .map(({ value, form }) => ({ value, form }))).toContainEqual({ value: "flow-run-stop-", form: "template-head" })
})

test("only a positive same-receiver delta guard removes a non-card kind claim", () => {
  const check = (source: string) => extractLiterals("/fixture/frames.ts", source)
    .flatMap(literal => [...violationsOf(literal, vocabularies)])
  expect(check('frames.filter(frame => frame.type === "delta" && frame.kind === "text")')).toEqual([])
  for (const source of [
    'frame.type !== "delta" && frame.kind === "text"',
    'frame.type === "delta" || frame.kind === "text"',
    'other.type === "delta" && frame.kind === "text"',
    'frame.kind === "text"'
  ]) expect(check(source).map(value => value.rule)).toContain("card-kind")
})

describe("the pin catches the 2026-08-15 rename it was built for", () => {
  /*
   * The regression fixture. A guard that cannot demonstrate catching the
   * defect it was built for is decoration, so the four literal classes that
   * survived that rename are fed back through the extractor verbatim.
   */
  const FIXTURE = [
    `import { fail } from "./harness";`,
    `const toolCall = { name: "workflow.create", arguments: "{}" };`,
    `controller.runCommand("workflow.create");`,
    `if (card.kind !== "workflow-run") fail("no run card");`,
    `const runCardId = \`workflow-run-\${runId}\`;`,
    `await page.evaluate(\`document.querySelector('[data-command="flow.run"]')\`);`,
    ""
  ].join("\n")

  const fixtureViolations = extractLiterals("/fixture/worker-e2e.ts", FIXTURE)
    .flatMap((literal) => [...violationsOf(literal, vocabularies)])

  test("all four dead literal classes are reported", () => {
    const reported = fixtureViolations.map((violation) => `${violation.rule}:${violation.value}`)
    expect(reported).toContain("dotted-identifier:workflow.create")
    expect(reported).toContain("flow:workflow.create")
    expect(reported).toContain("card-kind:workflow-run")
    expect(reported).toContain("card-id-prefix:workflow-run-")
    expect(reported).toContain("data-attribute:data-command")
  })

  test("each failure names the surviving member", () => {
    const messages = fixtureViolations.map((violation) => violation.message)
    expect(messages.some((message) => message.includes(`"workflow.create"`) && message.includes(`"flow.create"`)))
      .toBe(true)
    // The run card is `run-trace` now (factory spec 06), which shares no tail with `workflow-run`,
    // so the dead kind is reported with no lead rather than a stranger; `flow-run` is retired too.
    expect(messages.some((message) => message.includes(`"workflow-run"`) && !message.includes(`"flow-run"`))).toBe(true)
    expect(messages.some((message) => message.includes(`"run-trace"`))).toBe(false)
    // The flow-run form's prefix is now a closer lead (three edits versus four).
    expect(messages.some((message) => message.includes(`"workflow-run-"`) && message.includes(`"form-flow-run-"`))).toBe(
      true
    )
    // `data-command` → `data-flow` shares no tail, so the pin names the dead
    // attribute and says what is wrong with it rather than guessing.
    const attribute = messages.find((message) => message.includes(`"data-command"`))
    expect(attribute).toContain("is on no element this app renders")
    expect(attribute).not.toContain("Did you mean")
  })

  test("the surviving literals in the same shapes are clean", () => {
    const CLEAN = [
      `controller.runCommand("flow.create");`,
      `if (card.kind !== "run-trace") fail("no run card");`,
      `const runCardId = \`flow-run-\${runId}\`;`,
      `await page.evaluate(\`document.querySelector('[data-flow="flow.run"]')\`);`,
      ""
    ].join("\n")
    const clean = extractLiterals("/fixture/clean.ts", CLEAN)
      .flatMap((literal) => [...violationsOf(literal, vocabularies)])
    expect(clean).toEqual([])
  })

  test("a literal that only appears in a comment is not an assertion", () => {
    // The extractor parses with the TypeScript parser rather than grepping,
    // so prose about the old name does not read as a claim that it exists.
    const COMMENTED = [
      `// The old name was "workflow.create" and the old kind was "workflow-run".`,
      `/* [data-command="flow.run"] was the selector before the rename. */`,
      `const ok = true;`,
      ""
    ].join("\n")
    const commented = extractLiterals("/fixture/commented.ts", COMMENTED)
      .flatMap((literal) => [...violationsOf(literal, vocabularies)])
    expect(commented).toEqual([])
  })
})

describe("a card kind is checked wherever it appears, not only in the two easy positions", () => {
  /*
   * The hole the first cut of this pin left open, and the reason it is the
   * defect the pin exists to catch one level up: card kinds were checked only
   * inside `[data-kind="…"]` selectors and direct `.kind ===` comparisons.
   * Every other way a suite names a kind — and passing it as an argument is
   * the common one — sailed through. A suite calling `cardOfKind(client,
   * "workflow-run")` after the rename asks for a card that cannot exist,
   * finds nothing, and reports the absence as a pass.
   *
   * Each fixture below is one such position, in the shape the suites really
   * use, with a dead kind in it.
   */
  const reportOf = (name: string, source: string): ReadonlyArray<string> =>
    extractLiterals(`/fixture/${name}.ts`, source)
      .flatMap((literal) => [...violationsOf(literal, vocabularies)])
      .map((violation) => `${violation.rule}:${violation.value}`)

  test("a dead kind passed as a function argument is reported", () => {
    // connectors.e2e.ts's own helper, verbatim in shape: the parameter is
    // compared against `card.kind`, so every literal handed to that
    // parameter is a card-kind claim.
    const FIXTURE = [
      `const cardOfKind = <K extends string>(client: Client, kind: K) =>`,
      `\tclient.cards().find((card) => card.kind === kind);`,
      `const dead = cardOfKind(client, "workflow-run");`,
      ""
    ].join("\n")
    expect(reportOf("argument", FIXTURE)).toContain("card-kind:workflow-run")
  })

  test("a dead kind interpolated into a selector helper is reported", () => {
    // cards-approvals.e2e.ts builds its CDP expression this way. The static
    // text carries `[data-kind=` and the kind arrives through the hole in it.
    const FIXTURE = [
      "const selectorFor = (kind: string): string =>",
      "\t`section[data-kind=${JSON.stringify(kind)}]`;",
      `await page.evaluate(selectorFor("workflow-run"));`,
      ""
    ].join("\n")
    expect(reportOf("selector-helper", FIXTURE)).toContain("card-kind:workflow-run")
  })

  test("a dead kind in a card object literal is reported", () => {
    // The frames the suites script are card objects. `kind` alone means
    // nothing — half the wire model has a `kind` — so the object has to look
    // like a card before its kind is read as one.
    const FIXTURE = [
      `stack.chat.script({ frames: [card({`,
      `\tid: "copy-run-done",`,
      `\tkind: "workflow-run",`,
      `\ttitle: "Run finished",`,
      `\tstatus: "acted",`,
      `\tcreatedAt: 1700000000000,`,
      `\tordinal: 10,`,
      `\tpayload: {},`,
      `})] });`,
      ""
    ].join("\n")
    expect(reportOf("card-object", FIXTURE)).toContain("card-kind:workflow-run")
  })

  test("a dead kind reached through a name, a ternary, an array or a default is reported", () => {
    const FIXTURE = [
      `const wanted = "workflow-run";`,
      `if (card.kind === wanted) fail("still here");`,
      `const picked = admin ? "workflow-status" : "run-trace";`,
      `if (card.kind !== picked) fail("no card");`,
      `for (const kind of ["workflow-approval", "run-trace"]) {`,
      `\tif (card.kind === kind) fail("kind is back");`,
      `}`,
      `const { kind = "workflow-plan" } = frame;`,
      `if (card.kind === kind) fail("default is back");`,
      ""
    ].join("\n")
    const reported = reportOf("indirect", FIXTURE)
    // One dead kind per route, so no route can pass on another's finding.
    expect(reported).toContain("card-kind:workflow-run")
    expect(reported).toContain("card-kind:workflow-status")
    expect(reported).toContain("card-kind:workflow-approval")
    expect(reported).toContain("card-kind:workflow-plan")
    // The live kind in two of the same shapes is not reported.
    expect(reported).not.toContain("card-kind:run-trace")
  })

  test("a dead kind in a switch case or a membership set is reported", () => {
    // Two more spellings of "compared against a `.kind`". The parser sees a
    // `switch` case and a `KINDS.has(card.kind)` as neither a `===` nor a
    // selector, so the discovery rule had to name them or stay blind to a
    // suite that branches on kind instead of asserting on it.
    const FIXTURE = [
      `switch (card.kind) {`,
      `\tcase "workflow-run":`,
      `\t\treturn "run";`,
      `\tcase "run-trace":`,
      `\t\treturn "run";`,
      `\tdefault:`,
      `\t\treturn "other";`,
      `}`,
      `const ACCEPTED = new Set(["workflow-approval", "approval"]);`,
      `if (!ACCEPTED.has(card.kind)) fail("unexpected kind");`,
      ""
    ].join("\n")
    const reported = reportOf("switch-and-membership", FIXTURE)
    expect(reported).toContain("card-kind:workflow-run")
    expect(reported).toContain("card-kind:workflow-approval")
    // The live kinds sitting in the same two positions are left alone.
    expect(reported).not.toContain("card-kind:run-trace")
    expect(reported).not.toContain("card-kind:approval")
  })

  test("a kind a function returns is out of reach, and the header says so", () => {
    /*
     * The limit, pinned rather than described. Propagation follows values
     * into a call and never out of one, so a kind produced by a helper is
     * invisible. This test exists so the limit cannot quietly change: if a
     * later pass teaches the extractor to follow returns, this fails and
     * whoever did it updates the "WHAT IT CANNOT SEE" list in Literals.ts
     * in the same commit.
     */
    const FIXTURE = [
      `const kindFor = (row: Row): string => "workflow-run";`,
      `if (card.kind === kindFor(row)) fail("still here");`,
      ""
    ].join("\n")
    expect(reportOf("returned", FIXTURE)).not.toContain("card-kind:workflow-run")
  })

  test("the same positions holding a live kind stay clean", () => {
    // The other half of the widening. A rule that reports every kebab string
    // near the word `kind` would be noise, so the surviving vocabulary in the
    // same four shapes has to pass, and a `kind` belonging to another union
    // has to be left alone.
    const CLEAN = [
      `const cardOfKind = (client: Client, kind: string) =>`,
      `\tclient.cards().find((card) => card.kind === kind);`,
      `const live = cardOfKind(client, "repo-import");`,
      "const selectorFor = (kind: string): string =>",
      "\t`section[data-kind=${JSON.stringify(kind)}]`;",
      `await page.evaluate(selectorFor("approval"));`,
      `stack.chat.script({ frames: [`,
      `\t{ type: "delta", kind: "text", text: "Here is what finished." },`,
      `\tcard({`,
      `\t\tid: "copy-run-done",`,
      `\t\tkind: "run-trace",`,
      `\t\ttitle: "Run finished",`,
      `\t\tstatus: "acted",`,
      `\t\tcreatedAt: 1700000000000,`,
      `\t\tordinal: 10,`,
      `\t\tpayload: {},`,
      `\t}),`,
      `] });`,
      `const store = await createAppStore({ kind: "localStorage", storage });`,
      ""
    ].join("\n")
    expect(reportOf("clean-positions", CLEAN)).toEqual([])
  })
})

describe("the suggestion is a lead, not noise", () => {
  test("a near miss names its neighbour and a stranger names nobody", () => {
    expect(nearest("workflow.create", vocabularies.dottedIdentifiers)).toBe("flow.create")
    expect(nearest("workflow-run-", ["flow-run-"])).toBe("flow-run-")
    // The new form prefix is closer; the original run prefix still resolves above.
    expect(nearest("workflow-run-", vocabularies.cardIdPrefixes)).toBe("form-flow-run-")
    // No shared tail, no guess.
    expect(nearest("data-command", vocabularies.dataAttributes)).toBeUndefined()
    expect(nearest("zzzzzzzzzzzzzzzzzzzz", vocabularies.cardKinds)).toBeUndefined()
  })
})
