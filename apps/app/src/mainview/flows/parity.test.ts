import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import ts from "typescript"

/*
 * The launch-law gate: every interactive affordance in the app routes through
 * the command registry (`runCommand`), never a direct
 * controller call. This test enumerates the action props in every surface
 * file and asserts each one either dispatches through the registry itself or
 * is a delegated prop whose binding site does. Adding a button without a
 * command behind it fails this test.
 */

const read = (relative: string): string => {
  let source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
  // Inspect the shared bindings (flows/FlowAction.ts) as the JSX they spell
  // out, keeping every existing command and affordance check applicable to
  // both binding spellings — the attribute is written in one place now, so a
  // literal `data-flow="…"` no longer appears in a surface file at all.
  const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const edits: Array<{ start: number; end: number; text: string }> = []
  /** The attribute this call spells out, as JSX: `"x.y"` stays a literal, anything else stays an expression. */
  const attribute = (prop: string, node: ts.Expression): string =>
    `${prop}=${ts.isStringLiteral(node) ? JSON.stringify(node.text) : `{${node.getText(tree)}}`}`
  const visit = (node: ts.Node) => {
    if (ts.isJsxSpreadAttribute(node) && ts.isCallExpression(node.expression)) {
      const callee = node.expression.expression.getText(tree)
      const written = (text: string) => edits.push({ start: node.getStart(tree), end: node.end, text })
      if (callee === "flowAction" || callee === "dynamicFlowAction") {
        const [run, name, args] = node.expression.arguments
        if (!run || !name) throw new Error("A flow binding needs its dispatcher and command")
        written(
          `${attribute("data-flow", name)} onClick={() => ${run.getText(tree)}(${name.getText(tree)}${
            args ? `, ${args.getText(tree)}` : ""
          })}`
        )
      } else if (callee === "flowProps" || callee === "dynamicFlowProps") {
        const [name] = node.expression.arguments
        if (!name) throw new Error("A flow binding needs its command")
        written(attribute("data-flow", name))
      } else if (callee === "flowGestureProps") {
        const [name, activate] = node.expression.arguments
        if (!name || !activate) throw new Error("A gesture binding needs its rest and activation commands")
        written(`${attribute("data-flow", name)} ${attribute("data-flow-activate", activate)}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  for (const edit of edits.reverse()) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  return source
}

/**
 * The registry source: the Flows.ts aggregator, every namespace module under
 * ./entries and every shared operation module (`@smthrs/ui/app-operations`),
 * read together so a flow declared in any module counts.
 */
const registrySources = (): string => {
  const entries = fileURLToPath(new URL("./entries/", import.meta.url))
  const shared = fileURLToPath(new URL(".", import.meta.resolve("@smthrs/ui/app-operations")))
  return [
    read("./Flows.ts"),
    ...readdirSync(entries).sort().map((file) => read(`./entries/${file}`)),
    ...readdirSync(shared).sort().map((file) => readFileSync(`${shared}${file}`, "utf8"))
  ].join("\n")
}

/**
 * Every component file under src/mainview, discovered rather than listed: a new
 * surface added with a command-less button has to fail this gate, and a
 * hand-maintained list would silently exempt it.
 */
const surfaceFiles = (): Array<string> => {
  const root = fileURLToPath(new URL("..", import.meta.url))
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".tsx") && !entry.endsWith(".test.tsx"))
    // Design-owned Views have their own AST seam rule below, not legacy pins.
    .filter((entry) => !entry.split("\\").join("/").startsWith("cards/views/") && !["BranchTree.tsx", "EntryRow.tsx", "ContextLine.tsx", "EarlierArchive.tsx", "ToastStackView.tsx", "EdgeMap.tsx", "Timeline.tsx"].includes(entry))
    .map((entry) => `../${entry.split("\\").join("/")}`)
    .sort()
}

const ACTION_PROPS = ["onClick", "onSubmit", "onStop", "onConfirm", "onDecide", "onSelect", "onClose"] as const

interface HandlerRef {
  readonly prop: string
  /** The line the action prop appears on. */
  readonly line: string
  readonly context: string
}

/**
 * Inspect the complete JSX handler; focus handoffs can precede the command.
 * A handler passed as a property of an `actions` object (FailureNotice's
 * `actions={{ retry: { onClick } }}`) is a button too.
 */
const handlers = (source: string): Array<HandlerRef> => {
  const tree = ts.createSourceFile("surface.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lines = source.split("\n")
  const found: Array<HandlerRef> = []
  const isAction = (name: string) => ACTION_PROPS.includes(name as typeof ACTION_PROPS[number])
  const insideActions = (node: ts.Node): boolean => {
    for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
      if (ts.isJsxAttribute(parent)) return parent.name.getText(tree) === "actions"
    }
    return false
  }
  const visit = (node: ts.Node) => {
    const named = ts.isJsxAttribute(node) ||
      ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node)) &&
        insideActions(node))
    if (named && isAction(node.name.getText(tree))) {
      const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line
      found.push({ prop: node.name.getText(tree), line: lines[line]!, context: node.getText(tree) })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

/** Literal JSX bindings, excluding comments, text, and selectors used to find controls. */
const literalBindings = (source: string): Array<{ readonly prop: string; readonly name: string }> => {
  const tree = ts.createSourceFile("surface.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Array<{ readonly prop: string; readonly name: string }> = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node)) {
      const prop = node.name.getText(tree)
      if (prop === "data-flow" || prop === "closeCommand") {
        const value = node.initializer && ts.isJsxExpression(node.initializer)
          ? node.initializer.expression :
          node.initializer
        if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) {
          found.push({ prop, name: value.text })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

/**
 * Handlers that legitimately do NOT dispatch a command, with the reason each
 * is not a launch-law violation. Anything not listed here MUST route through
 * the registry.
 */
const PRESENTATION_ONLY = [
  "setSlashMenu", // slash-menu hover highlight: local presentation state
  "setTag(", // wiki tree tag filter: which tag narrows the tree — local presentation state
  "fileInput.current?.click()", // wiki attach: opening the file dialog is the human's gesture; the chosen file rides wiki.attach through its gesture
  "setCopied", // copy feedback flash; the clipboard write routes via onCopy
  "setSelectedPath", // world card doc selection: which note the embedded editor shows — local presentation state
  "onDismissDrawer(", // graph card detail drawer close: local presentation state (which node is focused)
  "setOpenLog(", // run timeline log panel: which row's log is open — local presentation state
  "setUncapped(", // burndown card: a long group shown past its embedded cap — local presentation state; maximized shows every row
  "setAsking(", // burndown card: whether its stop/resume question is open — local presentation state; the acts ride flow.run.stop / runs.signal / issue-sweep
  "onKeep}", // burndown card: closing that question — local presentation state
  "setDeleteDraft", // workspace card delete: the typed-confirm row's open state and its draft — local presentation state; the act itself rides box.delete
  "onRunCommand(", // delegated: App.tsx binds it to the registry's runCommand
  "onChoose(", // delegated: Composer.tsx routes a palette row through runCommand, or edits the draft (a namespace, a prefix)
  // Card maximize/minimize: each calls the delegated onMaximize/onMinimize (bound to card.maximize /
  // card.minimize at the App.tsx binding site) and then hands focus to the button
  // that replaces the one pressed, so Escape keeps a shell to land on.
  "maximizeThenFocus",
  "minimizeThenFocus",
  "openNamespace", // slash-menu namespace draft edit
  "onCopy(", // delegated: TranscriptMessage.tsx binds it to runCommandForResult("chat.copy-message", ...)
  "onDownload}", // delegated: TranscriptMessage.tsx binds StorageRecoveryButton to storage.recovery.export
  "onDecideApproval(", // delegated: App.tsx binds it to approval.approve / approval.deny
  "onRecoAction(", // delegated: App.tsx binds it to reco.accept / reco.edit / reco.dismiss
  "onGrantConfirm(", // delegated: App.tsx binds it to admin.grant.confirm
  "onGrantCancel(", // delegated: App.tsx binds it to admin.grant.cancel
  "onDismiss(", // delegated: App.tsx binds it to runCommand("toast.dismiss", ...)
  "onMaximize(", // delegated: App.tsx binds it to runCommand("card.maximize", ...)
  "onMinimize(", // delegated: App.tsx binds it to card.minimize
  "onFrameBack", // delegated: App.tsx binds it to frame.back
  "onFrameForward", // delegated: App.tsx binds it to frame.forward
  "onOpen(", // delegated: WikiPageView's card and WorldSurface bindings dispatch wiki navigation commands
  "onConnectGitHub(", // delegated: App.tsx binds it to auth.sign-in
  "onRunWorkflow(", // delegated: App.tsx binds it to runCommand("flow.run", ...)
  "onStopRun(", // delegated: App.tsx binds it to runCommand("flow.run.stop", ...)
  "onRetryRun(", // delegated: App.tsx binds it to runCommand("flow.run.retry", ...)
  "onChooseWorkflowRepo(", // delegated: App.tsx binds it to runCommand("flow.repo.choose", ...)
  "onConfirm}", // SurfaceChrome delegates to its binding site
  "onCancel}", // dismissing a dialog changes no application state
  "onClose}" // SurfaceChrome delegates to its binding site
] as const

// Indirections added with the run cards. Scope each literal
// to its component so a similarly named handler cannot inherit the exception.
const DELEGATED_HANDLERS: Readonly<Record<string, readonly string[]>> = {
  // Pre-boot browser navigation: no writable store/controller exists here.
  // Choosing this document's writer is a human tab gesture, not an app command.
  // The human credential continuation opened by auth.sign-in. Passwords stay
  // in the form and its auth controller, outside the command journal.
  "../LocalAuthPanel.tsx": [
    "onSubmit={submit}",
    "close(event.currentTarget.ownerDocument)",
    "onClick: () => auth.open()"
  ],
  // Bootstrap recovery runs before a controller exists. Backend selection
  // stays in the boot adapter; its credential must never enter a command journal.
  "../AppRoot.tsx": ["onClick={() => window.location.reload()}"], // saved-store failure blocks the command journal; Reload reopens storage
  "../StartupError.tsx": [
    "onClick={useSmithersHere}",
    "onClick={() => window.location.reload()}",
    "onClick: () => window.location.reload()",
    "onClick={() => setChoosing(true)}",
    "await switchBackend(origin, token)"
  ],
  "../ToastAction.tsx": ["onAction(action)"], // ToastStack/App bind the typed action to runCommand(action.flow, action.args)
  "../HelpBubble.tsx": ["onClick={dismiss}"], // restores focus, then onDismiss() dismisses transient help
  "../InputModeMenu.tsx": ["open ? close() : setOpen(true)", "latest.current.onChange(value)"], // transient menu; selection is input.mode at both mounts
  "../cards/WorkflowCards.tsx": ["sendRunCommand("], // the original onRunCommand prop, before the frame wrapper
  "../cards/FlowFormCards.tsx": ["cancel.onClick()"], // card.dismiss after the keyboard focus handoff; the full submit handler is inspected
  "../cards/ApprovalAnswer.tsx": ["onAnswer(", "onClick={send}"], // the answer is a value, not a flow argument; both mounts bind onAnswer to the controller
  "../ToastStack.tsx": ["setExpanded("] // the "+N more" row is a local disclosure of the capped stack
}

const routesThroughRegistry = (context: string): boolean =>
  context.includes("runCommand") || context.includes("onRunCommand") || context.includes("runSlashCommand")

const unwrap = (expression: ts.Expression): ts.Expression => {
  while (
    ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)
  ) expression = expression.expression
  return expression
}

/** Compare the tag expression itself: a neighbouring action's tag is not parity. */
const viewSeamViolations = (source: string, sourceUrl = new URL("../cards/views/CardView.tsx", import.meta.url)): string[] => {
  const tree = ts.createSourceFile("CardView.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const violations: string[] = []
  const declarations = new Map<string, ts.Expression | ts.FunctionDeclaration>()
  // `copyText` from @smthrs/ui is the one clipboard effect a View handler may call (ui-components.md Rules 3).
  const clipboard = new Set<string>()
  const viewChildren = new Set<ts.Identifier>()
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.set(node.name.text, node.initializer)
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      declarations.set(node.name.text, node)
      // Collapsed child Views stay in this scan; only module-level declarations can receive forwarded seams.
      if (ts.isSourceFile(node.parent)) viewChildren.add(node.name)
    }
    if (
      ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
      /^@smthrs\/ui(?:\/.*)?$/.test(node.moduleSpecifier.text) && !node.importClause?.isTypeOnly
    ) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === "copyText") {
            clipboard.add(element.name.text)
          }
        }
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith(".") && !node.importClause?.isTypeOnly) {
      const childUrl = new URL(node.moduleSpecifier.text, sourceUrl)
      const viewsUrl = new URL("../cards/views/", import.meta.url)
      if ((new URL(".", childUrl).href === viewsUrl.href || ["ToastStackView", "EdgeMap", "Timeline"].some(name => childUrl.pathname.endsWith(`/mainview/${name}`))) && !/\.(test|stories)(?:\.tsx?)?$/.test(childUrl.pathname) &&
        ["", ".tsx", ".ts"].some(ext => /\.tsx?$/.test(childUrl.pathname + ext) && existsSync(fileURLToPath(new URL(childUrl.href + ext))))) {
        const bindings = node.importClause?.namedBindings
        if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
          if (!element.isTypeOnly) viewChildren.add(element.name)
        }
        if (node.importClause?.name) viewChildren.add(node.importClause.name)
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(tree)
  /** The identifier that declares `name` in the innermost scope enclosing `from`, the way JavaScript resolves it. */
  const resolveName = (from: ts.Node, name: string): ts.Identifier | undefined => {
    const inBinding = (binding: ts.BindingName): ts.Identifier | undefined => {
      if (ts.isIdentifier(binding)) return binding.text === name ? binding : undefined
      for (const element of binding.elements) {
        if (ts.isOmittedExpression(element)) continue
        const found = inBinding(element.name)
        if (found) return found
      }
      return undefined
    }
    const inStatements = (statements: ts.NodeArray<ts.Statement>): ts.Identifier | undefined => {
      for (const statement of statements) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            const found = inBinding(declaration.name)
            if (found) return found
          }
        } else if (
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name
        ) return statement.name
        else if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause
          if (clause?.name?.text === name) return clause.name
          const bindings = clause?.namedBindings
          if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) return bindings.name
          if (bindings && ts.isNamedImports(bindings)) {
            const element = bindings.elements.find((item) => item.name.text === name)
            if (element) return element.name
          }
        }
      }
      return undefined
    }
    for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
      let found: ts.Identifier | undefined
      if (ts.isFunctionLike(scope)) {
        for (const parameter of scope.parameters) found ??= inBinding(parameter.name)
        if (!found && (ts.isFunctionExpression(scope) || ts.isFunctionDeclaration(scope)) && scope.name?.text === name) {
          found = scope.name
        }
      } else if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope)) {
        found = inStatements(scope.statements)
      } else if (ts.isDefaultClause(scope)) found = inStatements(scope.statements)
      else if (
        (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) && scope.initializer &&
        ts.isVariableDeclarationList(scope.initializer)
      ) {
        for (const declaration of scope.initializer.declarations) found ??= inBinding(declaration.name)
      } else if (ts.isCatchClause(scope) && scope.variableDeclaration) {
        found = inBinding(scope.variableDeclaration.name)
      }
      if (found) return found
    }
    return undefined
  }
  /** The `useState`/`useReducer` declaration whose setter `callee` lexically resolves to, if any. */
  const setterOf = (callee: ts.Identifier): ts.VariableDeclaration | undefined => {
    const element = resolveName(callee, callee.text)?.parent
    if (!element || !ts.isBindingElement(element) || !ts.isArrayBindingPattern(element.parent)) return undefined
    const declaration = element.parent.parent
    if (
      !ts.isVariableDeclaration(declaration) || !declaration.initializer ||
      !ts.isCallExpression(declaration.initializer) ||
      !/^(?:React\.)?use(?:State|Reducer)$/.test(declaration.initializer.expression.getText(tree)) ||
      element.parent.elements.indexOf(element) !== 1
    ) return undefined
    return declaration
  }
  const reducerOf = (declaration: ts.VariableDeclaration): ts.Expression | undefined => {
    const call = declaration.initializer as ts.CallExpression
    return /useReducer$/.test(call.expression.getText(tree)) ? call.arguments[0] : undefined
  }
  /**
   * True when `ref` lexically resolves to `useRef()`, `useRef(null)`, `useRef(undefined)` or `useRef([])`: a DOM ref,
   * or the element list a roving tabindex fills through `ref` callbacks.
   */
  const isDomRef = (ref: ts.Identifier): boolean => {
    const declaration = resolveName(ref, ref.text)?.parent
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false
    const initializer = declaration.initializer
    if (!ts.isCallExpression(initializer) || !/^(?:React\.)?useRef$/.test(initializer.expression.getText(tree))) {
      return false
    }
    const initial = initializer.arguments[0]
    return !initial || unwrap(initial).kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(unwrap(initial)) && unwrap(initial).getText(tree) === "undefined") ||
      (ts.isArrayLiteralExpression(unwrap(initial)) && (unwrap(initial) as ts.ArrayLiteralExpression).elements.length === 0)
  }
  /** `next = …` or `i++` on a variable the handler itself declares: no state outside the handler changes. */
  const assignsOwnLocal = (node: ts.Node, handler: ts.Node): boolean => {
    const target = ts.isBinaryExpression(node)
      ? node.left
      : ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
      ? node.operand
      : undefined
    if (!target || !ts.isIdentifier(target)) return false
    const declaration = resolveName(target, target.text)
    return declaration !== undefined && declaration.pos >= handler.pos && declaration.end <= handler.end
  }
  /** `copyText` imported from @smthrs/ui and not shadowed where it is called. */
  const isClipboard = (callee: ts.Identifier): boolean => {
    if (!clipboard.has(callee.text)) return false
    const declaration = resolveName(callee, callee.text)
    return declaration !== undefined && ts.isImportSpecifier(declaration.parent)
  }
  const mutates = (node: ts.Node): boolean =>
    (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) ||
    ts.isDeleteExpression(node)
  const calledTag = (
    expression: ts.Expression | ts.FunctionDeclaration | undefined,
    seen = new Set<string>()
  ): ts.Expression | undefined => {
    if (!expression) return undefined
    if (ts.isIdentifier(expression)) {
      if (seen.has(expression.text)) return undefined
      seen.add(expression.text)
      return calledTag(declarations.get(expression.text), seen)
    }
    if (!ts.isFunctionDeclaration(expression)) expression = unwrap(expression)
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) || ts.isFunctionDeclaration(expression)) {
      if (!expression.body) return undefined
      if (ts.isBlock(expression.body)) {
        const statements = [...expression.body.statements]
        while (statements.length > 1) {
          const first = statements[0]!
          if (!ts.isExpressionStatement(first) || !ts.isCallExpression(first.expression)) return undefined
          const call = first.expression
          if (!ts.isPropertyAccessExpression(call.expression) || call.arguments.length !== 0 ||
            !/^(?:event|e)$/.test(call.expression.expression.getText(tree)) ||
            !/^(?:preventDefault|stopPropagation)$/.test(call.expression.name.text)) return undefined
          statements.shift()
        }
        if (statements.length !== 1) return undefined
        const statement = statements[0]!
        if (ts.isExpressionStatement(statement) || ts.isReturnStatement(statement)) {
          return calledTag(statement.expression, seen)
        }
        return undefined
      }
      return calledTag(expression.body, seen)
    }
    if (
      !ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression) ||
      expression.expression.text !== "onAction"
    ) return undefined
    const tag = expression.arguments[0]
    if (!tag || expression.arguments.length > 2) return undefined
    let extraCall = false
    const inspectInput = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || mutates(node)) extraCall = true
      ts.forEachChild(node, inspectInput)
    }
    for (const argument of expression.arguments) inspectInput(argument)
    if (extraCall) return undefined
    const value = unwrap(tag)
    return ts.isPropertyAccessExpression(value) && value.name.text === "tag" ? value : undefined
  }
  const functionValue = (
    expression: ts.Expression | ts.FunctionDeclaration | undefined,
    seen = new Set<string>()
  ): ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | undefined => {
    if (!expression) return undefined
    if (!ts.isFunctionDeclaration(expression)) expression = unwrap(expression)
    if (ts.isIdentifier(expression)) {
      if (seen.has(expression.text)) return undefined
      seen.add(expression.text)
      return functionValue(declarations.get(expression.text), seen)
    }
    return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) || ts.isFunctionDeclaration(expression)
      ? expression
      : undefined
  }
  const pureCallback = (
    expression: ts.Expression | ts.FunctionDeclaration | undefined,
    seen = new Set<ts.Node>()
  ): boolean => {
    const callback = functionValue(expression)
    if (!callback?.body || seen.has(callback)) return false
    const next = new Set([...seen, callback])
    let valid = true
    const inspect = (node: ts.Node): void => {
      if (mutates(node) || ts.isNewExpression(node)) valid = false
      if (ts.isCallExpression(node) && !pureCallback(node.expression, next)) valid = false
      ts.forEachChild(node, inspect)
    }
    inspect(callback.body)
    return valid
  }
  const presentationHandler = (
    expression: ts.Expression | ts.FunctionDeclaration | undefined,
    seen = new Set<string>()
  ): boolean => {
    if (!expression) return false
    if (ts.isIdentifier(expression)) {
      if (seen.has(expression.text)) return false
      seen.add(expression.text)
      return presentationHandler(declarations.get(expression.text), seen)
    }
    if (!ts.isFunctionDeclaration(expression)) expression = unwrap(expression)
    if (
      !(ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) ||
        ts.isFunctionDeclaration(expression)) || !expression.body
    ) return false
    const handler = expression
    let valid = true
    let effects = 0
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        effects++
        const callee = node.expression
        const setter = ts.isIdentifier(callee) ? setterOf(callee) : undefined
        if (ts.isIdentifier(callee) && callee.text === "onView") {
          if (node.arguments.length !== 1) valid = false
        } else if (setter) {
          const reducer = reducerOf(setter)
          if (reducer && !pureCallback(reducer)) valid = false
          for (const argument of node.arguments) if (functionValue(argument) && !pureCallback(argument)) valid = false
        } else if (ts.isIdentifier(callee) && isClipboard(callee)) {
          // Copy: its arguments are inspected below like any other call's.
        } else if (ts.isIdentifier(callee) && presentationHandler(callee, new Set(seen))) {
          // A local helper must itself contain only presentation effects.
        } else if (
          ts.isPropertyAccessExpression(callee) && /^(?:focus|preventDefault|stopPropagation)$/.test(callee.name.text)
        ) {
          const receiver = callee.expression.getText(tree)
          // `ref.current.focus()`, or `refs.current[i]?.focus()` for a roving tabindex.
          const current = ts.isElementAccessExpression(callee.expression)
            ? unwrap(callee.expression.expression)
            : callee.expression
          const ref = ts.isPropertyAccessExpression(current) && current.name.text === "current" &&
              ts.isIdentifier(current.expression)
            ? current.expression
            : undefined
          const domRef = ref !== undefined && isDomRef(ref)
          if (!/^(?:event|e)(?:\.currentTarget|\.target)?$/.test(receiver) && !domRef) valid = false
        } else valid = false
      }
      if (ts.isNewExpression(node)) valid = false
      if (mutates(node)) {
        if (
          ts.isBinaryExpression(node) &&
          /^(?:event|e)\.(?:currentTarget|target)\.tabIndex$/.test(node.left.getText(tree))
        ) effects++
        else if (!assignsOwnLocal(node, handler)) valid = false
      }
      ts.forEachChild(node, inspect)
    }
    inspect(expression.body)
    return valid && effects > 0
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "addEventListener"
    ) {
      if (!presentationHandler(node.arguments[1])) violations.push("native listeners must change presentation only")
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes = node.attributes.properties
      const binding = attributes.find((attribute) =>
        ts.isJsxAttribute(attribute) && attribute.name.getText(tree) === "data-flow"
      )
      const dataFlow =
        binding && ts.isJsxAttribute(binding) && binding.initializer && ts.isJsxExpression(binding.initializer)
          ? binding.initializer.expression :
          undefined
      for (const attribute of attributes) {
        if (ts.isJsxSpreadAttribute(attribute)) {
          violations.push("spread attributes can hide a View handler")
          continue
        }
        const name = attribute.name.getText(tree)
        if (!/^on[A-Z]/.test(name) && name !== "gestures") continue
        const expression = attribute.initializer && ts.isJsxExpression(attribute.initializer)
          ? attribute.initializer.expression
          : undefined
        if (["onAction", "onView", "gestures"].includes(name) && expression && ts.isIdentifier(expression) &&
          expression.text === name && ts.isIdentifier(node.tagName)) {
          const callback = resolveName(expression, name)?.parent
          const child = resolveName(node.tagName, node.tagName.text)
          let owner: ts.Node | undefined = node.parent
          while (owner && owner !== callback?.parent?.parent?.parent) owner = owner.parent
          if (callback && ts.isBindingElement(callback) && ts.isObjectBindingPattern(callback.parent) &&
            ts.isParameter(callback.parent.parent) && callback.parent.parent.parent === owner &&
            (callback.propertyName?.getText(tree) ?? callback.name.getText(tree)) === name &&
            child && viewChildren.has(child)) continue
        }
        if (name === "gestures") continue
        const tag = calledTag(expression)
        if (!tag && !presentationHandler(expression)) {
          violations.push(`${name} must call onAction(action.tag) or change presentation`)
        } else if (
          tag &&
          (!dataFlow || unwrap(dataFlow).getText(tree).replace(/\s/g, "") !== tag.getText(tree).replace(/\s/g, ""))
        ) {
          violations.push(`${name} must carry the same action.tag in data-flow`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return violations
}

const containerSeamViolations = (source: string): string[] => {
  const tree = ts.createSourceFile("CardContainer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const helpers = new Set<string>()
  const declarations = new Map<string, ts.Expression>()
  const actionValues: ts.Expression[] = []
  const gestureValues: ts.Expression[] = []
  const handlers: ts.Expression[] = []
  let mutations = 0
  let helperCalls = 0
  const collect = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
      /(?:^|\/)flows\/cardActions(?:\.ts)?$/.test(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings
      if (!node.importClause?.isTypeOnly && bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === "cardActions") {
            helpers.add(element.name.text)
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        declarations.set(node.name.text, node.initializer)
        if (node.name.text === "actions") actionValues.push(node.initializer)
        if (node.name.text === "gestures") gestureValues.push(node.initializer)
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const prop = element.propertyName?.getText(tree) ?? element.name.getText(tree)
          if (ts.isIdentifier(element.name) && (prop === "actions" || prop === "gestures" || prop === "onAction")) {
            declarations.set(element.name.text, ts.factory.createPropertyAccessExpression(node.initializer, prop))
            if (prop === "actions") actionValues.push(node.initializer)
            if (prop === "gestures") gestureValues.push(node.initializer)
          }
        }
      }
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(tree).replace(/["']/g, "") === "actions") {
      actionValues.push(node.initializer)
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(tree).replace(/["']/g, "") === "gestures") {
      gestureValues.push(node.initializer)
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "actions") actionValues.push(node.name)
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "gestures") gestureValues.push(node.name)
    if (
      ts.isJsxAttribute(node) && node.name.getText(tree) === "actions" && node.initializer &&
      ts.isJsxExpression(node.initializer) && node.initializer.expression
    ) actionValues.push(node.initializer.expression)
    if (
      ts.isJsxAttribute(node) && node.name.getText(tree) === "gestures" && node.initializer &&
      ts.isJsxExpression(node.initializer) && node.initializer.expression
    ) gestureValues.push(node.initializer.expression)
    if (
      ts.isJsxAttribute(node) && node.name.getText(tree) === "onAction" && node.initializer &&
      ts.isJsxExpression(node.initializer) && node.initializer.expression
    ) handlers.push(node.initializer.expression)
    if (ts.isJsxSpreadAttribute(node)) {
      actionValues.push(node.expression)
      handlers.push(node.expression)
    }
    if (
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ((ts.isIdentifier(node.left) && node.left.text === "actions") ||
        (ts.isPropertyAccessExpression(node.left) && node.left.name.text === "actions"))
    ) actionValues.push(node.right)
    if (
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ((ts.isIdentifier(node.left) && node.left.text === "gestures") ||
        (ts.isPropertyAccessExpression(node.left) && node.left.name.text === "gestures"))
    ) gestureValues.push(node.right)
    ts.forEachChild(node, collect)
  }
  collect(tree)
  const count = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helpers.has(node.expression.text)) {
      helperCalls++
    }
    if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      /^(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)$/.test(node.expression.name.text)
    ) {
      const receiver = node.expression.expression
      if (
        (ts.isIdentifier(receiver) && receiver.text === "actions") ||
        (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "actions")
      ) mutations++
    }
    // A named gesture written onto the helper's record: `gestures.hover = …`, `bindings.gestures["hover"] = …`.
    if (
      ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
    ) {
      const owner = node.left.expression
      if (
        (ts.isIdentifier(owner) && owner.text === "gestures") ||
        (ts.isPropertyAccessExpression(owner) && owner.name.text === "gestures")
      ) mutations++
    }
    ts.forEachChild(node, count)
  }
  count(tree)
  const fromHelper = (expression: ts.Expression, seen = new Set<string>()): boolean => {
    expression = unwrap(expression)
    if (
      ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) &&
      helpers.has(expression.expression.text)
    ) return true
    if (
      ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === "forScope"
    ) {
      return fromHelper(expression.expression.expression, seen)
    }
    if (
      ts.isPropertyAccessExpression(expression) &&
      (expression.name.text === "actions" || expression.name.text === "gestures" || expression.name.text === "onAction")
    ) return fromHelper(expression.expression, seen)
    if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
      seen.add(expression.text)
      const value = declarations.get(expression.text)
      return value !== undefined && fromHelper(value, seen)
    }
    return false
  }
  return [
    ...(helperCalls === 0 ? ["Container must build actions through flows/cardActions"] : []),
    ...(actionValues.length === 0 ? ["Container must expose actions from cardActions"] : []),
    ...actionValues.filter((value) => !fromHelper(value)).map(() => "actions must come from cardActions"),
    ...gestureValues.filter((value) => !fromHelper(value)).map(() => "gestures must come from cardActions"),
    ...handlers.filter((value) => !fromHelper(value)).map(() => "onAction must come from cardActions"),
    ...(mutations > 0 ? ["Container must not mutate cardActions output"] : [])
  ]
}

/*
 * Shared UI Views that predate the View seam. They are library components with host callback props
 * (`onHeadingClick`, row-attribute spreads), not card Views fed `CardProps`; each host binds their
 * `data-flow` through the spread. Pinned exactly, so a new violation or a new non-compliant shared
 * View fails, and a fixed one fails until it leaves this list.
 */
const SHARED_VIEW_VIOLATIONS: Record<string, string[]> = {
  "vault/OutlineView.tsx": [
    "onClick must call onAction(action.tag) or change presentation", // onHeadingClick?.(heading.line), a host callback
    "spread attributes can hide a View handler" // {...headingProps?.(heading)}, the host's row binding
  ]
}

describe("View and Container catalog seam (C-UI-08)", () => {
  test("every design-owned View handler uses the action or presentation seam", () => {
    const root = fileURLToPath(new URL("../cards/", import.meta.url))
    const files = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.split("\\").join("/").startsWith("views/") && /\.tsx?$/.test(entry) && !/\.(test|stories)\.tsx?$/.test(entry))
    for (const name of ["ActorChip.tsx", "StateWord.tsx", "actorName.ts"]) expect(files).toContain(`views/${name}`)
    for (const file of ["ToastStackView.tsx", "EdgeMap.tsx", "Timeline.tsx"]) {
      expect(viewSeamViolations(read(`../${file}`), new URL(`../${file}`, import.meta.url))).toEqual([])
      for (const seed of [
        'function View({ onAction }) { return <button onClick={() => onAction(action.tag)} /> }',
        'function View() { return <button onClick={() => localStorage.clear()} /> }',
      ]) expect(viewSeamViolations(seed, new URL(`../${file}`, import.meta.url)).length).toBeGreaterThan(0)
      expect(viewSeamViolations('function View({ onView }) { return <button onClick={() => onView({ jump_to: "entry-12", on_screen: ["entry-11", "entry-12"], timeline_visible: true })} /> }', new URL(`../${file}`, import.meta.url))).toEqual([])
    }
    expect(
      files.flatMap((file) => viewSeamViolations(read(`../cards/${file}`), new URL(`../cards/${file}`, import.meta.url)).map((violation) => `${file}: ${violation}`))
    ).toEqual([])
  })

  test("conversation shell paths enforce the seam and reject file-specific seeds (C-UI-08)", () => {
    for (const name of ["BranchTree.tsx", "EntryRow.tsx", "ContextLine.tsx", "EarlierArchive.tsx"]) {
      const url = new URL(`../${name}`, import.meta.url)
      expect(existsSync(fileURLToPath(url))).toBe(true)
      expect(viewSeamViolations(readFileSync(url, "utf8"), url)).toEqual([])
      for (const seed of ['<button onClick={() => launch()} />', '<button onClick={() => onAction(action.tag, action.args)} />']) {
        expect(viewSeamViolations(seed, url).length).toBeGreaterThan(0)
      }
      expect(viewSeamViolations('<button data-flow={action.tag} onClick={() => onAction(action.tag, action.args)} />', url)).toEqual([])
      expect(viewSeamViolations('<button onClick={() => onView({ selected_branch: "main" })} />', url)).toEqual([])
    }
  })

  test("every shared UI View handler uses the action or presentation seam (C-UI-08 step 4)", () => {
    const root = fileURLToPath(new URL("../../../../../packages/smithers/ui/src/", import.meta.url))
    const files = readdirSync(root, { recursive: true, encoding: "utf8" })
      .map((entry) => entry.split("\\").join("/"))
      .filter((entry) => entry.endsWith("View.tsx") || ["actor-chip.tsx", "state-word.tsx"].includes(entry))
      .sort()
    for (const name of ["actor-chip.tsx", "state-word.tsx"]) {
      if (readdirSync(root).includes(name)) expect(files).toContain(name)
      expect(viewSeamViolations('<img onError={event => { event.currentTarget.hidden = true }} />')).not.toEqual([])
      expect(viewSeamViolations('const [failed, setFailed] = useState(false); const chip = <img onError={() => setFailed(true)} />')).toEqual([])
    }
    expect(files.length).toBeGreaterThan(0)
    const found = Object.fromEntries(
      files.map((file) => [file, viewSeamViolations(readFileSync(`${root}${file}`, "utf8"), new URL(`file://${root}${file}`))] as const)
        .filter(([, violations]) => violations.length > 0)
    )
    expect(found).toEqual(SHARED_VIEW_VIOLATIONS)
  })

  test("event suppression preserves accepted calls and scanned View forwarding", () => {
    for (const call of ["onAction(action.tag)", "onView({ open: true })", "setOpen(true)", "copyText(model.text)"]) {
      expect(viewSeamViolations(`import { copyText } from "@smthrs/ui/copy"; const [open, setOpen] = useState(false); const view = <button data-flow={action.tag} onClick={event => { event.preventDefault(); event.stopPropagation(); ${call} }} />`)).toEqual([])
    }
    expect(viewSeamViolations('function Child({ action, onAction }) { return <button data-flow={action.tag} onClick={() => onAction(action.tag)} /> } function View({ onAction }) { return <Child onAction={onAction} /> }')).toEqual([])
    for (const source of [
      'function Child({ onAction }) { return <button onClick={() => localStorage.clear()} /> } function View({ onAction }) { return <Child onAction={onAction} /> }',
      'function Child({ action, onAction }) { return <button data-flow={action.tag} onClick={() => onAction(action.tag)} /> } function View() { const onAction = () => localStorage.clear(); return <Child onAction={onAction} /> }',
    ]) expect(viewSeamViolations(source).length).toBeGreaterThan(0)
    expect(viewSeamViolations('import { ActorChip } from "./ActorChip"; function View({ onAction, onView, rows }) { return rows.map(row => <ActorChip onAction={onAction} onView={onView} />) }')).toEqual([])
    expect(viewSeamViolations('import { ActorChip } from "./ActorChip"; function View({ onView, rows }) { return rows.map(onView => <ActorChip onView={onView} />) }').length).toBeGreaterThan(0)
    expect(viewSeamViolations('import { ActorChip } from "./ActorChip"; function View({ onAction, onView, gestures }) { return <ActorChip onAction={onAction} onView={onView} gestures={gestures} /> }')).toEqual([])
    for (const source of [
      '<button onClick={event => { event.preventDefault(); runCommand("run") }} />',
      'import { ActorChip } from "./ActorChip"; const view = <ActorChip onAction={() => run()} />',
      'import { Child } from "../Child"; const view = <Child onAction={onAction} />',
      '<button onClick={event => { event.preventDefault(); onAction(action.tag); onAction(action.tag) }} />',
    ]) expect(viewSeamViolations(source).length).toBeGreaterThan(0)
  })

  for (const [name, source] of [
    ["local callback", 'import { ActorChip } from "./ActorChip"; function View() { const onAction = () => localStorage.setItem("x", "y"); return <ActorChip onAction={onAction} /> }'],
    ["shadowed child", 'import { ActorChip } from "./ActorChip"; function View({ onAction }) { const ActorChip = () => <button />; return <ActorChip onAction={onAction} /> }'],
  ]) test(`View forwarding rejects ${name}`, () => {
    expect(viewSeamViolations(source!).length).toBeGreaterThan(0)
  })

  test("nested row callbacks resolve the enclosing View prop without accepting shadows", () => {
    expect(viewSeamViolations('import { ActorChip } from "./ActorChip"; function View({ onAction }) { return items.map(item => item.rows.map(row => <ActorChip onAction={onAction} />)) }')).toEqual([])
    expect(viewSeamViolations('import { ActorChip } from "./ActorChip"; function View({ onAction }) { return items.map(onAction => <ActorChip onAction={onAction} />) }').length).toBeGreaterThan(0)
  })

  test("onAction forwards the action's opaque tag and optional form input", () => {
    for (
      const handler of [
        "() => onAction(action.tag)",
        "() => onAction(action.tag, { answer })",
        "() => { onAction(action.tag) }",
        "() => { return onAction(action.tag) }"
      ]
    ) {
      expect(viewSeamViolations(`<button data-flow={action.tag} onClick={${handler}} />`)).toEqual([])
    }
    expect(
      viewSeamViolations(
        "const send = () => onAction(row.action.tag); const view = <button data-flow={row.action.tag} onClick={send} />"
      )
    ).toEqual([])
    expect(viewSeamViolations("// <button onClick={() => bad()} />\nconst view = <p>onClick is text</p>")).toEqual([])
  })

  test("view patches and transient React or DOM handlers preserve the seam", () => {
    for (
      const source of [
        "<button onClick={() => onView({ maximized: true })} />",
        "const [open, setOpen] = useState(false); const view = <button onClick={() => setOpen(!open)} />",
        "const reducer = (state, action) => state + 1; const [highlight, dispatch] = React.useReducer(reducer, 0); const view = <button onKeyDown={() => dispatch({ type: \"next\" })} />",
        "const [value, setValue] = useState(\"\"); const view = <><input value={value} onChange={e => setValue(e.target.value)} /><button data-flow={action.tag} onClick={() => onAction(action.tag, { value })} /></>",
        "<button onKeyDown={event => { if (event.key === \"Escape\") event.currentTarget.focus() }} />",
        "const [open, setOpen] = useState(false); const view = <button onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} />",
        "<button onKeyDown={e => { e.currentTarget.tabIndex = 0; e.currentTarget.focus() }} />",
        "<button onKeyDown={e => { e.currentTarget.tabIndex = -1 }} />",
        "const [open, setOpen] = useState(false); const close = () => setOpen(false); const view = <button onKeyDown={e => { if (e.key === \"Escape\") close() }} />",
        "const inputRef = useRef(null); const focus = () => inputRef.current?.focus(); const view = <button onClick={focus} />",
        "const [open, setOpen] = useState(false); const close = () => setOpen(false); ref.current.addEventListener(\"keydown\", close)",
        "ref.current.addEventListener(\"focus\", event => event.currentTarget.focus())"
      ]
    ) expect(viewSeamViolations(source)).toEqual([])
    for (
      const source of [
        "const view = <button onClick={() => dispatch({ type: \"save\" })} />",
        "const [open, setOpen] = useState(false); const view = <button onClick={() => { setOpen(true); onRetry() }} />",
        "<button onClick={() => { model.value = \"changed\"; onView({ tab: \"files\" }) }} />",
        "ref.current.addEventListener(\"click\", () => onRetry())",
        "const retry = () => onRetry(); ref.current.addEventListener(\"click\", retry)",
        "const retry = () => onRetry(); const indirect = retry; ref.current.addEventListener(\"click\", indirect)",
        "const retry = () => onAction(action.tag); ref.current.addEventListener(\"click\", retry)",
        "ref.current.addEventListener(\"click\", unknownCallback)",
        "ref.current.addEventListener(\"click\", { handleEvent: () => onRetry() })",
        "const close = () => model.open = false; const view = <button onClick={close} />",
        "const dispatch = input => onRetry(input); const view = <button onClick={() => dispatch({ type: \"next\" })} />",
        "const [open, setOpen] = useState(false); const view = <button onClick={() => setOpen(onRetry())} />",
        "<button onClick={() => onView({ maximized: onRetry() })} />",
        "<button onClick={() => onView()} />",
        "<button onClick={() => onView({ maximized: true }, extra)} />",
        "<button onKeyDown={e => { model.tabIndex = 0; e.currentTarget.focus() }} />",
        "<button onKeyDown={e => { delete model.title; e.currentTarget.focus() }} />",
        "<button onClick={() => unrelated.focus()} />",
        "<button onClick={() => controller.current.focus()} />",
        "<button onClick={() => authority.current.focus()} />",
        "const authority = useRef({ focus: onRetry }); const view = <button onClick={() => authority.current.focus()} />",
        "const close = () => close(); const view = <button onClick={() => close()} />",
        "const close = () => again(); const again = () => close(); ref.current.addEventListener(\"click\", close)"
      ]
    ) expect(viewSeamViolations(source).length).toBeGreaterThan(0)
  })

  test("Copy through copyText from @smthrs/ui is a clipboard handler; other copies and calls are not", () => {
    for (
      const source of [
        "import { copyText } from \"@smthrs/ui\"; const view = <button onClick={() => copyText(model.text)} />",
        "import { copyText as copy } from \"@smthrs/ui/copy\"; const view = <button onClick={() => copy(model.ssh_line)} />",
        "import { copyText } from \"@smthrs/ui\"; const [copied, setCopied] = useState(false); const view = <button onClick={() => { copyText(model.text); setCopied(true) }} />"
      ]
    ) expect(viewSeamViolations(source)).toEqual([])
    for (
      const source of [
        "const view = <button onClick={() => copyText(model.text)} />",
        "import { copyText } from \"./clipboard\"; const view = <button onClick={() => copyText(model.text)} />",
        "import type { copyText } from \"@smthrs/ui\"; const view = <button onClick={() => copyText(model.text)} />",
        "import { copyText } from \"@smthrs/ui\"; const Row = ({ copyText }) => <button onClick={() => copyText(model.text)} />",
        "import { copyText } from \"@smthrs/ui\"; const view = <button onClick={() => copyText(onRetry())} />",
        "const view = <button onClick={() => navigator.clipboard.writeText(model.text)} />"
      ]
    ) expect(viewSeamViolations(source).length).toBeGreaterThan(0)
  })

  test("React setters, refs and handler locals resolve by lexical scope, not by name", () => {
    expect(
      viewSeamViolations(
        "function Local() { const [open, setOpen] = useState(false); return <button onClick={() => setOpen(!open)} /> }\n" +
          "function BadView({ setOpen }) { return <button onClick={() => setOpen(\"save\")} /> }"
      )
    ).toEqual(["onClick must call onAction(action.tag) or change presentation"])
    for (
      const source of [
        "function Local() { const [open, setOpen] = useState(false); const close = () => setOpen(false); return <button onKeyDown={close} /> }",
        "function Tree() { const [active, setActive] = useState(0); const refs = useRef([]); function onKeyDown(event) { let next = active; if (event.key === \"End\") next = 3; event.preventDefault(); setActive(next); refs.current[next]?.focus() } return <div onKeyDown={onKeyDown} /> }",
        "const inputRef = useRef(); const view = <button onClick={() => inputRef.current.focus()} />"
      ]
    ) expect(viewSeamViolations(source)).toEqual([])
    for (
      const source of [
        "const [open, setOpen] = useState(false); const view = rows.map((setOpen) => <button onClick={() => setOpen(1)} />)",
        "function Local() { const [open, setOpen] = useState(false); return null } const view = <button onClick={() => setOpen(true)} />",
        "const [open, setOpen] = useState(false); const view = <button onClick={() => open()} />",
        "const refs = useRef([authority]); const view = <div onKeyDown={() => refs.current[0].focus()} />",
        "function Local() { const refs = useRef([]); return null } const view = <div onKeyDown={() => refs.current[0].focus()} />",
        "let count = 0; const view = <button onClick={() => { count++ }} />",
        "let next = 0; const view = <button onKeyDown={e => { next = 1; e.currentTarget.focus() }} />"
      ]
    ) expect(viewSeamViolations(source).length).toBeGreaterThan(0)
  })

  test("reducers and state updater callbacks cannot hide commands", () => {
    for (
      const source of [
        "const [open, setOpen] = useState(false); const view = <button onClick={() => setOpen(previous => !previous)} />",
        "const toggle = previous => !previous; const [open, setOpen] = useState(false); const view = <button onClick={() => setOpen(toggle)} />",
        "const [index, dispatch] = useReducer((state, action) => action.type === \"next\" ? state + 1 : state - 1, 0); const view = <button onClick={() => dispatch({ type: \"next\" })} />"
      ]
    ) expect(viewSeamViolations(source)).toEqual([])
    for (
      const source of [
        "const reducer = (state, action) => { onRetry(); return state }; const [index, dispatch] = useReducer(reducer, 0); const view = <button onClick={() => dispatch({ type: \"next\" })} />",
        "const [index, dispatch] = useReducer((state, action) => { onAction(action.tag); return state }, 0); const view = <button onClick={() => dispatch({ type: \"next\" })} />",
        "const reducer = (state, action) => { model.index = state + 1; return state }; const [index, dispatch] = useReducer(reducer, 0); const view = <button onClick={() => dispatch({ type: \"next\" })} />",
        "const update = previous => { onRetry(); return previous }; const [open, setOpen] = useState(false); const view = <button onClick={() => setOpen(update)} />",
        "const update = previous => { onView({ tab: \"files\" }); return previous }; const [open, setOpen] = useState(false); const view = <button onClick={() => setOpen(update)} />",
        "const [open, setOpen] = useState(false); const view = <button onClick={() => setOpen(previous => { onRetry(); return previous })} />"
      ]
    ) expect(viewSeamViolations(source).length).toBeGreaterThan(0)
  })

  test("unbound, mismatched, direct command, hidden and alternate handlers are rejected", () => {
    for (
      const source of [
        "<button onClick={() => onAction(action.tag)} />",
        "<button data-flow={other.tag} onClick={() => onAction(action.tag)} />",
        "<button data-flow=\"todo.retry\" onClick={() => onAction(action.tag)} />",
        "<button data-flow={action.tag} onClick={() => controller.runCommand(action.tag)} />",
        "<button data-flow={action.tag} onClick={() => onAction(\"todo.retry\")} />",
        "<button data-flow={action.tag} onClick={() => { mutate(); onAction(action.tag) }} />",
        "<button data-flow={action.tag} onClick={() => onAction(action.tag, mutate())} />",
        "<button data-flow={action.tag} onClick={() => onAction(action.tag, { value: (model.value = \"changed\") })} />",
        "<button data-flow={action.tag} onClick={() => onAction(action.tag, { value: model.value++ })} />",
        "<input data-flow={action.tag} onChange={() => mutate()} />",
        "<button {...hiddenHandlers} data-flow={action.tag} />",
        "const send = () => mutate(); const view = <button data-flow={action.tag} onClick={send} />",
        "const send = again; const again = send; const view = <button data-flow={action.tag} onClick={send} />"
      ]
    ) expect(viewSeamViolations(source).length).toBeGreaterThan(0)
  })

  test("every Container constructs actions through the typed catalog helper", () => {
    const root = fileURLToPath(new URL("..", import.meta.url))
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((entry) =>
      entry.endsWith("Container.tsx")
    )
    expect(
      files.flatMap((file) => containerSeamViolations(read(`../${file}`)).map((violation) => `${file}: ${violation}`))
    ).toEqual([])
  })

  test("Container helper provenance survives imports, aliases and destructuring", () => {
    for (
      const source of [
        "import { cardActions } from \"../flows/cardActions\"; const { actions, onAction } = cardActions(run, definitions); const view = <View actions={actions} onAction={onAction} />",
        "import { cardActions as bind } from \"../flows/cardActions\"; const bindings = bind(run, definitions); const view = <View actions={bindings.actions} onAction={bindings.onAction} />",
        "import { cardActions } from \"../flows/cardActions\"; const actions = cardActions(run, definitions).actions; const props = { actions: actions };",
        "import { cardActions } from \"../flows/cardActions\"; const bindings = cardActions(run, definitions); const view = <View model={model} {...bindings} />",
        "import { cardActions } from \"../flows/cardActions\"; const bindings = cardActions(run, definitions); const row = bindings.forScope(\"T12\"); const view = <View actions={row.actions} onAction={row.onAction} />",
        "import { cardActions } from \"../flows/cardActions\"; const bindings = cardActions(run, definitions); const { actions, onAction } = bindings.forScope(\"T13\"); const view = <View actions={actions} onAction={onAction} />",
        "import { cardActions } from \"../flows/cardActions\"; const { actions, gestures, onAction } = cardActions(run, definitions); const view = <View actions={actions} gestures={gestures} onAction={onAction} />",
        "import { cardActions } from \"../flows/cardActions\"; const bindings = cardActions(run, definitions); const row = bindings.forScope(\"T12\"); const view = <View actions={bindings.actions} gestures={row.gestures} onAction={row.onAction} />"
      ]
    ) expect(containerSeamViolations(source)).toEqual([])
  })

  test("inline action arrays and lookalike helpers cannot satisfy the Container rule", () => {
    for (
      const source of [
        "const actions = [{ tag: \"todo.retry\" }]; const view = <View actions={actions} />",
        "import { controllerCardActions as cardActions } from \"../cards/controllerCardActions\"; const actions = cardActions(controller);",
        "import { cardActions } from \"../flows/cardActions\"; cardActions(run, definitions); const view = <View actions={[{ tag: \"todo.retry\" }]} />",
        "import { cardActions } from \"../flows/cardActions\"; const bindings = cardActions(run, definitions); bindings.actions = [];",
        "import { cardActions } from \"../flows/cardActions\"; const bindings = cardActions(run, definitions); bindings.actions.push({ tag: \"todo.retry\" });",
        "import { cardActions } from \"../flows/cardActions\"; const bindings = cardActions(run, definitions); const view = <View actions={bindings.actions} onAction={() => directCommand()} />",
        "import { cardActions } from \"../flows/cardActions\"; const actions = []; const props = { actions }; cardActions(run, definitions);",
        "import type { cardActions } from \"../flows/cardActions\"; const actions = cardActions(run, definitions);",
        "import { cardActions } from \"../flows/cardActions\"; cardActions(run, definitions); const view = <View />",
        "import { cardActions } from \"../flows/cardActions\"; const bindings = cardActions(run, definitions); const view = <View actions={bindings.actions} gestures={{ hover: { tag: \"file\", label: \"Hover\" } }} onAction={bindings.onAction} />",
        "import { cardActions } from \"../flows/cardActions\"; const bindings = cardActions(run, definitions); const gestures = { hover: { tag: \"file\", label: \"Hover\" } }; const view = <View actions={bindings.actions} gestures={gestures} onAction={bindings.onAction} />",
        "import { cardActions } from \"../flows/cardActions\"; const bindings = cardActions(run, definitions); bindings.gestures.hover = { tag: \"file\", label: \"Hover\" }; const view = <View {...bindings} />",
        "import { cardActions } from \"../flows/cardActions\"; const bindings = cardActions(run, definitions); bindings.gestures = {}; const view = <View {...bindings} />"
      ]
    ) expect(containerSeamViolations(source).length).toBeGreaterThan(0)
  })
})

describe("launch-law parity: every affordance is a command", () => {
  const files = Object.fromEntries(surfaceFiles().map((file) => [file, read(file)]))

  test("the discovered surface set covers every component file", () => {
    // A new .tsx under src/mainview joins the scan automatically; this pins that
    // discovery actually found the known surfaces (a broken glob fails loudly).
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "../App.tsx",
        "../TranscriptMessage.tsx",
        "../ChatCards.tsx",
        "../SurfaceChrome.tsx"
      ])
    )
  })

  test("every action prop routes through the registry or is allowlisted", () => {
    const violations: Array<string> = []
    for (const [file, source] of Object.entries(files)) {
      for (const handler of handlers(source)) {
        if (routesThroughRegistry(handler.context)) continue
        // The allowlist exempts the handler that NAMES the token, not any
        // handler that happens to sit near one: a complete one-line
        // handler matches against its own line only, so it can no longer
        // ride a neighbour's exemption through the four-line window. A
        // handler that opens a multi-line body may name its token on the
        // body's own lines.
        const opensBody = /=>\s*\{?\s*$/.test(handler.line)
        const allowance = opensBody ? handler.context : handler.line
        if (PRESENTATION_ONLY.some((token) => allowance.includes(token))) continue
        if (DELEGATED_HANDLERS[file]?.some((token) => allowance.includes(token))) continue
        violations.push(`${file}: ${handler.prop} → ${handler.context.split("\n")[0]?.trim()}`)
      }
    }
    expect(violations).toEqual([])
  })

  test("the focused guide and run-card indirections retain their bindings", () => {
    const startup = files["../StartupError.tsx"]!
    expect(startup).toContain("await switchBackend(origin, token)")
    expect(startup).toContain("switchBackendTarget(target, token, window.location.origin)")
    expect(files["../LocalAuthPanel.tsx"]).toContain("void auth.submit({")
    expect(files["../LocalAuthPanel.tsx"]).toContain("auth.close()")
    expect(files["../HelpBubble.tsx"]).toContain("onDismiss()")
    expect(files["../InputModeMenu.tsx"]).toContain("data-flow=\"input.mode\"")
    for (const file of ["../App.tsx"]) {
      expect(files[file]).toContain("onChange={mode => controller.runCommand(\"input.mode\", mode)}")
    }
    expect(files["../cards/WorkflowCards.tsx"]).toContain("onRunCommand: sendRunCommand")
    const form = files["../cards/FlowFormCards.tsx"]!
    expect(form).toContain('onRunCommand("form.submit", card.id)')
    expect(form).toContain('const cancel = flowAction(onRunCommand, "card.dismiss", card.id)')
    // Visibility is a host lifecycle observation, not a button or a command.
  })

  test("the expected affordances are all present (removal fails loudly too)", () => {
    // Files with no affordances at all (the composition root) are not pinned;
    // the moment one grows a handler it appears here and must be accounted for.
    const counts = Object.fromEntries(
      Object.entries(files)
        .map(([file, source]) => [file, handlers(source).length] as const)
        .filter(([, count]) => count > 0)
    )
    expect(counts).toEqual({
      // Toast dismissal is owned by ToastStack; includes dock Close and dictation controls.
      // Close, Back and Next all dispatch onboarding.act through IntroSlidesShell.
      // The optional capability reel after the last lesson: its launch pill and its Back.
      // Delegates to the shared onboarding and existing app flows; the Command-K overlay is the summoned composer with no chrome of its own.
      /*
       * The chrome Sign in button (LOCAL-APP.md: sign-in is an option in the
       * chrome, never a gate on the chat) is SessionNavigation's one handler
       * below.
       *
       * Shell bindings stay here; composer bindings are pinned independently
       * now that the hot path is its own module.
       */
      // 15 − the corner balance chip: the balance is one act away (/balance), never main-page chrome.
      // +1 (ask 5): the Flows pane's back-to-conversation close, like World's.
      // +1: the Flows pane's Triggers button, the button door of triggers.list.
      // +1 (Librarian L5): the Wiki pane's Graph button, the button door of wiki.graph.
      "../AgentMark.tsx": 1, // A persona that resolves to an agent profile is a door to the roster.
      "../App.tsx": 4, // -1: the shell has four handlers; main's five-count baseline was already stale.
      "../AppRoot.tsx": 1, // saved-store recovery Reload, with no writable command journal.
      "../ChatFilterMenu.tsx": 2,
      // Shared by the workspace and tutorial: copy, message CTA, retry, and explain.
      "../TranscriptMessage.tsx": 3,
      "../LocalAuthPanel.tsx": 4, // Includes the failed read's Retry, a FailureNotice action.
      "../StartupError.tsx": 7, // Runtime Reload, writer takeover/reload, backend chooser, credential submission, and the bootstrap Retry (a FailureNotice action).
      "../StorageRecoveryButton.tsx": 1,
      "../WorldSurface.tsx": 15, // The wiki spaces (#1922): the switch, New page, Graph, Edit (wiki.view), History/Rename/Delete for a page and an attachment, Attach, the local note's delete, and the empty state's New page / Create Wiki.
      "../WikiDeleteDialog.tsx": 1, // The Wiki confirmation moved to the shared shell; its command remains wiki.delete.confirm.
      "../HelpBubble.tsx": 1,
      "../InputModeMenu.tsx": 2,
      "../SessionNavigation.tsx": 1, // -1: the wordmark is a static mark; the sidebar it toggled is gone.
      "../cards/CodingVibeCard.tsx": 1,
      "../cards/RepositoryUpdateCard.tsx": 2,
      /*
       * The Library (the `plugins` surface and the guided introduction share
       * it): Install and Remove on a row, and the rail button each installed
       * plugin contributed. Every one is a delegated prop its binding site
       * runs through the registry.
       */
      /* 11 = 10 + the origin chip's "rev N exists · view" (lane change step 4; renders only when both seqs are known). */
      // Send and Stop, plus the prompt queue: Queue, Resume, Edit and Remove.
      "../Composer.tsx": 6,
      /*
       * 3 — the GitHub connect / disconnect pair and the empty state's own
       * import affordance (§11.6). The connected list carries no control.
       * The local-repository row and the disconnect dialog went with the
       * local backend (docs/LOCAL-BACKEND-RETIREMENT.md).
       */
      /*
       * The card shell: the maximize backdrop, the frame back / forward /
       * fork, the maximized card's "Open in tab" (docs/LOCAL-APP.md "Cards"),
       * Restore and Maximize. Every card body lives in its family file under
       * cards/ and is pinned there.
       */
      "../ChatCards.tsx": 8, // Includes the card error boundary's Reload app, a FailureNotice action (chat.reload).
      "../ChatRunTimeline.tsx": 1,
      /* The turn's approval card: approve and deny. */
      "../cards/ApprovalCard.tsx": 2,
      /*
       * The answer box for a gate that asks a question rather than for a
       * grant: Yes, No, one per select option, and Send answer. They carry a
       * VALUE — what the person wrote — which no flow argument string can hold,
       * so they call the controller's answerApproval through the card's own
       * onAnswer prop rather than runCommand.
       */
      "../cards/ApprovalAnswer.tsx": 4,
      /* The access-request queue's Approve. */
      /*
       * The run card's lane-runs acts: the two secondary tabs under the trace
       * (Steps, Transcript; Events under verbose), Check again and Stop
       * watching, launch Retry, Stop, Run again, the steer row's send, the
       * repository chooser's row and the workflow list's Run.
       */
      "../cards/WorkflowCards.tsx": 16, // Includes a failed launch's Retry, a FailureNotice action (flow.run.retry).
      "../DevtoolsPanel.tsx": 2, // + Reset conversation, admin.reset.ask's door since the rail left (#3334).
      "../SearchPalette.tsx": 6, // + Ask Smithers, the first row of an empty ⌘K
      "../SurfaceChrome.tsx": 3,
      "../ToastAction.tsx": 1,
      "../ToastStack.tsx": 2, // + the capped stack's "+N more" row (#3420)
      /* The multi-parity domain cards: every handler routes through onRunCommand. */

      "../cards/IssueCards.tsx": 11, // + the detail's comment box submit (issues.comment), the thread rows, the kind chips and the saved view toggles
      "../cards/IssueThread.tsx": 3, // The chat body: composer submit and send, reaction toggles, Retry, Resolve an unknown delivery, the parent link, the state acts.
      "../cards/LandingCards.tsx": 5, // Includes the durable PR tab flow.
      "../cards/FileCards.tsx": 3,
      /* A row's Test, Edit, Remove and select; New; and the attention row's Assign, Test or Edit. */
      /* Mark-all-read. */
      "../cards/EnvCard.tsx": 3,
      /* The account card's Sign out door (auth.sign-out through onRunCommand). */
      "../cards/AccountCard.tsx": 1, // The permissions read's Retry (account.show) is a FailureNotice action.
      /* 2 = Try again + the done state's Open the workspace (lane sync). */
      "../cards/RepoImportCard.tsx": 2,
      // The tutorial's ranked chooser: one row button plus Skip.
      "../cards/RepositoryChoiceCard.tsx": 2,
      "../cards/RepositoryHomeCard.tsx": 3,

      "../cards/SyncCards.tsx": 5,
      /* The /theme picker: nine swatches, one shared handler through onRunCommand. */
      /*
       * Lane citc: the workspace card's five facet tabs, the terminal facet's
       * Open and per-session Destroy, the snapshots' Fork-from, Template and
       * Delete, Suspend, Resume, Fork, Snapshot, the failed card's Retry, and
       * the typed delete confirm — all through onRunCommand; the draft input
       * rides the allowlist above. 15 = 13 + lane L3's ssh-host Copy (through
       * chat.copy-message) and the Egress facet's "Load older"; the Files
       * facet's rows belong to the imported FileListCardBody and are counted
       * in its file. Retained facets: terminal, browser, editor, files and status.
       */
      "../cards/WorkspaceCard.tsx": 14,
      /* The trace owns selection, views, filters and child navigation.
       * The extracted strip selects recorded sequences; summary actions reuse
       * approvals.open and runs.resume; goals reuse runs.coding.select. */
      "../cards/RunTraceCard.tsx": 14, // Includes the graph view door, the Steps view door, and a message trigger's Open (agent.session.view).
      "../cards/RunTraceSteps.tsx": 1, // Each step row selects its span.
      "../cards/RunTracePhaseStrip.tsx": 3,
      "../cards/RunTraceSummary.tsx": 4, // A parked run offers Continue and Stop.
      "../cards/RunTraceGoals.tsx": 1,
      /*
       * Lane runs: the run inbox's Open per row, its All/status filter chips,
       * and the Stop-all footer (all through onRunCommand), plus the
       * approvals inbox's two decision acts (approval.approve / approval.deny
       * through the delegated onDecideApproval).
       */
      "../cards/RunsCards.tsx": 11, // + the inbox rows' run reference.
      "../cards/SearchResultsCard.tsx": 2,
      "../cards/SecretsCard.tsx": 10,
      /* Includes TODO filing, check-receipt run opening, and the failure/Wiki Retry actions. */
      "../cards/StackCard.tsx": 10, // + Land (history.land).
      /* Local Open tab, cloud session Stop, and inventory Open/Stop. */
      "../cards/AgentCards.tsx": 1, // + each profile row's Runs door (runs.list flow=<profile>).
      "../cards/AnonymousCeilingCard.tsx": 1,
      // THE FORM LAW (.specs/engineering/spec.md §6.1): Cancel (card.dismiss), Submit (form.submit), and the retained PR Review (form.submit); fields commit on blur/change.
      "../cards/FlowFormCards.tsx": 3,
      // The plan card's one door, in its two states: Run once a plan exists, Plan again once one was refused.
      "../cards/FlowPlanCard.tsx": 2,
      // The run graph's bar: back to the turns, and the camera switch.
      "../cards/FlowRunGraph.tsx": 2,
      /*
       * The trigger panel (L6): the run in flight and a ledger row each open
       * their run, and a Plue registration carries Run now and Pause. The
       * trigger store's own rows carry no door, because no Control procedure
       * addresses one.
       */
      "../cards/FlowGraphTrigger.tsx": 2,
      /*
       * The node a graph has open (L5): its close, the tab strip's one
       * handler, one per dependency the node waits on, the Code tab's
       * `Open file`, the trigger drawer's own close, and a run-forest
       * node's Open and close (RunForest.ts). Every one is a `flowAction`
       * door on the card the drawer belongs to.
       */
      "../cards/FlowGraphDrawer.tsx": 7,
      /*
       * The repository welcome and its three answers (controller/onboarding.ts):
       * every door (the welcome's three, the maintainer's reads, the
       * contributor's three, the explore card's guide rows) is one shared
       * handler through onRunCommand with data-flow set.
       */
      /*
       * The repository's home pane (controller/onboarding.ts): the featured
       * flows' doors (flow.run) and Open PACKAGE.ts (files.read) are one
       * shared handler through onRunCommand with data-flow set; links are
       * anchors, not buttons.
       */
      /*
       * Lane change (ADR 0003) + lane L1 (ADR 0004, the live plue routes):
       * the change card's facet tabs, Land / Split ready / Revert / Full
       * diff, the conflict rows' Resolve, the Diff facet's two pickers, its
       * since-my-review and show-all, the file rows' one-file diff, the
       * Checks picker, Open the computer, the findings' Please fix and Not
       * useful, the review facet's show-all and thread acts, the history
       * rows' Diff to current, the diff card's re-read, and Request
       * review again after requested changes (ad40a699e) — all through
       * onRunCommand with data-flow set.
       */
      "../cards/ChangeCards.tsx": 21,
      /*
       * The plan inside a run card: Inspect review feedback and Inspect failed
       * execution (runs.trace.select), Vibe this change (flow.run), Check
       * available flows (flow.list), the predicted Change rows
       * (runs.coding.select) — all through onRunCommand with data-flow set.
       */
      "../cards/CodingPlanCard.tsx": 4,
      "../cards/CodingPocCard.tsx": 2, // Native execution inspection and existing steering form.
      /* The commits cards: a row's and a parent's commits.read, and the sha chip's chat.copy-message — all through onRunCommand. */
      "../cards/CommitCards.tsx": 3,
      "../cards/BranchesCard.tsx": 1, // a row opens that branch's commits (commits.list)
      /*
       * Connection, world and browser card interactions, plus the embedded
       * wiki collaboration cards (ad438463a6): page Previous/Next and the
       * pager's onSelect, the view-mode pickers (wiki.card.view), cloud
       * Open page, and Refresh (wiki.sync) — all through onRunCommand.
       */
      "../cards/ConversationCards.tsx": 11, // Wiki actions; the retired connection card has no doors.
      /* The factory card: one Open per present infra file, one shared handler through onRunCommand (files.read). */
      /*
       * The dispatcher card's Register door, the button door of
       * triggers.register (factory mock 2; sign-in is the door), and each
       * registered schedule's Run now and Pause, the button doors of
       * triggers.run and triggers.pause.
       */
      "../cards/TriggersCard.tsx": 4, // -1: a failed pause's Retry (triggers.pause) is a FailureNotice action.
      /* Librarian L5: the rail card's Open and note rows (wiki.open) and the graph card's Refresh (wiki.graph). */
      "../cards/WikiCards.tsx": 5, // + the history card's Previous/Next page (wiki.history).
      /* The wiki navigation (#1922): the space switch (wiki.space), the tree rows (wiki.select / wiki.cloud.open), the tag filter. */
      "../wiki/WikiNavigation.tsx": 4
    })
  })

  test("delegated props are bound to commands at their call sites", () => {
    const app = files["../App.tsx"]
    const message = files["../TranscriptMessage.tsx"]
    expect(app).toContain("<TranscriptMessage")
    expect(message).toMatch(/onDownload=\{\(\) => \{\s*controller\.runCommand\(STORAGE_RECOVERY_EXPORT\)/)
    expect(message).toContain("runCommandForResult(\"chat.copy-message\"")
    expect(message).toContain("runCommand(\"chat.retry\"")
    expect(message).not.toContain("agent.explain")
    expect(app).toContain("runCommand(\"toast.dismiss\"")
  })

  /* A card's acts bind once, and the live transcript uses that binding. */
  test("the transcript uses the shared card action binding", () => {
    const actions = read("../cards/controllerCardActions.ts")
    expect(read("./cardActions.ts")).not.toMatch(/from ["'][^"']*(?:cards\/|ChatCards)/)
    expect(actions).toContain("\"approval.approve\"")
    expect(actions).toContain("\"approval.deny\"")
    expect(actions).toContain("runCommand(\"card.maximize\"")
    expect(actions).toContain("runCommand(\"card.minimize\"")
    expect(actions).toContain("runCommand(\"frame.back\"")
    expect(actions).toContain("runCommand(\"frame.forward\"")
    expect(actions).toContain("runCommand(\"auth.sign-in\"")
    expect(actions).toContain("runCommand(\"flow.run\"")
    expect(actions).toContain("runCommand(\"flow.run.stop\"")
    expect(actions).toContain("runCommand(\"flow.run.retry\"")
    expect(actions).toContain("runCommand(\"flow.repo.choose\"")
    expect(actions).toContain("runCommand(\"wiki.edit\"")
    for (const surface of ["../App.tsx"] as const) {
      expect(files[surface]).toContain("cardActions(controller,")
    }
  })

  /*
   * §2a/§2f — no fabricated prompt pills, ever. A pill is a command
   * BINDING; a pill carrying free text for the model is a violation unless
   * it is explicitly a composer-prefill affordance (none exist). The banned
   * literals are the slop will named verbatim; the `suggest` command was
   * the fabricated-prompt mechanism and is deleted; the suggestion set is
   * derived in App.tsx from live state (empty is correct).
   */
  test("no pill carries a prompt string for the model, and no banned generic pill exists", () => {
    const bannedLiterals = [
      "Build my work queue",
      "Build a work queue",
      "Plan my day",
      "Help me plan my day",
      "Help me connect GitHub",
      "What should I do next?"
    ]
    for (const [, source] of Object.entries(files)) {
      for (const literal of bannedLiterals) {
        expect(source).not.toContain(literal)
      }
      // The prompt-pill shape itself: a suggestion carrying prompt text.
      expect(source).not.toContain("prompt: action.prompt")
      expect(source).not.toContain("suggestion.prompt")
    }
    const registrySource = registrySources()
    expect(registrySource).not.toContain("\"suggest\"")
    // The pill row binds commands directly (§2a): the suggestion markup
    // carries the command, and the click invokes it — never send().
    const app = files["../App.tsx"] ?? ""
    expect(app).toContain("data-flow={suggestion.flow}")
    expect(app).not.toContain("data-flow=\"suggest\"")
    // No standing composer status chrome (§2g): calm is the budget.
    expect(app).not.toContain("statusText=")
  })

  /*
   * Wave 13 C-1 — the gap the live sweep found: the static gate verified
   * data-flow bindings and allowlisted presentation-only handlers, but a
   * button with NEITHER (the "Surfaces" menu trigger, whose open/close was
   * allowlisted as local state) shipped unbound. This is the live C-1 rule
   * applied to the source: a button without a data-flow binding must have
   * a static label whose words resolve to a registered command's name or
   * summary — exactly what the launch checklist checks against the DOM.
   */
  test("a button with no data-flow binding has a label that resolves to a registered command", () => {
    const registrySource = registrySources()
    const names = [...registrySource.matchAll(/\bname:\s*"([^"]+)"/g)].map((match) => match[1] as string)
    const summaries = [...registrySource.matchAll(/\bsummary:\s*"([^"]+)"/g)].map((match) =>
      (match[1] as string).toLowerCase()
    )
    const resolves = (label: string): boolean => {
      const words = label
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((word) => word.length > 2)
      if (words.length === 0) return true
      // EVERY word must resolve: the old any-word rule passed a label on a
      // single common word ("open", "run") no matter what the rest of it
      // promised, which is exactly the fuzz a mis-bound button hides in.
      return words.every(
        (word) =>
          names.some((name) => name.includes(word) || word.includes(name)) ||
          summaries.some((summary) => summary.includes(word))
      )
    }
    const violations: Array<string> = []
    for (const [file, source] of Object.entries(files)) {
      const lines = source.split("\n")
      lines.forEach((line, index) => {
        const label = /(?:aria-label|title)="([^"]+)"/.exec(line)?.[1]
        if (label === undefined) return
        // The element the label belongs to: the nearest enclosing tag start.
        let start = index
        while (start > 0 && !/^\s*<[A-Za-z]/.test(lines[start] ?? "")) start -= 1
        if (!/^\s*<(?:button|Button)\b/.test(lines[start] ?? "")) return
        const chunk = lines.slice(start, Math.min(lines.length, index + 12)).join("\n")
        if (chunk.includes("data-flow")) return
        /*
         * A component that takes its caller's binding spreads a
         * FlowBindingProps prop (`{...dismissBinding}`, HelpBubble.tsx): the
         * attributes are there at runtime, just not as a literal here. The
         * prop's type is the binding, so this is a bound button.
         */
        if (/\{\.\.\.[A-Za-z]*[Bb]inding\b/.test(chunk)) return
        if (!resolves(label)) {
          violations.push(`${file}: button "${label}" has no data-flow and resolves to no registered command`)
        }
      })
    }
    expect(violations).toEqual([])
  })

  test("binding discovery reads JSX declarations, never focus-return selectors or comments", () => {
    const source = [
      "// <button data-flow=\"comment.only\" />",
      "const selector = `[data-flow=\"${flow}\"]`",
      "const description = 'closeCommand=\"text.only\"'",
      "const view = <><button data-flow=\"app.first-run.dismiss\" /><button data-flow={\"missing.command\"} />",
      "<button data-flow={`missing.template`} /><SurfaceHeader closeCommand=\"missing.close\" />",
      "<button data-flow={action.flow} />{/* <button data-flow=\"comment.only\" /> */}</>"
    ].join("\n")
    const bindings = literalBindings(source)
    expect(bindings).toEqual([
      { prop: "data-flow", name: "app.first-run.dismiss" },
      { prop: "data-flow", name: "missing.command" },
      { prop: "data-flow", name: "missing.template" },
      { prop: "closeCommand", name: "missing.close" }
    ])
    const declared = new Set(["app.first-run.dismiss"])
    expect(bindings.filter(({ name }) => !declared.has(name)).map(({ name }) => name)).toEqual([
      "missing.command",
      "missing.template",
      "missing.close"
    ])
  })

  test("every data-flow binding names a registered command, and the app exposes the registry manifest", () => {
    // The launch checklist reads the DOM, not the source: `.app-shell`
    // carries the live registry manifest (data-flows) and every
    // machine-legible affordance declares its command (data-flow). A
    // binding naming a command the registry does not have is a lie both
    // gates can catch here.
    const app = files["../App.tsx"]
    expect(app).toContain("const flows = controller.commands.all()")
    expect(app).toContain("data-flows={flows.map((command) => command.name).join(\" \")}")
    // Registry names from the registry source itself — the same file the
    // runtime registers — so a renamed command fails this gate.
    const registrySource = registrySources()
    const declared = new Set(
      [...registrySource.matchAll(/\bname:\s*"([^"]+)"/g)].map((match) => match[1] as string)
    )
    expect(declared.size).toBeGreaterThan(0)
    const violations: Array<string> = []
    for (const [file, source] of Object.entries(files)) {
      // SurfaceHeader renders its close affordance's data-flow from
      // closeCommand, so the literal lives at the call site and is gated here.
      for (const { prop, name } of literalBindings(source)) {
        if (!declared.has(name)) {
          violations.push(`${file}: ${prop}="${name}" is not a registered command`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("every embedded pane closes back to the conversation, not to some other surface", () => {
    // The chat-first contract: a pane's only exit is /chat. A pane wired to
    // close into another takeover would pass the registry gate above and still
    // break the contract, so the target itself is pinned.
    const panes = ["../WorldSurface.tsx"] as const
    for (const pane of panes) {
      const source = files[pane] ?? ""
      expect(source).toContain("closeCommand=\"chat\"")
      const targets = [...source.matchAll(/closeCommand="([^"]+)"/g)].map((match) => match[1])
      expect(targets.every((target) => target === "chat")).toBe(true)
    }
    // Every SurfaceHeader mounted anywhere declares one (a pane with an
    // unnamed close is exactly the affordance this gate exists to catch).
    for (const [file, source] of Object.entries(files)) {
      if (file === "../SurfaceChrome.tsx") continue
      const mounts = source.split("<SurfaceHeader").length - 1
      const declared = source.split("closeCommand=").length - 1
      expect(`${file}: ${mounts} SurfaceHeader / ${declared} closeCommand`).toBe(
        `${file}: ${mounts} SurfaceHeader / ${mounts} closeCommand`
      )
    }
  })

  test("light/dark remains callable while decorative themes are absent", () => {
    const source = registrySources()
    expect(source).toContain("name: \"appearance.dark-mode\"")
    expect(source).not.toContain("name: \"appearance.theme\"")
    expect(files["../cards/ThemePickerCard.tsx"]).toBeUndefined()
  })

  test("the slash menu wrapper dispatches through the registry", () => {
    const composer = files["../Composer.tsx"]
    const wrapper = composer.slice(
      composer.indexOf("const runSlashCommand"),
      composer.indexOf("const onComposerKeyDown")
    )
    expect(wrapper).toContain("controller.runCommand")
  })
})
