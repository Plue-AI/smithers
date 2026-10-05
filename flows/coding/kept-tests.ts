/**
 * The test guard: a deterministic check, never a model's judgment, that a
 * change keeps the test cases its base already has. A change that deletes,
 * empties or skips an existing test case gets a finding naming it, so the
 * correction loop has a turn to restore it, unless the person's own words
 * (the plan's prompt and feedback: steers, carried answers and the answer to
 * planning's question) ask for that test's removal.
 *
 * The stack's review lists the same removed tests from the pull request's
 * diff (packages/backend/internal/services/mythical_kept_tests.go). Both read
 * one rule; a change to it changes both, with the same cases in each test.
 */
import { Context, Effect, Layer } from "effect"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { CodingError, type Finding, type Plan, type Result } from "./schema.ts"

/** An existing test case a change takes away, and how. */
export interface RemovedTest {
  readonly path: string
  readonly name: string
  readonly how: "deleted" | "emptied" | "skipped"
}

const source = /\.(?:[cm]?[jt]sx?|py|go)$/
const testDirectories = new Set(["test", "tests", "__tests__", "spec"])

/** A test file by the conventions test runners discover them with. */
export const isTestPath = (path: string): boolean => {
  const parts = path.split("/"), name = parts.at(-1) ?? ""
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name) || /_test\.go$/.test(name) || /^test_.*\.py$/.test(name) ||
    /_test\.py$/.test(name) || (source.test(name) && parts.slice(0, -1).some((part) => testDirectories.has(part)))
}

interface Declared {
  readonly name: string
  /** False for a skipped or todo declaration: it runs nothing. */
  readonly active: boolean
  readonly body: "braces" | "indent"
}
const jsTest =
  /^\s*(?:await\s+)?(?:t\.)?(x?(?:test|it))(?:\.(only|skip|todo|concurrent))?\s*\(\s*(["'`])((?:\\.|(?!\3).)*)\3/
const goTest = /^func\s+(Test\w*)\s*\(\s*\w+\s+\*testing\.T\s*\)/
const pyTest = /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/

/** The test case a source line declares, if any. */
export const declared = (line: string): Declared | undefined => {
  const js = jsTest.exec(line)
  if (js) {
    return { name: js[4]!, active: !js[1]!.startsWith("x") && js[2] !== "skip" && js[2] !== "todo", body: "braces" }
  }
  const go = goTest.exec(line)
  if (go) return { name: go[1]!, active: true, body: "braces" }
  const py = pyTest.exec(line)
  return py ? { name: py[1]!, active: true, body: "indent" } : undefined
}

/** A line's code with string contents and comments removed, so braces count. */
const code = (line: string) =>
  line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "\"\"").replace(/\/\*.*?\*\//g, "")
    .replace(/\/\/.*$/, "")
const blank = (text: string) => /^\s*(?:\*.*|\/\*.*|\*\/\s*)?$/.test(text)

/**
 * Whether the test declared at lines[at] has an empty body: true or false
 * when its body closes inside lines, undefined when it cannot be told.
 */
const emptyBody = (lines: ReadonlyArray<string>, at: number, kind: Declared["body"]): boolean | undefined => {
  if (kind === "indent") {
    const indent = (line: string) => /^\s*/.exec(line)![0].length
    const outer = indent(lines[at]!), body: Array<string> = []
    for (let index = at + 1; index < lines.length; index++) {
      const line = lines[index]!
      if (line.trim() === "") continue
      if (indent(line) <= outer) return body.every((text) => /^(?:pass|\.\.\.|#.*)$/.test(text.trim()))
      body.push(line)
    }
    return undefined
  }
  let depth = 0, opened = false
  const body: Array<string> = []
  for (let index = at; index < lines.length; index++) {
    const text = code(lines[index]!)
    let start = 0
    for (let column = 0; column < text.length; column++) {
      if (text[column] === "{") {
        if (!opened) start = column + 1
        opened = true
        depth++
      } else if (text[column] === "}" && opened && --depth === 0) {
        body.push(text.slice(index === at ? start : 0, column))
        return body.every(blank)
      }
    }
    if (opened) body.push(index === at ? text.slice(start) : text)
  }
  return undefined
}

interface Hunk {
  readonly before: Array<string>
  readonly after: Array<string>
  /** The indexes of before that the change removed. */
  readonly removed: Set<number>
}
interface FileDiff {
  readonly path: string
  readonly hunks: ReadonlyArray<Hunk>
}

/** One unified diff's files and their hunks, each side's lines without their prefix. */
const filesOf = (diff: string): ReadonlyArray<FileDiff> =>
  diff.split(/^(?=diff --git )/m).flatMap((section) => {
    const lines = section.split("\n")
    const plus = lines.findIndex((line) => line.startsWith("+++ "))
    if (!section.startsWith("diff --git ") || plus < 1 || !lines[plus - 1]!.startsWith("--- ")) return []
    const after = lines[plus]!.slice(4), before = lines[plus - 1]!.slice(4)
    const path = (after === "/dev/null" ? before.replace(/^a\//, "") : after.replace(/^b\//, "")).replace(/\t$/, "")
    const hunks: Array<Hunk> = []
    for (const line of lines.slice(plus + 1)) {
      if (line.startsWith("@@")) hunks.push({ before: [], after: [], removed: new Set() })
      const hunk = hunks.at(-1)
      if (hunk === undefined || line.startsWith("@@") || line.startsWith("\\")) continue
      const kind = line[0] ?? " ", text = line.slice(1)
      if (kind === "-") {
        hunk.removed.add(hunk.before.length)
        hunk.before.push(text)
      } else if (kind === "+") hunk.after.push(text)
      else {
        hunk.before.push(text)
        hunk.after.push(text)
      }
    }
    return [{ path, hunks }]
  })

/**
 * The existing test cases a unified diff deletes, empties or skips, in test
 * files only. A test whose declaration the diff removes and nothing in the
 * file declares again is deleted, or skipped when it is declared again as
 * skip, todo or x; a test still declared whose body the diff leaves empty is
 * emptied.
 */
export const removedTests = (diff: string): ReadonlyArray<RemovedTest> =>
  filesOf(diff).filter((file) => isTestPath(file.path)).flatMap((file) => {
    const removed = new Set<string>(), kept = new Set<string>(), skipped = new Set<string>()
    const emptied = new Set<string>()
    for (const hunk of file.hunks) {
      hunk.before.forEach((line, index) => {
        const test = declared(line)
        if (test?.active && hunk.removed.has(index)) removed.add(test.name)
      })
      hunk.after.forEach((line, index) => {
        const test = declared(line)
        if (test === undefined) return
        if (!test.active) {
          skipped.add(test.name)
          return
        }
        kept.add(test.name)
        if (emptyBody(hunk.after, index, test.body) !== true) return
        const was = hunk.before.findIndex((other) => {
          const before = declared(other)
          return before?.active === true && before.name === test.name
        })
        if (was >= 0 && emptyBody(hunk.before, was, test.body) === false) emptied.add(test.name)
      })
    }
    return [
      ...[...removed].filter((name) => !kept.has(name)).map((name): RemovedTest => ({
        path: file.path,
        name,
        how: skipped.has(name) ? "skipped" : "deleted"
      })),
      ...[...emptied].map((name): RemovedTest => ({ path: file.path, name, how: "emptied" }))
    ]
  })

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** A removal verb no "not", "never", "don't" or "no" just before denies. */
const verb = String.raw`(?<!\b(?:not|never|don't|dont|no)\s+)\b(?:remove|delete|drop|replace|retire)\w*`
const removal = new RegExp(verb)
/** A removal verb, then at most three words that join no other clause, then test or spec. */
const removalOfTests = new RegExp(String.raw`${verb}\s+(?:(?!(?:and|then|but)\b)\S+\s+){0,3}(?:tests?|specs?)\b`)

/**
 * Whether the person's words ask for this test's removal: a removal verb
 * (remove, delete, drop, replace, retire) and the test's name, its file or
 * its file's name; or a removal verb a few words before "test" or "tests".
 */
export const removalAsked = (words: string, test: RemovedTest): boolean => {
  const text = words.toLowerCase()
  if (!removal.test(text)) return false
  const names = (needle: string) =>
    needle.length >= 3 && new RegExp(`(?:^|[^\\w])${escaped(needle.toLowerCase())}(?:$|[^\\w])`).test(text)
  return names(test.name) || names(test.path) || names(test.path.split("/").at(-1)!) || removalOfTests.test(text)
}

const verbs = { deleted: "deletes it", emptied: "empties its body", skipped: "skips it" } as const

/**
 * The guard's findings for one round's result over its whole diff (plan base
 * to the last implemented head). Each names the test and is owned by the
 * first Change that wrote its file, else the last Change.
 */
export const guardFindings = (plan: Plan, result: Result, diff: string): ReadonlyArray<Finding> => {
  const words = [plan.prompt, plan.feedback ?? ""].join("\n\n")
  return removedTests(diff).filter((test) => !removalAsked(words, test)).map((test) => {
    const index = result.changes.findIndex((group) => group.implementation.writes.includes(test.path))
    const owner = result.changes[index < 0 ? result.changes.length - 1 : index]!.implementation
    return {
      owner: owner.change,
      sourceCommitId: owner.head.commitId,
      message: `Restore the existing test "${test.name}" in ${test.path}: this change ${
        verbs[test.how]
      }, and the request does not ask for its removal.`
    }
  })
}

/** Reads the unified diff between two retained revisions. */
export class ChangeDiff extends Context.Service<ChangeDiff, {
  readonly read: (from: string, to: string) => Effect.Effect<string, CodingError>
}>()("coding/ChangeDiff") {}

/** The host's ChangeDiff: `jj diff --git` over the lane's own history. */
export const changeDiffLayer = Layer.effect(ChangeDiff)(Effect.gen(function*() {
  const jj = yield* Jj.Jj
  return {
    read: (from: string, to: string) =>
      jj.diff(from, to).pipe(Effect.mapError((error) =>
        new CodingError({
          code: "execution",
          message: `The test guard could not read the change's diff: ${error.message.slice(0, 512)}`
        })
      ))
  }
}))

/**
 * A round's result with the guard's findings added: a removed test turns a
 * validated result into changes-requested, so the correction loop repairs it.
 */
export const keepTests = (plan: Plan, result: Result): Effect.Effect<Result, CodingError, ChangeDiff> =>
  Effect.gen(function*() {
    const head = result.changes.at(-1)?.implementation.head
    if (head === undefined) return result
    const findings = guardFindings(plan, result, yield* (yield* ChangeDiff).read(plan.base.commitId, head.commitId))
    return findings.length === 0 ? result : {
      ...result,
      status: "changes-requested" as const,
      findings: [...result.findings, ...findings]
    }
  })
