/**
 * The security-review macro: one declaration, two model-review targets.
 *
 * A package declares the security checks an agent must perform on it, each a
 * named threat and the concrete, falsifiable things to inspect. The macro
 * renders those checks into an LlmLint rubric, always appends the built-in
 * `general` check that sweeps for every vulnerability class the named checks
 * miss, and returns two targets over the same rubric:
 *
 * - `security` reviews the files changed against `origin/main`. It is the cheap
 *   advisory review that `smthrs review '//...'` plans; the aggregate `ci`
 *   verb never plans a review.
 * - `securityAudit` reviews every included file, whether or not it changed
 *   (LlmLint scope `all`). It is manual: a bare wildcard skips it,
 *   and `smthrs review '//packages/x/...:securityAudit'` audits a whole
 *   package subtree, nested packages included.
 *
 * The prompt frames the run as what it is: an authorized defensive review of
 * the repository owner's own code. Findings name the flaw, the attacker
 * precondition, the location, and the fix, never a weaponized exploit.
 *
 * @since 1.0.0
 */

import { Minimatch } from "minimatch"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import * as Input from "./Input.ts"
import { LlmLint } from "./LlmLint.ts"
import type { Engine } from "./ModelEngine.ts"
import * as Target from "./Target.ts"

/**
 * The model a `claude` security review runs on when the caller names none.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultClaudeModel = "claude-opus-5-5"

/**
 * The model a `codex` security review runs on when the caller names none.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultCodexModel = "gpt-6-sol"

/**
 * One security check a reviewer performs on a package.
 *
 * `id` is kebab-case and unique within the declaration; every finding names
 * it. `threat` says who could do what to whose data or system. `lookFor` lists
 * concrete, falsifiable things to inspect. `paths` are package-relative globs
 * (or `//` workspace-rooted) the check focuses on; omitted, it applies to every
 * reviewed file.
 *
 * @category models
 * @since 1.0.0
 */
export interface Check {
  readonly id: string
  readonly title: string
  readonly threat: string
  readonly lookFor: ReadonlyArray<string>
  readonly paths?: ReadonlyArray<string> | undefined
}

/**
 * The built-in check every security review ends with.
 *
 * @category constants
 * @since 1.0.0
 */
export const generalCheck: Check = {
  id: "general",
  title: "Any other vulnerability",
  threat: "Any attacker who controls an input this code reads (a network request, a file, an environment variable, " +
    "a model or tool output, a dependency) makes it act outside what its caller authorized.",
  lookFor: [
    "Injection: untrusted text reaching a shell, SQL, a template, a regex, HTML, a log line, or an eval.",
    "Authorization: an action or read that skips the ownership, tenancy, or role check its siblings perform.",
    "Secrets: credentials, tokens, or keys hardcoded, logged, returned to a client, or passed to a child process that does not need them.",
    "Path traversal: a caller-controlled path or archive entry that can escape its intended root, including via symlinks.",
    "SSRF: a caller-controlled URL, host, or redirect fetched by the server.",
    "Unsafe deserialization: untrusted bytes decoded into code, prototypes, or unchecked types.",
    "Command execution: a spawn, exec, or shell whose argv or environment an untrusted input shapes.",
    "Crypto misuse: weak or homemade primitives, predictable randomness for secrets, missing constant-time comparison, disabled TLS verification.",
    "Prompt injection: untrusted content placed in an agent prompt or tool result that can steer tool calls, approvals, or data egress.",
    "Supply chain: install scripts, unpinned downloads, or unverified artifacts executed at build or run time.",
    "Denial of service: unbounded reads, allocations, loops, recursion, retries, or regex backtracking on untrusted input.",
    "Information leaks: stack traces, internal paths, other tenants' data, or secrets in errors, logs, or responses."
  ]
}

/**
 * The framing every security review prompt starts with.
 *
 * @category constants
 * @since 1.0.0
 */
export const securityPrompt = [
  "You are the security engineer for this repository, performing an authorized defensive security review",
  "commissioned by the repository owner. The owner wants weaknesses in their own code found and fixed before",
  "anyone can abuse them; this is the routine application-security review a code owner runs before a release.",
  "Read the files as an attacker would, then report each weakness precisely enough for the owner to fix it:",
  "the vulnerable location, the attacker's precondition, the impact, and the fix. Do not write exploit code,",
  "working payloads, or instructions for attacking any system; describe the flaw and the remedy. Judge the",
  "code you are shown, mark a finding suspected when it depends on code or configuration you cannot see, and",
  "prefer one well-evidenced finding over several speculative ones."
].join(" ")

const checkId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

const oneLine = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.trim() === "" || /[\r\n]/.test(value)) {
    throw new TypeError(`${what} must be one nonempty line`)
  }
  return value.trim()
}

/** Validates the declared checks and returns them with the general check appended. */
const withGeneral = (cwd: string, checks: ReadonlyArray<Check>): ReadonlyArray<Check> => {
  const seen = new Set<string>()
  const output: Array<Check> = []
  for (const check of checks) {
    const id = oneLine(check.id, "security check id")
    if (!checkId.test(id)) throw new TypeError(`security check id must be kebab-case: ${JSON.stringify(id)}`)
    if (id === generalCheck.id) throw new TypeError("security check id \"general\" is reserved for the built-in check")
    if (seen.has(id)) throw new TypeError(`security check id is declared twice: ${id}`)
    seen.add(id)
    if (check.lookFor.length === 0) throw new TypeError(`security check ${id} must list at least one lookFor item`)
    output.push({
      id,
      title: oneLine(check.title, `security check ${id} title`),
      threat: oneLine(check.threat, `security check ${id} threat`),
      lookFor: check.lookFor.map((item, index) => oneLine(item, `security check ${id} lookFor[${index}]`)),
      ...(check.paths === undefined
        ? {}
        : { paths: check.paths.map((path) => Input.resolvePath(cwd, oneLine(path, `security check ${id} path`))) })
    })
  }
  return [...output, generalCheck]
}

/**
 * Renders the rubric for a list of checks whose `paths` are already
 * workspace-relative, the built-in general check included.
 *
 * @category rendering
 * @since 1.0.0
 */
export const renderRubric = (checks: ReadonlyArray<Check>): string =>
  [
    "Checks. Every finding names exactly one check id below.",
    "",
    ...checks.flatMap((check) => [
      `[${check.id}] ${check.title}`,
      `Threat: ${check.threat}`,
      `Focus: ${check.paths === undefined ? "every reviewed file" : check.paths.join(", ")}`,
      "Look for:",
      ...check.lookFor.map((item) => `- ${item}`),
      ""
    ]),
    "Reporting rules:",
    "- Message format: \"[<check id>] <confirmed|suspected>: <who> can <do what> to <whose data or which system> " +
    "because <cause>. Fix: <concrete fix>.\"",
    "- Severity \"error\" means confirmed: an attacker at the stated trust boundary reaches the flaw through the code " +
    "shown. \"warning\" means suspected: plausible, but it depends on code or configuration not shown. \"info\" " +
    "means hardening with no demonstrated attacker path.",
    "- file and line point at the vulnerable operation (the sink or the missing check), not an import.",
    "- Report each distinct flaw once; name at most three call sites of the same flaw.",
    "- Style, correctness bugs without a security consequence, and missing tests are not findings.",
    "- Respond with [] when nothing qualifies."
  ].join("\n")

/**
 * Options for {@link SecurityReview}.
 *
 * `cwd` is the workspace-relative package directory. `include` defaults to
 * `src/**`; patterns are package-relative unless they start with `//`.
 * `context` files are read into every batch whether or not they changed.
 * `engine` defaults to `claude` on {@link defaultClaudeModel}; `codex`
 * defaults to {@link defaultCodexModel}. `base` is the diff review's base,
 * `origin/main` by default. `batchSize` (default 4) caps files per model call
 * in the diff review and `auditBatchSize` (default 8) in the full audit; the
 * audit reviews at most 64 batches, so a package over 512 included files
 * narrows `include` or raises `auditBatchSize`.
 *
 * `workspaceRoot` is the absolute workspace root the declaration is checked
 * against. It defaults to the root derived from the declaring `PACKAGE.ts`
 * and `cwd`. When a root is known, every `context` entry must match at least
 * one file, and every check path must match at least one file that an
 * `include` or `context` glob also matches; otherwise the declaration throws.
 * Outside a `PACKAGE.ts` with no `workspaceRoot`, the paths are not checked.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly cwd: string
  readonly checks: ReadonlyArray<Check>
  readonly include?: ReadonlyArray<Input.Glob | string> | undefined
  readonly context?: ReadonlyArray<Input.Glob | string> | undefined
  readonly deps?: ReadonlyArray<Target.AnyTarget> | undefined
  readonly engine?: Engine | undefined
  readonly model?: string | undefined
  readonly base?: string | undefined
  readonly batchSize?: number | undefined
  readonly auditBatchSize?: number | undefined
  readonly summary?: string | undefined
  readonly workspaceRoot?: string | undefined
}

/**
 * The two targets {@link SecurityReview} returns.
 *
 * @category models
 * @since 1.0.0
 */
export interface SecurityTargets {
  readonly security: ReturnType<typeof LlmLint>
  readonly securityAudit: ReturnType<typeof LlmLint>
}

/** Re-roots one declared glob so it matches workspace-relative git paths. */
const anchor = (cwd: string, declaration: Input.Glob | string): Input.Glob => {
  const glob = typeof declaration === "string" ? Input.glob(declaration) : declaration
  return Input.Glob.make({
    pattern: `//${Input.resolvePath(cwd, glob.pattern)}`,
    exclude: glob.exclude.map((entry) => `//${Input.resolvePath(cwd, entry)}`)
  })
}

/** Directories a plan-time path check never descends into. */
const skippedDirectories = new Set([".git", ".jj", "node_modules"])

const globMagic = /[*?[\]{}!()|@+]/

/** Workspace-relative directory holding every file a resolved pattern can match. */
const patternBase = (pattern: string): string => {
  const segments = pattern.split("/")
  const literal: Array<string> = []
  for (const segment of segments) {
    if (globMagic.test(segment)) break
    literal.push(segment)
  }
  if (literal.length === segments.length) literal.pop()
  return literal.join("/")
}

interface Matcher {
  readonly pattern: string
  readonly matches: (path: string) => boolean
}

const matcherOf = (glob: Input.Glob): Matcher => {
  const pattern = glob.pattern.slice(2)
  const included = new Minimatch(pattern, { dot: true })
  const excluded = glob.exclude.map((entry) => new Minimatch(entry.slice(2), { dot: true }))
  return {
    pattern,
    matches: (path) => included.match(path) && !excluded.some((entry) => entry.match(path))
  }
}

/**
 * Finds the first workspace file under `matcher`'s base that satisfies
 * `accept`, walking real directories only. Returns whether any file matched
 * the pattern at all, and whether one was also accepted.
 */
const probe = (
  root: string,
  matcher: Matcher,
  accept: (path: string) => boolean
): { readonly matched: boolean; readonly accepted: boolean } => {
  let matched = false
  const pending = [patternBase(matcher.pattern)]
  while (pending.length > 0) {
    const directory = pending.pop()!
    let entries: Array<NodeFs.Dirent>
    try {
      entries = NodeFs.readdirSync(NodePath.join(root, directory), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) pending.push(path)
      } else if ((entry.isFile() || entry.isSymbolicLink()) && matcher.matches(path)) {
        matched = true
        if (accept(path)) return { matched, accepted: true }
      }
    }
  }
  return { matched, accepted: false }
}

/** The absolute workspace root a PACKAGE.ts at `cwd` declares from, if known. */
const declaredRoot = (cwd: string): string | undefined => {
  const source = Target.declarationSourceFile()
  if (source === undefined) return undefined
  const directory = NodePath.dirname(source)
  const relative = Input.resolvePath("", cwd)
  if (relative === ".") return directory
  const suffix = `${NodePath.sep}${relative.split("/").join(NodePath.sep)}`
  if (!directory.endsWith(suffix)) {
    throw new TypeError(
      `security review cwd ${JSON.stringify(cwd)} does not name the directory of its declaring ${source}`
    )
  }
  return directory.slice(0, -suffix.length)
}

/**
 * Throws when a context entry matches no file, or when a check path matches
 * no file the review reads (an include or context glob).
 */
const validatePaths = (
  root: string,
  checks: ReadonlyArray<Check>,
  include: ReadonlyArray<Input.Glob>,
  context: ReadonlyArray<Input.Glob>
): void => {
  for (const glob of context) {
    const matcher = matcherOf(glob)
    if (!probe(root, matcher, () => true).matched) {
      throw new TypeError(
        `security review context ${JSON.stringify(matcher.pattern)} matches no file; context entries are file ` +
          "globs, so put descriptions in the check text"
      )
    }
  }
  const reviewed = [...include, ...context].map(matcherOf)
  for (const check of checks) {
    for (const path of check.paths ?? []) {
      const matcher = matcherOf(Input.Glob.make({ pattern: `//${path}`, exclude: [] }))
      const found = probe(root, matcher, (file) => reviewed.some((entry) => entry.matches(file)))
      if (!found.matched) {
        throw new TypeError(`security check ${check.id} path ${JSON.stringify(path)} matches no file`)
      }
      if (!found.accepted) {
        throw new TypeError(
          `security check ${check.id} path ${JSON.stringify(path)} matches no file the review reads; ` +
            "add it to include or context, or drop the path"
        )
      }
    }
  }
}

/**
 * Declares a package's security review: the `security` diff review and the
 * manual `securityAudit` full audit, both over the declared checks plus the
 * built-in `general` check. Spread the result into the package's targets.
 *
 * The call validates the checks and their paths against the workspace (see
 * {@link Options}) and returns declarations; it runs no review.
 * A confirmed finding (severity `error`) fails the target; suspected and
 * hardening findings are reported without failing it.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const securityReview = Smithers.SecurityReview({
 *   cwd: "packages/example",
 *   checks: [{
 *     id: "upload-path-traversal",
 *     title: "Upload paths stay inside the upload root",
 *     threat: "An authenticated user writes files outside their upload directory.",
 *     lookFor: ["A request-supplied file name joined to the root without normalizing and prefix-checking."],
 *     paths: ["src/upload/**"]
 *   }]
 * })
 *
 * export const Package = Smithers.Package({ targets: { ...securityReview } })
 * ```
 *
 * @category macros
 * @since 1.0.0
 */
export const SecurityReview = (options: Options): SecurityTargets => {
  const cwd = options.cwd
  const checks = withGeneral(cwd, options.checks)
  const include = (options.include ?? ["src/**"]).map((entry) => anchor(cwd, entry))
  const context = (options.context ?? []).map((entry) => anchor(cwd, entry))
  const root = options.workspaceRoot ?? declaredRoot(cwd)
  if (root !== undefined) validatePaths(root, checks, include, context)
  const engine = options.engine ?? "claude"
  const model = options.model ?? (engine === "claude" ? defaultClaudeModel : defaultCodexModel)
  const rubric = renderRubric(checks)
  const paths = include.map((entry) => entry.pattern.slice(2))
  const named = checks.length - 1
  const shared = {
    include,
    context,
    deps: options.deps ?? [],
    prompt: securityPrompt,
    rubric,
    engine,
    model,
    failOn: "error" as const
  }
  return {
    security: LlmLint({
      ...shared,
      summary: options.summary ??
        `Security review of changed ${cwd} sources against ${named} package checks plus a general sweep.`,
      changes: Input.gitDiff({ base: options.base ?? "origin/main", paths }),
      batchSize: options.batchSize ?? 4
    }),
    securityAudit: LlmLint({
      ...shared,
      summary:
        `Full security audit of every included ${cwd} source against ${named} package checks plus a general sweep.`,
      // Scope `all` lists files instead of diffing; the diff against HEAD
      // only re-keys the audit on uncommitted edits to the included files.
      changes: Input.gitDiff({ base: "HEAD", paths }),
      scope: "all",
      batchSize: options.auditBatchSize ?? 8,
      manual: true
    })
  }
}
