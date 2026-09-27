/**
 * The stable author-call prefix, assembled as a pure value.
 *
 * Sections are MDX sources (`prompts/*.mdx`) compiled into the generated
 * `internal/prompts.ts` this module imports and composes — no runtime
 * filesystem read, browser-safe, and a sync test fails the gate when the
 * sources and the generated module drift. Assembly is byte-stable — same
 * inputs, identical string — so the provider prompt-prefix cache hits
 * across turns. Design authority: https://chain.smithers.sh/contract/.
 *
 * The catalog block renders what the chain actually dispatches: names
 * dedupe last-wins exactly like `Catalog.make`'s lookup, an entry named
 * `author` is filtered (the trampoline intercepts that name before the
 * catalog), names are advertised byte-identically or omitted, and
 * descriptions are bounded JSON strings labelled as untrusted repository
 * data under the fixed contract rule. `forCatalog` assembles from a mounted
 * catalog service, keeping the advertised block and the dispatched entries
 * the same by construction.
 *
 * @since 0.1.0
 */

import * as AuthorDeclaration from "./AuthorDeclaration.ts"
import type * as Catalog from "./Catalog.ts"
import * as sections from "./internal/prompts.ts"

/**
 * Which agent the prefix addresses: the concierge (closest to the user)
 * or a sub-agent.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Role = "concierge" | "sub"

/**
 * The BASE section: what the agent is and what a chain, link, script and
 * call are. It names no host feature: the catalog block is the whole world.
 *
 * @category sections
 * @since 0.1.0
 * @slop
 */
export const base = sections.base

/**
 * The CONCIERGE section, added only for the concierge role.
 *
 * @category sections
 * @since 0.1.0
 * @slop
 */
export const concierge = sections.concierge

/**
 * The RULES section.
 *
 * @category sections
 * @since 0.1.0
 * @slop
 */
export const rules = sections.rules

/**
 * The authoring contract: what one turn's reply must contain.
 *
 * @category sections
 * @since 0.1.0
 * @slop
 */
export const contract = sections.contract

/**
 * The longest entry name the catalog block will advertise. An entry above
 * this bound is omitted rather than shortened, because advertised names must
 * stay byte-identical to what `Catalog.lookup` dispatches.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maxEntryName = 64

/** What every catalog line opens with, before the entry's name. */
const bullet = "- "

/**
 * What divides an entry's name from its description. It is the only
 * structure a catalog line has, so it is also what a reader splits on.
 */
const separator = " — "

/** One catalog line, and the only place its shape is written down. */
const line = (name: string, description: string): string => `${bullet}${name}${separator}${description}`

/**
 * Whether a name can be advertised verbatim on one bounded line.
 *
 * A name is rendered byte-identically or not at all, so the only names the
 * block can carry are the ones that already are one bounded line: no
 * whitespace to forge a section break, no backtick to open a span, and
 * within {@link maxEntryName}. Everything else is a name the model could
 * read but `Catalog.lookup` would refuse.
 *
 * The last clause is the round trip itself rather than a rule derived from
 * it: a reader recovers a call name by splitting a line at its FIRST
 * separator, so the name is renderable only when that first separator is the
 * real one. Deriving it from {@link line} keeps the predicate and the
 * renderer from drifting. The bullet contributes a space of its own, which
 * is what makes an entry named `—` — and only that one — render as
 * `- — — description`, whose first ` — ` sits before the name: a reader
 * splitting there recovers the empty string and calls something the catalog
 * does not carry. A name that merely CONTAINS an em dash, like `flows—build`,
 * still round-trips and is still advertised.
 *
 * @category assembly
 * @since 0.1.0
 * @slop
 */
export const renderableName = (name: string): boolean =>
  name.length > 0 && name.length <= maxEntryName && !/[\s`]/.test(name) &&
  line(name, "").indexOf(separator) === bullet.length + name.length

/**
 * The longest entry description before JSON encoding and provenance labelling.
 *
 * Registry-discovered entries carry descriptions written in repository
 * files rather than by the harness, so one entry must not be able to claim
 * an unbounded share of the context window.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maxEntryDescription = 200

/**
 * Encodes one entry description as a bounded, untrusted data field.
 *
 * Registry descriptions originate in repository files. Collapse whitespace,
 * remove backticks, and mark truncation to retain the single-line context
 * bound. Then JSON-quote the value so quotes, backslashes, and control
 * characters cannot close its data delimiter. Encoding happens after
 * truncation so the closing quote and escape sequences always stay intact.
 * The fixed contract preceding the catalog tells the model to disregard
 * instructions in these provenance-labelled fields.
 *
 * Names are treated differently: advertise-what-you-dispatch requires the
 * model to read the exact string `Catalog.lookup` accepts. An unrenderable
 * name is dropped because not advertising a dispatchable call is safe, while
 * advertising a rewritten call that gate 3 then refuses is not.
 */
const untrustedDescription = (description: string, limit: number): string => {
  const flat = description.replaceAll(/\s+/g, " ").replaceAll("`", "").trim()
  const bounded = flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`
  return `untrusted repository description: ${JSON.stringify(bounded)}`
}

/**
 * Renders the catalog as a byte-stable block: the author entry pinned
 * first, then every dispatchable entry sorted by name — deduped
 * last-wins to mirror `Catalog.make`, the reserved author name filtered,
 * with names advertised verbatim or omitted and descriptions encoded as
 * bounded, untrusted repository data.
 *
 * @category assembly
 * @since 0.1.0
 * @slop
 */
export const catalogBlock = (entries: ReadonlyArray<Catalog.Entry>): string => {
  const dispatchable = new Map<string, Catalog.Entry>()
  for (const entry of entries) {
    if (!renderableName(entry.name)) continue
    if (entry.name === AuthorDeclaration.authorName) continue
    dispatchable.set(entry.name, entry)
  }
  // Names are unique after the dedupe, so the comparator never sees equals.
  const lines = [...dispatchable.values()]
    .sort((left, right) => left.name < right.name ? -1 : 1)
    .map((entry) => line(entry.name, untrustedDescription(entry.description, maxEntryDescription)))
  return [
    "# Catalog",
    "",
    "The calls available to `ctx.call`:",
    "",
    line(AuthorDeclaration.authorName, AuthorDeclaration.authorDescription),
    ...lines
  ].join("\n")
}

/**
 * What assembly needs: the role the prefix addresses, the entries the
 * catalog block advertises, and an optional HOST section.
 *
 * The package sections promise only what this package dispatches: a
 * links, journaled calls, and the catalog. A host that mounts
 * more (a worldview store, background lineages, monitors, widgets) owns the
 * prose that teaches them and passes it as `host`, so the promise and the
 * entry that keeps it arrive from the same place. An empty or absent host
 * section adds nothing. The host must describe only capabilities its
 * catalog entries implement; assembly does not validate host prose.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface AssembleOptions {
  readonly role: Role
  readonly entries: ReadonlyArray<Catalog.Entry>
  readonly host?: string | undefined
}

/**
 * Assembles the full prefix in fixed order: BASE, CONCIERGE (concierge
 * role only), HOST (only when the host supplies one), RULES, the authoring
 * contract, the catalog block.
 *
 * @category assembly
 * @since 0.1.0
 * @slop
 */
export const assemble = (options: AssembleOptions): string =>
  [
    base,
    ...(options.role === "concierge" ? [concierge] : []),
    ...(options.host === undefined || options.host === "" ? [] : [options.host]),
    rules,
    contract,
    catalogBlock(options.entries)
  ].join("\n\n")

/**
 * Assembles the prefix from a mounted catalog service — the composition
 * that cannot diverge from what the chain dispatches.
 *
 * @category assembly
 * @since 0.1.0
 * @slop
 */
export const forCatalog = (catalog: Catalog.Service, role: Role, host?: string): string =>
  assemble({ entries: catalog.entries, host, role })
