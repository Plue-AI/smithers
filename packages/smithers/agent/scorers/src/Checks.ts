/**
 * Pure, deterministic text and action checks for agent output.
 *
 * Every check is a synchronous function from text (or recorded tool calls) to
 * a {@link Check}: an id, a pass flag, and a short detail naming what was
 * found. {@link all} folds a list into a score, and {@link scorer} declares a
 * scorer over a list of checks, so a suite can grade length, wording, links,
 * truncation, routing, and leakage without a model.
 *
 * Link syntax is understood in three forms: Slack `<url|label>` and `<url>`,
 * markdown `[label](url)`, and bare `http(s)://` URLs. Checks that read prose
 * ({@link words}, {@link barePaths}, {@link questions},
 * {@link linkedReferences}) read the link labels and skip the URLs.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Scorer from "./Scorer.ts"

/**
 * One check outcome. `detail` says what was found and is at most 200
 * characters.
 *
 * @category models
 * @since 0.1.0
 */
export interface Check {
  readonly id: string
  readonly pass: boolean
  readonly detail: string
}

/**
 * A link found in text, with its label when the syntax carries one.
 *
 * @category models
 * @since 0.1.0
 */
export interface Link {
  readonly url: string
  readonly label?: string
}

/**
 * A reference pattern and the link template it must be linked to.
 *
 * `pattern` is a regular expression source with one capture group, and `url`
 * a template in which `$1` is replaced by the captured text.
 *
 * @category models
 * @since 0.1.0
 */
export interface Reference {
  readonly pattern: string
  readonly url: string
}

/**
 * One recorded tool call.
 *
 * @category models
 * @since 0.1.0
 */
export interface Action {
  readonly tool: string
  readonly input: unknown
}

/**
 * What {@link count} counts and the bounds it enforces.
 *
 * @category models
 * @since 0.1.0
 */
export interface CountSpec {
  readonly tool: string
  readonly where?: Readonly<Record<string, string | number | boolean | ReadonlyArray<string>>>
  readonly min?: number
  readonly max?: number
  readonly id?: string
}

/**
 * Text written to one sink, such as a channel, a log, or a file.
 *
 * @category models
 * @since 0.1.0
 */
export interface Emission {
  readonly sink: string
  readonly text: string
}

/**
 * The fold of a list of checks.
 *
 * @category models
 * @since 0.1.0
 */
export interface Summary {
  readonly score: number
  readonly pass: boolean
  readonly failed: ReadonlyArray<Check>
}

/**
 * Options accepted by {@link scorer}.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScorerOptions {
  readonly id: string
  readonly version: string
  readonly name?: string
  readonly config?: unknown
  readonly checks: (input: Scorer.Input) => ReadonlyArray<Check>
}

const maxDetail = 200

const clip = (detail: string): string => detail.length > maxDetail ? `${detail.slice(0, maxDetail - 1)}…` : detail

const check = (id: string, pass: boolean, detail: string): Check => ({ id, pass, detail: clip(detail) })

const quote = (text: string): string => JSON.stringify(text)

/**
 * Folds typographic quotes and apostrophes to their ASCII forms, so "hasn’t"
 * matches an expectation written "hasn't". Models write both.
 */
const fold = (text: string): string => text.replace(/[\u2018\u2019\u02BC]/gu, "'").replace(/[\u201C\u201D]/gu, "\"")

const wordChar = /[\p{L}\p{N}_]/u

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const literal = /^\/(.+)\/([a-z]*)$/su

/**
 * Compiles one forbidden entry: `/source/flags` is a regular expression, and
 * anything else a case-insensitive whole word or phrase.
 */
const phrase = (entry: string): RegExp => {
  const regex = literal.exec(entry)
  if (regex !== null) {
    const flags = regex[2]!
    return new RegExp(regex[1]!, flags.includes("g") ? flags : `${flags}g`)
  }
  const before = wordChar.test(entry.charAt(0)) ? "(?<![\\p{L}\\p{N}_])" : ""
  const after = wordChar.test(entry.charAt(entry.length - 1)) ? "(?![\\p{L}\\p{N}_])" : ""
  return new RegExp(`${before}${escape(entry).replace(/\s+/g, "\\s+")}${after}`, "giu")
}

const hits = (text: string, entry: string): ReadonlyArray<string> =>
  entry.length === 0
    ? []
    : [...new Set([...fold(text).matchAll(phrase(literal.test(entry) ? entry : fold(entry)))].map(([match]) => match))]

// Slack `<url|label>` / `<url>`, markdown `[label](url)`, then a bare URL.
const linkSyntax = /<([a-z][a-z0-9+.-]*:[^|>\s]+)(?:\|([^>]*))?>|\[([^\]]*)\]\(([^)\s]+)\)|https?:\/\/[^\s<>]+/giu

interface Found {
  readonly index: number
  readonly raw: string
  readonly url: string
  readonly label: string | undefined
  readonly bare: boolean
}

const trimBare = (url: string): string => {
  let value = url
  for (;;) {
    const last = value.charAt(value.length - 1)
    const unbalanced = last === ")" && value.split("(").length < value.split(")").length
    if (".,;:!?'\"]".includes(last) || unbalanced) value = value.slice(0, -1)
    else return value
  }
}

const scan = (text: string): ReadonlyArray<Found> =>
  [...text.matchAll(linkSyntax)].map((match) => {
    const [raw, slackUrl, slackLabel, markdownLabel, markdownUrl] = match
    const label = (slackLabel ?? markdownLabel)?.trim()
    if (slackUrl !== undefined || markdownUrl !== undefined) {
      return {
        index: match.index,
        raw,
        url: slackUrl ?? markdownUrl!,
        label: label === undefined || label.length === 0 ? undefined : label,
        bare: false
      }
    }
    const url = trimBare(raw)
    return { index: match.index, raw: url, url, label: undefined, bare: true }
  })

/** Rewrites every link: labelled syntax becomes `labelled(found)`, a bare URL becomes `bare`. */
const rewrite = (text: string, labelled: (found: Found) => string, bare: string): string => {
  let out = ""
  let at = 0
  for (const found of scan(text)) {
    out += text.slice(at, found.index) + (found.bare ? bare : labelled(found))
    at = found.index + found.raw.length
  }
  return out + text.slice(at)
}

const labelOf = (found: Found): string => ` ${found.label ?? ""} `

/**
 * Counts whitespace-separated tokens that contain a letter or digit.
 *
 * A Slack or markdown link counts as its label's words, never its URL. A bare
 * URL counts as one word.
 *
 * @category measuring
 * @since 0.1.0
 */
export const words = (text: string): number =>
  rewrite(text, labelOf, " link ").split(/\s+/u).filter((token) => /[\p{L}\p{N}]/u.test(token)).length

/**
 * Checks the {@link words} count against inclusive bounds.
 *
 * @category checks
 * @since 0.1.0
 */
export const length = (
  text: string,
  bounds: { readonly min?: number | undefined; readonly max?: number | undefined }
): Check => {
  const count = words(text)
  if (bounds.min !== undefined && count < bounds.min) return check("length", false, `${count} words < ${bounds.min}`)
  if (bounds.max !== undefined && count > bounds.max) return check("length", false, `${count} words > ${bounds.max}`)
  return check("length", true, `${count} words`)
}

/**
 * Requires every entry as a case-insensitive substring. An array entry is an
 * any-of group: one member present satisfies it. Typographic quotes and
 * apostrophes match their ASCII forms.
 *
 * @category checks
 * @since 0.1.0
 */
export const includes = (text: string, required: ReadonlyArray<string | ReadonlyArray<string>>): Check => {
  const lower = fold(text).toLowerCase()
  const missing = required
    .map((entry) => typeof entry === "string" ? [entry] : entry)
    .filter((group) => !group.some((member) => lower.includes(fold(member).toLowerCase())))
    .map((group) => group.map(quote).join(" | "))
  return missing.length === 0
    ? check("includes", true, "all present")
    : check("includes", false, `missing: ${missing.join(", ")}`)
}

/**
 * Forbids words or phrases, matched case-insensitively as whole words: a
 * boundary is required at each end that is a letter, digit, or underscore.
 * Typographic quotes and apostrophes match their ASCII forms.
 * An entry written `/source/flags` is a regular expression with its own
 * flags; an invalid one throws a `SyntaxError`. Empty entries are ignored.
 *
 * @category checks
 * @since 0.1.0
 */
export const excludes = (text: string, forbidden: ReadonlyArray<string>, id = "excludes"): Check => {
  const found = [...new Set(forbidden.flatMap((entry) => hits(text, entry)))]
  return found.length === 0
    ? check(id, true, "none found")
    : check(id, false, `found: ${found.map(quote).join(", ")}`)
}

const leading = /^(?:[\s\p{P}\p{S}\p{Extended_Pictographic}]|\u200d|\ufe0f)+/u

/**
 * Fails when the message opens with one of `phrases` as whole words,
 * case-insensitively, after leading whitespace, emoji, and punctuation.
 *
 * @category checks
 * @since 0.1.0
 */
export const opener = (text: string, phrases: ReadonlyArray<string>): Check => {
  const start = fold(text).replace(leading, "")
  for (const entry of phrases) {
    const match = new RegExp(`^${escape(fold(entry).trim()).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_])`, "iu").exec(
      start
    )
    if (match !== null) return check("opener", false, `opens with ${quote(match[0])}`)
  }
  return check("opener", true, "no listed opener")
}

const fenceLine = /^ {0,3}```/u

/**
 * Fails on signs of cut-off text: an ellipsis (`…` or `...`) directly after a
 * letter or digit, an ellipsis ending the text, or an unclosed code fence.
 * Ellipses inside code fences and code spans are allowed.
 *
 * @category checks
 * @since 0.1.0
 */
export const truncated = (text: string): Check => {
  const prose: Array<string> = []
  let open = false
  for (const line of text.split("\n")) {
    if (fenceLine.test(line)) open = !open
    else if (!open) prose.push(line)
  }
  const plain = prose.join("\n").replace(/`[^`\n]*`/gu, " ")
  const problems = [...plain.matchAll(/[\p{L}\p{N}_-]{0,20}[\p{L}\p{N}](?:…|\.{3})/gu)].map(([match]) => quote(match))
  const tail = /(?:…|\.{3})\s*$/u.exec(plain)
  if (tail !== null && problems.length === 0) problems.push("trailing ellipsis")
  if (open) problems.push("unclosed code fence")
  return problems.length === 0
    ? check("truncation", true, "complete")
    : check("truncation", false, `found: ${problems.join(", ")}`)
}

/**
 * Extracts Slack `<url|label>` and `<url>`, markdown `[label](url)`, and bare
 * `http(s)://` links in order of appearance.
 *
 * Trailing punctuation is stripped from a bare URL, and a closing parenthesis
 * too unless the URL opened one. Links are deduplicated by URL, keeping the
 * first label found.
 *
 * @category extracting
 * @since 0.1.0
 */
export const links = (text: string): ReadonlyArray<Link> => {
  const byUrl = new Map<string, string | undefined>()
  for (const found of scan(text)) {
    if (byUrl.get(found.url) === undefined) byUrl.set(found.url, found.label)
  }
  return [...byUrl].map(([url, label]) => label === undefined ? { url } : { url, label })
}

const normalize = (url: string): string => {
  let value: string
  try {
    const parsed = new URL(url)
    parsed.hash = ""
    value = parsed.href
  } catch {
    value = url.replace(/#.*$/su, "").toLowerCase()
  }
  return value.endsWith("/") ? value.slice(0, -1) : value
}

/** Whether `found` is `required`, or extends it with a path or query. */
const covers = (required: string, found: string): boolean => {
  const want = normalize(required)
  const have = normalize(found)
  return have === want || (have.startsWith(want) && "/?".includes(have.charAt(want.length)))
}

/**
 * Requires each URL, or one member of each any-of group, among
 * {@link links}. Scheme and host compare case-insensitively, a trailing slash
 * and a `#fragment` are ignored, and a found URL that extends the required one
 * with a path or query also matches.
 *
 * @category checks
 * @since 0.1.0
 */
export const requiredLinks = (text: string, urls: ReadonlyArray<string | ReadonlyArray<string>>): Check => {
  const found = links(text).map((link) => link.url)
  const missing = urls
    .map((entry) => typeof entry === "string" ? [entry] : entry)
    .filter((group) => !group.some((url) => found.some((have) => covers(url, have))))
    .map((group) => group.join(" | "))
  return missing.length === 0
    ? check("links", true, `${found.length} links`)
    : check("links", false, `missing: ${missing.join(", ")}`)
}

/**
 * Requires every reference in the prose to be linked.
 *
 * Each `pattern` match outside link URLs (link labels are prose) must be
 * covered, in the {@link requiredLinks} sense, by a found link to its `url`
 * template with `$1` replaced by the first capture group, or by the whole match
 * when the pattern has none. A template containing `/issues/` also accepts the
 * same URL with `/pull/`, because an issue tracker numbers pull requests and
 * issues together.
 *
 * @category checks
 * @since 0.1.0
 */
export const linkedReferences = (text: string, refs: ReadonlyArray<Reference>): Check => {
  const prose = rewrite(text, labelOf, " ")
  const found = links(text).map((link) => link.url)
  const unlinked = new Set<string>()
  for (const ref of refs) {
    for (const match of prose.matchAll(new RegExp(ref.pattern, "g"))) {
      const url = ref.url.replaceAll("$1", match[1] ?? match[0])
      const accepted = url.includes("/issues/") ? [url, url.replace("/issues/", "/pull/")] : [url]
      if (!accepted.some((want) => found.some((have) => covers(want, have)))) unlinked.add(match[0])
    }
  }
  return unlinked.size === 0
    ? check("linked-references", true, "all linked")
    : check("linked-references", false, `unlinked: ${[...unlinked].join(", ")}`)
}

/**
 * File extensions {@link barePaths} treats as naming a file.
 *
 * @category models
 * @since 0.1.0
 */
export const pathExtensions: ReadonlyArray<string> = [
  "md",
  "json",
  "ts",
  "tsx",
  "js",
  "yaml",
  "yml",
  "txt",
  "log",
  "jsonl"
]

const fileName = new RegExp(`\\.(?:${pathExtensions.join("|")})$`, "iu")

/**
 * Fails on file-system paths outside link syntax: a token containing `/`
 * that ends in one of {@link pathExtensions}, or one starting with `/Users/`,
 * `/home/`, or `~/`. A URL with a scheme is never a path.
 *
 * @category checks
 * @since 0.1.0
 */
export const barePaths = (text: string): Check => {
  const found = new Set<string>()
  for (const raw of rewrite(text, () => " ", " ").split(/\s+/u)) {
    const token = raw.replace(/^[`'"([{<*_]+/u, "").replace(/[`'")\]}>*_.,;:!?]+$/u, "")
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(token)) continue
    const absolute = /^(?:\/Users\/|\/home\/|~\/)/u.test(token)
    if (absolute || (token.includes("/") && fileName.test(token))) found.add(token)
  }
  return found.size === 0
    ? check("bare-paths", true, "none found")
    : check("bare-paths", false, `found: ${[...found].map(quote).join(", ")}`)
}

/**
 * Counts sentences ending in `?`. A `?` inside a URL is not a question.
 *
 * @category measuring
 * @since 0.1.0
 */
export const questions = (text: string): number =>
  [...rewrite(text, labelOf, " link ").matchAll(/\?+(?=[\s"')\]*_]|$)/gu)].length

const matches = (actual: unknown, expected: string | number | boolean): boolean =>
  typeof expected === "string"
    ? typeof actual === "string" && actual.toLowerCase() === expected.toLowerCase()
    : actual === expected

const satisfies = (input: unknown, where: CountSpec["where"]): boolean => {
  if (where === undefined) return true
  if (typeof input !== "object" || input === null) return false
  const fields = input as Readonly<Record<string, unknown>>
  return Object.entries(where).every(([key, expected]) =>
    typeof expected === "object"
      ? expected.some((member) => matches(fields[key], member))
      : matches(fields[key], expected)
  )
}

/**
 * Counts calls to `spec.tool` whose input matches `spec.where` and checks the
 * count against inclusive bounds.
 *
 * `where` compares top-level input fields: strings case-insensitively, other
 * values strictly, and an array value is an any-of group. With neither bound
 * set, `min` defaults to 1. The id defaults to `count:<tool>`.
 *
 * @category checks
 * @since 0.1.0
 */
export const count = (actions: ReadonlyArray<Action>, spec: CountSpec): Check => {
  const id = spec.id ?? `count:${spec.tool}`
  const min = spec.min ?? (spec.max === undefined ? 1 : 0)
  const found = actions.filter((action) => action.tool === spec.tool && satisfies(action.input, spec.where)).length
  const counted = `${found} ${spec.tool} calls`
  if (found < min) return check(id, false, `${counted} < ${min}`)
  if (spec.max !== undefined && found > spec.max) return check(id, false, `${counted} > ${spec.max}`)
  return check(id, true, counted)
}

/**
 * Fails when any marker appears in any sink, matched as {@link excludes}
 * matches. The detail names each sink and marker, never the surrounding text.
 *
 * @category checks
 * @since 0.1.0
 */
export const leakage = (texts: ReadonlyArray<Emission>, markers: ReadonlyArray<string>): Check => {
  const leaked = texts.flatMap(({ sink, text }) =>
    markers.filter((marker) => hits(text, marker).length > 0).map((marker) => `${sink}: ${quote(marker)}`)
  )
  return leaked.length === 0
    ? check("leakage", true, "no markers found")
    : check("leakage", false, `leaked: ${[...new Set(leaked)].join(", ")}`)
}

/**
 * Folds checks into the fraction passing (1 for no checks) and whether all
 * passed.
 *
 * @category combinators
 * @since 0.1.0
 */
export const all = (checks: ReadonlyArray<Check>): Summary => {
  const failed = checks.filter((item) => !item.pass)
  return {
    score: checks.length === 0 ? 1 : (checks.length - failed.length) / checks.length,
    pass: failed.length === 0,
    failed
  }
}

/**
 * Declares a scorer over a list of checks.
 *
 * The score is {@link all}'s fraction passing, `meta` is `{ pass, checks }`,
 * and `reason` counts the passing checks and names each failure. The checks
 * function is not configuration: pass whatever changes it through `config` so
 * the `scorerKey` changes with it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const scorer = (options: ScorerOptions): Scorer.Scorer =>
  Scorer.make({
    id: options.id,
    version: options.version,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.config === undefined ? {} : { config: options.config }),
    score: (input) =>
      Effect.sync(() => {
        const checks = options.checks(input)
        const summary = all(checks)
        const passed = checks.length - summary.failed.length
        return {
          score: summary.score,
          reason: [
            `${passed}/${checks.length} checks passed`,
            ...summary.failed.map((item) => `${item.id}: ${item.detail}`)
          ].join("; "),
          meta: { pass: summary.pass, checks }
        }
      })
  })
