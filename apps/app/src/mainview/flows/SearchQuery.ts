/*
 * The palette's pure half (Search and Command Palette Spec 2026-09-07 §1, §2):
 * the prefix grammar, the fuzzy tiers, the ranking, and which registered
 * flows act on a result. Nothing here touches the DOM, the store, a seam or
 * Effect, so every rule is unit-testable in plain bun. The indexes live in
 * state/seams/SearchSeam.ts and the overlay in SearchPalette.tsx.
 */
import type { SearchAction, SearchItem, SearchItemKind } from "@smthrs/rpc/Cards"
import { assembleArgs, formFieldsFor } from "@smthrs/ui/flow-form"
import { runSearchPayload } from "@smthrs/ui/run-command"
import type { FlowEntry } from "./registry"
import { nameOf, namespaceOf } from "./registry"

/** The palette's modes: one per §1 prefix, plus the bare and path readings of an unprefixed query. */
export type PaletteMode =
  | "all"
  | "path"
  | "line"
  | "flows"
  | "targets"
  | "wiki"
  | "history"
  | "ask"
  | "runs"
  | "changes"
  | "issues"
  | "boxes"
  | "secrets"
  | "help"

/** One row of the `?` listing: the prefix, what it searches, the flow behind it, and whether it needs a session. */
export interface PrefixRow {
  /** What the first token starts with; empty for the two unprefixed readings. */
  readonly prefix: string
  /** What `?` prints for the row. */
  readonly label: string
  readonly mode: PaletteMode
  readonly searches: string
  /** The registered `search.*` flow the mode runs; null for a mode with none (`:`, `?`, the proposed `ask:`). */
  readonly flow: string | null
  /** Hidden signed out; `?` lists it as "sign in" (§4). */
  readonly signedIn: boolean
}

/** The §1 prefix table, in its order. */
export const PREFIXES: ReadonlyArray<PrefixRow> = [
  { prefix: "", label: "(none)", mode: "all", searches: "Everything by name, grouped", flow: "search.open", signedIn: false },
  { prefix: "", label: "path", mode: "path", searches: "Files by path, fuzzy per segment", flow: "search.files", signedIn: false },
  { prefix: ":", label: ":", mode: "line", searches: "Line :120 or :120:8 in the focused file card", flow: null, signedIn: false },
  { prefix: "/", label: "/", mode: "flows", searches: "Flows: the slash tree", flow: "search.flows", signedIn: false },
  { prefix: "//", label: "//", mode: "targets", searches: "Targets, //apps/app:test", flow: "search.targets", signedIn: false },
  { prefix: "wiki:", label: "wiki:", mode: "wiki", searches: "Generated wiki pages; signed in, your notes join the list", flow: "search.wiki", signedIn: false },
  { prefix: "history:", label: "history:", mode: "history", searches: "Mythical commits, epics, note sections tried, evidence, folded, superseded", flow: "search.history", signedIn: false },
  { prefix: "ask:", label: "ask:", mode: "ask", searches: "The Librarian: one sentence with citation doors (proposed)", flow: null, signedIn: false },
  { prefix: "run:", label: "run:", mode: "runs", searches: "Runs by id, flow, status, step", flow: "search.runs", signedIn: false },
  { prefix: "change:", label: "change:", mode: "changes", searches: "Changes by id, title, file", flow: "search.changes", signedIn: false },
  { prefix: "#", label: "#", mode: "issues", searches: "Issues, #412 or #label:bug", flow: "search.issues", signedIn: false },
  { prefix: "box:", label: "box:", mode: "boxes", searches: "Boxes by branch, owner, state", flow: "search.boxes", signedIn: true },
  { prefix: "secret:", label: "secret:", mode: "secrets", searches: "Secret names and grants; values never index", flow: "search.secrets", signedIn: true },
  { prefix: "?", label: "?", mode: "help", searches: "The prefix list", flow: null, signedIn: false }
]

/** The prefix row for a mode. */
export const prefixRow = (mode: PaletteMode): PrefixRow => PREFIXES.find((row) => row.mode === mode) ?? PREFIXES[0]!

/** The `word:` prefixes, by word. */
const WORD_PREFIXES: ReadonlyMap<string, PaletteMode> = new Map(
  PREFIXES.filter((row) => /^[a-z]+:$/.test(row.prefix)).map((row) => [row.prefix.slice(0, -1), row.mode])
)

/** The qualifiers GitHub's syntax and §1 name; any other `word:` inside a query is text. */
const QUALIFIER_KEYS: ReadonlySet<string> = new Set([
  "path",
  "lang",
  "label",
  "is",
  "kind",
  "status",
  "state",
  "section",
  "repo",
  "symbol",
  "file"
])

export interface Qualifier {
  readonly key: string
  readonly value: string
  readonly negated: boolean
}

/** A composer draft read as a palette query (§1). */
export interface ParsedQuery {
  readonly mode: PaletteMode
  /** The prefix as typed (`wiki:`, `#`); empty in the bare and path readings. */
  readonly prefix: string
  /** The query with the prefix and the qualifiers removed. */
  readonly query: string
  /** `:120` or `:120:8`. */
  readonly line?: { readonly line: number; readonly column?: number }
  readonly qualifiers: ReadonlyArray<Qualifier>
}

const QUALIFIER = /^(-?)([a-z]+):(\S+)$/

/** Splits the qualifiers out of a query; the rest is the query text in its original order. */
const splitQualifiers = (rest: string): { readonly query: string; readonly qualifiers: ReadonlyArray<Qualifier> } => {
  const qualifiers: Array<Qualifier> = []
  const words: Array<string> = []
  for (const token of rest.trim().split(/\s+/).filter((word) => word !== "")) {
    const match = QUALIFIER.exec(token)
    if (match !== null && QUALIFIER_KEYS.has(match[2] ?? "")) {
      qualifiers.push({ key: match[2] ?? "", value: match[3] ?? "", negated: match[1] === "-" })
    } else {
      words.push(token)
    }
  }
  return { query: words.join(" "), qualifiers }
}

/**
 * The first token decides the mode (§3: "Mode switches when the prefix is
 * the first token"). `//` beats `/`, a lone `?` is the
 * prefix list, `:N` is a line, a known `word:` is its mode, `#` is issues,
 * and a single unprefixed token is a path when it carries a `/` or a `.`.
 */
export const parseQuery = (text: string): ParsedQuery => {
  const raw = text.trimStart()
  if (raw.trim() === "?") return { mode: "help", prefix: "?", query: "", qualifiers: [] }
  if (raw.startsWith("//")) return { mode: "targets", prefix: "//", ...splitQualifiers(raw.slice(2)) }
  if (raw.startsWith("/")) return { mode: "flows", prefix: "/", query: raw.slice(1).trim(), qualifiers: [] }
  const line = /^:(\d+)(?::(\d+))?\s*$/.exec(raw)
  if (line !== null) {
    const column = line[2] === undefined ? undefined : Number(line[2])
    return {
      mode: "line",
      prefix: ":",
      query: raw.slice(1).trim(),
      line: { line: Number(line[1]), ...(column === undefined ? {} : { column }) },
      qualifiers: []
    }
  }
  const word = /^([a-z]+):/.exec(raw)
  const mode = word === null ? undefined : WORD_PREFIXES.get(word[1] ?? "")
  if (word !== null && mode !== undefined) {
    const split = splitQualifiers(raw.slice(word[0].length))
    return { mode, prefix: word[0], ...split }
  }
  if (raw.startsWith("#")) return { mode: "issues", prefix: "#", ...splitQualifiers(raw.slice(1)) }
  const split = splitQualifiers(raw)
  return { mode: /[/.]/.test(split.query) && !/\s/.test(split.query) ? "path" : "all", prefix: "", ...split }
}

/*
 * ── Fuzzy tiers (§2 rule 5) ──────────────────────────────────────────────
 * Name exact > prefix > contains > abbreviation > summary > subsequence, the
 * rank registry.ts already enforces for flows extended with CamelHump and
 * snake_case abbreviations for files and symbols. Zero is no match.
 */
export const TIER = { exact: 6, prefix: 5, contains: 4, abbreviation: 3, summary: 2, subsequence: 1, none: 0 } as const

/** The first character of every word: camel humps and `/ . _ - space` boundaries start words. */
export const heads = (title: string): string =>
  title
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[/._\-\s]+/)
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toLowerCase())
    .join("")

const subsequence = (haystack: string, needle: string): boolean => {
  let at = 0
  for (const char of needle) {
    at = haystack.indexOf(char, at)
    if (at === -1) return false
    at += 1
  }
  return true
}

/** `mainview/Comp` matches `apps/app/src/mainview/Composer.tsx` segment by segment, in order. */
const segmentsContain = (path: string, query: string): boolean => {
  const wanted = query.split("/").filter((segment) => segment !== "")
  const have = path.split("/")
  let from = 0
  for (const segment of wanted) {
    const at = have.findIndex((candidate, index) => index >= from && candidate.includes(segment))
    if (at === -1) return false
    from = at + 1
  }
  return wanted.length > 0
}

/**
 * How directly a title (and its subtitle) answers a query; an empty query
 * matches everything at the lowest tier. A path's NAME is its last segment
 * (`Redaction.ts` answers "redact" as a prefix, as the mock ranks it); the
 * whole path still matches by containment and per segment.
 */
export const matchTier = (title: string, query: string, subtitle?: string): number => {
  const needle = query.trim().toLowerCase()
  if (needle === "") return TIER.subsequence
  const name = title.toLowerCase()
  const base = name.slice(name.lastIndexOf("/") + 1)
  if (name === needle || base === needle) return TIER.exact
  if (name.startsWith(needle) || base.startsWith(needle)) return TIER.prefix
  if (name.includes(needle)) return TIER.contains
  if (needle.includes("/") && segmentsContain(name, needle)) return TIER.contains
  if (heads(title).includes(needle.replace(/[\s/._-]/g, ""))) return TIER.abbreviation
  if (subtitle !== undefined && subtitle.toLowerCase().includes(needle)) return TIER.summary
  if (subsequence(name, needle.replace(/\s+/g, ""))) return TIER.subsequence
  return TIER.none
}

/*
 * ── Ranking (§2) ─────────────────────────────────────────────────────────
 * Score = tier × kind weight + boosts. The recommender pills lead, then
 * frecency (seven days, linear decay), then the fuzzy tier. Groups order by
 * their best score; the tie order below is the mock's.
 */
export const KIND_ORDER: ReadonlyArray<SearchItemKind> = [
  "flow",
  "file",
  "target",
  "wiki",
  "note",
  "history",
  "run",
  "change",
  "issue",
  "box",
  "secret-name",
  "person"
]

export const GROUP_LABELS: Readonly<Record<SearchItemKind, string>> = {
  flow: "Flows",
  file: "Files",
  target: "Targets",
  wiki: "Wiki",
  note: "Notes",
  history: "History",
  run: "Runs",
  change: "Changes",
  issue: "Issues",
  box: "Boxes",
  "secret-name": "Secrets",
  person: "People"
}

/** One entry of the recents ledger (§5 "Recents and frecency"). */
export interface RecentItem {
  readonly ref: string
  readonly kind: string
  readonly count: number
  readonly lastSeen: number
}

export const RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** The frecency weight of one recent item: 0 outside the window, up to 1 for something opened often just now. */
export const frecency = (recent: RecentItem, now: number): number => {
  const age = now - recent.lastSeen
  if (age < 0 || age > RECENCY_WINDOW_MS) return 0
  const decay = 1 - age / RECENCY_WINDOW_MS
  return decay * Math.min(recent.count, 5) / 5
}

export interface RankContext {
  readonly recents: ReadonlyArray<RecentItem>
  readonly now: number
  /** The recommender's pill refs (flow names), in their order. */
  readonly recommended: ReadonlyArray<string>
}

/**
 * What ranking reads of an item: everything but its actions. The seams rank
 * on facts and derive actions only for the rows that are shown, so the
 * composer hot path never walks the registry for a row nobody sees.
 */
export type SearchFact = Omit<SearchItem, "actions">

export interface RankedItem<T extends SearchFact = SearchItem> {
  readonly item: T
  readonly score: number
  readonly recommended: boolean
  readonly recent: boolean
}

export interface ResultGroup<T extends SearchFact = SearchItem> {
  readonly label: string
  readonly items: ReadonlyArray<RankedItem<T>>
}

const RECOMMENDED_BOOST = 100
const RECENT_BOOST = 10

const recentKey = (kind: string, ref: string): string => `${kind}:${ref}`

/**
 * The ranked groups. Items that do not match drop; the recommended pills lead
 * in pill order; recents come next by frecency (only on an empty query, where
 * §2 says they lead); the rest group by kind, each group ordered by score and
 * the groups by their best item.
 */
export const rankItems = <T extends SearchFact>(items: ReadonlyArray<T>, query: string, ctx: RankContext): ReadonlyArray<ResultGroup<T>> => {
  const recentsByKey = new Map(ctx.recents.map((recent) => [recentKey(recent.kind, recent.ref), recent]))
  const recommendedRank = new Map(ctx.recommended.map((ref, index) => [ref, index]))
  const empty = query.trim() === ""
  const ranked: Array<RankedItem<T>> = []
  for (const item of items) {
    const tier = matchTier(item.title, query, item.subtitle)
    if (tier === TIER.none) continue
    const recent = recentsByKey.get(recentKey(item.kind, item.ref))
    const recency = recent === undefined ? 0 : frecency(recent, ctx.now)
    const recommended = item.kind === "flow" && recommendedRank.has(item.ref)
    ranked.push({
      item,
      score: tier + recency * RECENT_BOOST + (recommended ? RECOMMENDED_BOOST - (recommendedRank.get(item.ref) ?? 0) : 0),
      recommended,
      recent: recency > 0
    })
  }
  const groups: Array<ResultGroup<T>> = []
  const pills = ranked.filter((row) => row.recommended).sort((left, right) => right.score - left.score)
  if (pills.length > 0) groups.push({ label: "Recommended", items: pills })
  const taken = new Set(pills.map((row) => recentKey(row.item.kind, row.item.ref)))
  if (empty) {
    const recents = ranked
      .filter((row) => row.recent && !taken.has(recentKey(row.item.kind, row.item.ref)))
      .sort((left, right) => right.score - left.score)
    if (recents.length > 0) groups.push({ label: "Recent", items: recents })
    for (const row of recents) taken.add(recentKey(row.item.kind, row.item.ref))
  }
  const byKind = new Map<SearchItemKind, Array<RankedItem<T>>>()
  for (const row of ranked) {
    if (taken.has(recentKey(row.item.kind, row.item.ref))) continue
    const bucket = byKind.get(row.item.kind) ?? []
    bucket.push(row)
    byKind.set(row.item.kind, bucket)
  }
  const kinds = [...byKind.entries()]
    .map(([kind, rows]) => ({ kind, rows: rows.sort((left, right) => right.score - left.score), best: rows[0]?.score ?? 0 }))
    .sort((left, right) => right.best - left.best || KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind))
  for (const { kind, rows } of kinds) groups.push({ label: GROUP_LABELS[kind], items: rows })
  return groups
}

/*
 * ── Actions (§2 "every item has actions; every action is a flow") ────────
 * Enter runs the open flow, Cmd+Enter the primary flow, and the actions
 * panel lists the registered flows whose input the item's ref fills: every
 * required field of the flow is one the ref supplies, and the flow lives in
 * a namespace that is about the item's kind (so `prs.view <number>` does not
 * pose as an issue action). The three-door law holds by construction: the
 * panel names only registered flows, run through the one registry.
 */
export const OPEN_FLOWS: Readonly<Record<SearchItemKind, ReadonlyArray<string>>> = {
  file: ["files.read"],
  flow: [],
  target: [],
  wiki: ["wiki.open", "wiki.select"],
  note: ["wiki.select"],
  history: ["history.show"],
  run: ["runs.open"],
  change: ["change.view"],
  issue: ["issues.view"],
  box: ["box.view"],
  "secret-name": ["secrets.list"],
  person: []
}

export const PRIMARY_FLOWS: Readonly<Record<SearchItemKind, ReadonlyArray<string>>> = {
  file: ["implement"],
  flow: [],
  target: [],
  wiki: [],
  note: [],
  history: [],
  run: ["runs.resume"],
  change: ["review"],
  issue: ["implement"],
  box: ["box.terminal"],
  "secret-name": [],
  person: []
}

/** The input fields an item's ref can fill, by kind; a kind with none offers only its open flow. */
const REF_FIELDS: Readonly<Record<SearchItemKind, ReadonlyArray<string>>> = {
  file: ["path"],
  flow: [],
  target: ["repoId", "label", "workspace"],
  wiki: ["documentId", "path"],
  note: ["documentId"],
  history: ["sha"],
  run: ["runId"],
  change: ["changeId"],
  issue: ["number"],
  box: ["workspaceId"],
  "secret-name": [],
  person: []
}

/** The namespaces whose flows are about a kind. */
const KIND_NAMESPACES: Readonly<Record<SearchItemKind, ReadonlyArray<string>>> = {
  file: ["files", "code", "box", "tab"],
  flow: [],
  target: ["target"],
  wiki: ["wiki", "world"],
  note: ["wiki", "world"],
  history: ["history"],
  run: ["runs"],
  change: ["change", "review"],
  issue: ["issues"],
  box: ["box"],
  "secret-name": ["secrets"],
  person: []
}

/** The ref as the payload fields it fills. `target` refs are `<repoId> <label>`. */
export const refPayload = (kind: SearchItemKind, ref: string): Readonly<Record<string, unknown>> => {
  switch (kind) {
    case "file":
      return { path: ref }
    case "target": {
      const at = ref.indexOf(" ")
      return at === -1 ? { label: ref } : { repoId: ref.slice(0, at), label: ref.slice(at + 1) }
    }
    case "wiki":
      return { documentId: ref, path: ref }
    case "note":
      return { documentId: ref }
    case "history":
      return { sha: ref }
    case "run":
      return runSearchPayload(ref)
    case "change":
      return { changeId: ref }
    case "issue":
      return { number: Number(ref) }
    case "box":
      return { workspaceId: ref }
    case "flow":
    case "secret-name":
    case "person":
      return {}
  }
}

const roleOf = (kind: SearchItemKind, name: string): SearchAction["role"] =>
  OPEN_FLOWS[kind].includes(name) ? "open" : PRIMARY_FLOWS[kind].includes(name) ? "primary" : "other"

/**
 * Every registered flow that acts on the item, the open flow first. A kind's
 * open and primary flows are named by preference (`box.open`, else
 * `box.view`): the first one registered wins the role, so a hidden
 * alias never doubles a row. A flow whose required input the ref cannot fill
 * is absent, never listed with a form (a button always carries its args).
 */
export const actionsFor = (item: Pick<SearchItem, "kind" | "ref" | "title">, entries: ReadonlyArray<FlowEntry>): ReadonlyArray<SearchAction> => {
  if (item.kind === "flow") {
    const entry = entries.find((candidate) => nameOf(candidate) === item.ref)
    return entry === undefined ? [] : [{ flow: item.ref, label: entry.metadata.summary, role: "open" }]
  }
  const payload = refPayload(item.kind, item.ref)
  const fields = new Set(REF_FIELDS[item.kind])
  const namespaces = KIND_NAMESPACES[item.kind]
  const actions: Array<SearchAction> = []
  const roles = { open: false, primary: false }
  const consider = (entry: FlowEntry, preferred: boolean): void => {
    const name = nameOf(entry)
    const form = formFieldsFor(entry.input, entry.metadata.form)
    if (!form.every((field) => !field.required || fields.has(field.name))) return
    // A namespace flow joins only when the ref fills one of its fields; a kind's own open flow may take nothing (secrets.list).
    if (!preferred && !form.some((field) => fields.has(field.name))) return
    let role = roleOf(item.kind, name)
    if (role !== "other") {
      if (roles[role]) role = "other"
      else roles[role] = true
    }
    const args = assembleArgs(form, entry.metadata.form, payload)
    actions.push({ flow: name, ...(args === "" ? {} : { args }), label: entry.metadata.summary, role })
  }
  // Preference order first, so the first registered open/primary flow takes the role.
  const preferred = [...OPEN_FLOWS[item.kind], ...PRIMARY_FLOWS[item.kind]]
  for (const name of preferred) {
    const entry = entries.find((candidate) => nameOf(candidate) === name)
    if (entry !== undefined) consider(entry, true)
  }
  for (const entry of entries) {
    const name = nameOf(entry)
    if (preferred.includes(name)) continue
    const namespace = namespaceOf(name)
    if (namespace === undefined || !namespaces.includes(namespace)) continue
    consider(entry, false)
  }
  return actions.sort((left, right) => rolePosition(left.role) - rolePosition(right.role))
}

const rolePosition = (role: SearchAction["role"]): number => (role === "open" ? 0 : role === "primary" ? 1 : 2)

/** The action a key runs: Enter opens, Cmd+Enter runs the primary flow; undefined when the item has none. */
export const actionForKey = (item: SearchItem, role: "open" | "primary"): SearchAction | undefined =>
  item.actions.find((action) => action.role === role)

/** The model's copy of a search answer: the items as data, never a rendered list (§6 agent door). */
export const itemsValue = (flow: string, query: string, items: ReadonlyArray<SearchItem>): string =>
  JSON.stringify({ flow, query, count: items.length, items })
