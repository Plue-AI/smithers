/**
 * Validates the SFT dataset before it is uploaded or trained on.
 *
 * The exit code is the verdict, so this runs as a `NodeTest` gate: it proves
 * every row is a well-formed OpenAI chat example before an irreversible
 * `firectl dataset create` ships it to Fireworks. `firectl` uploads each row
 * verbatim, so the gate also rejects anything that must not leave this machine:
 * top-level metadata beside `messages`, absolute host paths, and credential
 * shapes. Assistant code may only import public paths from current workspace
 * packages. It reads its dataset and workspace graph relative to this file,
 * independently of the runner's working directory.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as ts from "typescript"

const roles = new Set(["system", "user", "assistant", "tool"])
const messageKeys = new Set(["role", "content"])
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

/** Read the package names and public paths from the root's declared workspaces. */
const workspaceExports = (): ReadonlyMap<string, ReadonlyMap<string, unknown>> => {
  const root = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8")) as {
    workspaces: ReadonlyArray<string>
  }
  const packages = new Map<string, ReadonlyMap<string, unknown>>()
  for (const pattern of root.workspaces) {
    const directories = pattern.endsWith("/*")
      ? readdirSync(join(workspaceRoot, pattern.slice(0, -2)), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${pattern.slice(0, -1)}${entry.name}`)
      : [pattern]
    for (const directory of directories) {
      const manifest = join(workspaceRoot, directory, "package.json")
      if (!existsSync(manifest)) continue
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string
        exports?: Record<string, unknown> | string | null
      }
      if (pkg.name) {
        const exposed = pkg.exports === undefined
          ? { ".": true }
          : typeof pkg.exports === "object" && pkg.exports !== null
            ? pkg.exports
            : { ".": pkg.exports }
        packages.set(pkg.name, new Map(Object.entries(exposed)))
      }
    }
  }
  return packages
}

const publicPackages = workspaceExports()

/** Parse assistant TypeScript so comments and quoted examples are not imports. */
const importSpecifiers = (code: string): ReadonlyArray<string> => {
  const source = ts.createSourceFile("assistant.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

const isExposed = (exports: ReadonlyMap<string, unknown>, subpath: string): boolean => {
  if (exports.has(subpath)) return exports.get(subpath) !== null
  const wildcard = [...exports.keys()]
    .filter((key) => {
      const star = key.indexOf("*")
      if (star < 0) return false
      const prefix = key.slice(0, star)
      const suffix = key.slice(star + 1)
      return subpath.length >= prefix.length + suffix.length &&
        subpath.startsWith(prefix) && subpath.endsWith(suffix)
    })
    .sort((a, b) => b.length - a.length)[0]
  return wildcard !== undefined && exports.get(wildcard) !== null
}

const workspaceImportProblem = (specifier: string): string | undefined => {
  if (!specifier.startsWith("@smthrs/")) return undefined
  const parts = specifier.split("/")
  const name = parts.slice(0, 2).join("/")
  const exports = publicPackages.get(name)
  if (!exports) return `imports ${JSON.stringify(specifier)} from a missing workspace package`
  const subpath = parts.length === 2 ? "." : `./${parts.slice(2).join("/")}`
  if (!isExposed(exports, subpath)) return `imports unpublished path ${JSON.stringify(specifier)}`
  return undefined
}

/**
 * Content that must never reach the training corpus: a home directory reveals
 * the maintainer's username and layout, and a credential shape is a leaked key.
 */
const forbidden: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  {
    label: "absolute host path",
    pattern: /(?:\/(?:Users|home)\/[A-Za-z0-9._-]+|\b[A-Za-z]:\\Users\\[A-Za-z0-9._-]+|(?:^|[\s"'`(=:])~[A-Za-z0-9._-]*\/)/
  },
  { label: "Fireworks API key", pattern: /\bfw_[A-Za-z0-9]{16,}/ },
  { label: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "JSON Web Token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/ }
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const validateRow = (parsed: unknown, row: number): ReadonlyArray<string> => {
  if (!isRecord(parsed)) {
    return [`row ${row}: not a JSON object`]
  }
  const problems: string[] = []
  const extraKeys = Object.keys(parsed).filter((key) => key !== "messages")
  if (extraKeys.length > 0) {
    problems.push(`row ${row}: unexpected top-level key(s) ${extraKeys.map((key) => JSON.stringify(key)).join(", ")}`)
  }

  const messages = parsed.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    problems.push(`row ${row}: missing a non-empty "messages" array`)
    return problems
  }

  messages.forEach((message: unknown, messageIndex) => {
    const at = `row ${row}, message ${messageIndex + 1}`
    if (!isRecord(message)) {
      problems.push(`${at}: not a JSON object`)
      return
    }
    const extraMessageKeys = Object.keys(message).filter((key) => !messageKeys.has(key))
    if (extraMessageKeys.length > 0) {
      problems.push(`${at}: unexpected key(s) ${extraMessageKeys.map((key) => JSON.stringify(key)).join(", ")}`)
    }
    if (typeof message.role !== "string" || !roles.has(message.role)) {
      problems.push(`${at}: role ${JSON.stringify(message.role)} is not one of ${[...roles].join(", ")}`)
    }
    if (typeof message.content !== "string" || message.content.trim().length === 0) {
      problems.push(`${at}: content is empty or not a string`)
      return
    }
    for (const { label, pattern } of forbidden) {
      if (pattern.test(message.content)) problems.push(`${at}: content contains ${label}`)
    }
    if (message.role === "assistant") {
      for (const specifier of importSpecifiers(message.content)) {
        const problem = workspaceImportProblem(specifier)
        if (problem) problems.push(`${at}: ${problem}`)
      }
    }
  })

  const lastIndex = messages.length - 1
  const last: unknown = messages[lastIndex]
  if (!isRecord(last) || last.role !== "assistant") {
    problems.push(`row ${row}: last message is not an "assistant" turn`)
  }
  const userBeforeLast = messages.slice(0, lastIndex).some((message: unknown) => isRecord(message) && message.role === "user")
  if (!userBeforeLast) {
    problems.push(`row ${row}: no "user" turn before the final assistant turn`)
  }
  return problems
}

/**
 * Returns every problem in a JSONL dataset; an empty list means it may ship.
 */
export const validateDataset = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length === 0) {
    return ["dataset is empty"]
  }
  return lines.flatMap((line, index) => {
    const row = index + 1
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      return [`row ${row}: not valid JSON: ${(error as Error).message}`]
    }
    return validateRow(parsed, row)
  })
}

if (import.meta.main) {
  const datasetPath = fileURLToPath(new URL("./data/pilot-sft.jsonl", import.meta.url))
  const text = readFileSync(datasetPath, "utf8")
  const problems = validateDataset(text)
  if (problems.length > 0) {
    console.error(`FAIL: ${problems.length} problem(s) in ${datasetPath}`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  const rows = text.split("\n").filter((line) => line.trim().length > 0).length
  console.log(`OK: ${rows} row(s) valid in ${datasetPath}`)
}
