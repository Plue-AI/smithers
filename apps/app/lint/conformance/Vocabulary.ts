/*
 * The vocabularies the application owns, derived from the application.
 *
 * Every set here is computed from product source or from the running app. None
 * is hand-listed: a hand-listed expectation goes stale at exactly the rename
 * this pin exists to catch, so it would reintroduce the defect one level up.
 */
import type { StorageApi } from "@tanstack/db"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Card } from "@smthrs/rpc/Cards"
import { CardSchema } from "@smthrs/rpc/Cards"
import ts from "typescript"
import { adminFlows, baseFlows, guideFlows, type CommandActions } from "../../src/mainview/flows/Flows"
import { nameOf } from "../../src/mainview/flows/registry"

import type { AgentPort } from "../../src/mainview/runtime/AgentPort"
import { createAppController } from "../../src/mainview/state/AppController"
import { createAppStore } from "../../src/mainview/state/AppStore"
import {
  DOTTED_IDENTIFIER,
  extractLiterals,
  FIXTURE_TREE,
  ID_PREFIX,
  segmentsOf,
  sourceFiles,
  TEST_FILE
} from "./Literals"

const from = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

/** The shape of a dotted key's static head: `smithers-mvp.`, `command.form.`. */
const DOTTED_HEAD = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.$/

/** `apps/app`. */
export const UI_APP = from("../../")
/** `apps/app/src`. */
export const UI_SRC = from("../../src/")
/** `apps/app/scripts` — the standalone e2e and live-check runners, the launch checklist included. */
export const SCRIPTS = from("../../scripts")
/** `apps/app/e2e` — the hermetic harness and its suites. */
export const E2E = from("../../e2e")
/** This directory. */
export const CONFORMANCE = from(".")
/** `packages/rpc/src` — the wire model both halves of the app share. */
export const SHARED_SRC = from("../../../../packages/rpc/src")
/** The shipped component library the app renders through. */
export const COMPONENT_LIBRARY = from("../../node_modules/@smthrs/ui/src")
/** React Flow's published bundle: the graph canvas wraps every node and edge the app draws in its own element. */
export const REACT_FLOW_BUNDLE = from("../../node_modules/@xyflow/react/dist/esm/index.mjs")
/**
 * The gateway the app reads the world through. Since the rc.0 retarget the app
 * binds projections the gateway folds, so the journal event kinds those
 * projections switch on are as much part of the app's vocabulary as a card
 * kind is — a rename there orphans the literals the proof script emits, which
 * is exactly the rot this pin exists to catch.
 */
export const GATEWAY_LIBRARY = from("../../node_modules/@smthrs/gateway/src")

/**
 * Whether a file asserts against the app instead of building it.
 *
 * A unit test and the fixtures it imports spell the same literals a browser
 * suite does, so counting them as the authority makes the presence rule say
 * "some test still mentions this name" — the answer this pin exists to reject.
 * A retired flow id or card-id prefix would then survive for as long as one
 * stale test kept spelling it, which is longer than the rename it hides.
 */
export const assertsAgainstTheApp = (file: string): boolean => TEST_FILE.test(file) || FIXTURE_TREE.test(file)

/**
 * Product source: everything the app is built from, minus the trees under
 * test and the files that only assert against it. Excluding this directory
 * and every test and fixture is what makes the presence rule mean "the app
 * still spells this name" rather than "some test still mentions it".
 */
export const productSourceFiles = (): ReadonlyArray<string> =>
  [
    // The app's own top-level config (electrobun.config.ts, vite.config.ts)
    // declares product identity, the macOS bundle id included, so it counts
    // as product source for "does the app own this name".
    ...readdirSync(UI_APP, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(UI_APP, entry.name)),
    ...sourceFiles(UI_SRC),
    ...sourceFiles(SHARED_SRC)
  ].filter((file) => !file.startsWith(CONFORMANCE) && !assertsAgainstTheApp(file))

/** The gateway source the app reads through, its own suites left out. */
const gatewaySourceFiles = (): ReadonlyArray<string> =>
  sourceFiles(GATEWAY_LIBRARY).filter((file) => !assertsAgainstTheApp(file))

/**
 * The words card kinds and card-id prefixes are built from. A runner's own id
 * prefix borrows none of them; an id the app is meant to recognise borrows at
 * least one.
 */
export const idVocabularySegments = (): ReadonlySet<string> => {
  const segments = new Set<string>()
  for (const name of [...cardKinds(), ...cardIdPrefixes()]) {
    for (const segment of segmentsOf(name)) segments.add(segment)
  }
  return segments
}

/*
 * Card kinds, straight off the discriminated union the wire model declares.
 * `Card` is `z.infer<typeof CardSchema>`, so the runtime options and the
 * compile-time union are the same declaration read two ways; the type-level
 * assertion below refuses to compile if that ever stops being true.
 */
type DerivedCardKind = (typeof CardSchema.options)[number]["shape"]["kind"]["value"]
const _derivedKindsAreExactlyCardKinds: DerivedCardKind extends Card["kind"]
  ? Card["kind"] extends DerivedCardKind ? true
  : never
  : never = true
void _derivedKindsAreExactlyCardKinds

/** Every card kind the wire model declares. */
export const cardKinds = (): ReadonlySet<Card["kind"]> =>
  new Set(CardSchema.options.map((option) => option.shape.kind.value))

/**
 * The property names every card in the wire model carries besides `kind`.
 *
 * `kind` is not a card's word. A stream delta has one, a store config has one,
 * half the wire model has one, so a literal under a `kind:` property is only a
 * card kind when the object around it looks like a card. These are the names
 * that decide it, and they come off `CardSchema` so the test that reads them
 * cannot drift from the model the way a hand-written list would.
 */
export const cardObjectFields = (): ReadonlySet<string> => {
  const shared = CardSchema.options.map((option) => new Set(Object.keys(option.shape)))
  const [first, ...rest] = shared
  if (first === undefined) return new Set()
  return new Set(
    [...first].filter((field) => field !== "kind" && rest.every((option) => option.has(field)))
  )
}

/*
 * Flow names, twice over.
 *
 * `declaredFlowNames` reads the declarations, including the admin plugin that
 * registers only for an admin session. `manifestFlowNames` boots the real
 * store and controller and reads `controller.commands.all()` — the same
 * expression `App.tsx` renders into `data-flows`, so it is literally what the
 * DOM contains. The manifest is the stronger source; the declarations are the
 * superset a suite driving an admin session may legitimately assert against.
 */
const declarationStub = (): CommandActions => new Proxy({}, {
  get: (_, key) =>
    key === "snapshot"
      ? () => ({ pluginLibrary: true })
      : () => undefined
}) as unknown as CommandActions

export const declaredFlowNames = (): ReadonlySet<string> =>
  /* The same composition `Commands.ts` builds the registry from. */
  new Set([...baseFlows(declarationStub()), ...guideFlows(declarationStub()), ...adminFlows(declarationStub())].map(nameOf))

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const absentAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "no native agent in the conformance pin" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}


/** The command manifest `App.tsx` renders into `data-flows`, read the same way. */
export const manifestFlowNames = async (): Promise<ReadonlySet<string>> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, absentAgent)
  return new Set(controller.commands.all().map((command) => command.name))
}

/**
 * Every `data-*` attribute the rendered DOM can carry. There are three ways to
 * put one there and all three are read: a JSX attribute, a `setAttribute`/`toggleAttribute`
 * call, and a `dataset` property write. Sources are the app's own components
 * and the component library the app renders through, plus the `data-*` props
 * React Flow's compiled bundle writes on the node and edge wrappers it owns
 * (`"data-id": id`), since the graph canvas renders those — a CDP selector naming
 * anything else matches nothing, which is exactly what seventeen stale
 * `data-command` selectors did after the rename. Tests are left out for the
 * same reason they are left out of the source corpus: an attribute only a
 * test renders is not one the app puts on the page.
 */
export const emittedDataAttributes = (): ReadonlySet<string> => {
  const emitted = new Set<string>()
  const rendered = [...sourceFiles(UI_SRC), ...sourceFiles(COMPONENT_LIBRARY)]
    .filter((candidate) => !assertsAgainstTheApp(candidate))
  for (const file of rendered) {
    const parsed = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ESNext,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node)) {
        // TypeScript keeps a hyphenated JSX attribute name as an
        // identifier node, so the source text is the attribute name.
        const name = node.name.getText(parsed)
        if (name.startsWith("data-")) emitted.add(name)
      }
      if (
        ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ["setAttribute", "toggleAttribute"].includes(node.expression.name.text)
      ) {
        const first = node.arguments[0]
        if (first !== undefined && ts.isStringLiteral(first) && first.text.startsWith("data-")) {
          emitted.add(first.text)
        }
      }
      // `element.dataset.toastStatus = x` renders as `data-toast-status`.
      if (
        ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left)
        && ts.isPropertyAccessExpression(node.left.expression)
        && node.left.expression.name.text === "dataset"
      ) {
        emitted.add(`data-${node.left.name.text.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`)}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
  }
  for (const match of readFileSync(REACT_FLOW_BUNDLE, "utf8").matchAll(/"(data-[a-z][a-z-]*)":/g)) emitted.add(match[1]!)
  return emitted
}

/**
 * The `data-*` attributes a suite stamps onto the page itself.
 *
 * A browser suite may mark the elements it found (`owner.setAttribute(
 * "data-e2e-ring", …)`) and read them back a step later. Those markers are the
 * suite's own, so they belong in the attribute vocabulary — but only because
 * the suite is seen writing them. A selector for an attribute nobody writes,
 * which is what seventeen `data-command` selectors were, still fails.
 *
 * The scan is over raw text because the writes live inside CDP expression
 * strings, where there is no AST to walk.
 */
export const stampedDataAttributes = (trees: ReadonlyArray<string>): ReadonlySet<string> => {
  const stamped = new Set<string>()
  const write = /(?:setAttribute\(\s*\\?["']|dataset\.)([A-Za-z][\w-]*)/g
  for (const file of trees.flatMap((tree) => [...sourceFiles(tree)])) {
    for (const match of readFileSync(file, "utf8").matchAll(write)) {
      const name = match[1] ?? ""
      const attribute = name.startsWith("data-")
        ? name
        : `data-${name.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`)}`
      if (name.startsWith("data-") || !name.includes("-")) stamped.add(attribute)
    }
  }
  return stamped
}

/**
 * Every dotted identifier the product source spells as a literal: flow names,
 * transition types, stream frame types, toast keys. A dotted literal in a test
 * tree that is in no product source file names nothing — `workflow.create`
 * after the rename.
 *
 * The gateway source counts alongside the app's own, for the same reason the
 * component library counts for `data-*` attributes: the app renders what the
 * gateway's projections fold, and those projections are where a control-plane
 * event kind such as `control.approval.requested` is spelled.
 */
export const productDottedIdentifiers = (): ReadonlySet<string> => {
  const owned = new Set<string>()
  for (const file of [...productSourceFiles(), ...gatewaySourceFiles()]) {
    for (const literal of extractLiterals(file, readFileSync(file, "utf8"))) {
      if (literal.form === "string" && DOTTED_IDENTIFIER.test(literal.value)) owned.add(literal.value)
    }
  }
  // The real issue-recovery journey reads receipts written by the Go backend.
  // Derive their event types from the INSERT, so a backend rename still orphans
  // the assertion; neither a fixture nor an allowlist supplies the vocabulary.
  const issueSync = readFileSync(from("../../../../packages/backend/internal/services/issue_sync.go"), "utf8")
  for (const match of issueSync.matchAll(/INSERT INTO issue_events\(issue_id,actor_id,event_type,payload\)\s+VALUES\(\$1,\$2,'([^']+)'/g)) {
    if (DOTTED_IDENTIFIER.test(match[1]!)) owned.add(match[1]!)
  }
  return owned
}

/**
 * The static heads of the dotted keys the app composes rather than spells.
 *
 * `DurableCollection.ts` writes every collection to `` `smithers-mvp.${id}` ``,
 * so no file spells `smithers-mvp.app-messages` whole even though it is the
 * app's own storage key. A head here plus a word the app spells is what lets
 * the rule accept such a key without accepting every dotted string: rename
 * either half and the literal orphans again.
 */
export const composedDottedHeads = (): ReadonlySet<string> => {
  const heads = new Set<string>()
  for (const file of [...productSourceFiles(), ...gatewaySourceFiles()]) {
    for (const literal of extractLiterals(file, readFileSync(file, "utf8"))) {
      if (literal.form === "template-head" && DOTTED_HEAD.test(literal.value)) heads.add(literal.value)
    }
  }
  return heads
}

/** Every plain string literal the product source spells, the tail half of a composed key. */
export const productStringLiterals = (): ReadonlySet<string> => {
  const spelled = new Set<string>()
  for (const file of [...productSourceFiles(), ...gatewaySourceFiles()]) {
    for (const literal of extractLiterals(file, readFileSync(file, "utf8"))) {
      if (literal.form === "string") spelled.add(literal.value)
    }
  }
  return spelled
}

/**
 * The card-id prefixes the app builds. A card id is assembled as
 * `` `flow-run-${runId}` `` (AppController), so the prefix is the static head
 * of a template in product source.
 */
export const cardIdPrefixes = (): ReadonlySet<string> => {
  const prefixes = new Set<string>()
  for (const file of productSourceFiles()) {
    for (const literal of extractLiterals(file, readFileSync(file, "utf8"))) {
      if (literal.form === "template-head" && ID_PREFIX.test(literal.value)) prefixes.add(literal.value)
    }
  }
  return prefixes
}
