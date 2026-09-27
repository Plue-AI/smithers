import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as Capability from "../src/Capability.ts"

/**
 * HARDEN-2: every capability literal the repository stages is validated by the
 * real parser and matcher.
 *
 * A capability literal is a security-relevant string that nothing type-checks.
 * It is written into a prompt, a skill, a plugin manifest, an example, a
 * documentation snippet, or a host's own grant rules, and it is read back by
 * `parse` and `matches` at run time. A literal that is misspelled, renamed on
 * one side only, or padded with a stray space neither fails to compile nor
 * fails to load. It simply grants nothing, and the first sign of it is a
 * permission refusal in a run that should have been allowed.
 *
 * That has happened three times here: a `jj:snapshot` grant whose resource
 * still named the pre-rename message, an MCP authority vocabulary the
 * permission boundary rejected, and a `proc:spawn` grant written `" *"`, whose
 * leading space put every real command outside it.
 *
 * This suite reads the staged literals out of the tree and asserts the one
 * thing every grant must do: permit at least one concrete request. It cannot
 * know which request a given grant is meant to allow, so it does not guess. It
 * fails a literal the parser rejects, and a literal that parses but permits
 * nothing.
 *
 * What it therefore does not catch, stated so nobody reads more into a green
 * run: a rename whose new resource still grants something, just not the thing
 * the caller asks for. `jj:snapshot:flows action *` grants `flows action x` and
 * passes here; only a test that knows the message the engine writes can catch
 * that one, and `packages/smithers/flows/engine-store` owns that message.
 */

// The repository root, five levels up: this package nests two deep.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..")

/**
 * Where a capability literal is staged rather than constructed by a test.
 *
 * Test sources are out of scope on purpose: a test that pins a refusal has to
 * be free to write a literal that grants nothing, which is exactly what this
 * suite fails everywhere else.
 *
 * `apps` is out of scope too, and not by omission. `apps/app` stages its own
 * `capabilities:` vocabulary (`agent`, `local.repositories`, `app:act`,
 * `outbound:launch`), validated by that app's `RepositoryCapabilityPattern`
 * schema and not by this one, so reading it here would fail dozens of strings
 * that are correct where they live. An app's grants are built in code from
 * host values rather than written down, so the app half is a code-level case
 * against the composition, not a corpus walk.
 */
const roots = [
  "skills",
  "examples/src",
  "docs",
  ".smithers",
  "prompts",
  "packages/smithers/flows/src",
  "packages/smithers/agent/std/src",
  "packages/smithers/flows/kernel/src",
  "packages/smithers/agent/src",
  "packages/smithers/migrate/src"
]

const readable = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".mjs",
  ".js",
  ".json",
  ".md",
  ".mdx",
  ".txt",
  ".toml",
  ".yaml",
  ".yml"
])

const filesUnder = (directory: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".git")) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (readable.has(path.slice(path.lastIndexOf(".")))) found.push(path)
    }
  }
  walk(directory)
  return found
}

const stagedFiles = roots
  .map((entry) => join(root, entry))
  .filter((path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  })
  .flatMap(filesUnder)

/**
 * The action selectors the kernel itself declares, read off the package's own
 * `PatternAction` schema rather than copied here.
 *
 * The copy is what goes stale. A hand-written `fs|net|model|proc|jj` list stops
 * covering the vocabulary the day the kernel gains a namespace, and the sweep
 * reports a clean run over a corpus it can no longer see.
 */
const selectors: ReadonlyArray<string> = Capability.PatternAction.literals

/** The namespace half of a selector: `fs:read` and `fs:*` are both `fs`. */
const namespacesOf = (from: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(from.map((selector) => selector.split(":")[0]!))].sort()

const escapeForClass = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * A literal written whole, inside quotes or a code span: `fs:read:/tmp/x`.
 *
 * The namespace is one the kernel declares; the operation is anything, so a
 * misspelled action (`fs:reed:/tmp/**`) is still extracted and still fails.
 * The namespace half cannot be widened to any word: `test:e2e:native`,
 * `file:line:col`, and `task:subtask:0` are the same shape and are not
 * capabilities, so an unfiltered scan fails on eighteen strings that grant
 * nothing because they were never grants. An unknown namespace reaches this
 * suite through the two forms below, whose position says what the string is.
 */
const wholeFor = (namespaces: ReadonlyArray<string>): RegExp =>
  new RegExp(
    `["'\`]((?:${namespaces.map(escapeForClass).join("|")}):(?:[a-z-]+|\\*):[^"'\`\n]*)["'\`]`,
    "g"
  )

/** A literal split across an `action`/`resource` pair, as a pattern is built. */
const split = /action:\s*["'`]([^"'`]+)["'`]\s*,\s*resource:\s*["'`]([^"'`]*)["'`]/g

/** A literal handed straight to the parser: `Capability.parse("fs:read:/tmp/x")`. */
const parseCall = /Capability\.parse\(\s*["'`]([^"'`\n]+)["'`]\s*\)/g

/** A literal built by the constructor: `Capability.make("fs:read", "/tmp/x")`. */
const makeCall = /Capability\.make\(\s*["'`]([^"'`\n]+)["'`]\s*,\s*["'`]([^"'`\n]*)["'`]\s*\)/g

interface Literal {
  readonly file: string
  readonly line: number
  readonly text: string
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length

/**
 * Stands a template substitution up as one concrete resource.
 *
 * A grant whose resource is computed (`` `${workspaceRoot}/**` ``) still names
 * an action, and a wrong action is the defect this suite exists for. Reading
 * the text up to the substitution and standing the rest up as `x` judges the
 * half that is written down and asks nothing about the half the host computes.
 * The cut also repairs a capture a nested quote truncated, which is what a
 * regex over a template literal returns.
 */
const concrete = (text: string): string => {
  const at = text.indexOf("${")
  return at < 0 ? text : `${text.slice(0, at)}x`
}

/**
 * Every capability literal one file stages, in the three forms the tree writes.
 *
 * `namespaces` is the whole-form vocabulary, defaulted to the kernel's own so
 * production callers cannot pass a stale one, and named so a case can prove
 * the extractor follows a vocabulary the kernel has not declared yet.
 */
const literalsIn = (
  file: string,
  source: string,
  namespaces: ReadonlyArray<string> = namespacesOf(selectors)
): ReadonlyArray<Literal> => {
  const found: Array<Literal> = []
  for (const match of source.matchAll(wholeFor(namespaces))) {
    found.push({ file, line: lineOf(source, match.index), text: concrete(match[1]!) })
  }
  for (const match of source.matchAll(split)) {
    found.push({ file, line: lineOf(source, match.index), text: `${match[1]!}:${concrete(match[2]!)}` })
  }
  for (const match of source.matchAll(parseCall)) {
    found.push({ file, line: lineOf(source, match.index), text: concrete(match[1]!) })
  }
  for (const match of source.matchAll(makeCall)) {
    found.push({ file, line: lineOf(source, match.index), text: `${match[1]!}:${concrete(match[2]!)}` })
  }
  return found
}

const literals: ReadonlyArray<Literal> = stagedFiles.flatMap((path) =>
  literalsIn(relative(root, path), readFileSync(path, "utf8"))
)

/**
 * The narrowest request a grant is written to permit, with every wildcard
 * standing for one segment.
 *
 * Trimmed, because every resource a host asks about is trimmed: a path, a
 * command line, a URL, a change id. A grant that permits only a resource with
 * leading or trailing whitespace permits nothing that will ever be requested,
 * which is how `"proc:spawn: *"` passed review.
 */
const witnessOf = (resource: string): string =>
  resource
    .replaceAll("**", "x")
    .replaceAll("*", "x")
    .replaceAll("?", "x")
    .trim()

/** One concrete action each wildcard action selector stands for. */
const witnessActions: Readonly<Record<string, Capability.Action>> = {
  "*": "fs:read",
  "fs:*": "fs:read",
  "net:*": "net:get",
  "model:*": "model:call",
  "proc:*": "proc:spawn",
  "jj:*": "jj:status"
}

/**
 * Reads a literal with the package parser that owns the pattern grammar.
 */
const read = (text: string): Option.Option<Capability.CapabilityPattern> => Capability.parsePattern(text)

/**
 * Why a literal grants nothing, or `undefined` when it permits a request.
 *
 * One judgement for the corpus and for the cases that prove the corpus is
 * judged: a second copy of this reasoning is how a sweep starts passing
 * literals its own negative cases would fail.
 */
const refusalReason = (text: string): string | undefined => {
  const read_ = read(text)
  if (Option.isNone(read_)) return `"${text}" is not a capability or pattern the readers accept`

  const pattern = read_.value
  const witness = witnessOf(pattern.resource)
  if (witness.length === 0) return `"${text}" permits no non-empty resource`

  const action = witnessActions[pattern.action] ?? (pattern.action as Capability.Action)
  return Capability.matches(pattern, Capability.make(action, witness))
    ? undefined
    : `"${text}" permits nothing; it does not permit "${action}:${witness}"`
}

describe("HARDEN-2: every staged capability literal grants something", () => {
  it("finds staged literals at all, so a silently empty sweep fails", () => {
    expect(literals.length).toBeGreaterThan(0)
  })

  it.each(literals.map((literal) => [`${literal.file}:${literal.line} ${literal.text}`, literal] as const))(
    "%s",
    (_label, literal) => {
      const reason = refusalReason(literal.text)
      expect(reason === undefined, `${literal.file}:${literal.line}: ${reason}`).toBe(true)
    }
  )
})

/**
 * The sweep's own negative gates.
 *
 * A corpus sweep passes for two reasons: every literal is sound, or nothing is
 * read. These cases separate them. Each stages one defect shape in one of the
 * forms the tree writes and asserts the sweep both finds it and refuses it.
 */
describe("HARDEN-2: the sweep sees each staged form and judges it", () => {
  const found = (source: string, namespaces?: ReadonlyArray<string>): ReadonlyArray<string> =>
    (namespaces === undefined ? literalsIn("fixture.ts", source) : literalsIn("fixture.ts", source, namespaces))
      .map((literal) => literal.text)

  it("reads the whole-form vocabulary off the kernel's own selectors", () => {
    expect(namespacesOf(selectors)).toEqual(["*", "fs", "jj", "memory", "model", "net", "proc"])
  })

  it("follows a namespace the kernel has not declared yet", () => {
    expect(found(`const grant = "mcp:call:authority"`, ["mcp"])).toEqual(["mcp:call:authority"])
  })

  it("sees a literal written whole", () => {
    expect(found(`const grant = "fs:reed:/tmp/**"`)).toEqual(["fs:reed:/tmp/**"])
  })

  it("sees a literal split across an action and a resource, whatever its namespace", () => {
    expect(found(`new CapabilityPattern({ action: "mcp:call", resource: "authority" })`))
      .toEqual(["mcp:call:authority"])
  })

  it("sees a literal handed to the parser, whatever its namespace", () => {
    expect(found(`Option.match(Capability.parse("mcp:call:authority"), {`)).toEqual(["mcp:call:authority"])
  })

  it("sees a literal built by the constructor", () => {
    expect(found(`Capability.make("fs:read", "/workspace/src/main.ts")`))
      .toEqual(["fs:read:/workspace/src/main.ts"])
  })

  it("judges the written half of a grant whose resource is computed", () => {
    expect(found("new CapabilityPattern({ action: \"fs:write\", resource: `${workspaceRoot}/**` })"))
      .toEqual(["fs:write:x"])
    expect(found("new CapabilityPattern({ action: \"mcp:call\", resource: `${authority}` })"))
      .toEqual(["mcp:call:x"])
    expect(refusalReason("mcp:call:x")).toContain("is not a capability or pattern the readers accept")
  })

  it.each([
    ["an unknown namespace", "mcp:call:authority", "is not a capability or pattern the readers accept"],
    ["a misspelled action", "fs:reed:/tmp/**", "is not a capability or pattern the readers accept"],
    ["a leading space", "proc:spawn: *", `does not permit "proc:spawn:x"`],
    ["an empty resource", "fs:read:", "permits no non-empty resource"]
  ])("refuses %s", (_shape, text, reason) => {
    expect(refusalReason(text)).toContain(reason)
  })
})
