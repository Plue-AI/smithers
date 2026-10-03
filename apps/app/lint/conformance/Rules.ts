/*
 * The rules the pin enforces, as pure functions over extracted literals and
 * derived vocabularies.
 *
 * Each rule closes one of the four classes the 2026-08-15 `command`→`flow`
 * rename left behind in `scripts/worker-e2e.ts` and the browser scripts:
 * eight dead flow names, nine comparisons against a card kind that no longer
 * existed, two dead run-card id prefixes, and seventeen `data-command`
 * selectors the app never emitted.
 *
 * A rule is only as good as the positions it looks in. The first cut of the
 * card-kind rule read two of them — `[data-kind="…"]` selectors and direct
 * `.kind ===` comparisons — and so reproduced, one level up, the defect the
 * pin exists to catch: a kind handed to `cardOfKind(client, "…")`, or written
 * into a scripted card frame, was never checked at all. The rule now reads a
 * kind wherever the file puts one. `Literals.ts` traces the value-carrying
 * positions; the card-frame position is decided here, because it needs the
 * wire model to say what a card object looks like.
 */
import ts from "typescript"
import {
  attributeSelectorValues,
  dataAttributesIn,
  DOTTED_IDENTIFIER,
  type ExtractedLiteral,
  FILE_NAME,
  ID_PREFIX,
  nearest,
  segmentsOf
} from "./Literals"

/** One orphaned literal, named well enough to fix without reading this file. */
export interface Violation {
  /** Which vocabulary the literal failed to resolve against. */
  readonly rule: "actor-label" | "flow" | "card-kind" | "card-id-prefix" | "data-attribute" | "dotted-identifier"
  readonly value: string
  readonly file: string
  readonly line: number
  readonly message: string
}

/** The vocabularies a check runs against. */
export interface Vocabularies {
  readonly flowNames: ReadonlySet<string>
  readonly cardKinds: ReadonlySet<string>
  readonly cardIdPrefixes: ReadonlySet<string>
  readonly dataAttributes: ReadonlySet<string>
  readonly dottedIdentifiers: ReadonlySet<string>
  /**
   * The static heads of the dotted keys the app composes rather than spells,
   * such as the `smithers-mvp.` every durable collection is stored under.
   */
  readonly composedDottedHeads: ReadonlySet<string>
  /** Every plain string literal the product source spells, the tail half of a composed key. */
  readonly productStringLiterals: ReadonlySet<string>
  /**
   * The property names a card carries besides `kind`. They are what tells a
   * scripted card frame from the many other objects in the suites with a
   * `kind` of their own — a stream delta, a store config, a submit union.
   */
  readonly cardObjectFields: ReadonlySet<string>
  /**
   * Every hyphen-separated word the app's card kinds and card-id prefixes are
   * built from. It is what tells a card id apart from an id a runner coins for
   * itself: `workflow-run-` borrows `workflow` and `run` from the app, while
   * `canary-seam-probe-` borrows nothing.
   */
  readonly idVocabularySegments: ReadonlySet<string>
}

const suggest = (value: string, vocabulary: ReadonlySet<string>): string => {
  const closest = nearest(value, vocabulary)
  return closest === undefined ? "" : ` Did you mean "${closest}"?`
}

/**
 * Calls that take a flow name the registry has to know, at any argument
 * position. `Array.prototype.find` takes a callback, so it never collides
 * here, and the dotted-name shape test below rejects the rest.
 */
const FLOW_CALLS = new Set(["runCommand", "runFlow", "find"])

/** Calls whose first argument is a prefix or suffix of an id the app builds. */
const AFFIX_CALLS = new Set(["startsWith", "endsWith"])

/**
 * Whether an id prefix is one the app builds by composing two of its own.
 *
 * The DOM ids the suites select on are composed: `ChatCards.tsx` renders every
 * card as ``data-testid={`card-${card.id}`}``, so a card whose id is built from
 * the `file-` head reaches the DOM as `card-file-…`. The derivation reads one
 * template head per literal, so it holds `card-` and `file-` and never their
 * product; a suite naming `card-file-` is naming an id the app really builds.
 * Both halves still have to be heads the app owns, so a coined prefix such as
 * `canary-file-` is no more excused than it was.
 */
const composedPrefix = (value: string, prefixes: ReadonlySet<string>): boolean =>
  [...prefixes].some((head) =>
    value.length > head.length && value.startsWith(head) && prefixes.has(value.slice(head.length))
  )

/**
 * Whether a dotted key is one the app composes out of two names it owns.
 *
 * `DurableCollection.ts` stores every collection at `` `smithers-mvp.${id}` ``,
 * so `smithers-mvp.app-messages` is the app's own key that no file spells
 * whole. Both halves must be product source — the head a template the app
 * interpolates into, the tail a word the app spells — so renaming either half
 * still orphans the literal.
 */
const composedDotted = (
  value: string,
  heads: ReadonlySet<string>,
  words: ReadonlySet<string>
): boolean =>
  [...heads].some((head) =>
    value.length > head.length && value.startsWith(head) && words.has(value.slice(head.length))
  )

/**
 * Form test ids compose the DOM card prefix, the form prefix, and a flow
 * name: `card-${formCardId(flow)}`. Check both prefixes and the registered
 * tail, and only in a test-id lookup so this cannot excuse a dead flow call.
 */
const composedFlowTestId = (literal: ExtractedLiteral, vocabularies: Vocabularies): boolean =>
  literal.argumentOf?.callee === "getByTestId" && [...vocabularies.flowNames].some(flow => {
    if (!literal.value.endsWith(flow)) return false
    const prefix = literal.value.slice(0, -flow.length)
    return vocabularies.cardIdPrefixes.has(prefix) || composedPrefix(prefix, vocabularies.cardIdPrefixes)
  })

/**
 * How many of a card's other fields an object literal must carry before its
 * `kind` is read as a card kind.
 *
 * Three is the smallest count no non-card object in the suites reaches: a
 * stream delta is `{ type, kind, text }` and a store config is
 * `{ kind, storage }`, while every scripted card frame carries `id`, `title`,
 * `status`, `createdAt`, `ordinal` and `payload`. Requiring all of them would
 * miss a partial frame written to prove the client rejects it.
 */
const CARD_OBJECT_FIELDS_REQUIRED = 3

/** True when the literal is the `kind` of an object literal shaped like a card. */
const isCardFrameKind = (literal: ExtractedLiteral, fields: ReadonlySet<string>): boolean =>
  literal.propertyName === "kind"
  && literal.siblingProperties.filter((sibling) => fields.has(sibling)).length >= CARD_OBJECT_FIELDS_REQUIRED

/**
 * Check one literal against every rule that applies to it. A literal can break
 * more than one rule (a selector naming both a dead attribute and a dead
 * value), and each is reported, because fixing one and leaving the other is
 * how a suite half-recovers and stays silent.
 */
export const violationsOf = (literal: ExtractedLiteral, vocabularies: Vocabularies): ReadonlyArray<Violation> => {
  const found: Array<Violation> = []
  const at = { value: literal.value, file: literal.file, line: literal.line }
  // Suffix provenance is conditional on every enclosing ID head still being
  // emitted by the product. Unknown heads and direct uses retain full checks.
  const testOwned = literal.testOwnedContext !== undefined && (literal.productIdPrefixUses === undefined
    || literal.productIdPrefixUses.every(prefix => vocabularies.cardIdPrefixes.has(prefix)
      || composedPrefix(prefix, vocabularies.cardIdPrefixes)))

  for (const attribute of dataAttributesIn(literal.value)) {
    if (!vocabularies.dataAttributes.has(attribute)) {
      found.push({
        ...at,
        value: attribute,
        rule: "data-attribute",
        message:
          `"${attribute}" is on no element this app renders, so the selector matches nothing and every assertion behind it is vacuous.${
            suggest(attribute, vocabularies.dataAttributes)
          }`
      })
    }
  }

  for (const kind of attributeSelectorValues(literal.value, "data-kind")) {
    if (!vocabularies.cardKinds.has(kind)) {
      found.push({
        ...at,
        value: kind,
        rule: "card-kind",
        message: `[data-kind="${kind}"] names no card kind the wire model declares.${
          suggest(kind, vocabularies.cardKinds)
        }`
      })
    }
  }

  for (const flow of attributeSelectorValues(literal.value, "data-flow")) {
    if (!vocabularies.flowNames.has(flow)) {
      found.push({
        ...at,
        value: flow,
        rule: "flow",
        message: `[data-flow="${flow}"] names no registered flow, so the selector matches no affordance.${
          suggest(flow, vocabularies.flowNames)
        }`
      })
    }
  }

  if (
    (literal.kindClaim || isCardFrameKind(literal, vocabularies.cardObjectFields))
    && !vocabularies.cardKinds.has(literal.value)
  ) {
    found.push({
      ...at,
      rule: "card-kind",
      message:
        `"${literal.value}" is used as a card kind but is no card kind the wire model declares, so nothing can ever match it.${
          suggest(literal.value, vocabularies.cardKinds)
        }`
    })
  }

  // Any argument position, not just the first: `runFlow(page, "flow.create")`
  // names a flow exactly as `runFlow("flow.create")` does.
  if (
    literal.argumentOf !== undefined && FLOW_CALLS.has(literal.argumentOf.callee)
    && DOTTED_IDENTIFIER.test(literal.value) && !vocabularies.flowNames.has(literal.value)
  ) {
    found.push({
      ...at,
      rule: "flow",
      message: `"${literal.value}" is run as a flow but is not a registered flow name.${
        suggest(literal.value, vocabularies.flowNames)
      }`
    })
  }

  /*
   * Two positions claim to name an id the app built. `startsWith`/`endsWith`
   * is the dangerous one — a dead prefix there filters to nothing and a
   * "found no bad rows" assertion passes. A template head that CONSTRUCTS an
   * id is checked only when it borrows the app's own id words, because every
   * runner and double also coins ids of its own (`gw-`, `canary-macos-`) that
   * the app was never meant to know.
   */
  const affix = (literal.leadingArgumentOf !== undefined && AFFIX_CALLS.has(literal.leadingArgumentOf))
    || (literal.form === "template-head"
      && !testOwned
      && segmentsOf(literal.value).some((segment) => vocabularies.idVocabularySegments.has(segment)))
  if (
    affix && ID_PREFIX.test(literal.value) && !vocabularies.cardIdPrefixes.has(literal.value)
    && !composedPrefix(literal.value, vocabularies.cardIdPrefixes)
  ) {
    found.push({
      ...at,
      rule: "card-id-prefix",
      message: `"${literal.value}" is used as an id prefix but the app builds no id starting with it.${
        suggest(literal.value, vocabularies.cardIdPrefixes)
      }`
    })
  }

  if (
    literal.form === "string" && DOTTED_IDENTIFIER.test(literal.value) && !FILE_NAME.test(literal.value)
    // Health checker IDs are supplied by pluggable monitors, not app commands.
    // This does not exempt the same literal in a runCommand or data-flow.
    && literal.propertyName !== "checkerId"
    && !testOwned
    && !vocabularies.dottedIdentifiers.has(literal.value)
    && !composedDotted(literal.value, vocabularies.composedDottedHeads, vocabularies.productStringLiterals)
    && !composedFlowTestId(literal, vocabularies)
  ) {
    found.push({
      ...at,
      rule: "dotted-identifier",
      message:
        `"${literal.value}" is spelled in no product source file — no flow, transition, frame type or toast key answers to it.${
          suggest(literal.value, vocabularies.dottedIdentifiers)
        }`
    })
  }

  return found
}

/** T-APP-09: actor labels have one formatter, including template static chunks. */
export const actorLabelViolations = (literal: ExtractedLiteral): ReadonlyArray<Violation> => {
  if (!/(?: via | for |'s terminal)/.test(literal.value)) return []
  return [{ rule: "actor-label", value: literal.value, file: literal.file, line: literal.line,
    message: "Use actorName for participant labels." }]
}

/** Inspect actor formatting expressions, so ordinary copy such as "Stop for now" remains valid. */
export const actorSourceViolations = (file: string, source: string): ReadonlyArray<Violation> => {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: Violation[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && /^(?:[A-Z][\w -]* for [A-Z]|.+ via (?:SSH|CLI)$)|'s terminal/.test(node.text)) {
      found.push({ rule: "actor-label", file, value: node.text,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        message: "Use actorName for participant labels." })
    }
    if (ts.isTemplateExpression(node) || ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      // Only the outer formatting expression, to avoid reporting nested concatenations twice.
      if (ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) return
      const identifiers: string[] = [], strings: string[] = []
      const collect = (child: ts.Node): void => {
        if (ts.isIdentifier(child)) identifiers.push(child.text)
        if (ts.isStringLiteralLike(child) || ts.isTemplateHead(child) || ts.isTemplateMiddle(child) || ts.isTemplateTail(child)) strings.push(child.text)
        ts.forEachChild(child, collect)
      }
      collect(node)
      if (identifiers.some(name => /^(?:actor|person|member|owner|author|answerer|requester|name)(?:$|[A-Z_])/.test(name))) {
        for (const value of strings.filter(value => /^(?: via | for )|'s terminal|^(?:Smithers|Claude Code|Codex|Coding agent|Reviewer) for /.test(value))) found.push({
          rule: "actor-label", file, value, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
          message: "Use actorName for participant labels."
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}
