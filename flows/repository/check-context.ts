/** Bounded supporting source from the same private tree as the checked change. */
import * as Digest from "@smthrs/core/Digest"
import { Effect, Path, Schema } from "effect"
import { contained, type ImmutableSourceOptions } from "../coding/immutable-source.ts"
import { extractPaths, normalizePath, Source } from "../coding/planning-sources.ts"
import { repositorySourceReader } from "./inspection.ts"
import type { Check } from "./schema.ts"

export const ContextRead = Schema.Struct({
  path: Schema.String,
  from: Schema.String,
  reason: Schema.Literals(["rule", "source", "import", "convention"]),
  required: Schema.Boolean,
  status: Schema.Literals(["read", "missing", "refused", "oversized", "unreadable", "limit", "unresolved", "external"]),
  digest: Schema.optionalKey(Schema.String)
})
export const CheckContext = Schema.Struct({
  checkId: Schema.String,
  source: Schema.NonEmptyString,
  files: Schema.Array(Source),
  reads: Schema.Array(ContextRead)
})
export type CheckContext = typeof CheckContext.Type
const maxFiles = 24, maxBytes = 128_000, maxReads = 96, maxDepth = 3
/** A job's own retained configuration. `writeCandidate` commits it into the
 * repository, and no check may read it back as reviewable source. */
export const privatePath = (path: string): boolean => /^\.smithers\/repository-jobs(?:\/|$)/i.test(path)
const script = /\.(?:[cm]?[jt]sx?)$/i
const encoder = new TextEncoder()

/** Bare prose and package names are not file requirements. Slash paths and
 * explicitly quoted filenames in the reviewed rule are repository inputs. */
export const rulePaths = (rule: string): Array<string> => {
  const text = rule.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ")
  const normalized = text.replace(/(?<![\w./])\.\//g, "")
  const quoted = new Set([...normalized.matchAll(/[`'"]([^`'"\n]+)[`'"]/g)].map((match) => match[1]))
  const paths = extractPaths(normalized).filter((path) =>
    path.includes("/") || quoted.has(path) || /^(?:AGENTS|README|CONTRIBUTING)\.md$/i.test(path)
  )
  // Keep explicit escapes as refused evidence instead of silently losing them
  // through the ordinary planning path normalizer.
  for (const [path] of text.matchAll(/(?<![A-Za-z0-9_.@+/-])(?:\.\.\/|\/)[A-Za-z0-9_./@+-]+\.[A-Za-z][A-Za-z0-9]*/g)) {
    paths.push(path)
  }
  return [...new Set(paths)]
}

/** The cooked value of a single- or double-quoted JavaScript string body, or
 * undefined when an escape is not valid in module (strict) code. */
const cooked = (body: string): string | undefined => {
  let value = ""
  for (let index = 0; index < body.length;) {
    const character = body[index++]!
    if (character !== "\\") {
      value += character
      continue
    }
    const escape = body[index++]
    if (escape === undefined) return undefined
    const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" }
    if (escape in simple) value += simple[escape]
    else if (escape === "0" && !/[0-9]/.test(body[index] ?? "")) value += "\0"
    else if (/[0-9]/.test(escape)) return undefined
    else if (escape === "x") {
      const hex = /^[0-9a-fA-F]{2}/.exec(body.slice(index))?.[0]
      if (!hex) return undefined
      value += String.fromCharCode(Number.parseInt(hex, 16))
      index += 2
    } else if (escape === "u") {
      const unit = /^(?:[0-9a-fA-F]{4}|\{([0-9a-fA-F]+)\})/.exec(body.slice(index))
      const code = unit && Number.parseInt(unit[1] ?? unit[0], 16)
      if (!unit || code === null || code > 0x10ffff) return undefined
      value += String.fromCodePoint(code)
      index += unit[0].length
    } else if (escape === "\r") {
      if (body[index] === "\n") index++
    } else if (escape !== "\n" && escape !== "\u2028" && escape !== "\u2029") value += escape
  }
  return value
}

/** Literal module edges only. Dynamic expressions cannot establish a known
 * local dependency; external package imports are recorded, never fetched.
 * A static specifier whose escapes are not valid is returned as written, so it
 * resolves to a required gap instead of silently becoming no import. */
export const sourceImports = (name: string, text: string): Array<string> => {
  if (!script.test(name)) return []
  // A small lexical pass keeps examples, comments and ordinary strings from
  // becoming module edges. It does not execute or transpile repository code.
  const tokens: Array<{ word: string; quoted: boolean; raw?: string }> = []
  for (let index = 0; index < text.length;) {
    const character = text[index]!
    if (/\s/.test(character)) {
      index++
      continue
    }
    if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index)
      index = end < 0 ? text.length : end
      continue
    }
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2)
      index = end < 0 ? text.length : end + 2
      continue
    }
    if (character === "'" || character === "\"" || character === "`") {
      const delimiter = character, start = ++index
      while (index < text.length && text[index] !== delimiter) index += text[index] === "\\" ? 2 : 1
      const body = text.slice(start, Math.min(index, text.length))
      index++
      // A template literal is a dynamic expression, never a known module edge.
      const value = delimiter === "`" ? "" : cooked(body)
      tokens.push(
        value === undefined ? { word: "", quoted: true, raw: body } : { word: value, quoted: true }
      )
      continue
    }
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(index))?.[0] ?? character
    tokens.push({ word, quoted: false })
    index += word.length
  }
  const imports = new Set<string>()
  const specifier = (token: { word: string; raw?: string } | undefined) => {
    const value = token?.word || token?.raw
    if (value) imports.add(value)
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!, next = tokens[index + 1]
    if (token.quoted || !["import", "export", "require"].includes(token.word) || tokens[index - 1]?.word === ".") {
      continue
    }
    if (token.word === "import" && next?.quoted) {
      specifier(next)
      continue
    }
    if (next?.word === "(" && tokens[index + 2]?.quoted && tokens[index + 3]?.word === ")") {
      specifier(tokens[index + 2])
      continue
    }
    if (token.word === "require" || next?.word === ".") continue
    // A declaration clause holds only names, `*`, commas and one braced list of
    // (possibly quoted) names; it is read to its end however long it is.
    let braces = 0
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const part = tokens[cursor]!
      if (braces === 0 && part.word === "from" && !part.quoted && tokens[cursor + 1]?.quoted) {
        specifier(tokens[cursor + 1])
        break
      }
      if (part.quoted) {
        if (braces === 0) break
      } else if (part.word === "{" && braces === 0) braces = 1
      else if (part.word === "}" && braces === 1) braces = 0
      else if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part.word) && part.word !== "," && part.word !== "*") break
    }
  }
  return [...imports]
}

export const contextFailure = (
  context: CheckContext,
  source: string,
  checkId: string,
  paths: ReadonlyArray<string> = []
): string | undefined => {
  if (context.source !== source || context.checkId !== checkId) {
    return "Supporting context names another check or source"
  }
  // The comparison carries every changed file's own complete verified source, so
  // a changed path this capture dropped at its read, file or byte budget is
  // recorded evidence for the checker, not a gap in the repository.
  const bounded = (read: typeof ContextRead.Type) => read.reason === "source" && read.status === "limit"
  const gap = context.reads.find((read) => read.required && read.status !== "read" && !bounded(read))
  if (gap) return `Supporting context ${gap.path}: ${gap.status}`
  if (
    paths.some((path) =>
      !context.reads.some((read) =>
        read.path === path && read.reason === "source" &&
        (bounded(read) || (read.required && read.status === "read"))
      )
    )
  ) return "Supporting context omits a changed source"
  for (const read of context.reads.filter((read) => read.status === "read")) {
    const file = context.files.find((file) => file.path === read.path)
    if (!file || file.truncated || file.digest !== read.digest || Digest.digest(file.text) !== file.digest) {
      return `Supporting context ${read.path}: incomplete source`
    }
  }
  return undefined
}

export const captureCheckContext = (options: ImmutableSourceOptions, root: string, input: {
  readonly source: string
  readonly check: typeof Check.Type
  readonly paths: ReadonlyArray<string>
  readonly deadlineAt: number
  /** Host-selected direct rule paths for this source side. Imports never cross sides. */
  readonly ruleInputs?: ReadonlyArray<string>
  readonly conventionPaths?: ReadonlyArray<string>
  /** Changed paths this check may not read. They are recorded as refused
   * evidence so the checker sees what the change touched and was withheld. */
  readonly refusedPaths?: ReadonlyArray<string>
}) =>
  Effect.gen(function*() {
    const path = yield* Path.Path, fs = options.fs, reader = yield* repositorySourceReader(root, fs)
    type Pending = {
      path: string
      from: string
      reason: typeof ContextRead.Type["reason"]
      required: boolean
      depth: number
    }
    const files: Array<typeof Source.Type> = [],
      reads: Array<typeof ContextRead.Type> = [],
      pending: Array<Pending> = []
    const seen = new Map<string, number>(), directories = new Set<string>(), external = new Set<string>()
    let bytes = 0
    const add = (name: string, from: string, reason: Pending["reason"], required = true, depth = 0) =>
      pending.push({ path: name, from, reason, required, depth })
    const conventions = (name: string) => {
      let directory = path.dirname(name)
      while (!directories.has(directory)) {
        directories.add(directory)
        for (const file of ["AGENTS.md", "README.md", "CONTRIBUTING.md"]) {
          add(directory === "." ? file : `${directory}/${file}`, name, "convention", false)
        }
        if (directory === ".") {
          break
        }
        directory = path.dirname(directory)
      }
    }
    for (const name of input.ruleInputs ?? rulePaths(input.check.rule)) {
      add(name, "rule", "rule")
    }
    for (const name of input.paths) {
      add(name, "comparison", "source")
      conventions(name)
    }
    for (const name of input.refusedPaths ?? []) add(name, "comparison", "source", false)
    for (const name of input.conventionPaths ?? []) conventions(name)
    const inspect = (name: string) =>
      Effect.gen(function*() {
        if (normalizePath(name) !== name || privatePath(name)) return { status: "refused" as const }
        const target = path.join(root, name)
        const resolved = yield* fs.realPath(target).pipe(Effect.orElseSucceed(() => ""))
        if (!resolved) {
          return {
            status: (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true)))
              ? "unreadable" as const
              : "missing" as const
          }
        }
        if (!contained(root, resolved, path) || privatePath(path.relative(root, resolved))) {
          return { status: "refused" as const }
        }
        const stat = yield* fs.stat(resolved).pipe(Effect.orElseSucceed(() => undefined))
        if (!stat || stat.type !== "File") {
          return { status: "unreadable" as const, directory: stat?.type === "Directory" }
        }
        if (stat.size > 32_768n) return { status: "oversized" as const }
        const read = yield* reader.read(name)
        return read.kind === "text" ?
          { status: "read" as const, text: read.text, canonical: path.relative(root, resolved) }
          : { status: read.kind === "missing" ? "missing" as const : "unreadable" as const }
      })
    const resolveImport = (from: string, specifier: string) =>
      Effect.gen(function*() {
        if (!specifier.startsWith(".")) {
          return {
            path: specifier,
            status: /^(?:@\/|~\/|#)/.test(specifier) ? "unresolved" as const : "external" as const
          }
        }
        const name = path.normalize(path.join(path.dirname(from), specifier))
        if (normalizePath(name) !== name || privatePath(name)) return { path: name, status: "refused" as const }
        const extension = path.extname(name)
        // TypeScript's emitted .js/.mjs/.cjs names may refer to source .ts files.
        const candidates = /\.(?:[cm]?js|jsx)$/.test(extension) && /\.[cm]?tsx?$/.test(from) ?
          [
            name.replace(/\.jsx?$/, ".ts").replace(/\.mjs$/, ".mts").replace(/\.cjs$/, ".cts"),
            name.replace(/\.jsx?$/, ".tsx"),
            name
          ]
          : extension ?
          [name] :
          [
            name,
            ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"].map((ext) => name + ext),
            ...["index.ts", "index.tsx", "index.js", "index.mjs", "index.json"].map((index) => `${name}/${index}`)
          ]
        for (const candidate of [...new Set(candidates)]) {
          const found = yield* inspect(candidate)
          if (found.status === "refused") return { path: candidate, status: found.status }
          if (found.status === "read" || found.status === "oversized") return { path: candidate }
          if (found.status === "unreadable" && !("directory" in found && found.directory)) {
            return { path: candidate, status: found.status }
          }
        }
        return { path: name, status: "unresolved" as const }
      })
    for (let index = 0; index < pending.length; index++) {
      const item = pending[index]!, previous = seen.get(item.path)
      if (previous !== undefined) {
        if (item.required && !reads[previous]!.required) reads[previous] = { ...reads[previous]!, required: true }
        if (item.reason === "source") reads[previous] = { ...reads[previous]!, reason: "source", from: item.from }
        continue
      }
      if (reads.length >= maxReads || Date.now() >= input.deadlineAt) {
        const omitted = pending.slice(index).find((item) =>
          item.required || /(?:^|\/)(?:AGENTS|CONTRIBUTING)\.md$/i.test(item.path)
        ) ?? item
        reads.push({
          path: omitted.path,
          from: omitted.from,
          reason: omitted.reason,
          required: omitted.required || /(?:^|\/)(?:AGENTS|CONTRIBUTING)\.md$/i.test(omitted.path),
          status: "limit"
        })
        break
      }
      seen.set(item.path, reads.length)
      const found = yield* inspect(item.path)
      const required = item.required ||
        (found.status !== "missing" && /(?:^|\/)(?:AGENTS|CONTRIBUTING)\.md$/i.test(item.path))
      const entry = { path: item.path, from: item.from, reason: item.reason, required }
      if (found.status !== "read") {
        reads.push({ ...entry, status: found.status })
        continue
      }
      const size = encoder.encode(found.text).length
      if (item.depth > maxDepth || files.length >= maxFiles || bytes + size > maxBytes) {
        reads.push({ ...entry, status: "limit" })
        continue
      }
      bytes += size
      const digest = Digest.digest(found.text)
      files.push({ path: item.path, text: found.text, digest, truncated: false })
      reads.push({ path: item.path, from: item.from, reason: item.reason, required, status: "read", digest })
      if (item.reason !== "convention") {
        conventions(item.path)
        if (found.canonical !== item.path) {
          conventions(found.canonical)
        }
      }
      // Follow path references from actual repository guidance, not arbitrary
      // strings in source code or model-written event prose.
      if ((item.reason === "rule" && !script.test(item.path)) || /(?:^|\/)AGENTS\.md$/i.test(item.path)) {
        for (const name of rulePaths(found.text)) {
          add(name, item.path, "rule", true, item.depth + 1)
        }
      }
      for (const specifier of sourceImports(item.path, found.text)) {
        const imported = yield* resolveImport(found.canonical, specifier)
        if (imported.status) {
          if (imported.status === "external") {
            if (reads.length >= maxReads) {
              continue
            }
            if (external.has(imported.path)) {
              continue
            }
            external.add(imported.path)
            if (external.size > 9) {
              continue
            }
            if (external.size === 9) {
              reads.push({
                path: "(additional external imports)",
                from: item.path,
                reason: "import",
                required: false,
                status: "limit"
              })
              continue
            }
          }
          if (reads.length >= maxReads) {
            add(imported.path, item.path, "import")
            break
          }
          reads.push({
            path: imported.path,
            from: item.path,
            reason: "import",
            required: imported.status !== "external",
            status: imported.status
          })
        } else add(imported.path, item.path, "import", true, item.depth + 1)
      }
    }
    return { checkId: input.check.id, source: input.source, files, reads } satisfies CheckContext
  })
