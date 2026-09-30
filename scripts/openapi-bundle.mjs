#!/usr/bin/env node
/**
 * Bundles the per-tag product API sources under docs/api/openapi/ into the
 * published docs/api/openapi.yaml.
 *
 * `_root.yaml` holds everything outside `paths` (openapi, info, servers,
 * components) with an empty `paths:` key. Every other `<tag>.yaml` holds the
 * paths whose operations carry that tag, and may add `components` entries of
 * a kind `_root.yaml` declares. The bundle is the root with each tag file's
 * entries appended in file-name order, byte for byte, so changes under
 * different tags touch different files and different regions of the bundle.
 *
 * `//:openapiBundle` runs this script; `lint` fails when the committed bundle
 * differs from what the sources produce.
 */
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** The source file that owns everything outside `paths`. */
export const rootFile = "_root.yaml"

const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"])

/** The source file name for an OpenAPI tag: `Pair Sessions` is `pair-sessions.yaml`. */
export const tagFile = (tag) => {
  const slug = tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  if (slug === "") throw new Error(`OpenAPI tag ${JSON.stringify(tag)} has no file name`)
  return `${slug}.yaml`
}

const fail = (file, line, message) => {
  throw new Error(`${file}${line === undefined ? "" : `:${line}`}: ${message}`)
}

/**
 * Splits block-style YAML into the entries of one indentation level: each
 * entry is a `key:` line at exactly `indent` spaces and the deeper lines under
 * it. Anything else at or above that level is refused, so a source the bundler
 * cannot concatenate verbatim never produces a bundle.
 */
const entries = (file, lines, first, indent) => {
  const prefix = " ".repeat(indent)
  const result = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const number = first + index
    if (line === "") fail(file, number, "blank lines are not allowed")
    const depth = line.length - line.trimStart().length
    if (depth > indent) {
      if (result.length === 0) fail(file, number, `expected a key at indentation ${indent}`)
      result.at(-1).lines.push(line)
      continue
    }
    if (depth < indent) fail(file, number, `expected indentation of at least ${indent}`)
    const match = /^([^\s#'"][^:]*|'[^']*'|"[^"]*"):(?: (.*))?$/.exec(line.slice(indent))
    if (match === null) fail(file, number, `expected a block mapping key at indentation ${indent}`)
    result.push({ key: match[1], line: number, lines: [line] })
  }
  return result.map((entry) => ({ ...entry, header: entry.lines[0], body: entry.lines.slice(1) }))
}

/** Parses one source into its top-level sections. */
export const parseSource = (file, text) => {
  if (!text.endsWith("\n")) fail(file, undefined, "must end with a newline")
  const lines = text.slice(0, -1).split("\n")
  const sections = entries(file, lines, 1, 0)
  const seen = new Set()
  for (const section of sections) {
    if (seen.has(section.key)) fail(file, section.line, `duplicate top-level key ${section.key}`)
    seen.add(section.key)
  }
  return sections
}

/** The `components` kinds (schemas, responses, ...) of one section, with their entries. */
const componentKinds = (file, section) =>
  entries(file, section.body, section.line + 1, 2).map((kind) => {
    if (kind.header !== `  ${kind.key}:`) fail(file, kind.line, `components.${kind.key} must be a block mapping`)
    return { ...kind, entries: entries(file, kind.body, kind.line + 1, 4) }
  })

/** Refuses a path item whose operation's first tag belongs to a different file. */
const checkOwnership = (file, item) => {
  for (const operation of entries(file, item.body, item.line + 1, 4)) {
    if (!methods.has(operation.key)) continue
    const at = operation.body.indexOf("      tags:")
    const tag = at === -1 ? undefined : /^ {8}- (.+)$/.exec(operation.body[at + 1] ?? "")?.[1]
    if (tag === undefined) fail(file, operation.line, `${operation.key} ${item.key} has no tags`)
    const owner = tagFile(tag.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1"))
    if (owner !== file) fail(file, operation.line, `${operation.key} ${item.key} is tagged ${tag}; move it to ${owner}`)
  }
}

/**
 * Bundles `sources`, a map from file name to text, into the published
 * document. Throws on a malformed source, a duplicate path or component, or
 * an operation filed under the wrong tag.
 */
export const bundle = (sources) => {
  const rootText = sources.get(rootFile)
  if (rootText === undefined) fail(rootFile, undefined, "is missing")
  const root = parseSource(rootFile, rootText)
  const rootPaths = root.find((section) => section.key === "paths")
  if (rootPaths === undefined || rootPaths.header !== "paths:" || rootPaths.body.length > 0) {
    fail(rootFile, rootPaths?.line, "must declare an empty `paths:`")
  }
  const rootComponents = root.find((section) => section.key === "components")
  const kinds = rootComponents === undefined ? [] : componentKinds(rootFile, rootComponents)
  const extra = new Map(kinds.map((kind) => [kind.key, []]))
  const owners = new Map(kinds.flatMap((kind) => kind.entries.map((entry) => [`${kind.key}.${entry.key}`, rootFile])))
  const paths = []
  const pathOwners = new Map()
  for (const file of [...sources.keys()].filter((name) => name !== rootFile).sort()) {
    for (const section of parseSource(file, sources.get(file))) {
      if (section.key === "paths") {
        if (section.header !== "paths:") fail(file, section.line, "paths must be a block mapping")
        for (const item of entries(file, section.body, section.line + 1, 2)) {
          const previous = pathOwners.get(item.key)
          if (previous !== undefined) fail(file, item.line, `path ${item.key} is already declared in ${previous}`)
          pathOwners.set(item.key, file)
          checkOwnership(file, item)
          paths.push(...item.lines)
        }
      } else if (section.key === "components") {
        for (const kind of componentKinds(file, section)) {
          const target = extra.get(kind.key)
          if (target === undefined) fail(file, kind.line, `components.${kind.key} is not declared in ${rootFile}`)
          for (const entry of kind.entries) {
            const name = `${kind.key}.${entry.key}`
            const previous = owners.get(name)
            if (previous !== undefined) fail(file, entry.line, `components.${name} is already declared in ${previous}`)
            owners.set(name, file)
            target.push(...entry.lines)
          }
        }
      } else {
        fail(file, section.line, `only paths and components belong in a tag file, not ${section.key}`)
      }
    }
  }
  const out = []
  for (const section of root) {
    out.push(section.header)
    if (section === rootPaths) out.push(...paths)
    else if (section === rootComponents) {
      for (const kind of kinds) out.push(kind.header, ...kind.body, ...extra.get(kind.key))
    } else out.push(...section.body)
  }
  return `${out.join("\n")}\n`
}

/** Reads every `*.yaml` source in `directory`. */
export const readSources = (directory) =>
  new Map(
    readdirSync(directory)
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => [name, readFileSync(join(directory, name), "utf8")])
  )

const apiDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/api")

/** The source directory and published bundle this repository commits. */
export const layout = { sources: join(apiDirectory, "openapi"), output: join(apiDirectory, "openapi.yaml") }

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(layout.output, bundle(readSources(layout.sources)))
  process.stdout.write(`wrote ${basename(layout.output)}\n`)
}
