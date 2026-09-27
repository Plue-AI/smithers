/**
 * Ownership declarations for `PACKAGE.ts` and `WORKSPACE.ts`, and the two
 * generated-file rules that project them.
 *
 * A package names who owns it the way it names its targets: inert data on
 * the `S.Package` call. `owners` lists logins and `team:<name>` references,
 * `perFile` adds owners for globs inside the package, `noparent` stops the
 * walk up to the parent package, `agents` is the policy an agent-authored
 * change lands under, and `upstream` lets a package claim changes to the
 * packages it depends on. The workspace declares default owners and the
 * team roster team references resolve against.
 *
 * Every constructor validates and freezes; nothing here reads a file or a
 * graph. Resolution against the package tree and the dependency graph lives
 * in `@smthrs/build-cli`, which also renders `.github/CODEOWNERS` and the
 * per-directory `OWNERS` tree from these declarations.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as NodeUtil from "node:util/types"
import * as Target from "./Target.ts"

/**
 * Maximum owners one declaration may list.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumOwners = 64

/**
 * Maximum per-file and policy patterns one declaration may list.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumPatterns = 128

/**
 * The login grammar: GitHub-shaped, bounded, no leading punctuation.
 *
 * @category constants
 * @since 0.1.0
 */
export const loginShape = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

/**
 * Schema for one owner: a login or a `team:<name>` reference.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Owner = Schema.NonEmptyString.check(Schema.isPattern(/^(?:team:)?[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/))

/**
 * One owner: a login or a `team:<name>` reference.
 *
 * @category models
 * @since 0.1.0
 */
export type Owner = typeof Owner.Type

/**
 * Schema for the policy an agent-authored change lands under.
 *
 * `auto-land` lets an agent change land on an agent LGTM alone,
 * `human-approve` (the default) requires a human owner's approval, and
 * `deny` refuses agent-authored changes to the matched paths outright.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AgentPolicy = Schema.Literals(["auto-land", "human-approve", "deny"])

/**
 * The policy an agent-authored change lands under.
 *
 * @category models
 * @since 0.1.0
 */
export type AgentPolicy = typeof AgentPolicy.Type

/**
 * Schema for one per-glob policy override, matched against paths relative
 * to the declaring package, first match wins.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PolicyOverride = Schema.Struct({
  pattern: Schema.NonEmptyString,
  policy: AgentPolicy
})

/**
 * Schema for the normalized agent policy: a default plus ordered overrides.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Agents = Schema.Struct({
  default: AgentPolicy,
  overrides: Schema.Array(PolicyOverride)
})

/**
 * The normalized agent policy.
 *
 * @category models
 * @since 0.1.0
 */
export type Agents = typeof Agents.Type

/**
 * Schema for one per-file rule: owners added for paths matching a glob
 * relative to the declaring package.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PerFile = Schema.Struct({
  pattern: Schema.NonEmptyString,
  owners: Schema.Array(Owner)
})

/**
 * Schema for the upstream claim: how a change to a package this package
 * depends on resolves to this package's owners.
 *
 * `review` adds them as suggested reviewers; `approve` adds them as required
 * approvers. `packages` bounds the claim to the named package labels or
 * subtree patterns; absent, it covers the whole transitive dependency set.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Upstream = Schema.Struct({
  mode: Schema.Literals(["review", "approve"]),
  packages: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

/**
 * The normalized upstream claim.
 *
 * @category models
 * @since 0.1.0
 */
export type Upstream = typeof Upstream.Type

/**
 * Schema for the validated ownership declaration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Declaration = Schema.TaggedStruct("Owners", {
  owners: Schema.Array(Owner),
  perFile: Schema.Array(PerFile),
  noparent: Schema.Boolean,
  agents: Schema.optional(Agents),
  upstream: Schema.optional(Upstream)
})

/**
 * The validated ownership declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type Declaration = typeof Declaration.Type

/**
 * Checks whether a value is a validated ownership declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isDeclaration: (value: unknown) => value is Declaration = Schema.is(Declaration)

/**
 * The upstream forms {@link declare} accepts.
 *
 * @category models
 * @since 0.1.0
 */
export type UpstreamOption =
  | "none"
  | "review"
  | "approve"
  | { readonly mode: "review" | "approve"; readonly packages?: ReadonlyArray<string> | undefined }

/**
 * The agent policy forms {@link declare} accepts: one policy for the whole
 * package, or a default with per-glob overrides keyed by policy.
 *
 * @category models
 * @since 0.1.0
 */
export type AgentsOption =
  | AgentPolicy
  | {
    readonly default?: AgentPolicy | undefined
    readonly "auto-land"?: ReadonlyArray<string> | undefined
    readonly "human-approve"?: ReadonlyArray<string> | undefined
    readonly deny?: ReadonlyArray<string> | undefined
  }

/**
 * Options accepted by {@link declare}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly owners?: ReadonlyArray<string> | undefined
  readonly perFile?: Readonly<Record<string, string | ReadonlyArray<string>>> | undefined
  readonly noparent?: boolean | undefined
  readonly agents?: AgentsOption | undefined
  readonly upstream?: UpstreamOption | undefined
}

const knownOptions: ReadonlySet<string> = new Set(["owners", "perFile", "noparent", "agents", "upstream"])
const policies: ReadonlySet<string> = new Set(["auto-land", "human-approve", "deny"])
const byCodeUnit = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !NodeUtil.isProxy(value) && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const ownerList = (value: unknown, where: string): ReadonlyArray<Owner> => {
  if (!Array.isArray(value)) throw new TypeError(`Owners ${where} must be an array of logins or team:<name> references`)
  if (value.length > maximumOwners) throw new Error(`Owners ${where} lists more than ${maximumOwners} owners`)
  const seen = new Set<string>()
  const owners: Array<Owner> = []
  for (const entry of value) {
    if (typeof entry !== "string" || !Schema.is(Owner)(entry)) {
      throw new Error(`Owners ${where} entry is not a login or team:<name> reference: ${JSON.stringify(entry)}`)
    }
    if (seen.has(entry)) continue
    seen.add(entry)
    owners.push(entry)
  }
  return owners
}

const patternList = (value: unknown, where: string): ReadonlyArray<string> => {
  if (!Array.isArray(value)) throw new TypeError(`Owners ${where} must be an array of glob patterns`)
  if (value.length > maximumPatterns) throw new Error(`Owners ${where} lists more than ${maximumPatterns} patterns`)
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "" || entry.includes("\0")) {
      throw new Error(`Owners ${where} pattern must be a non-empty string: ${JSON.stringify(entry)}`)
    }
    if (entry.startsWith("/") || entry.startsWith("//") || entry.split("/").includes("..")) {
      throw new Error(`Owners ${where} pattern must be relative to the package: ${JSON.stringify(entry)}`)
    }
  }
  return value
}

const normalizeAgents = (value: unknown): Agents => {
  if (typeof value === "string") {
    if (!policies.has(value)) {
      throw new Error(`Owners agents policy is not auto-land, human-approve, or deny: ${JSON.stringify(value)}`)
    }
    return Agents.make({ default: value as AgentPolicy, overrides: [] })
  }
  if (!isPlainObject(value)) throw new TypeError("Owners agents must be a policy name or an object of policy overrides")
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key !== "default" && !policies.has(key)) {
      throw new TypeError(`Owners agents received unknown key ${JSON.stringify(key)}`)
    }
  }
  const fallback = value["default"] ?? "human-approve"
  if (typeof fallback !== "string" || !policies.has(fallback)) {
    throw new Error(`Owners agents default is not auto-land, human-approve, or deny: ${JSON.stringify(fallback)}`)
  }
  const overrides: Array<{ readonly pattern: string; readonly policy: AgentPolicy }> = []
  for (const policy of ["auto-land", "human-approve", "deny"] as const) {
    const patterns = value[policy]
    if (patterns === undefined) continue
    for (const pattern of patternList(patterns, `agents ${policy}`)) overrides.push({ pattern, policy })
  }
  return Agents.make({ default: fallback as AgentPolicy, overrides })
}

const labelPattern = /^\/\/(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)?(?:\/\.\.\.)?$|^\/\/\.\.\.$/

const normalizeUpstream = (value: unknown): Upstream | undefined => {
  if (value === "none") return undefined
  if (value === "review" || value === "approve") return Upstream.make({ mode: value })
  if (!isPlainObject(value)) {
    throw new TypeError("Owners upstream must be none, review, approve, or { mode, packages }")
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key !== "mode" && key !== "packages") {
      throw new TypeError(`Owners upstream received unknown key ${JSON.stringify(key)}`)
    }
  }
  const mode = value["mode"]
  if (mode !== "review" && mode !== "approve") {
    throw new Error(`Owners upstream mode must be review or approve: ${JSON.stringify(mode)}`)
  }
  const packages = value["packages"]
  if (packages === undefined) return Upstream.make({ mode })
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new TypeError(
      "Owners upstream packages must be a non-empty array of //package labels or //package/... patterns"
    )
  }
  if (packages.length > maximumPatterns) throw new Error(`Owners upstream lists more than ${maximumPatterns} packages`)
  for (const entry of packages) {
    if (typeof entry !== "string" || !labelPattern.test(entry)) {
      throw new Error(
        `Owners upstream package must be a //package label or //package/... pattern: ${JSON.stringify(entry)}`
      )
    }
  }
  return Upstream.make({ mode, packages: [...packages].sort(byCodeUnit) })
}

/**
 * Validates and normalizes an ownership declaration.
 *
 * `S.Package({ owners: { ... } })` and `S.Workspace(name, { owners: { ... } })`
 * call this on the plain object they receive; a caller may also call it
 * directly and pass the result.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * export const Package = S.Package({
 *   owners: {
 *     owners: ["will", "team:platform"],
 *     perFile: { "*.sql": ["team:data"] },
 *     agents: { default: "human-approve", "auto-land": ["*.md", "docs/**"], deny: ["migrations/**"] },
 *     upstream: "review"
 *   },
 *   targets: { ... }
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const declare = (options: Options | Declaration): Declaration => {
  if (isDeclaration(options)) return options
  if (!isPlainObject(options)) throw new TypeError("Owners options must be a plain object")
  for (const key of Object.getOwnPropertyNames(options)) {
    if (!knownOptions.has(key)) throw new TypeError(`Owners received unknown option ${JSON.stringify(key)}`)
  }
  const owners = options.owners === undefined ? [] : ownerList(options.owners, "owners")
  const perFile: Array<{ readonly pattern: string; readonly owners: ReadonlyArray<Owner> }> = []
  if (options.perFile !== undefined) {
    if (!isPlainObject(options.perFile)) throw new TypeError("Owners perFile must be an object of glob to owners")
    const patterns = Object.getOwnPropertyNames(options.perFile)
    patternList(patterns, "perFile")
    for (const pattern of [...patterns].sort(byCodeUnit)) {
      const value = options.perFile[pattern]
      const list = ownerList(typeof value === "string" ? [value] : value, `perFile ${JSON.stringify(pattern)}`)
      if (list.length === 0) throw new Error(`Owners perFile ${JSON.stringify(pattern)} names no owner`)
      perFile.push({ pattern, owners: list })
    }
  }
  if (options.noparent !== undefined && typeof options.noparent !== "boolean") {
    throw new TypeError("Owners noparent must be a boolean")
  }
  const noparent = options.noparent === true
  if (noparent && owners.length === 0 && perFile.length === 0) {
    throw new Error("Owners noparent requires at least one owner: a package that inherits nothing must name someone")
  }
  const agents = options.agents === undefined ? undefined : normalizeAgents(options.agents)
  const upstream = options.upstream === undefined ? undefined : normalizeUpstream(options.upstream)
  return Declaration.make({
    owners,
    perFile,
    noparent,
    ...(agents === undefined ? {} : { agents }),
    ...(upstream === undefined ? {} : { upstream })
  })
}

/**
 * Schema for the workspace team roster: team name to member logins.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TeamsDeclaration = Schema.TaggedStruct("Teams", {
  teams: Schema.Record(Schema.String, Schema.Array(Schema.NonEmptyString))
})

/**
 * The validated team roster.
 *
 * @category models
 * @since 0.1.0
 */
export type TeamsDeclaration = typeof TeamsDeclaration.Type

/**
 * Checks whether a value is a validated team roster.
 *
 * @category guards
 * @since 0.1.0
 */
export const isTeamsDeclaration: (value: unknown) => value is TeamsDeclaration = Schema.is(TeamsDeclaration)

/**
 * Validates a team roster: team names are login-shaped, members are logins,
 * and every list is deduplicated and sorted.
 *
 * @example
 * ```ts
 * export const Workspace = S.Workspace("force", {
 *   teams: S.Teams({ platform: ["will", "erik"], data: ["chungyi"] }),
 *   owners: { owners: ["team:platform"] },
 *   ...
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Teams = (roster: Readonly<Record<string, ReadonlyArray<string>>> | TeamsDeclaration): TeamsDeclaration => {
  if (isTeamsDeclaration(roster)) return roster
  if (!isPlainObject(roster)) throw new TypeError("Teams must be a plain object of team name to member logins")
  const teams: Record<string, ReadonlyArray<string>> = {}
  for (const name of Object.getOwnPropertyNames(roster).sort(byCodeUnit)) {
    if (!loginShape.test(name)) throw new Error(`Teams name is not a portable identifier: ${JSON.stringify(name)}`)
    const members = roster[name]
    if (!Array.isArray(members)) throw new TypeError(`Teams ${JSON.stringify(name)} must be an array of member logins`)
    if (members.length > maximumOwners) {
      throw new Error(`Teams ${JSON.stringify(name)} lists more than ${maximumOwners} members`)
    }
    const seen = new Set<string>()
    for (const member of members) {
      if (typeof member !== "string" || !loginShape.test(member)) {
        throw new Error(`Teams ${JSON.stringify(name)} member is not a login: ${JSON.stringify(member)}`)
      }
      seen.add(member)
    }
    teams[name] = [...seen].sort(byCodeUnit)
  }
  return TeamsDeclaration.make({ teams })
}

/**
 * The team names one declaration references, without the `team:` prefix.
 *
 * @category accessors
 * @since 0.1.0
 */
export const teamReferences = (declaration: Declaration): ReadonlyArray<string> => {
  const names = new Set<string>()
  for (const owner of declaration.owners) if (owner.startsWith("team:")) names.add(owner.slice(5))
  for (const rule of declaration.perFile) {
    for (const owner of rule.owners) if (owner.startsWith("team:")) names.add(owner.slice(5))
  }
  return [...names].sort(byCodeUnit)
}

/**
 * Attrs for {@link Codeowners}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CodeownersAttrs = Schema.Struct({
  /** GitHub organization teams render under, as `@<org>/<team>`. */
  org: Schema.NonEmptyString.check(Schema.isPattern(loginShape)),
  /** Workspace-relative output path; defaults to `.github/CODEOWNERS`. */
  path: Schema.optional(Schema.NonEmptyString)
})

/**
 * Generates `.github/CODEOWNERS` from every package's `owners` declaration.
 *
 * GitHub semantics: one line per package and per-file rule, ordered so the
 * most specific rule comes last and wins. Required approvers only: an
 * `upstream: "approve"` claim adds the claiming package's owners to the
 * claimed package's line, an `upstream: "review"` claim does not appear
 * because CODEOWNERS has no suggested-reviewer form. Check by default under
 * `lint`; `build --write` applies.
 *
 * @category targets
 * @since 0.1.0
 */
export const Codeowners = Target.make("Owners.Codeowners", {
  attrs: CodeownersAttrs,
  kinds: ["build", "lint"],
  implementation: () => Target.notImplemented("Owners.Codeowners")
})

/**
 * Attrs for {@link Tree}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TreeAttrs = Schema.Struct({
  /** File name written in each owning package directory; defaults to `OWNERS`. */
  file: Schema.optional(Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/)))
})

/**
 * Generates the per-directory `OWNERS` tree from every package's `owners`
 * declaration, in the Google format the Smithers landing gate reads:
 * `set noparent`, one owner per line, `per-file <glob> = <owners>`,
 * `agents: <policy> [globs]`, and `reviewers: <owners>` for upstream review
 * claims. Check by default under `lint`; `build --write` applies.
 *
 * @category targets
 * @since 0.1.0
 */
export const Tree = Target.make("Owners.Tree", {
  attrs: TreeAttrs,
  kinds: ["build", "lint"],
  implementation: () => Target.notImplemented("Owners.Tree")
})
