/*
 * The product vocabulary is what the app spells, not what a test mentions.
 *
 * The literal pin's whole claim is that a name resolving is evidence the
 * application still uses it. Discovering the app's own `*.test.ts` files as
 * product source broke that claim quietly: a flow id, an event kind or a
 * card-id prefix deleted from the app stayed in the vocabulary for as long as
 * one stale test kept spelling it, so the pin went on excusing exactly the
 * literals it exists to name. These tests hold the authority independent.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  DOTTED_IDENTIFIER,
  extractLiterals,
  FILE_NAME,
  FIXTURE_TREE,
  ID_PREFIX,
  sourceFiles,
  TEST_FILE
} from "./Literals"
import { violationsOf, type Vocabularies } from "./Rules"
import {
  assertsAgainstTheApp,
  cardIdPrefixes,
  cardKinds,
  cardObjectFields,
  composedDottedHeads,
  CONFORMANCE,
  declaredFlowNames,
  emittedDataAttributes,
  GATEWAY_LIBRARY,
  idVocabularySegments,
  productDottedIdentifiers,
  productSourceFiles,
  productStringLiterals,
  SHARED_SRC,
  UI_SRC
} from "./Vocabulary"

const vocabularies: Vocabularies = {
  flowNames: declaredFlowNames(),
  cardKinds: cardKinds(),
  cardIdPrefixes: cardIdPrefixes(),
  dataAttributes: emittedDataAttributes(),
  dottedIdentifiers: productDottedIdentifiers(),
  composedDottedHeads: composedDottedHeads(),
  productStringLiterals: productStringLiterals(),
  cardObjectFields: cardObjectFields(),
  idVocabularySegments: idVocabularySegments()
}

/*
 * "Spelled by a test and by nothing else" is computed here from the two file
 * sets directly rather than read off `productDottedIdentifiers`, so these
 * tests cannot agree with the derivation by construction: they fail against a
 * corpus that discovers tests, which is what the corpus did until this change.
 */
// The immutable corpus is parsed once. Re-parsing every test file for each
// literal form made the second assertion exceed its budget under shared load.
const parsedLiterals = new Map<string, ReturnType<typeof extractLiterals>>()
const literalsOf = (files: ReadonlyArray<string>, form: "string" | "template-head"): ReadonlySet<string> => {
  const found = new Set<string>()
  for (const file of files) {
    let literals = parsedLiterals.get(file)
    if (literals === undefined) {
      literals = extractLiterals(file, readFileSync(file, "utf8"))
      parsedLiterals.set(file, literals)
    }
    for (const literal of literals) {
      if (literal.form === form) found.add(literal.value)
    }
  }
  return found
}

/*
 * The same roots the authority reads, filtered here rather than there. The
 * trees under test are dropped exactly as `productSourceFiles` drops them, so
 * a name is "retired" only when nothing outside a test spells it anywhere.
 */
const underTest = (file: string): boolean => file.startsWith(CONFORMANCE)
const appFiles = [UI_SRC, SHARED_SRC]
  .flatMap((root) => [...sourceFiles(root)])
  .filter((file) => !assertsAgainstTheApp(file) && !underTest(file))
const dottedAppFiles = [...appFiles, ...sourceFiles(GATEWAY_LIBRARY).filter((file) => !assertsAgainstTheApp(file))]
const testFiles = sourceFiles(UI_SRC).filter((file) => assertsAgainstTheApp(file) && !underTest(file))

// Discover this independent oracle with the corpus above, before assertions.
// Assertion budgets must not depend on how long a loaded machine takes to
// parse the entire repository. Both forms share the same parsed files.
const appStrings = literalsOf(dottedAppFiles, "string")
const testStrings = literalsOf(testFiles, "string")
const appHeads = literalsOf(appFiles, "template-head")
const testHeads = literalsOf(testFiles, "template-head")

const at = (value: string, form: "string" | "template-head", leadingArgumentOf?: string) => ({
  value,
  form,
  file: testFiles[0] ?? "",
  line: 1,
  leadingArgumentOf,
  argumentOf: undefined,
  propertyName: undefined,
  siblingProperties: [],
  kindComparison: false,
  kindClaim: false
})

describe("the product vocabulary is derived from the app alone", () => {
  test("no test or fixture file is part of the authority", () => {
    expect(productSourceFiles().filter((file) => TEST_FILE.test(file) || FIXTURE_TREE.test(file))).toEqual([])
    // The exclusion has to have something to exclude, or a broken path reads
    // as a clean corpus. 265 test files under src today.
    expect(testFiles.length).toBeGreaterThan(100)
    expect(appFiles.length).toBeGreaterThan(60)
  })

  test("a dotted identifier only a test spells is rejected", () => {
    /*
     * The 2026-08-15 casualty in miniature: `workflow.create` survived the
     * rename in a stub, and while tests counted as product source the pin
     * read that stub as proof the name still existed. A name the app does
     * not spell resolves only two ways — it is a file name, or the app
     * composes it out of a head and a word it does own — and every other
     * one has to fail.
     */
    const retired = [...testStrings]
      .filter((value) => DOTTED_IDENTIFIER.test(value) && !appStrings.has(value) && !FILE_NAME.test(value))
      .filter((value) =>
        ![...vocabularies.composedDottedHeads].some((head) =>
          value.startsWith(head) && vocabularies.productStringLiterals.has(value.slice(head.length))
        )
      )
    expect(retired.length).toBeGreaterThan(0)
    expect(retired.filter((value) => vocabularies.dottedIdentifiers.has(value))).toEqual([])
    expect(
      retired.filter((value) =>
        ![...violationsOf(at(value, "string"), vocabularies)].some((violation) => violation.rule === "dotted-identifier")
      )
    ).toEqual([])
  })

  test("a card-id prefix only a test builds is rejected", () => {
    /*
     * A prefix a suite feeds to `startsWith` filters to nothing when the app
     * stopped building ids under it, and the assertion behind the filter then
     * passes on an empty list. A prefix the app composes out of two of its
     * own still resolves, which is why the rule is asked rather than the set.
     */
    const retired = [...testHeads]
      .filter((value) => ID_PREFIX.test(value) && !appHeads.has(value))
    expect(retired.length).toBeGreaterThan(0)
    expect(retired.filter((value) => vocabularies.cardIdPrefixes.has(value))).toEqual([])
    const rejected = retired.filter((value) =>
      [...violationsOf(at(value, "string", "startsWith"), vocabularies)].some((violation) =>
        violation.rule === "card-id-prefix"
      )
    )
    expect(rejected.length).toBeGreaterThan(0)
  })

  test("a key the app composes still resolves", () => {
    /*
     * `DurableCollection.ts` stores every collection at
     * `` `smithers-mvp.${id}` ``, so the storage key a recovery suite asserts
     * against is spelled in two pieces. Dropping the tests from the authority
     * must not orphan it: the head and the word are both the app's.
     */
    expect(vocabularies.composedDottedHeads.has("smithers-mvp.")).toBe(true)
    expect(vocabularies.productStringLiterals.has("app-messages")).toBe(true)
    expect(vocabularies.dottedIdentifiers.has("smithers-mvp.app-messages")).toBe(false)
    expect([...violationsOf(at("smithers-mvp.app-messages", "string"), vocabularies)]).toEqual([])
    // A head with a word the app never spells is still an orphan.
    expect(
      [...violationsOf(at("smithers-mvp.retired-collection", "string"), vocabularies)].map((violation) => violation.rule)
    ).toEqual(["dotted-identifier"])
  })
})

test("health checker IDs are external data; the same literal used as a flow is still checked", () => {
  const fields = extractLiterals("fixture.ts", 'const status = { provenance: { checkerId: "fixture.semantic" } }; runCommand("fixture.semantic")')
  const reports = fields.flatMap(literal => violationsOf(literal, vocabularies))
  expect(reports.filter(report => report.rule === "dotted-identifier")).toHaveLength(1)
  expect(reports.filter(report => report.rule === "flow")).toHaveLength(1)
})

test("React Flow's own wrapper attributes resolve; an attribute nothing renders still does not", () => {
  // The canvas wraps every node the app draws in a React Flow element carrying `data-id`.
  expect(vocabularies.dataAttributes.has("data-id")).toBe(true)
  expect(vocabularies.dataAttributes.has("data-forest")).toBe(true)
  expect(vocabularies.dataAttributes.has("data-retired-marker")).toBe(false)
})
