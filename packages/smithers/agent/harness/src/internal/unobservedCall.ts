/**
 * The completion its own cell wrote before reading the calls it made.
 *
 * Several `cell` blocks in one reply run as one program, and the model writes
 * the whole program before any call in it settles. A reply that probes and
 * answers — `const seen = await ctx.call("bash", …)`, a `console.log` of `seen`,
 * then `ctx.done(…)` — therefore completes the run before the model has read
 * a byte of what it asked to see. Real seats do this about once in three
 * deliveries even when their prompt says to answer in a later reply, and the
 * answer is either an unverified claim or "blocked: output not observed".
 *
 * ## The rule, and what it spares
 *
 * A completion is handed back, once per run, when its own cell made a call,
 * kept that call's result, and left it for the model alone: printed or
 * bound, and read by nothing in the program but `console.*` and guards that
 * only decide what `console.*` prints (`if (r.exitCode)` around a `console.log` of `r.stderr`),
 * so the completion reads no result either. It is also handed back when the
 * program acted on some results but a completion that reads none — in its
 * output or a guard around it — follows a result the program only printed.
 * The next frame is shown the results and asked to answer after reading them.
 *
 * Three shapes are spared because nothing in them was written blind:
 *
 * - a completion that reads a call's result — in its output, or in a guard
 *   around it. `if (after.exitCode === 0) ctx.done(…)` is the shape the cell
 *   contract teaches: the program, not the model's memory, decides the
 *   verdict. Reading is transitive through the program's own bindings, so
 *   `result.summary = seen.stdout; ctx.done(JSON.stringify(result))` reads.
 * - a cell whose program acts on a result: passes it into another call, or
 *   branches on it. The contract teaches deriving later inputs from earlier
 *   results inside one cell, and a cell that asked, saved the answer and
 *   completed did what it set out to do without the model reading anything.
 * - a cell whose calls are all effects whose result it discarded, such as
 *   `await ctx.call("edit", …)` as a statement of its own. The cell never
 *   asked to see anything, and a failed effect is `FailedCall`'s demand.
 *
 * The reading is a parse of the cell's source, so it is a pure function of
 * the cell and a replay reaches the same decision. It reads names, not
 * scopes, and what it cannot see through — a result handed to a function of
 * the program's own, a `.then` callback, a completion reached through an
 * alias — reads as acted on. A wrong refusal takes a legitimate answer away
 * from every consumer of the harness, while a wrong pass costs one unread
 * probe, so the rule fires only where the source leaves no other reading.
 *
 * @since 1.0.0-rc.1
 * @private
 */

import { parse } from "@babel/parser"
import type * as Syntax from "@babel/types"

/**
 * How many completions one run may have handed back for unread calls.
 *
 * One, like every measured demand: the frame that answers it has read the
 * results, and asking again would be the loop grading that answer.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const cap = 1

/**
 * The heading of the demand, so a transcript and a test can find it.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const heading = "Answer written before its calls returned"

/** The frame accounting's view of one settled call. */
interface Settled {
  readonly flow: string
  readonly ok: boolean
  readonly ordinal: number
  readonly summary: string
}

/**
 * One call a completion was written without reading.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export interface Unobserved {
  readonly flow: string
  readonly ok: boolean
  readonly ordinal: number
  readonly summary: string
}

type Node = Syntax.Node

const isNode = (value: unknown): value is Node =>
  value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"

/** Keys that hold positions, comments and parser detail rather than children. */
const skipped = new Set(["loc", "start", "end", "extra", "leadingComments", "trailingComments", "innerComments"])

const children = (node: Node): ReadonlyArray<Node> => {
  const found: Array<Node> = []
  for (const [key, value] of Object.entries(node)) {
    if (skipped.has(key)) continue
    if (Array.isArray(value)) { for (const item of value) if (isNode(item)) found.push(item) }
    if (isNode(value)) found.push(value)
  }
  return found
}

const ctxMember = (node: Node, name: string): boolean =>
  (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && !node.computed &&
  node.object.type === "Identifier" && node.object.name === "ctx" &&
  node.property.type === "Identifier" && node.property.name === name

const ctxCall = (node: Node, name: string): boolean =>
  (node.type === "CallExpression" || node.type === "OptionalCallExpression") && ctxMember(node.callee, name)

/**
 * The nodes a reference can hide in: a non-computed property or key names
 * nothing, so `x.seen` does not read `seen`.
 */
const referencing = (node: Node): ReadonlyArray<Node> => {
  switch (node.type) {
    case "MemberExpression":
    case "OptionalMemberExpression":
      return node.computed ? [node.object, node.property] : [node.object]
    case "ObjectProperty":
      return node.computed ? [node.key, node.value] : [node.value]
    case "ObjectMethod":
    case "ClassMethod":
    case "ClassPrivateMethod":
      return [...node.params, node.body]
    default:
      return children(node)
  }
}

/** Whether an expression makes a call or reads a name that holds a result. */
const reads = (node: Node, results: ReadonlySet<string>): boolean => {
  if (ctxCall(node, "call")) return true
  if (node.type === "Identifier") return results.has(node.name)
  return referencing(node).some((child) => reads(child, results))
}

/** The names a binding or assignment target writes; a member target writes its root. */
const targets = (node: Node): ReadonlyArray<string> => {
  switch (node.type) {
    case "Identifier":
      return [node.name]
    case "MemberExpression":
    case "OptionalMemberExpression":
      return targets(node.object)
    case "ObjectPattern":
      return node.properties.flatMap((property) => targets(property.type === "RestElement" ? property : property.value))
    case "ArrayPattern":
      return node.elements.flatMap((element) => element === null ? [] : targets(element))
    case "RestElement":
      return targets(node.argument)
    case "AssignmentPattern":
      return targets(node.left)
    default:
      return []
  }
}

/** The names `ctx` and `console` are the realm's, never a result's. */
const realm = new Set(["ctx", "console"])

/** Every way the program moves a value into a name: `[targets, source]`. */
const flows = (root: Node): ReadonlyArray<readonly [ReadonlyArray<string>, Node]> => {
  const found: Array<readonly [ReadonlyArray<string>, Node]> = []
  const visit = (node: Node): void => {
    switch (node.type) {
      case "VariableDeclarator":
        if (node.init !== null && node.init !== undefined) found.push([targets(node.id), node.init])
        break
      case "AssignmentExpression":
        found.push([targets(node.left), node.right])
        break
      case "FunctionDeclaration":
        // A script's function declaration always has a name; only a module's
        // default export may omit it, and a cell is never a module.
        found.push([[node.id!.name], node.body])
        break
      case "ForOfStatement":
      case "ForInStatement":
        found.push([
          targets(node.left.type === "VariableDeclaration" ? node.left.declarations[0]!.id : node.left),
          node.right
        ])
        break
      case "CallExpression":
      case "OptionalCallExpression":
        // `results.push(seen)` keeps a result in `results`.
        if (node.callee.type === "MemberExpression" || node.callee.type === "OptionalMemberExpression") {
          for (const argument of node.arguments) found.push([targets(node.callee.object), argument])
        }
        break
    }
    for (const child of children(node)) visit(child)
  }
  visit(root)
  return found.map(([names, source]) => [names.filter((name) => !realm.has(name)), source] as const)
}

/** Every name that holds, directly or through the program's own bindings, a call's result. */
const resultNames = (root: Node): ReadonlySet<string> => {
  const moves = flows(root)
  const results = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const [names, source] of moves) {
      if (names.every((name) => results.has(name)) || !reads(source, results)) continue
      for (const name of names) results.add(name)
      grew = true
    }
  }
  return results
}

/** Whether an expression reads a name in `names`, calls aside. */
const mentions = (node: Node, names: ReadonlySet<string>): boolean =>
  node.type === "Identifier" ? names.has(node.name) : referencing(node).some((child) => mentions(child, names))

/**
 * Each name a call's result is bound to directly, with every name the
 * program's own bindings copy it into.
 */
const resultsByCall = (root: Node): ReadonlyArray<ReadonlySet<string>> => {
  const moves = flows(root)
  return moves.filter(([, source]) => reads(source, new Set())).flatMap(([names]) =>
    names.map((name) => {
      const held = new Set([name])
      for (let grew = true; grew;) {
        grew = false
        for (const [targets, source] of moves) {
          if (targets.every((target) => held.has(target)) || !mentions(source, held)) continue
          for (const target of targets) held.add(target)
          grew = true
        }
      }
      return held
    })
  )
}

/**
 * Whether a completion depends on a result: its output reads one, or a guard
 * around it (a condition, a loop over a result, a `catch`) does. A completion
 * inside a function of the program's own is out of sight and counts as
 * depending.
 */
const completionReads = (root: Node, results: ReadonlySet<string>): boolean => {
  const visit = (node: Node, guarded: boolean): boolean => {
    if (ctxCall(node, "done")) {
      return guarded || (node as Syntax.CallExpression).arguments.some((argument) => reads(argument, results))
    }
    const parts = functionParts(node)
    if (parts !== undefined) return parts.some((child) => visit(child, true))
    let tests: ReadonlyArray<Node | null | undefined> = []
    switch (node.type) {
      case "IfStatement":
      case "ConditionalExpression":
      case "WhileStatement":
      case "DoWhileStatement":
        tests = [node.test]
        break
      case "LogicalExpression":
        tests = [node.left]
        break
      case "SwitchStatement":
        tests = [node.discriminant, ...node.cases.map((entry) => entry.test)]
        break
      case "ForOfStatement":
      case "ForInStatement":
        tests = [node.right]
        break
      case "CatchClause":
        return visit(node.body, true)
    }
    const inner = guarded || tests.some((test) => test != null && reads(test, results))
    return children(node).some((child) => visit(child, inner))
  }
  return visit(root, false)
}

/** The realm's calls that only move a value: their arguments are read where their result is. */
const pure = new Map<string, ReadonlySet<string>>([
  ["Promise", new Set(["all", "allSettled", "any", "race", "resolve"])],
  ["JSON", new Set(["parse", "stringify"])],
  ["Object", new Set(["assign", "entries", "fromEntries", "keys", "values"])],
  ["Array", new Set(["from", "of"])]
])
const pureFunctions = new Set(["String", "Number", "Boolean"])
/** Methods that keep their argument in the receiver; `flows` follows it there. */
const keeping = new Set(["push", "unshift", "add", "set", "append"])

/** A function's parameters and body, or nothing when the node is not a function. */
const functionParts = (node: Node): ReadonlyArray<Node> | undefined => {
  switch (node.type) {
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "FunctionDeclaration":
    case "ObjectMethod":
    case "ClassMethod":
    case "ClassPrivateMethod":
      return [...node.params, node.body]
    default:
      return undefined
  }
}

const functionLike = (node: Node): boolean => functionParts(node) !== undefined

const consoleCall = (node: Node): boolean => {
  if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return false
  const member = memberName(node.callee)
  return member !== undefined && member[0].type === "Identifier" && member[0].name === "console" &&
    !node.arguments.some(functionLike)
}

/** An expression that only prints, or yields nothing: a `console.log` of `r`, `null`, `void 0`. */
const logging = (node: Node): boolean =>
  consoleCall(node) || node.type === "NullLiteral" || (node.type === "Identifier" && node.name === "undefined") ||
  (node.type === "UnaryExpression" && node.operator === "void" && node.argument.type === "NumericLiteral") ||
  (node.type === "ConditionalExpression" && logging(node.consequent) && logging(node.alternate)) ||
  (node.type === "LogicalExpression" && logging(node.right))

/**
 * A statement that only prints, whatever it prints under: a guard such as
 * `if (r.exitCode)` around a `console.log` of `r.stderr` shows a result to the model and
 * decides nothing, so the result it tests stays unread by the program. A
 * `return`, `throw`, `break` out of a loop, or any other statement is control
 * flow or an effect and is not logging.
 */
const loggingOnly = (node: Node | null | undefined): boolean => {
  if (node === null || node === undefined) return true
  switch (node.type) {
    case "EmptyStatement":
      return true
    case "BlockStatement":
      return node.body.every(loggingOnly)
    case "ExpressionStatement":
      return logging(node.expression)
    case "IfStatement":
      return loggingOnly(node.consequent) && loggingOnly(node.alternate)
    case "SwitchStatement":
      return node.cases.every((entry) =>
        entry.consequent.every((statement) =>
          (statement.type === "BreakStatement" && statement.label === null) || loggingOnly(statement)
        )
      )
    default:
      return false
  }
}

const memberName = (callee: Node): readonly [Node, string] | undefined =>
  (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") && !callee.computed &&
    callee.property.type === "Identifier"
    ? [callee.object, callee.property.name]
    : undefined

/**
 * Whether the program acts on a result: reads a call or a name holding a
 * result anywhere but inside `console.*`, and other than by copying it into
 * another name, which is followed through that name.
 *
 * Copying is narrow on purpose: the source of a binding or assignment, the
 * argument of `push` and its kin, and the realm's value-moving functions
 * (`JSON.parse`, `Promise.all`, a method of the result itself). Anything the
 * parse cannot see through — a function of the program's own, a callback, a
 * `.then`, an alias — is an act, because the program may complete from there.
 */
const actsOn = (root: Node, results: ReadonlySet<string>, calls = true): boolean => {
  // Without `calls`, only the names count: a call read inline is some other result.
  const reading = (node: Node) => calls ? reads(node, results) : mentions(node, results)
  const visit = (node: Node, acting: boolean): boolean => {
    if (node.type === "Identifier") return acting && results.has(node.name)
    const parts = functionParts(node)
    // A function's body runs whenever the program calls it, so it acts.
    if (parts !== undefined) return parts.some((child) => visit(child, true))
    if (node.type === "ExpressionStatement" || (node.type === "UnaryExpression" && node.operator === "void")) {
      // An effect's result discarded as a statement of its own is not read.
      const discarded = node.type === "ExpressionStatement" ? node.expression : node.argument
      const inner = discarded.type === "AwaitExpression" ? discarded.argument : discarded
      if (ctxCall(inner, "call")) {
        return (inner as Syntax.CallExpression).arguments.some((argument) => visit(argument, true))
      }
    }
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression" || node.type === "NewExpression") {
      const callee = node.callee
      const member = memberName(callee)
      if (member !== undefined && member[0].type === "Identifier" && member[0].name === "console") return false
      if (ctxCall(node, "call")) {
        return (calls && acting) || node.arguments.some((argument) => visit(argument, true))
      }
      if (ctxCall(node, "done")) return node.arguments.some((argument) => visit(argument, true))
      const readsCallee = reading(callee)
      if (
        (callee.type === "Identifier" && pureFunctions.has(callee.name)) ||
        (member !== undefined && member[0].type === "Identifier" && pure.get(member[0].name)?.has(member[1]) === true)
      ) return node.arguments.some((argument) => visit(argument, acting))
      if (member !== undefined && keeping.has(member[1])) {
        // `all.push(seen)` writes `all`; `flows` follows `seen` into it.
        return node.arguments.some((argument) => visit(argument, false))
      }
      if (member !== undefined && readsCallee && !node.arguments.some(functionLike)) {
        // A method of the result itself, such as `seen.stdout.trim()`.
        return visit(callee, acting) || node.arguments.some((argument) => visit(argument, acting))
      }
      return readsCallee || node.arguments.some((argument) => reading(argument))
    }
    // A guard around printing alone reads its test for the model, not the
    // program; only as a statement of its own, since `ctx.done(r.ok || null)`
    // reads `r`.
    if (node.type === "IfStatement" && loggingOnly(node)) {
      return quietly(node.test) || visit(node.consequent, false) ||
        (node.alternate != null && visit(node.alternate, false))
    }
    if (node.type === "SwitchStatement" && loggingOnly(node)) {
      return quietly(node.discriminant) ||
        node.cases.some((entry) =>
          (entry.test != null && quietly(entry.test)) || entry.consequent.some((statement) => visit(statement, false))
        )
    }
    if (node.type === "ExpressionStatement" && loggingOnly(node)) return quietly(node.expression)
    switch (node.type) {
      case "VariableDeclarator":
        return node.init != null && visit(node.init, false)
      case "AssignmentExpression":
        return visit(node.left, false) || visit(node.right, false)
      case "ForOfStatement":
      case "ForInStatement":
        return visit(node.right, false) || visit(node.body, acting)
      case "IfStatement":
      case "ConditionalExpression":
      case "WhileStatement":
      case "DoWhileStatement":
        if (visit(node.test, true)) return true
        break
      case "LogicalExpression":
        if (visit(node.left, true)) return true
        break
      case "SwitchStatement":
        if (visit(node.discriminant, true)) return true
        break
      case "SwitchCase":
        if (node.test != null && visit(node.test, true)) return true
        break
    }
    return referencing(node).some((child) => visit(child, acting))
  }
  /** An expression whose value only decides what is printed. */
  const quietly = (node: Node): boolean => {
    if (node.type === "ConditionalExpression") {
      return quietly(node.test) || quietly(node.consequent) || quietly(node.alternate)
    }
    if (node.type === "LogicalExpression") return quietly(node.left) || quietly(node.right)
    return visit(node, false)
  }
  return visit(root, true)
}

/** Whether a call's result is used at all, rather than discarded as a statement of its own. */
const keepsResult = (root: Node): boolean => {
  const calls: Array<Node> = []
  const discarded = new Set<Node>()
  const visit = (node: Node): void => {
    if (ctxCall(node, "call")) calls.push(node)
    if (node.type === "ExpressionStatement" || (node.type === "UnaryExpression" && node.operator === "void")) {
      const inner = node.type === "ExpressionStatement" ? node.expression : node.argument
      discarded.add(inner.type === "AwaitExpression" ? inner.argument : inner)
    }
    for (const child of children(node)) visit(child)
  }
  visit(root)
  return calls.some((call) => !discarded.has(call))
}

/**
 * Whether a completing cell's source wrote its completion blind: it kept a
 * call's result for the model alone and completed from code that reads none.
 * A source that does not parse is never read as blind, because nothing here
 * can say what it did.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const blind = (source: string): boolean => {
  let program: Syntax.File
  try {
    program = parse(source, {
      sourceType: "script",
      plugins: ["typescript"],
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      errorRecovery: true
    })
  } catch {
    return false
  }
  if (!keepsResult(program.program)) return false
  const results = resultNames(program.program)
  if (!actsOn(program.program, results)) return true
  // A program that acted on some results but completes from none of them
  // wrote its answer blind to any result it only printed.
  if (completionReads(program.program, results)) return false
  return resultsByCall(program.program).some((held) => !actsOn(program.program, held, false))
}

/**
 * The calls a completion was written without reading, oldest first: every
 * call its own frame settled, when the cell wrote the completion blind.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const find = (calls: ReadonlyArray<Settled>, source: string): ReadonlyArray<Unobserved> =>
  calls.length === 0 || !blind(source)
    ? []
    : calls.map((call) => ({ flow: call.flow, ok: call.ok, ordinal: call.ordinal, summary: call.summary }))

/**
 * The demand a blind completion is handed back with: the results it never
 * read, then the correction.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const demand = (calls: ReadonlyArray<Unobserved>): string =>
  `${heading}:
${calls.map((call) => `- ${call.ordinal}. ${call.flow} -> ${call.ok ? "ok" : "FAILED"}: ${call.summary}`).join("\n")}

Answer after reading the calls' output, in a reply of its own.`
