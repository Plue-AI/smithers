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

import * as Schema from "effect/Schema"
import { Minimatch } from "minimatch"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import * as Input from "./Input.ts"
import { Finding, LlmLint, Reproduction } from "./LlmLint.ts"
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
 * A trust boundary's actors, assumptions and ordered cross-package execution path.
 * Path entries use the same file glob syntax as include. Every path is reviewed
 * and supplied as context in every batch; cwd records ownership, not scope.
 *
 * @category models
 * @since 1.0.0
 */
export interface Boundary {
  readonly id: string
  readonly actors: ReadonlyArray<string>
  readonly assets: ReadonlyArray<string>
  readonly entryPoints: ReadonlyArray<string>
  readonly identityTransformations: ReadonlyArray<string>
  readonly enforcementPoints: ReadonlyArray<string>
  readonly deploymentAssumptions: ReadonlyArray<string>
  readonly path: {
    readonly caller: ReadonlyArray<string>
    readonly authorization: ReadonlyArray<string>
    readonly service: ReadonlyArray<string>
    readonly storageOrEgress: ReadonlyArray<string>
  }
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
  "the vulnerable location, the attacker's precondition, the impact, and the fix. Do not write exploit code",
  "for attacking live systems. Safe local regression tests using synthetic data are permitted;",
  "a trusted host can run them in an isolated checkout. This reviewer cannot attest execution;",
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
    "- Include structured security fields: checkId, impact, verification, releaseRecommendation, " +
    "attackerPreconditions, evidence, and nextConfirmationStep. Message describes the cause and concrete fix.",
    "- Impact is low, medium, high, or critical; verification is suspected for every model finding. " +
    "Only a trusted host receipt of controlled reproduction at an immutable revision can confirm a finding.",
    "- Release recommendation is allow, review, or block. High and critical impact always block release, " +
    "even when suspected. Severity is derived from release recommendation, never verification.",
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
  readonly boundaries?: ReadonlyArray<Boundary> | undefined
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

const boundaryFields = [
  ["actors", "Actors"],
  ["assets", "Assets"],
  ["entryPoints", "Entry points"],
  ["identityTransformations", "Identity transformations"],
  ["enforcementPoints", "Enforcement points"],
  ["deploymentAssumptions", "Deployment assumptions"]
] as const

const boundaryStages = [
  ["caller", "Caller"],
  ["authorization", "Authorization"],
  ["service", "Service"],
  ["storageOrEgress", "Storage/egress"]
] as const

const assembleBoundaries = (cwd: string, boundaries: ReadonlyArray<Boundary> | undefined, root: string | undefined) => {
  if (boundaries !== undefined && boundaries.length === 0) {
    throw new TypeError("security boundaries must contain at least one boundary")
  }
  const ids = new Set<string>()
  const paths = new Map<string, Input.Glob>()
  const checks: Array<Check> = []
  const rubric: Array<string> = []
  for (const boundary of boundaries ?? []) {
    const id = oneLine(boundary.id, "security boundary id")
    if (!checkId.test(id)) throw new TypeError(`security boundary id must be kebab-case: ${id}`)
    if (ids.has(id)) throw new TypeError(`security boundary id is declared twice: ${id}`)
    ids.add(id)
    const lines = (values: ReadonlyArray<string>, field: string) => {
      if (!Array.isArray(values) || values.length === 0) {
        throw new TypeError(`security boundary ${id} ${field} must contain at least one item`)
      }
      return values.map((value) => oneLine(value, `security boundary ${id} ${field}`))
    }
    const boundaryPaths: Array<string> = []
    rubric.push(`Boundary [${id}] (owner: ${cwd})`)
    for (const [field, label] of boundaryFields) {
      rubric.push(`${label}: ${lines(boundary[field], field).join("; ")}`)
    }
    rubric.push("Path: Caller -> Authorization -> Service -> Storage/egress")
    for (const [field, label] of boundaryStages) {
      const stage = lines(boundary.path?.[field], field).map((path) => anchor(cwd, path))
      for (const glob of stage) {
        const path = glob.pattern.slice(2)
        if (root !== undefined && !probe(root, matcherOf(glob), () => true).matched) {
          throw new TypeError(`security boundary ${id} (${cwd}) ${field} path ${JSON.stringify(path)} matches no file`)
        }
        paths.set(glob.pattern, glob)
        boundaryPaths.push(glob.pattern)
      }
      rubric.push(`${label}: ${stage.map((glob) => glob.pattern.slice(2)).join(", ")}`)
    }
    checks.push({
      id: `boundary-${id}`,
      title: `Trace the ${id} trust boundary end to end`,
      threat: "A caller crosses the declared boundary to access assets or exercise authority without authorization.",
      lookFor: [
        "Trace the declared caller, authorization, service and storage/egress path together, using every stage supplied as context.",
        "Verify the declared actors, assets, entry points, identity transformations and enforcement points at each transition.",
        "Report missing evidence needed for this declared path as incomplete coverage; deployment assumptions are outside this source review scope."
      ],
      paths: [...new Set(boundaryPaths)]
    })
    rubric.push("")
  }
  if (rubric.length > 0) {
    rubric.push(
      "Trace each boundary end to end across all supplied files, including context; package ownership is not a trust boundary.",
      "Check identity propagation, authorization before effects, credential attachment and isolation at every transition.",
      "Deployment assumptions are explicitly outside this declared source review scope, not evidence of hosted enforcement. Do not put those declared assumptions in missingContext; report missing files or evidence needed to trace the declared paths there.",
      "Report coverage for every boundary-<id> check as well as the named checks and general; use the matching boundary check id for boundary findings."
    )
  }
  return { paths: [...paths.values()], checks, rubric: rubric.join("\n") }
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
 * A blocking release recommendation fails the target, including suspected
 * high or critical impact. Model assertions cannot confirm a finding.
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
  const root = options.workspaceRoot ?? declaredRoot(cwd)
  const boundaries = assembleBoundaries(cwd, options.boundaries, root)
  const checks = withGeneral(cwd, [...options.checks, ...boundaries.checks])
  const unique = (
    globs: ReadonlyArray<Input.Glob>
  ) => [...new Map(globs.map((glob) => [JSON.stringify(glob), glob])).values()]
  const include = unique([...(options.include ?? ["src/**"]).map((entry) => anchor(cwd, entry)), ...boundaries.paths])
  const context = unique([...(options.context ?? []).map((entry) => anchor(cwd, entry)), ...boundaries.paths])
  if (root !== undefined) validatePaths(root, checks, include, context)
  const engine = options.engine ?? "claude"
  const model = options.model ?? (engine === "claude" ? defaultClaudeModel : defaultCodexModel)
  const rubric = [boundaries.rubric, renderRubric(checks)].filter(Boolean).join("\n\n")
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
    failOn: "error" as const,
    securityChecks: checks.map((check) => check.id)
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

/**
 * Records a trusted host's controlled reproduction. The host must actually run
 * the command against the immutable revision and retain its execution evidence.
 * Never pass model output here: this attestation boundary does not execute commands.
 * Confirmation does not change impact or release advice.
 *
 * @category verification
 * @since 1.0.0
 */
export const confirmFinding = (
  finding: Finding,
  receipt: typeof Reproduction.Type
): Finding => {
  const decoded = Schema.decodeUnknownSync(Finding)(finding)
  const reproduction = Schema.decodeUnknownSync(Reproduction)(receipt)
  if (decoded.security === undefined) throw new TypeError("confirmation requires a security finding")
  return { ...decoded, security: { ...decoded.security, verification: "confirmed", reproduction } }
}
