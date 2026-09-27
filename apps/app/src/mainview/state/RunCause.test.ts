import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as ts from "typescript"
import { REFUSAL_COPY } from "@smthrs/rpc/RefusalCopy"
import {
  ANSWERED_CODES,
  HARNESS_CODES,
  isSharedCode,
  MODEL_CODES,
  OPEN_CODED,
  RUN_CAUSE_COPY,
  runCause,
  SHARED_CODES
} from "./RunCause"

/*
 * The sweep. `failureSummary` prefixes the code of the innermost rendered
 * record that carries a `message`, off ANY record, so every failure class in
 * this repo shaped `{ code, message: string }` can put its own code on a run's
 * first journal line. That shape is what this walk looks for, and the tag it
 * is declared under is the author the line does not carry.
 *
 * Nothing here is a list somebody maintains, and nothing here matches source
 * text. Four rounds of this file resolved a `code` field with regular
 * expressions and four rounds missed a spelling the repo already used —
 * a schema named in another file, `Data.TaggedError("tag")<{…}>`, an open code,
 * `Schema.Literal("…")` singular, a code built by a helper that defaults it so
 * no raise site ever writes one. Each miss was closed by adding a branch, and
 * the next spelling beat the new branch too.
 *
 * So this reads the language instead of the formatting. `ts.createSourceFile`
 * parses every source in the repo, {@link taggedOf} finds a class extending a
 * tagged-error base through its heritage clause, and {@link resolver} EVALUATES
 * the `code` member — following identifiers to their declarations, imported
 * names to the modules that export them, `export { X as Y }` through the
 * rename, `Schema.Literal`/`Literals`/`Union` to their arguments, `.pipe` and
 * `.pick` to their receiver, and a call to a helper this repo wrote into that
 * helper's body with its parameters bound. A spelling nobody has invented yet
 * resolves because the parser understands the language, not because someone
 * anticipated it. Where the evaluation cannot close the set the class is open,
 * and its codes are the literals its own `new` sites pass — read through a
 * shorthand, a const or a call into a repo helper, because a raise site's
 * `code` is evaluated exactly as a declaration's is.
 *
 * A class this walk cannot take apart is COUNTED, and the count is asserted at
 * zero. That is the part four earlier rounds lacked: each of them was beaten
 * by a shape that made a class vanish, and a table one class lighter looks
 * exactly like a table that is right.
 *
 * Tests are not swept. A class declared inside a `*.test.ts` or a `test/`
 * directory never crosses a seam into a person's run journal, and two such
 * fixtures (`ActionErrorCause/AdapterError`, `test/SeatRejected`) would
 * otherwise take `model_failed`, `authentication` and `quota_exceeded` off
 * this table for failures no person can be shown.
 */
const REPO = fileURLToPath(new URL("../../../../../", import.meta.url))
/* Every root holding this repo's own TypeScript. `crates` is Rust, `docs` is
 * prose, `patches` is diffs, and `node_modules` is somebody else's. */
const ROOTS = ["apps", "evals", "examples", "factory", "flows", "packages", "scripts"]
const SKIP_DIR = /^(node_modules|dist|coverage|out|\.git|\.jj|test|tests|__tests__|e2e)$/
const SKIP_FILE = /\.(test|spec)\.tsx?$/

const sources = (dir: string, found: Array<string> = []): Array<string> => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIR.test(entry.name)) sources(join(dir, entry.name), found) }
    else if (/\.tsx?$/.test(entry.name) && !SKIP_FILE.test(entry.name)) found.push(join(dir, entry.name))
  }
  return found
}

const parse = (path: string, text: string): ts.SourceFile =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

/** Past the wrappers that change a node's type and not its value. */
const unwrap = (node: ts.Node): ts.Node => {
  let at = node
  for (;;) {
    if (ts.isParenthesizedExpression(at) || ts.isAsExpression(at) || ts.isSatisfiesExpression(at) || ts.isNonNullExpression(at)) at = at.expression
    else if (ts.isParenthesizedTypeNode(at)) at = at.type
    else return at
  }
}

/** The last name in `a.b.c`, which is the one a declaration is keyed by. */
const name = (node: ts.Node): string | undefined => {
  const at = unwrap(node)
  if (ts.isIdentifier(at)) return at.text
  if (ts.isPropertyAccessExpression(at)) return at.name.text
  return undefined
}

/**
 * Every top-level name a file binds, to EVERY node that defines it.
 *
 * A schema and its decoded type share a name by convention
 * (`export const ModelErrorCode = …` beside
 * `export type ModelErrorCode = typeof ModelErrorCode.Type`), so one node per
 * name silently drops whichever is written second.
 */
const bindings = (file: ts.SourceFile): Map<string, Array<ts.Node>> => {
  const bound = new Map<string, Array<ts.Node>>()
  const add = (bind: string, node: ts.Node) => bound.set(bind, [...(bound.get(bind) ?? []), node])
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) add(declaration.name.text, declaration.initializer)
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) add(statement.name.text, statement)
    else if (ts.isTypeAliasDeclaration(statement)) add(statement.name.text, statement.type)
  }
  return bound
}

/** Where a name can be read: this file's own bindings, plus a call's arguments. */
interface Scope {
  readonly file: ts.SourceFile
  readonly locals: ReadonlyMap<string, ReadonlyArray<ts.Node>>
  readonly bound?: ReadonlyMap<string, { readonly node: ts.Node; readonly scope: Scope }>
}

const returned = (block: ts.Block): ts.Expression | undefined => {
  for (const statement of block.statements) if (ts.isReturnStatement(statement)) return statement.expression
  return undefined
}

/**
 * One member of a schema's fields, of a tagged class's type argument, or of the
 * object a `new` site passes.
 *
 * A shorthand yields its own name, because `{ code, message }` says `code` is
 * whatever `code` is in scope — which is a question for the evaluator, not for
 * this walk. That is the whole of the raise-site hole R111d found.
 */
const memberOf = (members: ts.ObjectLiteralExpression | ts.TypeLiteralNode, field: string): ts.Node | undefined => {
  if (ts.isObjectLiteralExpression(members)) {
    for (const property of members.properties) {
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === field) return property.name
      if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === field) return property.initializer
    }
    return undefined
  }
  for (const member of members.members) {
    if (ts.isPropertySignature(member) && ts.isIdentifier(member.name) && member.name.text === field) return member.type
  }
  return undefined
}

/**
 * Whether every member of a container is one {@link memberOf} can see, so that
 * finding no `code` means the class declares none rather than that the walk
 * could not read it.
 *
 * A spread is the case this exists for: `{ ...Common.fields, code: … }` has a
 * `message` this walk cannot find and `failureSummary` can, and a class dropped
 * for a missing `message` is a class that left this table silently.
 */
const readable = (members: ts.ObjectLiteralExpression | ts.TypeLiteralNode): boolean =>
  ts.isObjectLiteralExpression(members)
    ? members.properties.every((property) =>
      ts.isShorthandPropertyAssignment(property) ||
      (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)))
    : members.members.every((member) => ts.isPropertySignature(member) && ts.isIdentifier(member.name))

/** What one raise expression constructs: the class, and the codes that raise gives it. */
interface Raise {
  readonly raiser: string
  readonly codes: ReadonlySet<string>
  /** Whether the object it passes carries both members `failureSummary` reads. */
  readonly record: boolean
}

/**
 * An evaluator from a schema expression or a type to the string literals it
 * admits, over the whole parsed repo.
 *
 * A name is resolved in this order: a parameter bound by the call being
 * inlined, then this file's own declarations, then every module that exports
 * it. The last step is a union rather than a single module because a code
 * schema is imported as often as it is declared in place and the import
 * specifier is not followed to disk. Where one name is exported twice with
 * different literals the union stands: over-crediting a class puts a code in
 * {@link SHARED_CODES}, which costs a sentence, and under-crediting it lets a
 * foreign raiser through, which costs a person a false one.
 */
const resolver = (files: ReadonlyArray<ts.SourceFile>) => {
  const scopes = new Map<ts.SourceFile, Scope>()
  const scope = (file: ts.SourceFile): Scope => {
    const found = scopes.get(file)
    if (found !== undefined) return found
    const made: Scope = { file, locals: bindings(file) }
    scopes.set(file, made)
    return made
  }
  /* Every exported name in the repo, to the nodes that define it. */
  const exported = new Map<string, Array<{ readonly file: ts.SourceFile; readonly node: ts.Node }>>()
  /* `export { X as Y } from "./elsewhere"`: Y is whatever X is, wherever X is. */
  const renamed = new Map<string, string>()
  for (const file of files) {
    const locals = scope(file).locals
    const add = (bind: string, node: ts.Node) => exported.set(bind, [...(exported.get(bind) ?? []), { file, node }])
    for (const statement of file.statements) {
      const isExported = ts.canHaveModifiers(statement) &&
        ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
      if (isExported && ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) add(declaration.name.text, declaration.initializer)
        }
      } else if (isExported && ts.isTypeAliasDeclaration(statement)) add(statement.name.text, statement.type)
      else if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const from = (element.propertyName ?? element.name).text
          const here = locals.get(from)
          if (here !== undefined) for (const node of here) add(element.name.text, node)
          else if (element.propertyName !== undefined) renamed.set(element.name.text, from)
        }
      }
    }
  }

  const sites = (bind: string, at: Scope): ReadonlyArray<{ readonly node: ts.Node; readonly scope: Scope }> => {
    const parameter = at.bound?.get(bind)
    if (parameter !== undefined) return [parameter]
    const local = at.locals.get(bind)
    if (local !== undefined) return local.map((node) => ({ node, scope: { file: at.file, locals: at.locals } }))
    const rename = renamed.get(bind)
    const found = exported.get(bind) ?? (rename === undefined ? undefined : exported.get(rename))
    return (found ?? []).map((site) => ({ node: site.node, scope: scope(site.file) }))
  }

  /** The union over every definition of a name that resolves, or undefined when none does. */
  const named = (bind: string, at: Scope, path: Set<ts.Node>): ReadonlySet<string> | undefined => {
    const all = new Set<string>()
    let any = false
    for (const site of sites(bind, at)) {
      const found = codes(site.node, site.scope, path)
      if (found === undefined) continue
      any = true
      for (const code of found) all.add(code)
    }
    return any ? all : undefined
  }

  /** The union over every node, or undefined when any one of them is open. */
  const every = (nodes: ReadonlyArray<ts.Node> | ts.NodeArray<ts.Node>, at: Scope, path: Set<ts.Node>): ReadonlySet<string> | undefined => {
    const all = new Set<string>()
    for (const node of nodes) {
      const found = codes(node, at, path)
      if (found === undefined) return undefined
      for (const code of found) all.add(code)
    }
    return all
  }

  const call = (node: ts.CallExpression, at: Scope, path: Set<ts.Node>): ReadonlySet<string> | undefined => {
    const callee = unwrap(node.expression)
    const called = name(callee)
    const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression : undefined
    /* `Schema.Literal("a")`, `Schema.Literal("a", "b")`, `Schema.Literals([…])` and `Schema.Union([…])`
     * are all the union of their arguments, whatever shape those arguments are written in. */
    if (called === "Literal" || called === "Literals" || called === "Union") return every(node.arguments, at, path)
    /* A pipe, an annotation and a check all keep their receiver's members whatever they add —
     * a constructor default, an identifier, a refinement are still that set — and a pick keeps
     * the ones it names. `@smthrs/sync`'s `Schema.Literals(errorCodes).annotate({ identifier })`
     * is a closed declaration that read as an open one until `annotate` was one of these. */
    if ((called === "pipe" || called === "annotate" || called === "check") && receiver !== undefined) return codes(receiver, at, path)
    if (called === "pick" && receiver !== undefined) {
      const whole = codes(receiver, at, path)
      const picked = every(node.arguments, at, path)
      return whole === undefined || picked === undefined ? undefined : new Set([...picked].filter((code) => whole.has(code)))
    }
    /* A helper this repo wrote: evaluate its body with its parameters bound to these arguments. */
    for (const site of called === undefined ? [] : sites(called, at)) {
      const fn = unwrap(site.node)
      if (!ts.isArrowFunction(fn) && !ts.isFunctionDeclaration(fn) && !ts.isFunctionExpression(fn)) continue
      const bound = new Map<string, { readonly node: ts.Node; readonly scope: Scope }>()
      fn.parameters.forEach((parameter, index) => {
        const argument = node.arguments[index]
        if (argument !== undefined && ts.isIdentifier(parameter.name)) bound.set(parameter.name.text, { node: argument, scope: at })
      })
      const body = fn.body === undefined ? undefined : ts.isBlock(fn.body) ? returned(fn.body) : fn.body
      const found = body === undefined ? undefined : codes(body, { file: site.scope.file, locals: site.scope.locals, bound }, path)
      if (found !== undefined) return found
    }
    return undefined
  }

  /** The string literals this expression or type admits, or undefined when the set is not closed. */
  const codes = (node: ts.Node, at: Scope, path: Set<ts.Node>): ReadonlySet<string> | undefined => {
    if (path.has(node)) return undefined
    path.add(node)
    try {
      const it = unwrap(node)
      if (ts.isStringLiteralLike(it)) return new Set([it.text])
      if (ts.isLiteralTypeNode(it) && ts.isStringLiteralLike(it.literal)) return new Set([it.literal.text])
      if (ts.isUnionTypeNode(it)) return every(it.types, at, path)
      if (ts.isArrayLiteralExpression(it)) return every(it.elements, at, path)
      if (ts.isTupleTypeNode(it)) return every(it.elements, at, path)
      if (ts.isIdentifier(it)) return named(it.text, at, path)
      if (ts.isTypeReferenceNode(it)) return named(ts.isQualifiedName(it.typeName) ? it.typeName.right.text : it.typeName.text, at, path)
      if (ts.isPropertyAccessExpression(it)) return named(it.name.text, at, path)
      if (ts.isTypeQueryNode(it)) {
        /* `typeof ModelErrorCode.Type` is the decoded form of the schema of that name. */
        let entity = it.exprName
        while (ts.isQualifiedName(entity)) entity = entity.left
        return named(entity.text, at, path)
      }
      if (ts.isIndexedAccessTypeNode(it)) return codes(it.objectType, at, path)
      if (ts.isCallExpression(it)) return call(it, at, path)
      return undefined
    } finally {
      path.delete(node)
    }
  }

  /**
   * Every class a raise expression constructs, to the codes that raise gives it.
   *
   * A `new` site's `code` is EVALUATED here, not matched: a shorthand, a const and a
   * call into a repo helper all resolve exactly as they already do in a declaration.
   * And a CALL is a raise site too, because `failure("model_failed", …)` raises
   * whatever its body constructs — so the helper is inlined with its arguments bound,
   * which is the same machinery {@link call} uses. Without that hop, a file whose
   * every raise goes through a one-line helper credits its codes to nothing.
   */
  /**
   * Every name bound to a function that raises, directly or through another one.
   *
   * The inlining below is worth doing for `failure(…)` and pointless for the tens of
   * thousands of other calls in this repo, so the names worth trying are found once: a
   * function whose returned expression is a `new`, then a function whose returned
   * expression calls one of those, to a fixed point.
   */
  let raisers: Set<string> | undefined
  const helpers = (): ReadonlySet<string> => {
    if (raisers !== undefined) return raisers
    const bodies = new Map<string, Array<ts.Node>>()
    const add = (bind: string, node: ts.Node) => {
      const fn = unwrap(node)
      if (!ts.isArrowFunction(fn) && !ts.isFunctionDeclaration(fn) && !ts.isFunctionExpression(fn)) return
      const body = fn.body === undefined ? undefined : ts.isBlock(fn.body) ? returned(fn.body) : fn.body
      if (body !== undefined) bodies.set(bind, [...(bodies.get(bind) ?? []), unwrap(body)])
    }
    for (const file of files) for (const [bind, nodes] of scope(file).locals) for (const node of nodes) add(bind, node)
    for (const [bind, sites] of exported) for (const site of sites) add(bind, site.node)
    const found = new Set<string>()
    for (let round = 0, grew = true; grew && round < 8; round++) {
      grew = false
      for (const [bind, nodes] of bodies) {
        if (found.has(bind)) continue
        const raises = nodes.some((body) =>
          ts.isNewExpression(body) || (ts.isCallExpression(body) && found.has(name(unwrap(body.expression)) ?? "")))
        if (raises) { found.add(bind); grew = true }
      }
    }
    raisers = found
    return found
  }

  const raises = (node: ts.Node, at: Scope, path: Set<ts.Node>): ReadonlyArray<Raise> => {
    if (path.has(node)) return []
    path.add(node)
    try {
      const it = unwrap(node)
      if (ts.isNewExpression(it)) {
        const raiser = name(it.expression)
        const first = it.arguments?.[0] === undefined ? undefined : unwrap(it.arguments[0])
        if (raiser === undefined || first === undefined || !ts.isObjectLiteralExpression(first)) return []
        const code = memberOf(first, "code")
        const found = code === undefined ? undefined : codes(code, at, path)
        return [{ raiser, codes: found ?? new Set(), record: code !== undefined && memberOf(first, "message") !== undefined }]
      }
      if (!ts.isCallExpression(it)) return []
      const called = name(unwrap(it.expression))
      if (called === undefined || !helpers().has(called)) return []
      for (const site of sites(called, at)) {
        const fn = unwrap(site.node)
        if (!ts.isArrowFunction(fn) && !ts.isFunctionDeclaration(fn) && !ts.isFunctionExpression(fn)) continue
        const body = fn.body === undefined ? undefined : ts.isBlock(fn.body) ? returned(fn.body) : fn.body
        if (body === undefined) continue
        const bound = new Map<string, { readonly node: ts.Node; readonly scope: Scope }>()
        fn.parameters.forEach((parameter, index) => {
          const argument = it.arguments[index]
          if (argument !== undefined && ts.isIdentifier(parameter.name)) bound.set(parameter.name.text, { node: argument, scope: at })
        })
        const found = raises(body, { file: site.scope.file, locals: site.scope.locals, bound }, path)
        if (found.length > 0) return found
      }
      return []
    } finally {
      path.delete(node)
    }
  }

  return {
    scope,
    /** What one raise expression constructs, read in one file's scope. */
    raises: (node: ts.Node, file: ts.SourceFile): ReadonlyArray<Raise> => raises(node, scope(file), new Set()),
    /** The literal set a schema expression or type admits, read in one file's scope. */
    read: (node: ts.Node, file: ts.SourceFile): ReadonlySet<string> | undefined => codes(node, scope(file), new Set()),
    /** The literal set a name admits, read in one file's scope. */
    declared: (bind: string, file: ts.SourceFile): ReadonlySet<string> | undefined => named(bind, scope(file), new Set())
  }
}

/** What a class's heritage clause says it is, whether or not the walk got it all. */
interface Heritage {
  /** Whether the base chain calls a `*TaggedError`, which is what makes it a failure class. */
  readonly tagged: boolean
  /** Whether the base is a call chain at all, as every tagged spelling in this repo is. */
  readonly chain: boolean
  readonly tag?: string
  readonly members?: ts.ObjectLiteralExpression | ts.TypeLiteralNode
}

/**
 * The tag and member container of a class extending a tagged-error base.
 *
 * Both spellings this repo uses land here, because the walk follows the call
 * chain of the heritage clause rather than a shape:
 * `Schema.TaggedError<T>()("tag", { … })` puts the members in an argument and
 * `Data.TaggedError("tag")<{ … }>` puts them in a type argument. A tag written
 * as a name rather than a literal — `Schema.TaggedError<Skipped>()(skippedTag,
 * { … })`, live in `agent/src/Budget.ts` — is EVALUATED, like every other
 * member of this walk.
 *
 * What it found is returned even when it is not everything, because a class
 * this walk cannot take apart has to be counted rather than dropped: that is
 * the difference between a sixth shape reddening this file and vanishing from
 * it.
 */
const taggedOf = (node: ts.ClassLikeDeclaration, read: (node: ts.Node) => ReadonlySet<string> | undefined): Heritage => {
  const heritage = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
  if (heritage === undefined) return { tagged: false, chain: false }
  let tag: string | undefined
  let members: ts.ObjectLiteralExpression | ts.TypeLiteralNode | undefined
  let tagged = false
  let chain = false
  const fromTypes = (nodes: ts.NodeArray<ts.TypeNode> | undefined) => {
    for (const argument of nodes ?? []) {
      const type = unwrap(argument)
      if (ts.isTypeLiteralNode(type) && members === undefined) members = type
    }
  }
  fromTypes(heritage.typeArguments)
  let at: ts.Node = unwrap(heritage.expression)
  while (ts.isCallExpression(at)) {
    chain = true
    if (name(at.expression)?.endsWith("TaggedError") === true) tagged = true
    for (const argument of at.arguments) {
      /* `Schema.Struct({ … })` is those fields, so a base written around one is as readable
       * as a bare fields object (`harness/Cell.ts` `CallResult`). */
      const fields = unwrap(argument)
      const inner = ts.isCallExpression(fields) && name(fields.expression) === "Struct" && fields.arguments[0] !== undefined
        ? unwrap(fields.arguments[0])
        : fields
      if (ts.isObjectLiteralExpression(inner)) { if (members === undefined) members = inner }
      else if (tag === undefined) {
        const found = read(argument)
        if (found?.size === 1) tag = [...found][0]
      }
    }
    fromTypes(at.typeArguments)
    at = unwrap(at.expression)
  }
  return { tagged, chain, ...(tag === undefined ? {} : { tag }), ...(members === undefined ? {} : { members }) }
}

/**
 * Every code a tagged failure class in these sources can carry, to the tags
 * that carry it.
 *
 * A class whose `code` no declaration closes falls back to the literals its
 * own `new` sites pass, so an open `code: Schema.String` cannot spell an
 * answered code at a raise site and say nothing here.
 */
const sweepOf = (files: ReadonlyArray<ts.SourceFile>) => {
  const read = resolver(files)
  const raised = new Map<string, Set<string>>()
  /* Every class some raise site passes the `{ code, message }` record `failureSummary` reads. */
  const records = new Set<string>()
  const owners = new Map<string, Set<string>>()
  const unread: Array<string> = []
  const open = new Set<string>()
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
        for (const raise of read.raises(node, file)) {
          if (raise.record) records.add(raise.raiser)
          for (const code of raise.codes) raised.set(raise.raiser, (raised.get(raise.raiser) ?? new Set()).add(code))
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  for (const file of files) {
    const where = (node: ts.ClassLikeDeclaration) => `${file.fileName.slice(file.fileName.lastIndexOf("/") + 1)} ${node.name?.text ?? "(anonymous)"}`
    const visit = (node: ts.Node): void => {
      if (ts.isClassLike(node)) {
        const heritage = taggedOf(node, (at) => read.read(at, file))
        const { chain, members, tag, tagged } = heritage
        const whole = tag !== undefined && members !== undefined && readable(members)
        /* A class the heritage says IS a failure and this walk could not take apart, and
         * a class it read as nothing at all that a raise site builds with the record
         * `failureSummary` reads. A spread, a tag it cannot evaluate and a factory base
         * all land here rather than leaving the table one class lighter in silence. */
        if (tagged ? !whole : chain && members === undefined && node.name !== undefined && records.has(node.name.text)) {
          unread.push(where(node))
        } else if (tagged && whole) {
          /* `failureSummary` reads a record's code only when that record also carries the message. */
          const code = memberOf(members!, "message") === undefined ? undefined : memberOf(members!, "code")
          if (code !== undefined) {
            const declared = read.read(code, file)
            if (declared === undefined) open.add(tag!)
            const closed = declared ?? (node.name === undefined ? undefined : raised.get(node.name.text))
            for (const one of closed ?? []) owners.set(one, (owners.get(one) ?? new Set()).add(tag!))
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return {
    owners: owners as ReadonlyMap<string, ReadonlySet<string>>,
    /** Every tagged failure class this walk could not take apart, by file and name. */
    unread: unread as ReadonlyArray<string>,
    /** Every tagged failure whose `code` no declaration closes, by tag. */
    open: open as ReadonlySet<string>,
    read
  }
}

const HARNESS = "packages/smithers/agent/harness/src/HarnessError.ts"
const MODEL = "packages/smithers/agent/model/src/ModelError.ts"

/**
 * How long the first test that touches {@link repo} may take.
 *
 * `ts.createSourceFile` over every source in the repo is ~2 s alone and several
 * times that on a loaded machine, and it happens once for the whole file. The
 * default 5 s is a coin flip under CI load, and a suite that reds on the
 * machine's queue depth teaches people to ignore it.
 */
const SWEPT = 60_000

/** The parsed repo, swept once for every test that needs it. */
let swept: {
  readonly owners: ReadonlyMap<string, ReadonlySet<string>>
  readonly unread: ReadonlyArray<string>
  readonly open: ReadonlySet<string>
  readonly vocabulary: (path: string, of: string) => ReadonlyArray<string>
} | undefined
const repo = () => {
  if (swept !== undefined) return swept
  const files = new Map<string, ts.SourceFile>()
  for (const root of ROOTS) for (const path of sources(join(REPO, root))) files.set(path, parse(path, readFileSync(path, "utf8")))
  const { open, owners, read, unread } = sweepOf([...files.values()])
  swept = { owners, unread, open, vocabulary: (path, of) => [...read.declared(of, files.get(join(REPO, path))!) ?? []] }
  return swept
}

test("every code the harness and the model declare is answered here, and only those", () => {
  const harness = repo().vocabulary(HARNESS, "HarnessErrorCode")
  const model = repo().vocabulary(MODEL, "ModelErrorCode")
  expect(harness.length).toBeGreaterThan(0)
  expect(model.length).toBeGreaterThan(0)
  const answered: ReadonlyArray<string> = HARNESS_CODES
  const provider: ReadonlyArray<string> = MODEL_CODES
  expect([...answered].sort()).toEqual([...harness].sort())
  expect([...provider].sort()).toEqual([...model].sort())
  expect(Object.keys(RUN_CAUSE_COPY).sort()).toEqual([...harness, ...model].filter((code) => !isSharedCode(code)).sort())
  const table: ReadonlyArray<string> = ANSWERED_CODES
  expect([...table].sort()).toEqual(Object.keys(RUN_CAUSE_COPY).sort())
}, SWEPT)

/*
 * The claim this file used to make, and the one it makes now. The two
 * vocabularies are disjoint from each other — that much was true and is still
 * checked — but disjointness from EACH OTHER never made a code identify its
 * author, because the line a card reads is `<code>: <message>` and any tagged
 * failure in this repo can write one. That is what the sweep decides, and a
 * new foreign raiser fails here rather than reaching a person as the model's
 * sentence and waiting for a reviewer to notice.
 */
test("a code this table answers is one no other failure vocabulary in the repo spells", () => {
  const harness = repo().vocabulary(HARNESS, "HarnessErrorCode")
  const model = repo().vocabulary(MODEL, "ModelErrorCode")
  expect(harness.filter((code) => model.includes(code))).toEqual([])

  const owners = repo().owners
  /* The sweep finds the two declarations it is judging, so a walk that read nothing cannot pass. */
  for (const code of [...harness, ...model]) expect([...owners.get(code) ?? []]).not.toEqual([])

  const shared = Object.fromEntries(
    [...harness, ...model]
      .filter((code) => (owners.get(code)?.size ?? 0) > 1)
      .map((code) => [code, [...owners.get(code)!].sort()])
  )
  /* Every code more than one vocabulary spells, and every vocabulary that spells it. */
  expect(shared).toEqual(
    Object.fromEntries(Object.entries(SHARED_CODES).map(([code, tags]) => [code, [...tags].sort()]))
  )
  /* A shared code gets no sentence, and every code with one has exactly one author. */
  for (const code of Object.keys(shared)) expect(runCause(code)).toBeUndefined()
  for (const code of ANSWERED_CODES) expect(owners.get(code)?.size).toBe(1)
}, SWEPT)

/*
 * Nine declaration shapes, each read off a class that is on the tree today,
 * so a shape stops being understood here before it stops being caught above.
 * Every one of them was a live blind spot of some earlier regular expression,
 * and the parser resolves them all without a branch for any of them.
 */
test("every shape this repo declares a failure code in is read off the real tree", () => {
  const owners = repo().owners
  const only = (code: string) => [...owners.get(code) ?? []].sort()
  /* 1. An inline `Schema.Literals([…])`. */
  expect(only("model_failed")).toEqual(["/harness/HarnessError"])
  /* 2. A code schema another file declares: `code: GrantStoreErrorCode`, imported from `./GrantStoreErrorCode.ts`. */
  expect(only("request_not_found")).toEqual(["@smthrs/capability/GrantStoreError"])
  /* 3. `TokenError` declares `Data.TaggedError("tag")<{ readonly code: WorkerFailureCode; … }>`. */
  expect(only("workspace_gone")).toEqual(["TokenError"])
  /* 4. A closed set reached through `.annotate({ identifier })`, which read as an OPEN class
   * until `annotate` joined `pipe`: an annotation keeps its receiver's members. */
  expect(only("lineage_changed")).toEqual(["@smthrs/sync/SyncError"])
  /* 5. `Schema.Literal("…")` singular, under a name, one directory from the harness's own error. */
  expect(only("invalid_compaction_prefix")).toEqual(["flows/harness/ContextWindowError"])
  /* 6. The same spelling in another package, read through `typeof …Code.Type` as well as the const. */
  expect(only("entry_limit_exceeded")).toEqual(["@smthrs/engine-store/FileEnumerationError"])
  /* 7. `constantCode("launch_failed")`, a helper whose constructor default means no raise site
   * writes a `code:` at all — the shape a raise-site fallback can never rescue. */
  expect(only("launch_failed")).toEqual(["/control/LaunchFailed"])
  /* And `AlertError`'s code is a declared set behind a constructor default, not an open one:
   * all four come off `FailureCode`, not off `layerWebhook` happening to spell them. */
  expect(only("sink_unreachable")).toEqual(["/notifications/AlertError"])
  /* The build tree ships and is walked: it holds two vocabularies no earlier sweep ever saw. */
  expect(only("probe_failed")).toEqual(["smithers-build/RuntimeError"])
  /* 8. A tag written as a name rather than a literal: `agent/src/Budget.ts` declares
   * `Schema.TaggedError<Skipped>()(skippedTag, { … })`, which the walk used to drop whole. */
  expect(repo().vocabulary("packages/smithers/agent/src/Budget.ts", "skippedTag")).toEqual(["flows/agent/Skipped"])
  /* 9. A code this repo declares and a guest program outside it answers: the codes on
   * `coding/NativeCodingError` are `NativeCode`, which is what the native adapter's error
   * envelope now decodes into (`flows/coding/native.ts`). */
  expect(only("workspace_busy")).toEqual(["coding/NativeCodingError"])
}, SWEPT)

/*
 * The same seven shapes as source rather than as pins, so a regression in the
 * parser names the shape it lost instead of naming a package that moved.
 */
test("the reader resolves each shape from source, including a renamed re-export", () => {
  const files = [
    parse("/probe/codes.ts", [
      `export const Inline = Schema.Literals(["inline_one"])`,
      `export const Hidden = Schema.Literals(["renamed_one"])`,
      `export const Singular = Schema.Literal("singular_one")`,
      `export type Singular = typeof Singular.Type`
    ].join("\n")),
    parse("/probe/rename.ts", `export { Hidden as Renamed } from "./codes.ts"`),
    parse("/probe/errors.ts", [
      `const constantCode = <const Code extends string>(code: Code) =>`,
      `  Schema.Literal(code).pipe(Schema.withConstructorDefault(Effect.succeed(code)))`,
      `export class Inlined extends Schema.TaggedError<Inlined>()("probe/Inlined", {`,
      `  code: Schema.Literals(["literals_one"]), message: Schema.String`,
      `}) {}`,
      `export class Imported extends Schema.TaggedError<Imported>()("probe/Imported", {`,
      `  code: Inline, message: Schema.String`,
      `}) {}`,
      `export class Reexported extends Schema.TaggedError<Reexported>()("probe/Reexported", {`,
      `  code: Renamed, message: Schema.String`,
      `}) {}`,
      `export class Single extends Schema.TaggedError<Single>()("probe/Single", {`,
      `  code: Schema.Literal("single_one"), message: Schema.String`,
      `}) {}`,
      `export class Named extends Schema.TaggedError<Named>()("probe/Named", {`,
      `  code: Singular, message: Schema.String`,
      `}) {}`,
      `export class Defaulted extends Schema.TaggedError<Defaulted>()("probe/Defaulted", {`,
      `  code: constantCode("defaulted_one"), message: Schema.String`,
      `}) {}`,
      `export const raise = () => new Defaulted({ message: "no raise site writes this code" })`,
      `export class Tagged extends Data.TaggedError("probe/Tagged")<{`,
      `  readonly code: "data_one" | "data_two"`,
      `  readonly message: string`,
      `}> {}`,
      `export class Open extends Schema.TaggedError<Open>()("probe/Open", {`,
      `  code: Schema.String, message: Schema.String`,
      `}) {}`
    ].join("\n")),
    parse("/probe/raise.ts", `export const raise = () => new Open({ code: "open_one", message: "" })`)
  ]
  const { owners } = sweepOf(files)
  expect(Object.fromEntries([...owners].map(([code, tags]) => [code, [...tags].sort()]))).toEqual({
    literals_one: ["probe/Inlined"],
    inline_one: ["probe/Imported"],
    /* `export { Inline as Renamed }` — the cross-file fix is not one `as` away from defeat. */
    renamed_one: ["probe/Reexported"],
    single_one: ["probe/Single"],
    singular_one: ["probe/Named"],
    defaulted_one: ["probe/Defaulted"],
    data_one: ["probe/Tagged"],
    data_two: ["probe/Tagged"],
    open_one: ["probe/Open"]
  })
})

/*
 * The eighth shape, and the first one a reviewer beat on the first try: an open
 * class whose every raise goes through a one-line helper, which is how
 * `flows/coding/native.ts` writes about twenty codes. A raise site's `code` is
 * read by the same evaluator a declaration's is, so a shorthand, a const and a
 * call into a repo helper all resolve — and a call IS a raise site, because
 * `failure("model_failed", …)` raises whatever its body constructs.
 */
test("an open class's codes are read off its raise sites however the raise is written", () => {
  const files = [
    parse("/probe/open.ts", [
      `export class Open extends Schema.TaggedError<Open>()("probe/Open", {`,
      `  code: Schema.String, message: Schema.String`,
      `}) {}`
    ].join("\n")),
    parse("/probe/helper.ts", [
      /* The live shape: a shorthand `{ code, message }` inside a helper nobody calls directly. */
      `const failure = (code: string, message: string) => new Open({ code, message })`,
      `export const one = () => failure("helper_one", "through this file's own helper")`,
      `export const two = () => Effect.fail(failure("helper_two", "and again, under a wrapper"))`,
      /* A const, resolved where the raise site writes it. */
      `const THIRD = "helper_three"`,
      `export const three = () => new Open({ code: THIRD, message: "a name, not a literal" })`,
      /* And the bare literal that was the only spelling ever credited before. */
      `export const four = () => new Open({ code: "helper_four", message: "" })`
    ].join("\n"))
  ]
  const { owners } = sweepOf(files)
  expect(Object.fromEntries([...owners].map(([code, tags]) => [code, [...tags].sort()]))).toEqual({
    helper_one: ["probe/Open"],
    helper_two: ["probe/Open"],
    helper_three: ["probe/Open"],
    helper_four: ["probe/Open"]
  })
})

/*
 * Four rounds of this file each closed the shape a reviewer had just shown and
 * were beaten by the next one. The reason was never the shape: it was that a
 * class this walk cannot take apart LEAVES, and a table one class lighter looks
 * exactly like a table that is right. So a class the heritage says is a failure
 * and the walk cannot read is counted, and the count is asserted at zero — a
 * sixth shape reds this file rather than surprising the next reviewer.
 */
test("a failure class this reader cannot take apart is counted, not dropped", () => {
  const files = [
    parse("/probe/common.ts", `export const Common = { fields: { message: Schema.String } }`),
    parse("/probe/unread.ts", [
      /* A fields object behind a spread: `memberOf` finds no `message` and `failureSummary` does. */
      `export class Spread extends Schema.TaggedError<Spread>()("probe/Spread", {`,
      `  ...Common.fields, code: Schema.Literal("spread_one")`,
      `}) {}`,
      /* A tag this walk cannot evaluate. */
      `export class Computed extends Schema.TaggedError<Computed>()(tagFor("probe", counter()), {`,
      `  code: Schema.Literal("computed_one"), message: Schema.String`,
      `}) {}`,
      /* A base built by a factory: no `TaggedError` anywhere in the chain, and no fields
       * object either, so the class is read as nothing — while a raise site beside it
       * passes the exact record `failureSummary` reads. */
      `export class Factory extends failureClass<Factory>("probe/Factory", "model_failed") {}`,
      `export const raise = () => new Factory({ code: "model_failed", message: "" })`
    ].join("\n")),
    /* A readable class in the same file set, so the count is of the unreadable ones only. */
    parse("/probe/read.ts", [
      `export class Plain extends Schema.TaggedError<Plain>()("probe/Plain", {`,
      `  code: Schema.Literal("plain_one"), message: Schema.String`,
      `}) {}`
    ].join("\n"))
  ]
  const { owners, unread } = sweepOf(files)
  expect([...unread].sort()).toEqual(["unread.ts Computed", "unread.ts Factory", "unread.ts Spread"])
  /* And each one really did lose its code: the count is what says so, not a reviewer. */
  expect(owners.get("spread_one")).toBeUndefined()
  expect(owners.get("computed_one")).toBeUndefined()
  expect(owners.get("model_failed")).toBeUndefined()
  expect([...owners.get("plain_one") ?? []]).toEqual(["probe/Plain"])
})

test("no failure class on the real tree defeats this reader in silence", () => {
  expect(repo().unread).toEqual([])
}, SWEPT)

/*
 * Where the guarantee stops, enumerated rather than asserted.
 *
 * A class whose `code` a declaration closes can only ever carry codes written
 * in this repo. A class whose `code` is open cannot: its codes are the literals
 * its raise sites pass PLUS whatever a raise site passes that is not a literal
 * at all — a string decoded from a subprocess, an HTTP body, a file. Those are
 * the classes {@link RunCause.OPEN_CODED} names, and this is the check
 * that the list is the whole list: a new open `{ code, message }` class reds
 * here until it is placed.
 */
test("every failure class whose code no declaration closes is one the guarantee names", () => {
  expect([...repo().open].sort()).toEqual([...OPEN_CODED].sort())
}, SWEPT)

test("no sentence a person reads carries a code, an internal id, or a thrown message", () => {
  for (const [code, row] of Object.entries(RUN_CAUSE_COPY)) {
    expect(row.message).not.toContain(code)
    /* Every code in both vocabularies is snake_case, and no sentence spells one. */
    expect(row.message).not.toMatch(/[a-z]_[a-z]/)
    expect(row.message).not.toMatch(/\b(run-|Error|Exception|undefined|null|session ")/)
    expect(row.message[0]).toBe(row.message[0]!.toUpperCase())
    expect(row.message.endsWith(".")).toBe(true)
  }
})

test("a fault that is not the person's says so, and one that is names the act", () => {
  for (const [code, row] of Object.entries(RUN_CAUSE_COPY)) {
    expect(Object.keys(REFUSAL_COPY)).toContain(row.fault)
    if (row.fault === "user") expect(row.message).not.toContain("Not your")
    else expect(row.message).toContain("Not your")
    /* A sentence that only assigns blame tells the reader nothing to do next. */
    expect(row.message.length).toBeGreaterThan(REFUSAL_COPY.infra.lead.length / 2)
    expect(code).toBeString()
  }
})

test("the late-turn conditions are different sentences, not one lead", () => {
  const distinct = [
    /* A turn opened and nothing came back. */ "model_failed",
    /* The engine under the turn, rather than the model in it. */ "engine_failed",
    /* The brake, both halves, which mean different things since 46fcc61722f5. */ "claim_unproven",
    "completion_unjudged",
    /* Nothing was assembled, versus a turn that could not be built to send. */ "assembly_failed",
    "render_failed",
    /* A cap this side enforced, and a wait that never ended. */ "read_only_cap",
    "suspended",
    /* A record from another build. */ "incompatible_journal",
    /* The model's own nine, each a different condition at the provider boundary. */
    "content_policy",
    "context_overflow",
    "invalid_provider_output",
    "no_route",
    "authentication",
    "provider_internal",
    "transport",
    "quota_exceeded",
    "call_timeout"
  ] as const
  const said = distinct.map((code) => runCause(code)!.message)
  expect(new Set(said).size).toBe(distinct.length)
  for (const sentence of said) expect(sentence).not.toBe(REFUSAL_COPY.infra.lead)
})

test("a code this build has never heard of is answered by nothing here", () => {
  for (const code of ["", "brand_new_code", "invalid_receipt", "execution", "stale_revision"]) {
    expect(runCause(code)).toBeUndefined()
  }
  /* And neither is one another vocabulary also spells, whoever raised it this time. */
  for (const code of Object.keys(SHARED_CODES)) expect(runCause(code)).toBeUndefined()
})
