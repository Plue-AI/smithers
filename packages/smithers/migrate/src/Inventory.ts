/**
 * The per-file construct inventory.
 *
 * `Detect` says which files matter. This module says what is in them: every
 * JSX element whose tag resolves to a Smithers 0.x component, every `ctx`
 * accessor, every agent constructor, every runtime call, and every named
 * import of the old facade. Each hit carries the props that are present,
 * because a prop is what raises a construct's class (`Mapping.classify`).
 *
 * Resolution is syntactic. A tag counts only when its identifier comes from an
 * old import or from destructuring a `createSmithers` factory, so a workflow
 * written against a foreign authoring API contributes nothing and is reported
 * as `unknown-authoring-api` instead of being mistranslated.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as ts from "typescript/unstable/ast"
import * as Constructs from "./Constructs.ts"
import * as Detect from "./Detect.ts"
import * as Sort from "./internal/Sort.ts"
import * as Ts from "./internal/Ts.ts"
import type { MigrateError } from "./MigrateError.ts"

/**
 * One construct hit.
 *
 * `detail` carries source text, never a summary. `Mapping.snippet` builds a
 * rewrite out of it and emits nothing when a piece is missing, so a hit whose
 * detail is thin becomes a guided decision instead of an invented one.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface InventoryEntry {
  readonly file: string
  readonly line: number
  readonly column: number
  /**
   * The catalog name, for example `Task`, `ctx.outputMaybe`, `createSmithers`.
   * A factory member is recorded under its catalog shape, `outputs.<key>`, with
   * the project's own key in `detail`.
   */
  readonly construct: string
  /** Prop or argument names present at this hit, sorted. */
  readonly props: ReadonlyArray<string>
  /**
   * Source text worth carrying into a mapping decision.
   *
   * Every JSX attribute that is present appears under its own prop name. The
   * scanner adds these captured keys where it can resolve them:
   *
   * - `children`: the element's children, verbatim.
   * - `childConstructs`: the catalog components inside the element's children,
   *   as `Construct:id` pairs, so a group's rewrite can name its own steps.
   * - `<prop>Constructs`: the catalog components inside one prop's value, for
   *   the props that take an element (`<Branch then={<Task id=\"ship\" />} />`).
   * - `payloadChain`: the zod chain the factory's `input` schema holds, which
   *   is a workflow's payload.
   * - `outputChain`: the zod chain the `output` prop resolves to.
   * - `agentModel`, `agentProvider`, `agentInstructions`: the model literal,
   *   the provider callee, and the instructions of the agent the `agent` prop
   *   resolves to.
   * - `promptText`: the text of the `.mdx` prompt the children render.
   * - `payloadFields`: the zod chain behind each value the step reads, as JSON,
   *   resolved through `deps` and the factory's `input` schema.
   * - `childPayloads`: for a group, the payload each named child step reads, as
   *   JSON of id to key to the source expression behind it (`ctx.input.topic`,
   *   `deps.research.summary`), or `null` for a child whose payload the scanner
   *   could not resolve. A group's rewrite threads values between its steps,
   *   and it may only do that from the expressions the source itself wrote.
   * - `childOutputs`: for a group, the zod chain each named child step declares
   *   as its `output`, as JSON of id to chain, or `null` where the scanner
   *   could not resolve it. The last one is the flow's success schema.
   * - `childAgents`: the ids of the named child steps that carry an `agent` or
   *   `fallbackAgent` prop, comma-joined. A flow with one of them can fail with
   *   `AgentAction.AgentFailure`; a flow without one cannot.
   * - `description`: for a `<Workflow>`, the `// smithers-description:` or
   *   `// smithers-display-name:` header the workflow file carries. It is the
   *   only prose 0.x records about a workflow, and the registry needs one.
   * - `key`, `member`: the factory member this hit reads.
   */
  readonly detail?: Readonly<Record<string, string>> | undefined
}

/**
 * The names `createSmithers` destructures into. Anything else in the pattern is
 * project code and is left alone.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const factoryBindings: ReadonlyArray<string> = [
  "Approval",
  "ApprovalGate",
  "Branch",
  "ContinueAsNew",
  "HumanTask",
  "Loop",
  "Memory",
  "MergeQueue",
  "Monitor",
  "Panel",
  "Parallel",
  "Ralph",
  "Sandbox",
  "Sequence",
  "Signal",
  "Subflow",
  "Task",
  "Timer",
  "TUI",
  "UI",
  "WaitForEvent",
  "Worktree",
  "Workflow",
  "close",
  "continueAsNew",
  "db",
  "outputs",
  "smithers",
  "tables",
  "useCtx"
]

const runtimeCalls = new Set(
  Constructs.byKind("runtime").map((entry) => entry.name).concat(
    Constructs.byKind("store").map((entry) => entry.name),
    Constructs.byKind("server").map((entry) => entry.name),
    ["defineTool", "createHttpTool", "createOpenApiTools"]
  )
)

const agentNames = new Set(Constructs.byKind("agent").map((entry) => entry.name))

const ctxMethods = new Set(
  Constructs.byKind("ctx").map((entry) => entry.name.slice("ctx.".length))
)

/**
 * The names of local functions that hand back a `createSmithers` result.
 *
 * The old examples wrap the factory (`createExampleSmithers` in
 * `examples/_example-kit.js`), so a scanner that only knows the literal name
 * misses every component in every example. Collecting the wrappers first, from
 * the same file set, resolves them without evaluating anything.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export const factoryNames = (
  sources: ReadonlyMap<string, string>,
  parse: typeof Ts.parse = Ts.parse
): ReadonlySet<string> => {
  const names = new Set<string>(["createSmithers", "createSmithersPostgres", "createSmithersCloudflare"])
  for (const [file, text] of sources) {
    if (!/\bcreateSmithers\w*\s*\(/.test(text)) continue
    const parsed = parse(file, text)
    Ts.forEachNode(parsed, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
        if (/\bcreateSmithers\w*\s*\(/.test(node.body.getText())) names.add(node.name.text)
        return
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
        /\bcreateSmithers\w*\s*\(/.test(node.initializer.getText())
      ) {
        names.add(node.name.text)
      }
    })
  }
  return names
}

const attributeDetail = (
  node: ts.JsxOpeningLikeElement,
  props: ReadonlyArray<string>
): Record<string, string> => {
  const detail: Record<string, string> = {}
  for (const prop of props) {
    const text = Ts.attributeText(node, prop)
    if (text !== undefined) detail[prop] = text
  }
  return detail
}

/** The members a factory binding is read through, by their catalog shape. */
const memberConstructs: Readonly<Record<string, string>> = {
  outputs: "outputs.<key>",
  tables: "tables.<key>",
  db: "db.<member>"
}

/** The factory bindings that are called rather than read. */
const factoryCalls = new Set(["smithers", "close", "useCtx", "continueAsNew"])

/** The initializer of every `const` in a file, by the name it binds. */
const initializers = (source: ts.SourceFile): ReadonlyMap<string, ts.Expression> => {
  const found = new Map<string, ts.Expression>()
  Ts.forEachNode(source, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.initializer === undefined) return
    if (found.has(node.name.text)) return
    found.set(node.name.text, node.initializer)
  })
  return found
}

/** The string a property of an object literal holds, when it holds one. */
const stringProperty = (node: ts.ObjectLiteralExpression, name: string): string | undefined => {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (property.name === undefined || !ts.isIdentifier(property.name) || property.name.text !== name) continue
    if (ts.isStringLiteral(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer)) {
      return property.initializer.text
    }
  }
  return undefined
}

/** The value expression a property of an object literal holds. */
const property = (node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
  for (const item of node.properties) {
    if (!ts.isPropertyAssignment(item)) continue
    if (item.name === undefined || !ts.isIdentifier(item.name) || item.name.text !== name) continue
    return item.initializer
  }
  return undefined
}

/**
 * The model and provider an agent construction names.
 *
 * `new Agent({ model: anthropic("claude-sonnet-5") })` yields
 * `{ provider: "anthropic", model: "claude-sonnet-5" }`, and a bare string
 * model yields the model alone. Anything else yields nothing, because a seat
 * the tool cannot read out of the source is a seat it must not write.
 */
const agentDetail = (expression: ts.Expression): Record<string, string> => {
  const detail: Record<string, string> = {}
  const argument = ts.isNewExpression(expression) || ts.isCallExpression(expression)
    ? expression.arguments?.[0]
    : undefined
  if (argument === undefined || !ts.isObjectLiteralExpression(argument)) return detail
  const instructions = stringProperty(argument, "instructions") ?? stringProperty(argument, "system")
  if (instructions !== undefined) detail["agentInstructions"] = instructions
  const model = property(argument, "model")
  if (model === undefined) return detail
  if (ts.isStringLiteral(model)) {
    detail["agentModel"] = model.text
    return detail
  }
  if (ts.isCallExpression(model) && ts.isIdentifier(model.expression)) {
    const first = model.arguments[0]
    if (first !== undefined && ts.isStringLiteral(first)) {
      detail["agentProvider"] = model.expression.text
      detail["agentModel"] = first.text
    }
  }
  return detail
}

/** Joins a POSIX-style project path with a relative import specifier. */
const resolveRelative = (from: string, specifier: string): string => {
  const parts = from.split("/").slice(0, -1)
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue
    if (segment === "..") parts.pop()
    else parts.push(segment)
  }
  return parts.join("/")
}

const entry = (
  file: string,
  source: ts.SourceFile,
  node: ts.Node,
  construct: string,
  props: ReadonlyArray<string>,
  detail?: Record<string, string> | undefined
): InventoryEntry => {
  const position = Ts.positionOf(source, node)
  const sorted = [...props].sort()
  return detail === undefined
    ? { file, ...position, construct, props: sorted }
    : { file, ...position, construct, props: sorted, detail }
}

/**
 * Scans one file and returns its construct hits.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export const scanFile = (
  file: string,
  text: string,
  options: {
    readonly factories: ReadonlySet<string>
    readonly parse?: typeof Ts.parse | undefined
    /** The text of an `.mdx` prompt, by its import specifier. */
    readonly prompt?: ((specifier: string) => string | undefined) | undefined
    /** The factory bindings one import specifier re-exports, by local name. */
    readonly reexports?: ((specifier: string) => ReadonlyMap<string, string> | undefined) | undefined
    /**
     * The `smithers-*` header comments this file carries, by header name
     * without the prefix, as {@link module:Detect.WorkflowFile} records them.
     */
    readonly headers?: ReadonlyMap<string, string> | undefined
  }
): ReadonlyArray<InventoryEntry> => {
  const parse = options.parse ?? Ts.parse
  const source = parse(file, text)
  const hits: Array<InventoryEntry> = []
  const locals = initializers(source)

  // Local name to catalog name, for everything that came from an old import or
  // from destructuring a factory.
  const bound = new Map<string, string>()
  // The local names a foreign authoring API binds. Plue's `issue-pipeline.tsx`
  // imports `createSmithers` from `@smithers-ai/workflow` and `Worktree` from
  // `smithers-orchestrator` in the same file, so the factory has to be judged
  // by where it came from, not by its name.
  const foreign = new Set<string>()
  for (const record of Ts.imports(source)) {
    if (Detect.foreignAuthoringApis.includes(record.specifier)) {
      for (const [local] of record.names) foreign.add(local)
      if (record.namespace !== undefined) foreign.add(record.namespace)
    }
  }
  for (const record of Ts.imports(source)) {
    const specifier = record.specifier
    const old = specifier === "smthrs" ||
      specifier === "smithers" ||
      specifier === "smithers-orchestrator" ||
      specifier.startsWith("smthrs/") ||
      specifier.startsWith("smithers/") ||
      specifier.startsWith("smithers-orchestrator/") ||
      specifier.startsWith("@smithers/") ||
      specifier.startsWith("@smthrs/")
    // A pack splits the factory across files: one module calls
    // `createSmithers` and re-exports the bindings, and every workflow imports
    // them from there. Without this the whole pack scans as zero constructs.
    const reexported = options.reexports?.(specifier)
    if (reexported !== undefined) {
      for (const [local, name] of record.names) {
        const resolved = reexported.get(name)
        if (resolved !== undefined) bound.set(local, resolved)
      }
    }
    if (!old) continue
    for (const [local, imported] of record.names) bound.set(local, imported)
  }

  // The `createSmithers` output-table schemas, by key, so `output={outputs.x}`
  // resolves to the zod chain the project actually wrote.
  const schemas = new Map<string, string>()

  Ts.forEachNode(source, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      options.factories.has(Ts.calleeName(node.initializer)) &&
      // A foreign `createSmithers` hands back a foreign `Workflow` and a
      // foreign `Task`. Binding them would file that project's props against
      // 0.x components that never declared them.
      !foreign.has(Ts.calleeName(node.initializer))
    ) {
      for (const [local, imported] of Ts.destructuredNames(node.name)) {
        if (factoryBindings.includes(imported)) bound.set(local, imported)
      }
      const first = node.initializer.arguments[0]
      if (first !== undefined && ts.isObjectLiteralExpression(first)) {
        for (const item of first.properties) {
          if (!ts.isPropertyAssignment(item) || item.name === undefined || !ts.isIdentifier(item.name)) continue
          const value = ts.isIdentifier(item.initializer)
            ? locals.get(item.initializer.text)?.getText()
            : item.initializer.getText()
          if (value !== undefined) schemas.set(item.name.text, value)
        }
      }
    }
  })

  /** The zod chain an `output` prop resolves to, through `outputs.<key>`. */
  const outputChain = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined
    const parts = value.split(".")
    if (parts.length === 2 && bound.get(parts[0] ?? "") === "outputs") return schemas.get(parts[1] ?? "")
    const local = locals.get(value)?.getText()
    return local !== undefined && /^z\s*\./.test(local) ? local : undefined
  }

  /** The `.mdx` element the children of a task render, when there is one. */
  const promptElement = (children: ReadonlyArray<ts.JsxChild>): ts.JsxOpeningLikeElement | undefined => {
    const specifiers = new Map<string, string>()
    for (const record of Ts.imports(source)) {
      if (!record.specifier.endsWith(".mdx")) continue
      for (const [local, imported] of record.names) {
        if (imported === "default") specifiers.set(local, record.specifier)
      }
    }
    const found: Array<ts.JsxOpeningLikeElement> = []
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        if (specifiers.has(Ts.tagName(node))) found.push(node)
      }
      node.forEachChild(visit)
    }
    for (const child of children) visit(child)
    return found.length === 1 ? found[0] : undefined
  }

  /** The specifier one prompt element imports its body from. */
  const promptSpecifier = (element: ts.JsxOpeningLikeElement): string | undefined => {
    for (const record of Ts.imports(source)) {
      if (!record.specifier.endsWith(".mdx")) continue
      for (const [local, imported] of record.names) {
        if (imported === "default" && local === Ts.tagName(element)) return record.specifier
      }
    }
    return undefined
  }

  /** The zod chain one field of an object chain holds. */
  const fieldChain = (chain: string | undefined, field: string): string | undefined => {
    if (chain === undefined) return undefined
    const parsed = parse("chain.ts", `const value = ${chain}`)
    let found: string | undefined
    Ts.forEachNode(parsed, (node) => {
      if (found !== undefined || !ts.isPropertyAssignment(node)) return
      if (node.name === undefined || node.name.getText() !== field) return
      found = node.initializer.getText()
    })
    return found
  }

  /** The zod chain each key of a `deps` prop resolves to. */
  const depsChains = (text: string | undefined): ReadonlyMap<string, string> => {
    const found = new Map<string, string>()
    if (text === undefined) return found
    const parsed = parse("deps.ts", `const value = (${text})`)
    Ts.forEachNode(parsed, (node) => {
      if (!ts.isPropertyAssignment(node) || node.name === undefined) return
      const chain = outputChain(node.initializer.getText())
      if (chain !== undefined) found.set(node.name.getText(), chain)
    })
    return found
  }

  /**
   * The payload fields a step reads, as zod chains, or `undefined` when one of
   * them cannot be resolved from the source.
   *
   * A step's payload is not guessed. It is the `deps` the source declared, or,
   * for a prompt, the value expression behind each prompt prop: `deps.<key>`
   * fields resolve through the declared output schema and `ctx.input.<field>`
   * through the factory's `input` schema. Anything else leaves the payload
   * unresolved, and the hit becomes a guided decision.
   */
  const payloadFields = (
    node: ts.JsxOpeningLikeElement,
    prompt: ts.JsxOpeningLikeElement | undefined
  ): Record<string, string> | undefined => {
    const deps = depsChains(Ts.attributeText(node, "deps"))
    if (prompt === undefined) {
      const fields: Record<string, string> = {}
      for (const [key, chain] of deps) fields[key] = chain
      return fields
    }
    const fields: Record<string, string> = {}
    for (const name of Ts.attributeNames(prompt)) {
      if (name === "...") return undefined
      const value = Ts.attributeText(prompt, name)
      if (value === undefined) return undefined
      const parts = value.split(".")
      const chain = parts.length === 3 && parts[0] === "deps"
        ? fieldChain(deps.get(parts[1] ?? ""), parts[2] ?? "")
        : parts.length === 3 && parts[0] === "ctx" && parts[1] === "input"
        ? fieldChain(schemas.get("input"), parts[2] ?? "")
        : undefined
      if (chain === undefined) return undefined
      fields[name] = chain
    }
    return fields
  }

  /**
   * The expression behind each value a step reads, as the source wrote it:
   * `ctx.input.topic`, or `deps.research.summary`.
   *
   * `undefined` when any of them is anything else. {@link payloadFields} gives
   * the *type* of each value; this gives *where it comes from*, which is what a
   * group's rewrite needs to thread one step's answer into the next one's call.
   */
  const payloadSources = (
    node: ts.JsxOpeningLikeElement,
    prompt: ts.JsxOpeningLikeElement | undefined
  ): Record<string, string> | undefined => {
    const deps = depsChains(Ts.attributeText(node, "deps"))
    if (prompt === undefined) {
      const fields: Record<string, string> = {}
      for (const key of deps.keys()) fields[key] = `deps.${key}`
      return fields
    }
    const fields: Record<string, string> = {}
    for (const name of Ts.attributeNames(prompt)) {
      if (name === "...") return undefined
      const value = Ts.attributeText(prompt, name)
      if (value === undefined) return undefined
      const parts = value.split(".")
      const known = (parts.length === 3 && parts[0] === "deps" && deps.has(parts[1] ?? "")) ||
        (parts.length === 3 && parts[0] === "ctx" && parts[1] === "input")
      if (!known) return undefined
      fields[name] = value
    }
    return fields
  }

  /**
   * The catalog components inside a list of nodes, as `Construct:id` pairs.
   *
   * The walk stops at the first component on each path, so a group records its
   * own steps and not their steps' steps, and it descends through whatever the
   * source wraps them in: a fragment, a conditional, an array, or a prop
   * value.
   */
  const componentsIn = (
    nodes: ReadonlyArray<ts.Node>
  ): ReadonlyArray<
    { construct: string; id: string; opening: ts.JsxOpeningLikeElement; children: ReadonlyArray<ts.JsxChild> }
  > => {
    const found: Array<
      { construct: string; id: string; opening: ts.JsxOpeningLikeElement; children: ReadonlyArray<ts.JsxChild> }
    > = []
    const visit = (node: ts.Node): void => {
      const opening = ts.isJsxElement(node)
        ? node.openingElement
        : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined
      if (opening !== undefined) {
        const construct = bound.get(Ts.tagName(opening))
        if (construct !== undefined && Constructs.isComponent(construct)) {
          // Only a literal id. An id the source computes — Plue's
          // `id={`${id}:review-claude`}` — is not a name this tool may print,
          // and the empty string is how the rewrite is told so.
          const literal = Ts.attributeLiteral(opening, "id") ?? ""
          const id = /[,:]/.test(literal) ? "" : literal
          found.push({
            construct,
            id,
            opening,
            children: ts.isJsxElement(node) ? node.children : []
          })
          return
        }
      }
      node.forEachChild(visit)
    }
    for (const node of nodes) visit(node)
    return found
  }

  /** `Construct:id` pairs, the form a hit's detail carries a child list in. */
  const encodeChildren = (
    children: ReadonlyArray<{ construct: string; id: string }>
  ): string => children.map((child) => `${child.construct}:${child.id}`).join(",")

  /** Each named child step's payload sources, as JSON, for a group's rewrite. */
  const encodePayloads = (
    children: ReadonlyArray<
      { construct: string; id: string; opening: ts.JsxOpeningLikeElement; children: ReadonlyArray<ts.JsxChild> }
    >
  ): string | undefined => {
    const record: Record<string, Record<string, string> | null> = {}
    let any = false
    for (const child of children) {
      if (child.id === "" || !child.construct.startsWith("Task")) continue
      any = true
      const prompt = promptElement(child.children)
      // The source expression and the type behind it have to resolve together.
      // A step reading `ctx.input.topic` where the factory declares no `input`
      // schema has a source but no payload the rewrite can declare, and a call
      // filled from it would name a step whose own action was never written.
      record[child.id] = payloadFields(child.opening, prompt) === undefined
        ? null
        : payloadSources(child.opening, prompt) ?? null
    }
    return any ? JSON.stringify(record) : undefined
  }

  /**
   * Each named child step's declared output schema, as JSON, for a group's
   * rewrite. `null` for a child whose `output` prop resolves to no zod chain.
   */
  const encodeOutputs = (
    children: ReadonlyArray<
      { construct: string; id: string; opening: ts.JsxOpeningLikeElement; children: ReadonlyArray<ts.JsxChild> }
    >
  ): string | undefined => {
    const record: Record<string, string | null> = {}
    let any = false
    for (const child of children) {
      if (child.id === "" || !child.construct.startsWith("Task")) continue
      any = true
      const declared = Ts.attributeText(child.opening, "output") ?? Ts.attributeText(child.opening, "outputSchema")
      record[child.id] = outputChain(declared) ?? null
    }
    return any ? JSON.stringify(record) : undefined
  }

  /** The named child steps that run on an agent. */
  const agentChildren = (
    children: ReadonlyArray<{ id: string; opening: ts.JsxOpeningLikeElement }>
  ): ReadonlyArray<string> =>
    children
      .filter((child) =>
        child.id !== "" &&
        Ts.attributeNames(child.opening).some((name) => name === "agent" || name === "fallbackAgent")
      )
      .map((child) => child.id)

  /** The value expression of one JSX attribute, when it has one. */
  const attributeExpression = (node: ts.JsxOpeningLikeElement, name: string): ts.Expression | undefined => {
    for (const item of node.attributes.properties) {
      if (!ts.isJsxAttribute(item) || item.name.getText() !== name) continue
      const initializer = item.initializer
      if (initializer === undefined || !ts.isJsxExpression(initializer)) return undefined
      return initializer.expression
    }
    return undefined
  }

  Ts.forEachNode(source, (node) => {
    // JSX elements whose tag resolves to a catalog component.
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = Ts.tagName(node)
      const resolved = bound.get(tag) ?? bound.get(tag.split(".")[0] ?? "")
      const construct = resolved === undefined
        ? undefined
        : tag.includes(".")
        ? `${resolved}.${tag.split(".").slice(1).join(".")}`
        : resolved
      if (construct === undefined || !Constructs.isComponent(construct)) return
      const present = Ts.attributeNames(node).filter((name) => name !== "...")
      const detail = attributeDetail(node, present)

      const parent = node.parent
      const children = ts.isJsxElement(parent) && parent.openingElement === node ? parent.children : undefined
      if (children !== undefined) {
        // A lone `{expression}` child is the step's handler, and the braces are
        // JSX syntax around it, not part of the expression.
        const only = children.filter((child) => !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces))
        const single = only.length === 1 ? only[0] : undefined
        const body = single !== undefined && ts.isJsxExpression(single) && single.expression !== undefined
          ? single.expression.getText()
          : children.map((child) => child.getText()).join("").trim()
        if (body !== "") detail["children"] = body
        const named = componentsIn(children)
        if (named.length > 0) {
          detail["childConstructs"] = encodeChildren(named)
          const payloads = encodePayloads(named)
          if (payloads !== undefined) detail["childPayloads"] = payloads
          const outputs = encodeOutputs(named)
          if (outputs !== undefined) detail["childOutputs"] = outputs
          const agents = agentChildren(named)
          if (agents.length > 0) detail["childAgents"] = agents.join(",")
        }
        const prompt = promptElement(children)
        const specifier = prompt === undefined ? undefined : promptSpecifier(prompt)
        const text = specifier === undefined ? undefined : options.prompt?.(specifier)
        if (text !== undefined) detail["promptText"] = text
        // Only a step reads a payload. A group's children are steps, not
        // values, so recording an empty payload on it would say nothing.
        const fields = construct.startsWith("Task") ? payloadFields(node, prompt) : undefined
        if (fields !== undefined) detail["payloadFields"] = JSON.stringify(fields)
      }

      // A component handed to a prop is a step of its own, and the rewrite has
      // to name it: `<Branch then={<Task id="ship" />} />`.
      for (const prop of present) {
        const value = attributeExpression(node, prop)
        if (value === undefined) continue
        const named = componentsIn([value])
        if (named.length > 0) {
          detail[`${prop}Constructs`] = encodeChildren(named)
          const payloads = encodePayloads(named)
          if (payloads !== undefined) detail[`${prop}Payloads`] = payloads
        }
      }

      // The factory's `input` schema is the workflow's payload, and nothing
      // else's, so only a `<Workflow>` hit carries it.
      const payload = schemas.get("input")
      if (construct === "Workflow" && payload !== undefined) detail["payloadChain"] = payload

      // The registry needs a description and 0.x records prose about a workflow
      // in exactly one place: the header comments the CLI reads. A `description`
      // the element itself declared wins, because that came from the element.
      if (construct === "Workflow" && detail["description"] === undefined) {
        const described = options.headers?.get("description") ?? options.headers?.get("display-name")
        if (described !== undefined && described.trim() !== "") detail["description"] = described.trim()
      }

      const chain = outputChain(detail["output"] ?? detail["outputSchema"])
      if (chain !== undefined) detail["outputChain"] = chain

      const agent = detail["agent"] ?? detail["fallbackAgent"]
      const agentInit = agent === undefined ? undefined : locals.get(agent)
      if (agentInit !== undefined) {
        detail["agentExpression"] = agentInit.getText()
        Object.assign(detail, agentDetail(agentInit))
      }

      hits.push(
        entry(file, source, node, construct, present, Object.keys(detail).length === 0 ? undefined : detail)
      )
      return
    }

    // `ctx.<method>` accessors and reads through a factory binding.
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const local = node.expression.text
      if (local === "ctx") {
        const name = node.name.text
        if (ctxMethods.has(name)) hits.push(entry(file, source, node, `ctx.${name}`, []))
        return
      }
      const member = memberConstructs[bound.get(local) ?? ""]
      if (member === undefined) return
      hits.push(
        entry(
          file,
          source,
          node,
          member,
          [],
          member === "db.<member>"
            ? { member: node.name.text }
            : { key: node.name.text }
        )
      )
      return
    }

    // Agent constructors.
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const resolved = bound.get(node.expression.text)
      if (resolved !== undefined && agentNames.has(resolved)) {
        const options = node.arguments?.[0]
        const props = options !== undefined && ts.isObjectLiteralExpression(options)
          ? options.properties.flatMap((property) =>
            "name" in property && property.name !== undefined && ts.isIdentifier(property.name)
              ? [property.name.text]
              : []
          )
          : []
        const model = options !== undefined && ts.isObjectLiteralExpression(options)
          ? options.properties.find((property) =>
            "name" in property && property.name !== undefined && ts.isIdentifier(property.name) &&
            property.name.text === "model"
          )
          : undefined
        const detail = model !== undefined && ts.isPropertyAssignment(model) && ts.isStringLiteral(model.initializer)
          ? { model: model.initializer.text }
          : undefined
        hits.push(entry(file, source, node, resolved, props, detail))
      }
      return
    }

    // Runtime, store, and tool calls.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text
      const resolved = bound.get(name) ?? (options.factories.has(name) ? "createSmithers" : undefined)
      if (
        resolved !== undefined &&
        (runtimeCalls.has(resolved) || agentNames.has(resolved) || factoryCalls.has(resolved))
      ) {
        hits.push(entry(file, source, node, resolved, []))
      }
      return
    }
  })

  return hits.sort((left, right) => left.line - right.line || left.column - right.column)
}

/**
 * The zod schema chains declared in one file, by the name they are bound to.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export const zodChains = (
  file: string,
  text: string,
  parse: typeof Ts.parse = Ts.parse
): ReadonlyArray<{ readonly name: string; readonly chain: string }> => {
  const source = parse(file, text)
  const chains: Array<{ name: string; chain: string }> = []
  Ts.forEachNode(source, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.initializer === undefined) return
    const chain = node.initializer.getText()
    if (!/^z\s*\./.test(chain)) return
    chains.push({ name: node.name.text, chain })
  })
  return chains
}

/**
 * The `.mdx` prompts one file imports, by the local component name.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export const mdxImports = (
  file: string,
  text: string,
  parse: typeof Ts.parse = Ts.parse
): ReadonlyArray<{ readonly local: string; readonly specifier: string }> => {
  const source = parse(file, text)
  const found: Array<{ local: string; specifier: string }> = []
  for (const record of Ts.imports(source)) {
    if (!record.specifier.endsWith(".mdx")) continue
    for (const [local, imported] of record.names) {
      if (imported === "default") found.push({ local, specifier: record.specifier })
    }
  }
  return found
}

const withoutExtension = (file: string): string => file.replace(/\.(?:[cm]?[jt]sx?)$/, "")

/**
 * The factory bindings each module re-exports, by module path without its
 * extension.
 *
 * A real 0.x pack does not call `createSmithers` in the workflow file. One
 * module calls it and re-exports the bindings (`export const { Workflow, Task,
 * outputs } = createSmithers(...)`), and every workflow imports them from
 * there. A scanner that only reads in-file destructuring records nothing for
 * such a pack.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export const factoryReexports = (
  sources: ReadonlyMap<string, string>,
  factories: ReadonlySet<string>,
  parse: typeof Ts.parse = Ts.parse
): ReadonlyMap<string, ReadonlyMap<string, string>> => {
  const modules = new Map<string, ReadonlyMap<string, string>>()
  for (const [file, text] of sources) {
    if (!/\bcreateSmithers\w*\s*\(/.test(text)) continue
    const source = parse(file, text)
    const bindings = new Map<string, string>()
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      if (exported !== true) continue
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isObjectBindingPattern(declaration.name) || declaration.initializer === undefined) continue
        if (!ts.isCallExpression(declaration.initializer)) continue
        if (!factories.has(Ts.calleeName(declaration.initializer))) continue
        for (const [local, imported] of Ts.destructuredNames(declaration.name)) {
          if (factoryBindings.includes(imported)) bindings.set(local, imported)
        }
      }
    }
    if (bindings.size > 0) modules.set(withoutExtension(file), bindings)
  }
  return modules
}

/**
 * Scans every file a migration touches and returns the inventory, sorted by
 * file then position so a report is stable.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export const scan = (
  detection: Detect.Detection,
  parse: typeof Ts.parse = Ts.parse
): Effect.Effect<ReadonlyArray<InventoryEntry>, MigrateError, FileSystem.FileSystem> =>
  Effect.sync(() => {
    const factories = factoryNames(detection.sources, parse)
    const reexports = factoryReexports(detection.sources, factories, parse)
    const files = [
      ...detection.workflowFiles.map((workflow) => workflow.path),
      ...detection.components,
      ...detection.libs,
      ...detection.tests,
      ...detection.uis.filter((ui) => ui.resolved).map((ui) => ui.path)
    ]
    const headers = new Map(detection.workflowFiles.map((workflow) => [workflow.path, workflow.headers]))
    const seen = new Set<string>()
    const hits: Array<InventoryEntry> = []
    for (const file of files) {
      if (seen.has(file)) continue
      seen.add(file)
      const text = detection.sources.get(file)
      if (text === undefined) continue
      const carried = headers.get(file)
      hits.push(...scanFile(file, text, {
        factories,
        parse,
        prompt: (specifier) => detection.sources.get(resolveRelative(file, specifier)),
        reexports: (specifier) =>
          specifier.startsWith(".") ? reexports.get(withoutExtension(resolveRelative(file, specifier))) : undefined,
        ...(carried === undefined ? {} : { headers: carried })
      }))
    }
    return hits.sort((left, right) =>
      Sort.byText(left.file, right.file) || left.line - right.line || left.column - right.column
    )
  })
