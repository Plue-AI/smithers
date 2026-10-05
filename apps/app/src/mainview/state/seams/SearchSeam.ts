/*
 * The search seam (Search and Command Palette Spec 2026-09-07 §5, §6): the
 * indexes the browser holds, ranked by flows/SearchQuery.ts, answered two
 * ways. `palette` is the button door: synchronous rows for the overlay, read
 * from what the store already holds (§5: "the browser holds caches and
 * recents"), so every row is a fact a seam has already established. `search`
 * is the slash and agent door of every `search.*` flow: it reads the same
 * indexes, takes secrets and history from the reader's own answer, embeds ONE
 * `search-results` card for a human and answers the items as data for the
 * model. A search never dispatches another card: the secrets and history
 * cards belong to their own seams' flows (§6).
 *
 * The indexes are FACTS (kind, ref, title, subtitle); ranking reads facts,
 * and an item's actions are derived from the registry only for the rows the
 * overlay shows or the flow answers, because `palette` runs on every
 * keystroke while the overlay is open.
 *
 * The proposed Librarian ask mode refuses in place; it has no registered flow.
 */
import type { SearchAction, SearchItem } from "@smthrs/rpc/Cards"
import type { MythicalStack } from "@smthrs/rpc/Mythical"
import type { SearchArgs } from "../../flows/entries/search"
import { actionsFor, itemsValue, parseQuery, prefixRow, PREFIXES, rankItems } from "../../flows/SearchQuery"
import type { PaletteMode, ParsedQuery, PrefixRow, ResultGroup, SearchFact } from "../../flows/SearchQuery"
import type { CommandState, FlowEntry } from "../../flows/registry"
import type { CommandRegistry } from "../../flows/Commands"
import { recommendedNames, unmetRequirements } from "../../flows/registry"
import type { Card, WorkingCopy } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { runScopeFromCard } from "../RunReference"
import { runSearchRef } from "@smthrs/ui/run-command"
import { fileArgs } from "@smthrs/rpc/FileRead"
import { readRepositorySecrets } from "./RepositorySecrets"
import type { RepositorySecret } from "./RepositorySecrets"
import { captureCloudOwner, type SeamContext } from "./SeamContext"
import { SIGN_OUT_REFUSAL } from "./CloudSignIn"

/** The registry the seam reads: the flows it can act with and the state the scope rules read. */
export interface SearchRegistry {
  readonly entries: () => ReadonlyArray<FlowEntry>
  readonly state: () => CommandState
  readonly explainAbsent: CommandRegistry["explainAbsent"]
}

export interface SearchSeamDeps {
  readonly registry: () => SearchRegistry
  /** The history (stack) seam: the watched snapshot, else one read; `heldStack` is the watched one only. */
  readonly readStack?: (repo?: string) => Promise<MythicalStack | string>
  readonly heldStack?: (repo: string) => MythicalStack | undefined
  readonly now?: () => number
}

/** The overlay's answer for one draft. */
export interface PaletteAnswer {
  readonly parsed: ParsedQuery
  readonly groups: ReadonlyArray<ResultGroup>
  /** The mode's honest refusal when its index does not exist yet; shown in place, never as rows. */
  readonly refusal?: string
  /** `?`: every prefix, with whether this session may use it. */
  readonly help?: ReadonlyArray<PrefixRow & { readonly available: boolean }>
  /** The flow Enter runs with the query when no row is highlighted; null for a mode with none. */
  readonly flow: string | null
}

export interface SearchSeam {
  readonly palette: (text: string) => PaletteAnswer
  readonly search: (flow: string, mode: PaletteMode, args: SearchArgs) => Promise<string | void | { readonly value: string }>
}

/** Rows per group in the overlay: past this, typing more is the answer, as the slash menu's cap says. */
export const PALETTE_GROUP_CAP = 8
/** Items a flow answers when the call names no limit. */
export const SEARCH_DEFAULT_LIMIT = 50

export const ASK_PROPOSED = "ask: is proposed with the Librarian and not built; wiki: and history: search the same indexes."
export const NO_FOCUSED_FILE = "No file card is open to jump into; read one with files.read first."

const joinPath = (directory: string, name: string): string => (directory === "" ? name : `${directory}/${name}`)

const firstLine = (text: string): string => text.split("\n")[0]?.trim() ?? ""

/** Signed out, a mode §4 hides answers nothing at all: no rows, no badge, and Enter still runs the flow, which defers through sign-in. */
const HIDDEN_SIGNED_OUT: ReadonlySet<PaletteMode> = new Set(["secrets"])

/** The flow behind a mode, when the registry has it. */
const flowOf = (mode: PaletteMode): string | null => prefixRow(mode).flow

/**
 * One indexed row before its actions exist. `actions` is set only where the
 * row's flow is known without the registry walk, including file reads that
 * retain their repository or working-copy target.
 */
type Fact = SearchFact & {
  readonly actions?: ReadonlyArray<SearchAction>
}

/** The flows a search names must be registered on this host; the rest of an item's actions come from the registry too. */
const withActions = (entries: ReadonlyArray<FlowEntry>, fact: Fact): SearchItem => {
  const item: SearchFact = { kind: fact.kind, ref: fact.ref, title: fact.title, ...(fact.subtitle === undefined ? {} : { subtitle: fact.subtitle }) }
  if (fact.actions !== undefined) return { ...item, actions: [...fact.actions] }
  return { ...item, actions: [...actionsFor(item, entries)] }
}

/** The secrets of one repository as the repository's secrets list names them: names and hosts, never a value. */
interface SecretRows {
  readonly repo: string
  readonly secrets: ReadonlyArray<Pick<RepositorySecret, "name" | "hosts">>
}

/** The live reads a flow door takes from the readers' answers instead of the cards (§6: a search embeds one card). */
interface LiveIndexes {
  readonly history?: ReadonlyArray<MythicalStack>
  readonly secrets?: ReadonlyArray<SecretRows>
}

export const createSearchSeam = (ctx: SeamContext, deps: SearchSeamDeps): SearchSeam => {
  const now = deps.now ?? (() => Date.now())
  // Each human search replaces one card. Agent answers do not claim that card.
  const latest = new Map<string, symbol>()
  const cards = (): ReadonlyArray<Card> => [...ctx.store.collections.cards.values()].sort((left, right) => left.ordinal - right.ordinal)

  /* ---- the indexes, each from a seam's own rows ---- */

  /** The slash tree as data: every listed flow this session may run (signed out, only what works signed out, as the slash menu offers). */
  const flowItems = (): ReadonlyArray<Fact> => {
    const { entries, state } = deps.registry()
    const snapshot = state()
    return entries()
      .filter((entry) => entry.metadata.hidden !== true)
      .filter((entry) => !snapshot.signedOut || unmetRequirements(entry.metadata, snapshot).length === 0)
      .map((entry) => ({
        kind: "flow" as const,
        ref: entry.binding.descriptor.name,
        title: entry.binding.descriptor.name,
        subtitle: entry.metadata.summary,
        actions: [{ flow: entry.binding.descriptor.name, label: entry.metadata.summary, role: "open" as const }]
      }))
  }

  /** Files the app has listed: the sidebar's loaded directories and the file and listing cards. Box files open in the box. */
  const fileItems = (): ReadonlyArray<Fact> => {
    const read = (flow: "files.read" | "box.file", path: string, target: string): SearchAction => ({
      flow, args: fileArgs(path, target), role: "open",
      label: flow === "files.read" ? "Read a file from a repository" : "Read one file out of a cloud workspace"
    })
    const seen = new Map<string, Fact>()
    const add = (kind: "shared" | "workspace", target: string, path: string, subtitle: string): void => {
      const relative = path.replace(/^\/+/, "")
      const ref = kind === "shared" ? `/${target}/${relative}` : `${kind}:${encodeURIComponent(target)}/${relative}`
      if (seen.has(ref)) return
      // Identity and execution retain the observed repository or explicit working copy.
      seen.set(ref, { kind: "file", ref, title: relative, subtitle,
        actions: [read(kind === "workspace" ? "box.file" : "files.read", relative, target)] })
    }
    const copies = ctx.store.collections.workingCopies
    for (const row of ctx.store.collections.repoTree.values()) {
      if (row.state !== "loaded") continue
      const copy: WorkingCopy | undefined = copies.get(row.copyId)
      if (copy === undefined) continue
      for (const entry of row.entries) {
        if (entry.kind !== "file") continue
        const path = joinPath(row.path, entry.name)
        if (copy.kind === "workspace") add("workspace", copy.workspaceId ?? copy.id, path, `${copy.repoId} · ${copy.label}`)
        else add("shared", copy.repoId, path, copy.repoId)
      }
    }
    for (const card of cards()) {
      if (card.kind !== "file" && card.kind !== "file-list") continue
      const { localRepoId, repo, path } = card.payload
      if (localRepoId !== undefined) continue
      const kind = "shared"
      const target = repo
      if (card.kind === "file") add(kind, target, path, repo)
      else for (const entry of card.payload.entries) {
        if (entry.kind === "file") add(kind, target, joinPath(path.replace(/^\/+/, ""), entry.name), repo)
      }
    }
    return [...seen.values()]
  }

  /** The Wiki pane's documents: the person's notes (generated pages exist on no catalog repository yet). */
  const wikiItems = (): ReadonlyArray<Fact> =>
    [...ctx.store.collections.worldDocuments.values()].map((document) => ({ kind: "note" as const, ref: document.id, title: document.title, subtitle: document.path }))

  /** The histories the History cards show: each card's live snapshot. */
  const heldHistory = (): ReadonlyArray<MythicalStack> =>
    cards().flatMap((card) => {
      const stack = card.kind === "stack" ? deps.heldStack?.(card.payload.repo) : undefined
      return stack === undefined ? [] : [stack]
    })

  /** The secrets cards the secrets seam has written, as name-and-host rows. */
  const heldSecrets = (): ReadonlyArray<SecretRows> =>
    cards().flatMap((card) => (card.kind === "secrets" ? [{ repo: card.payload.repo, secrets: card.payload.secrets }] : []))

  /** The history's changes, tip first: each one's title, its issue and whether main contains it. */
  const historyItems = (stacks: ReadonlyArray<MythicalStack>): ReadonlyArray<Fact> =>
    stacks.flatMap((stack) => stack.changes.map((change) => ({
      kind: "history" as const,
      ref: `${stack.repository}#${change.changeId}`,
      title: change.title,
      subtitle: change.issue === undefined ? change.state : `#${change.issue} · ${change.state}`
    })))

  /** Runs the runs controller has listed or opened. */
  const runItems = (status?: string): ReadonlyArray<Fact> => {
    const seen = new Map<string, Fact>()
    const add = (card: Card, runId: string, flow: string, phase: string): void => {
      const scope = runScopeFromCard(ctx.store, card, runId)
      if (scope === undefined) return
      const key = JSON.stringify([scope.repo, scope.workspaceId ?? null, runId])
      seen.set(key, {
        kind: "run", ref: runSearchRef(runId, card.id), title: runId,
        subtitle: `${flow} · ${phase} · ${scope.repo}${scope.workspaceId === undefined ? "" : ` · ${scope.workspaceId}`}`
      })
    }
    for (const card of cards()) {
      if (card.kind === "run-list") {
        for (const run of card.payload.runs) {
          if (status !== undefined && run.status !== status) continue
          add(card, run.runId, run.flowId, run.status)
        }
      }
      if (card.kind === "run-trace" && (status === undefined || card.payload.phase === status)) {
        add(card, card.payload.runId, card.payload.workflow, card.payload.phase)
      }
    }
    return [...seen.values()]
  }

  /** Changes the change seam has read (the changes collection). */
  const changeItems = (): ReadonlyArray<Fact> =>
    [...ctx.store.collections.changes.values()].map((row) => ({
      kind: "change" as const,
      ref: row.changeId,
      title: firstLine(row.description) || row.changeId,
      subtitle: `${row.repoId} · ${row.commitId === null ? "no commit" : row.commitId.slice(0, 8)}`
    }))

  /** Issues the issues seam has listed or opened. */
  const issueItems = (is?: string): ReadonlyArray<Fact> => {
    const seen = new Map<string, Fact>()
    const add = (number: number, title: string, state: string, repo: string): void => {
      if (is !== undefined && state !== is) return
      seen.set(`${repo}#${number}`, { kind: "issue", ref: String(number), title: `#${number} ${title}`, subtitle: `${state} · ${repo}` })
    }
    for (const card of cards()) {
      if (card.kind === "issue-list") for (const issue of card.payload.issues) add(issue.number, issue.title, issue.state, card.payload.repo)
      if (card.kind === "issue") add(card.payload.number, card.payload.title, card.payload.state, card.payload.repo)
    }
    return [...seen.values()]
  }

  /** Secret NAMES with the hosts they bind to; no value exists on the wire. */
  const secretItems = (rows: ReadonlyArray<SecretRows>): ReadonlyArray<Fact> => {
    const seen = new Map<string, Fact>()
    for (const { repo, secrets } of rows) {
      for (const secret of secrets) {
        seen.set(`${repo}:${secret.name}`, {
          kind: "secret-name",
          ref: secret.name,
          title: secret.name,
          subtitle: `${repo}${secret.hosts.length === 0 ? "" : ` · ${secret.hosts.join(", ")}`}`
        })
      }
    }
    return [...seen.values()]
  }

  /** `:120`: the line in the newest file card, as one item whose open flow re-reads the file at that line. */
  const lineItems = (parsed: ParsedQuery): ReadonlyArray<Fact> | string => {
    const file = [...cards()].reverse().find((card): card is Extract<Card, { kind: "file" }> => card.kind === "file")
    if (file === undefined || file.payload.localRepoId !== undefined || parsed.line === undefined) return NO_FOCUSED_FILE
    const at = `${parsed.line.line}${parsed.line.column === undefined ? "" : `:${parsed.line.column}`}`
    const path = file.payload.address ?? file.payload.path
    return [{
      kind: "file",
      ref: path,
      title: `${path}:${at}`,
      subtitle: file.payload.repo,
      actions: [{ flow: "files.read", args: fileArgs(`${file.payload.path}:${at}`, file.payload.repo), label: "Read a file from a repository", role: "open" }]
    }]
  }

  /** The items of one mode, or the refusal that stands in for an index that does not exist; `live` is a flow door's fresh read, else the held cards. */
  const itemsOf = (mode: PaletteMode, parsed: Pick<ParsedQuery, "qualifiers">, live: LiveIndexes = {}): ReadonlyArray<Fact> | string => {
    const qualifier = (key: string): string | undefined =>
      parsed.qualifiers.find((row) => row.key === key && !row.negated)?.value
    const history = live.history ?? heldHistory()
    const secrets = live.secrets ?? heldSecrets()
    switch (mode) {
      case "all":
        return [...flowItems(), ...fileItems(), ...wikiItems(), ...historyItems(history), ...runItems(), ...changeItems(), ...issueItems(), ...secretItems(secrets)]
      case "path":
        return fileItems()
      case "flows":
        return flowItems()
      case "wiki":
        return wikiItems()
      case "history":
        return historyItems(history)
      case "runs":
        return runItems(qualifier("status"))
      case "changes": {
        const state = qualifier("state")
        return state === undefined ? changeItems() : "Changes on this wire carry no state to filter with; search without state:."
      }
      case "issues": {
        const label = qualifier("label")
        return label === undefined ? issueItems(qualifier("is")) : "Issue rows on this wire carry no labels to filter with; search without label:."
      }
      case "secrets":
        return secretItems(secrets)
      case "ask":
        return ASK_PROPOSED
      case "line":
      case "help":
        return []
    }
  }

  /** The kinds §4 hides from a signed-out visitor, cut from a bare answer. */
  const scoped = (items: ReadonlyArray<Fact>, signedOut: boolean): ReadonlyArray<Fact> =>
    signedOut ? items.filter((item) => item.kind !== "secret-name") : items

  const rank = (items: ReadonlyArray<Fact>, query: string): ReadonlyArray<ResultGroup<Fact>> => {
    const session = ctx.store.session()
    return rankItems(items, query, {
      recents: session.paletteRecents ?? [],
      now: now(),
      recommended: recommendedNames(deps.registry().state())
    })
  }

  /* ---- the button door: the overlay's rows ---- */

  const palette: SearchSeam["palette"] = (text) => {
    const parsed = parseQuery(text)
    const snapshot = deps.registry().state()
    const flow = flowOf(parsed.mode)
    if (parsed.mode === "help") {
      return {
        parsed,
        groups: [],
        flow,
        help: PREFIXES.map((row) => ({ ...row, available: !(row.signedIn && snapshot.signedOut) }))
      }
    }
    if (parsed.mode === "flows") {
      // Resolve an exact command name through the same authority as execution.
      // Keep unavailable commands out of the rows, including when arguments follow.
      const name = parsed.query.split(/\s+/, 1)[0] ?? ""
      const refusal = deps.registry().explainAbsent(name)?.reason
      return { parsed, groups: [], flow, ...(refusal === undefined ? {} : { refusal }) }
    }
    if (snapshot.signedOut && HIDDEN_SIGNED_OUT.has(parsed.mode)) return { parsed, groups: [], flow }
    const items = parsed.mode === "line" ? lineItems(parsed) : itemsOf(parsed.mode, parsed)
    if (typeof items === "string") return { parsed, groups: [], flow, refusal: items }
    const groups = rank(scoped(items, snapshot.signedOut), parsed.query)
    /*
     * An empty bare query is the mock's opening: the pills and the recents,
     * nothing more (§2 rules 1 and 2). A prefixed empty query lists its mode.
     */
    const kept = parsed.mode === "all" && parsed.query === ""
      ? groups.filter((group) => group.label === "Recommended" || group.label === "Recent")
      : groups
    // Actions exist only for the rows the overlay shows: the registry walk is per shown row, never per indexed fact.
    const entries = deps.registry().entries()
    return {
      parsed,
      groups: kept.map((group) => ({
        label: group.label,
        items: group.items.slice(0, PALETTE_GROUP_CAP).map((ranked) => ({ ...ranked, item: withActions(entries, ranked.item) }))
      })),
      flow
    }
  }

  /* ---- the slash and agent door: the flows ---- */

  /**
   * The live reads a flow door takes before it answers, where the mode has
   * one. Each is the reader's own answer, indexed in place: a search embeds
   * one card (§6), so the secrets and history cards stay their own flows'.
   * A watched history snapshot is the index, else one read; the environment
   * document is always re-read, as secrets.list re-reads it.
   */
  const liveIndexes = async (mode: PaletteMode, args: SearchArgs): Promise<LiveIndexes | string> => {
    if (mode !== "secrets" && mode !== "history") return {}
    const target = resolveTargetRepo(ctx.store, args.repo)
    if ("error" in target) return target.error
    const { repo } = target
    if (mode === "secrets") {
      const secrets = await readRepositorySecrets(ctx, repo)
      if (typeof secrets === "string") return secrets
      return { secrets: [{ repo, secrets }] }
    }
    if (deps.readStack === undefined) return { history: [] }
    const stack = await deps.readStack(repo)
    return typeof stack === "string" ? stack : { history: [stack] }
  }

  const search: SearchSeam["search"] = async (flow, mode, args) => {
    const current = captureCloudOwner(ctx, false)
    if (!current()) return SIGN_OUT_REFUSAL
    const actor = ctx.actor()
    const request = Symbol()
    if (actor !== "smithers") latest.set(flow, request)
    const live = await liveIndexes(mode, args)
    if (!current()) return SIGN_OUT_REFUSAL
    if (typeof live === "string") return live
    // The flow's query reads in its own mode's grammar.
    const parsed = parseQuery(`${prefixRow(mode).prefix}${args.query}`)
    const query = parsed.query
    const base = itemsOf(mode, parsed, live)
    if (typeof base === "string") return base
    const { entries, state } = deps.registry()
    const snapshot = state()
    const kinds = args.kinds === undefined ? undefined : new Set(args.kinds)
    const pool = scoped(base, snapshot.signedOut).filter((item) => kinds === undefined || kinds.has(item.kind))
    const limit = args.limit ?? SEARCH_DEFAULT_LIMIT
    const registered = entries()
    const items = rank(pool, query).flatMap((group) => group.items.map((row) => row.item)).slice(0, limit).map((fact) => withActions(registered, fact))
    const value = itemsValue(flow, args.query, items)
    if (actor === "smithers" || latest.get(flow) !== request) return { value }
    const id = `search-${flow}`
    const existing = ctx.store.collections.cards.get(id)
    const card: Card = {
      id,
      kind: "search-results",
      title: `Search · ${prefixRow(mode).prefix}${query === "" ? prefixRow(mode).searches : query}`,
      status: "active",
      createdAt: existing?.createdAt ?? now(),
      ordinal: ctx.nextOrdinal(),
      payload: { query: args.query, flow, ...(args.query === "" ? {} : { args: args.query }), items: [...items] }
    }
    ctx.dispatch({ type: "card.upsert", actor, card })
    return { value }
  }

  return { palette, search }
}

/** Whether a mode's flow needs a session (§4): the hidden-signed-out prefixes. */
export const signedInMode = (mode: PaletteMode): boolean => HIDDEN_SIGNED_OUT.has(mode)
