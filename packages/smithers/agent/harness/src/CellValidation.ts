/**
 * Cell validation at the boundary.
 *
 * A cell used to be parsed for the first time inside the realm that runs it, so
 * "this does not compile" arrived as a settled frame: one whole model turn
 * bought, spent, and answered with a syntax error. The r90 wave paid for nine
 * of them — `sympy__sympy-20154` emitted a 53 KB program that never ran and
 * then had it replayed back to it verbatim as input, `django__django-15987`
 * spent 59 % of the instance's whole bill on one dead cell, and
 * `sympy__sympy-18763` emitted the *same* syntax error twice in a row because
 * the first failure was invisible to it.
 *
 * Parsing is cheap and the controller can do it before it commits anything, so
 * it does: this module is the parse, and `CellTurn` answers what it finds
 * inside the same frame, at cached-prefix price, instead of ending the frame on
 * it.
 *
 * The same parse does one more thing: it normalizes the top-level statement
 * list so the persistent realm behaves like a notebook rather than like a script
 * that may only be run once. See {@link normalize}.
 *
 * Nothing here executes anything, and nothing here is a gate. The only outcome
 * it can produce is a rejection the model is asked to fix in this frame.
 *
 * @since 0.1.0
 */

import { parse } from "@babel/parser"
import * as Syntax from "@babel/types"
import { transform } from "sucrase"
import * as Cell from "./Cell.ts"

/**
 * What the boundary learned by parsing one cell.
 *
 * Exactly one of `rejected` and `compiled` is present: a cell either has a
 * program to run or a reason it does not.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Validation =
  | { readonly rejected: Cell.Rejected; readonly compiled: undefined }
  | { readonly rejected: undefined; readonly compiled: string }

/**
 * The module syntax a cell used, named as the model would say it.
 *
 * @private
 */
type ModuleSyntax = "import" | "export" | "require"

/**
 * Finds module syntax a cell wrote, by parsing rather than by matching text.
 *
 * A cell has no module loader to reach, so this is a real violation. Its
 * strings are another matter: cells routinely pass a `bash` command whose
 * Python heredoc reads `from pathlib import Path`, or a `grep` pattern naming
 * `from _pytest import`. That text is data. A regexp over the source cannot
 * tell the two apart, and reading the source as text rejected five otherwise
 * correct SWE-bench frames in one wave, one of them an instance's opening
 * frame, each costing a whole turn to a rule the cell had not broken.
 *
 * A namespace body is not descended into. `export` inside one is not ESM, and
 * the namespace itself is refused by {@link nonErasableSyntax}.
 *
 * @private
 */
const moduleSyntax = (source: Syntax.File): ModuleSyntax | undefined => {
  let found: ModuleSyntax | undefined
  Syntax.traverseFast(source, (node) => {
    if (Syntax.isTSModuleDeclaration(node)) return Syntax.traverseFast.skip
    if (Syntax.isImportDeclaration(node) || Syntax.isTSImportEqualsDeclaration(node)) found = "import"
    else if (
      Syntax.isExportDeclaration(node) || Syntax.isTSExportAssignment(node) ||
      Syntax.isTSNamespaceExportDeclaration(node)
    ) found = "export"
    else if (Syntax.isImportExpression(node)) found = "import"
    else if (Syntax.isMetaProperty(node) && node.meta.name === "import") found = "import"
    else if (Syntax.isCallExpression(node) && Syntax.isIdentifier(node.callee) && node.callee.name === "require") {
      found = "require"
    }
    if (found !== undefined) return Syntax.traverseFast.stop
  })
  return found
}

const nonErasableSyntax = (source: Syntax.File): string | undefined => {
  let found: string | undefined
  Syntax.traverseFast(source, (node) => {
    if (Syntax.isTSEnumDeclaration(node)) found = "enum declarations"
    else if (Syntax.isTSModuleDeclaration(node)) found = "namespace/module declarations"
    else if (Syntax.isTSParameterProperty(node)) found = "parameter properties"
    if (found !== undefined) return Syntax.traverseFast.stop
  })
  return found
}

/**
 * The first thing a compiler refused, as a sentence naming where it is.
 *
 * The line and the offending text are the whole point. A model handed
 * "'}' expected." can only guess; handed "line 34: `if (a) {`" it edits the
 * line it wrote.
 *
 * @private
 */
const located = (text: string, cause: unknown): string => {
  const error = (cause instanceof Error ? cause : new Error(String(cause))) as Error & {
    loc?: { line: number; column: number }
  }
  const message = error.message.replace(/ \(\d+:\d+\)$/, "")
  const at = error.loc
  if (at === undefined) return message
  // A compiler points past the last token when the thing that is missing is a
  // closing one, so the named line is regularly blank. Quoting a blank line
  // says nothing and reads like a truncation, so it is left out.
  const line = (text.split(/\r\n?|\n|\u2028|\u2029/)[at.line - 1] ?? "").trim()
  return `line ${at.line}, column ${at.column + 1}: ${message}${line === "" ? "" : `\n  ${line}`}`
}

const parseCell = (text: string, typescript = false) =>
  parse(text, {
    sourceType: "script",
    plugins: typescript ? ["typescript"] : [],
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
    ...(typescript ? { strictMode: true } : {}),
    errorRecovery: true
  })

/** Top-level bindings become re-declarable vars; nested lexical bindings do not. */
const reboundOffsets = (source: Syntax.File): ReadonlySet<number | null | undefined> => {
  const offsets = new Set<number | null | undefined>()
  for (const statement of source.program.body) {
    if (
      Syntax.isVariableDeclaration(statement) || Syntax.isClassDeclaration(statement) ||
      Syntax.isFunctionDeclaration(statement)
    ) {
      for (const identifiers of Object.values(Syntax.getBindingIdentifiers(statement, true, true))) {
        for (const identifier of identifiers) offsets.add(identifier.start)
      }
    }
  }
  return offsets
}

/** Preserve the strict-script semantics of the former TypeScript emitter. */
const strictScript = (code: string): string => {
  const directive = "\"use strict\";\n"
  if (!code.startsWith("#!")) return directive + code
  return code.replace(/^(#![^\r\n]*)(?:\r\n?|\n|$)/, `$1\n${directive}`)
}

/**
 * One replacement of a byte range of a cell's compiled text.
 *
 * @private
 */
interface Splice {
  readonly start: number
  readonly end: number
  readonly text: string
}

/**
 * Finds a `return` the realm would refuse, wherever the cell put it.
 *
 * A REPL cell is a global async script, and `return` is a syntax error at the
 * top level of one — measured on the shipped QuickJS variant, which answers
 * `SyntaxError: return not in a function` and runs nothing at all. Function
 * bodies are skipped, because a `return` inside one is ordinary JavaScript.
 *
 * @private
 */
const topLevelReturn = (source: Syntax.File): Syntax.ReturnStatement | undefined => {
  let found: Syntax.ReturnStatement | undefined
  Syntax.traverseFast(source, (node) => {
    if (Syntax.isFunction(node) || Syntax.isClass(node)) return Syntax.traverseFast.skip
    if (Syntax.isReturnStatement(node)) {
      found = node
      return Syntax.traverseFast.stop
    }
  })
  return found
}

/**
 * The two names a REPL cell may not declare at its top level.
 *
 * They are the realm's own host bindings, and in a persistent realm a top-level
 * declaration of one is not a shadow — {@link normalize} makes it a `var`, and a
 * `var` over an existing global assigns. Under the per-cell realm that
 * assignment died with the cell; here it would take `ctx.call` or `console.log`
 * away from every later cell of the run.
 *
 * @private
 */
const reserved = ["ctx", "console"]

/**
 * Names every identifier one top-level declaration binds, patterns included.
 *
 * @private
 */
const declaredNames = (source: Syntax.File): ReadonlyArray<string> => {
  const found = new Set<string>()
  for (const statement of source.program.body) {
    if (
      Syntax.isVariableDeclaration(statement) || Syntax.isFunctionDeclaration(statement) ||
      Syntax.isClassDeclaration(statement)
    ) {
      for (const name of Object.keys(Syntax.getBindingIdentifiers(statement, false, true))) found.add(name)
    }
  }
  // A block does not contain var: a loop or if-body can still replace a
  // persistent host binding. Functions/classes introduce their own scope.
  Syntax.traverseFast(source.program, (node) => {
    if (Syntax.isFunctionDeclaration(node)) {
      for (const name of Object.keys(Syntax.getBindingIdentifiers(node, false, true))) found.add(name)
    }
    if (Syntax.isFunction(node) || Syntax.isClass(node)) return Syntax.traverseFast.skip
    if (Syntax.isVariableDeclaration(node) && node.kind === "var") {
      for (const name of Object.keys(Syntax.getBindingIdentifiers(node))) found.add(name)
    }
  })
  return [...found]
}

/**
 * Rewrites a cell's top-level declarations so a persistent realm can re-run it.
 *
 * Raw persistence is not enough. Consecutive global evals in one QuickJS context
 * do share top-level `const`/`let` — they live in the realm's global lexical
 * scope, exactly like consecutive `<script>` tags — but that leaves a REPL three
 * measured edges: a later cell that reuses a name dies on
 * `SyntaxError: redeclaration of 'x'` with nothing run at all, a cell that
 * throws leaves every name below the throw permanently in TDZ — unreadable and
 * un-redeclarable for the rest of the run — and lexical names are invisible to
 * reflection, so no panel can enumerate them.
 *
 * All three are closed by one mechanical rewrite of the top-level statement list
 * only:
 *
 * - a top-level `const`/`let` variable statement becomes the same statement
 *   with the keyword `var`; destructuring patterns, initializers and multiple
 *   declarators are untouched, because only the keyword token moves;
 * - `let x;` with no initializer becomes `var x = undefined;`, so re-declaring
 *   a name really does clear it;
 * - a top-level `class K { … }` becomes `var K = class K { … };`;
 * - a top-level `function f() {}` is untouched, being already a redeclarable
 *   global;
 * - everything nested — function bodies, blocks, loop heads, class bodies — is
 *   untouched, so an inner `const` is still an inner `const` and a
 *   `for (const x of …)` head still scopes to its loop.
 *
 * The price is stated plainly: a top-level `const` is no longer read-only. That
 * is the same price every notebook pays. What it buys is that rebinding a name
 * is ordinary, a throw leaves no poison, and every live name is an own property
 * of `globalThis` — which is what makes the variables panel reflective instead
 * of parsed.
 *
 * @category conversions
 * @since 0.1.0
 */
export const normalize = (compiled: string): string => {
  const source = parseCell(compiled)
  const splices: Array<Splice> = []
  for (const statement of source.program.body) {
    if (Syntax.isVariableDeclaration(statement)) {
      if (statement.kind !== "const" && statement.kind !== "let") continue
      const keyword = statement.start!
      splices.push({ start: keyword, end: keyword + statement.kind.length, text: "var" })
      for (const declaration of statement.declarations) {
        if (declaration.init === null) {
          splices.push({ start: declaration.end!, end: declaration.end!, text: " = undefined" })
        }
      }
      continue
    }
    if (!Syntax.isClassDeclaration(statement)) continue
    const start = statement.start!
    splices.push({ start, end: start, text: `var ${statement.id!.name} = ` })
    splices.push({ start: statement.end!, end: statement.end!, text: ";" })
  }
  if (splices.length === 0) return compiled
  let text = compiled
  for (const splice of [...splices].sort((left, right) => right.start - left.start)) {
    text = text.slice(0, splice.start) + splice.text + text.slice(splice.end)
  }
  return text
}

/**
 * Parses one cell and reports everything the parse can decide.
 *
 * It refuses a `return` the realm cannot compile, refuses a top-level
 * declaration of a name the realm owns, and normalizes the top-level
 * declarations the realm has to be able to re-run.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const validate = (cell: Cell.Source): Validation => {
  const isTypeScript = cell.language === "typescript"
  const refuse = (rejected: Cell.Rejected): Validation => ({ rejected, compiled: undefined })
  try {
    const parsed = parseCell(cell.text, isTypeScript)
    const moduleUse = moduleSyntax(parsed)
    if (moduleUse !== undefined) {
      return refuse(
        new Cell.Rejected({
          code: "imports_forbidden",
          message: `A cell may not ${moduleUse} anything: it runs in a realm with no module loader. ` +
            "Use ctx.call for every effect and ctx.flows for the catalog it may call; they are the only bindings a cell has."
        })
      )
    }
    if (isTypeScript) {
      const forbidden = nonErasableSyntax(parsed)
      if (forbidden !== undefined) {
        return refuse(
          new Cell.Rejected({
            code: "compile_failed",
            message: `The TypeScript cell uses ${forbidden}, which are not erasable syntax.`
          })
        )
      }
    }
    // Several response blocks may intentionally rebind the same top-level
    // name. Only errors on bindings normalization actually rewrites can be
    // dismissed; duplicate lexical bindings inside a function/block still fail.
    const rebound = reboundOffsets(parsed)
    const diagnostic = parsed.errors?.find((error) =>
      error.reasonCode !== "VarRedeclaration" || !rebound.has(error.loc.index)
    )
    if (diagnostic !== undefined) throw diagnostic
    // The JavaScript a cell wrote is run as written. Only TypeScript is handed
    // to the emitter, and only to have its type-only syntax erased.
    const returned = topLevelReturn(parsed)
    if (returned !== undefined) {
      return refuse(
        new Cell.Rejected({
          code: "compile_failed",
          message:
            `A cell is a script, not a function body, so the \`return\` on line ${
              returned.loc!.start.line
            } would not compile and nothing would run. ` +
            "Finish by calling instead: ctx.done(output) ends the run, ctx.park(reason, message) waits durably, and a cell that calls neither simply ends its turn."
        })
      )
    }
    const claimed = declaredNames(parsed).find((name) => reserved.includes(name))
    if (claimed !== undefined) {
      return refuse(
        new Cell.Rejected({
          code: "compile_failed",
          message:
            `A cell may not declare \`${claimed}\` at its top level: the realm outlives the cell, so that name is ` +
            "the run's own binding and declaring it would take it away from every later cell. Rename the variable."
        })
      )
    }
    const compiled = isTypeScript
      ? strictScript(
        transform(cell.text, {
          transforms: ["typescript"],
          disableESTransforms: true,
          keepUnusedImports: true
        }).code
      )
      : cell.text
    return { rejected: undefined, compiled: normalize(compiled) }
  } catch (cause) {
    return refuse(
      new Cell.Rejected({ code: "compile_failed", message: `The cell did not compile — ${located(cell.text, cause)}` })
    )
  }
}
