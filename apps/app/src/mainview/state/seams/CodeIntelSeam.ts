import { refuseCloudSignIn, SIGN_OUT_REFUSAL } from "./CloudSignIn"
import { actorSharedState } from "../ActorBindings"
/*
 * The code-intel seam (docs/code-intel/PLAN.md §4): `code.hover`,
 * `code.definition` and `code.diagnostics` against a language server. Each is
 * ONE act with three doors and answers two things: a `{ value }` the MODEL
 * reads (the FilesSeam rule — a read the model cannot read is a confabulation
 * waiting to happen), and a patch to the human's FILE card through
 * `card.updated` (no new card kind): `hover`, `diagnostics`, and `intel` —
 * what the card knows about the server. The definition opens its target
 * through files.read's line anchor.
 *
 * Every repository is a cloud repository (docs/LOCAL-BACKEND-RETIREMENT.md).
 * One with a RUNNING workspace asks the server plue runs inside that
 * workspace (CloudLspClient.ts, through the Bun tunnel); one without is told
 * which act opens or resumes a workspace; a file no language the workspace
 * relays handles is told the DTO's list.
 *
 * Honesty: a missing language server is stated with its install line and
 * never installed; a position the server has nothing for is stated; a
 * definition the server found outside the repository is stated as that,
 * never as "none"; every cap the host applied is stated (`N of M shown`,
 * `… and N more`, `cut at 4 KiB`); every close reason and every refusal the
 * cloud relay answers is shown verbatim, never a silent close. Diagnostics
 * the server publishes with no request patch the card they belong to; a
 * publication for a file nobody opened has nowhere to render and is dropped.
 *
 * An answer is about the CARD's text (the client sends it), so it lands only
 * while the card still shows that text. A hover drawn under line 12 of text
 * that no longer has that line would be an invention.
 */
import { LSP_HOVER_CAP_CHARS, LSP_LANGUAGE_SERVER_MISSING, LSP_REQUEST_TIMEOUT_MS, lspLanguageFor } from "@smthrs/rpc/LocalLsp"
import type { LspDiagnostic, LspLocation } from "@smthrs/rpc/LocalLsp"
import { canonicalStoredJsonValue } from "../EventValue"
import { CardSchema, parseRepoSelection } from "../AppState"
import type { Actor, Card, CloudWorkspaceRow } from "../AppState"
import type { CloudLspClient, CloudLspDocument, CloudLspEvent, LspAnswer, LspRefusal } from "../CloudLspClient"
import { resolveFileTarget } from "./FilesSeam"
import type { FileAnchor, FilesSeam } from "./FilesSeam"
import { captureCloudOwner, type SeamContext } from "./SeamContext"

export interface CodeIntelSeam {
  readonly hover: (path: string, line: number, column: number, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly definition: (path: string, line: number, column: number, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly diagnostics: (path: string, repo?: string) => Promise<string | void | { readonly value: string }>
  /** Close the owned client and detach its subscriptions. */
  readonly dispose: () => void
}

export interface CodeIntelSeamOptions {
  /**
   * Creates one workspace language-server client per account owner. The seam
   * closes it when that owner retires. Absent where this host
   * has no cloud tunnel (the web host until the W4 relay), and a cloud file
   * is then told so instead of dialing nothing.
   */
  readonly createCloudLsp?: () => CloudLspClient
  /**
   * files.read: the definition target opens through it at its line, and a
   * file with no card yet renders one (at the asked position) before the
   * answer patches it — a hover with no card to show it on is nothing the
   * human can see.
   */
  readonly readFile: (...args: Parameters<FilesSeam["readFile"]>) => ReturnType<FilesSeam["readFile"]>
  /**
   * How long a first request may run before the card states the server is
   * starting (the 300 ms law): the host spawns on first use and tsserver
   * loads the project for seconds; a card that already saw the server
   * answer is never told "starting" again.
   */
  readonly startingAfterMs?: number
}

/** The web host until the W4 relay: no tunnel, so no workspace language server can be reached from here. */
const CLOUD_TUNNEL_ABSENT = "Hover and definitions on a cloud repository need the native app; this host has no cloud tunnel yet."

type FilePayload = Extract<Card, { kind: "file" }>["payload"]
type Intel = NonNullable<FilePayload["intel"]>

const cardIdOf = (repo: string, path: string): string => `file-${repo}-${path}`

/** `line:col severity message (source code)` — one diagnostic as the model reads it. */
const diagnosticRow = (item: LspDiagnostic): string => {
  const origin = [item.source, item.code].filter((part): part is string => part !== undefined).join(" ")
  return `${item.line}:${item.character} ${item.severity} ${item.message}${origin === "" ? "" : ` (${origin})`}`
}

const locationRow = (location: LspLocation): string => `${location.path}:${location.line}:${location.character}`

const HOVER_CUT = `(cut at ${LSP_HOVER_CAP_CHARS / 1024} KiB)`

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`

const UNSETTLED: ReadonlySet<string> = new Set(["pending", "starting"])

/**
 * The cloud relay's refusal, in the workspace's terms: plue's 409
 * `language_server_missing` carries the install line verbatim, and the card
 * says which workspace lacks the server (the native card's "on this machine"
 * would be false here); every other refusal — a close reason, a POST's
 * words — is shown as it came.
 */
const refusedCloud = (refusal: LspRefusal, document: CloudLspDocument, workspace: { readonly id: string; readonly name: string }): { readonly intel: Intel; readonly text: string } =>
  refusal.code === LSP_LANGUAGE_SERVER_MISSING && refusal.install !== undefined
    ? {
      intel: { state: "unavailable", note: `no ${document.language} language server in workspace "${workspace.name}" (${workspace.id}) — install: ${refusal.install}` },
      text: `Workspace "${workspace.name}" (${workspace.id}) has no ${document.language} language server. Install: ${refusal.install}`
    }
    : { intel: { state: "unavailable", note: refusal.message }, text: refusal.message }

interface Prepared {
  readonly client: CloudLspClient
  readonly current: () => boolean
  readonly canPublish: () => boolean
  readonly repo: string
  readonly path: string
  readonly id: string
  readonly document: CloudLspDocument
  readonly workspace: { readonly id: string; readonly name: string }
}

export const createCodeIntelSeam = (ctx: SeamContext, options: CodeIntelSeamOptions): CodeIntelSeam => {
  const startingAfterMs = options.startingAfterMs ?? 300

  const fileCard = (id: string): Extract<Card, { kind: "file" }> | undefined => {
    const card = ctx.store.collections.cards.get(id)
    return card?.kind === "file" ? card : undefined
  }

  /** Patch the file card's payload through the dispatcher; false when no such card exists. */
  const patch = (id: string, fields: Partial<FilePayload>, actor: Actor = ctx.actor()): boolean => {
    const card = fileCard(id)
    if (card === undefined) return false
    ctx.dispatch({ type: "card.updated", actor, id, patch: { payload: { ...card.payload, ...fields } } })
    return true
  }

  /** The card's diagnostics fields from an answer: the capped list, and the total only when the cap cut. */
  const diagnosticsFields = (items: ReadonlyArray<LspDiagnostic>, total: number): Partial<FilePayload> => ({
    diagnostics: [...items],
    diagnosticsTotal: total > items.length ? total : undefined
  })

  /*
   * The cloud client speaks for every workspace at once: a publication lands
   * on the card still showing the text it is about; a close, and a refusal
   * the server asked to be retried, are stated on every card the connection
   * serves — the documents it opened and the cards whose act is dialing it
   * right now (the first act opens no document until the server is ready).
   * Never a silent close.
   */
  const cloudWatch = actorSharedState(ctx, "code-cloud-watch", () => ({
    unwatch: undefined as (() => void) | undefined,
    client: undefined as CloudLspClient | undefined,
    current: undefined as (() => boolean) | undefined,
    disposed: false,
    subscriptions: undefined as Array<{ unsubscribe(): void }> | undefined,
    pending: new Map<string, { readonly value: string }>(),
    hovers: new Map<string, symbol>()
  }))
  /** Publications are observations; only explicit commands record identical answers again. */
  const observe = (id: string, fields: Partial<FilePayload>): void => {
    const card = fileCard(id)
    if (card === undefined) return
    const payload = { ...card.payload, ...fields }
    const value = (row: Card | undefined) => row === undefined ? undefined : canonicalStoredJsonValue(CardSchema.parse(row))
    const next = value({ ...card, payload })!
    if (value(card) === next && (value(ctx.store.committedCard(id)) === next || cloudWatch.pending.get(id)?.value === next)) return
    const receipt = ctx.dispatch({ type: "card.updated", actor: "system", id, patch: { payload } })
    const pending = { value: next }
    cloudWatch.pending.set(id, pending)
    // An older receipt must not clear a newer accepted observation with the same value.
    const clear = () => { if (cloudWatch.pending.get(id) === pending) cloudWatch.pending.delete(id) }
    void receipt.isPersisted.promise.then(clear, clear)
  }
  const dialing = actorSharedState(ctx, "code-cloud-dialing", () => new Map<string, Set<string>>())
  const connectionKey = (workspaceId: string, language: string): string => `${workspaceId} ${language}`
  const cloudCards = (event: Extract<CloudLspEvent, { readonly paths: ReadonlyArray<string> }>): ReadonlySet<string> =>
    new Set([...event.paths.map((path) => cardIdOf(event.repo, path)), ...(dialing.get(connectionKey(event.workspaceId, event.language)) ?? [])])
  const retire = (): void => {
    const client = cloudWatch.client
    cloudWatch.unwatch?.()
    cloudWatch.unwatch = undefined
    cloudWatch.client = undefined
    cloudWatch.current = undefined
    cloudWatch.pending.clear()
    cloudWatch.hovers.clear()
    dialing.clear()
    client?.dispose()
  }
  if (cloudWatch.subscriptions === undefined) {
    const checkOwner = () => { if (cloudWatch.current?.() === false) retire() }
    cloudWatch.subscriptions = [
      ctx.store.collections.identitySessions.subscribeChanges(checkOwner),
      ctx.store.collections.cloudSessions.subscribeChanges(checkOwner)
    ]
  }
  const watchCloud = (): CloudLspClient => {
    if (cloudWatch.current?.() === false) retire()
    if (cloudWatch.client !== undefined) return cloudWatch.client
    const owner = captureCloudOwner(ctx)
    const client = options.createCloudLsp!()
    const current = () => !cloudWatch.disposed && cloudWatch.client === client && owner()
    cloudWatch.client = client
    cloudWatch.current = current
    cloudWatch.unwatch = client.subscribe((event) => {
      if (!current()) return
      switch (event.type) {
        case "diagnostics": {
          const id = cardIdOf(event.repo, event.path)
          if (fileCard(id)?.payload.content === event.content) observe(id, diagnosticsFields(event.items, event.total))
          return
        }
        case "closed": {
          const note = `the workspace language server closed: ${event.reason === "" ? "no reason given" : event.reason} (${event.code})`
          for (const id of cloudCards(event)) observe(id, { intel: { state: "unavailable", note } })
          return
        }
        case "waiting": {
          for (const id of cloudCards(event)) observe(id, { intel: { state: "unavailable", note: event.note } })
          return
        }
      }
    })
    return client
  }

  /** The file card the answer lands on, rendered through files.read when absent; the read's refusal is the answer then. */
  const ensureCard = async (repo: string, path: string, anchor?: FileAnchor): Promise<string | undefined> => {
    if (fileCard(cardIdOf(repo, path)) !== undefined) return undefined
    const read = await options.readFile(path, repo, anchor)
    return typeof read === "string" ? read : undefined
  }

  /** Run one request; past the 300 ms mark a card that never saw the server answer states "starting". */
  const request = async <T>(prepared: Prepared, work: () => Promise<LspAnswer<T>>): Promise<LspAnswer<T>> => {
    const { id } = prepared
    const timer = setTimeout(() => {
      if (prepared.current() && prepared.canPublish() && fileCard(id)?.payload.intel?.state !== "ready") patch(id, { intel: { state: "starting" } })
    }, startingAfterMs)
    ;(timer as { unref?: () => void }).unref?.()
    const key = connectionKey(prepared.document.workspaceId, prepared.document.language)
    const set = dialing.get(key) ?? new Set<string>()
    dialing.set(key, set.add(id))
    try {
      return await work()
    } finally {
      clearTimeout(timer)
      set.delete(id)
      if (set.size === 0 && dialing.get(key) === set) dialing.delete(key)
    }
  }

  /*
   * The workspace a cloud repository's act means: the active working copy
   * when it is a running workspace of that repository, else the one running
   * workspace of it — never a guess among several. Without a running one,
   * the refusal names the act that gets one.
   */
  const workspaceFor = (repo: string): { readonly workspace: CloudWorkspaceRow } | { readonly refusal: string } => {
    const rows = [...ctx.store.collections.cloudWorkspaces.values()].filter((row) => row.repoId === repo)
    const running = rows.filter((row) => row.status === "running")
    const key = ctx.store.session().activeRepoKey ?? null
    const selection = key === null ? null : parseRepoSelection(key)
    const copyId = selection === null ? undefined : "repoId" in selection ? selection.copyId : selection.localCopyId
    const copy = copyId === undefined ? undefined : ctx.store.collections.workingCopies.get(copyId)
    const active = copy?.kind === "workspace" ? running.find((row) => row.id === copy.workspaceId) : undefined
    if (active !== undefined) return { workspace: active }
    if (running.length === 1) return { workspace: running[0]! }
    if (running.length > 1) {
      return { refusal: `Several workspaces of ${repo} are running (${running.map((row) => `"${row.name}" ${row.id}`).join(", ")}) — select one first.` }
    }
    const resumable = rows.find((row) => row.status === "suspended" || row.status === "stopped")
    if (resumable !== undefined) {
      return { refusal: `Hover and definitions need a running workspace of ${repo}: "${resumable.name}" (${resumable.id}) is ${resumable.status} — /workspace.resume ${resumable.id} first.` }
    }
    const settling = rows.find((row) => UNSETTLED.has(row.status))
    if (settling !== undefined) {
      return { refusal: `Hover and definitions need a running workspace of ${repo}: "${settling.name}" (${settling.id}) is ${settling.status} — wait for it to settle (the card tracks it).` }
    }
    return { refusal: `Hover and definitions need a running workspace of ${repo} — /workspace.open ${repo} first.` }
  }

  /** The cloud half of `prepare`: the tunnel, the sign-in, the workspace, the language it relays, and the card's whole text. */
  const prepareCloud = async (repo: string, path: string, anchor: FileAnchor | undefined, canPublish = () => true): Promise<Prepared | string> => {
    const id = cardIdOf(repo, path)
    if (cloudWatch.disposed || ctx.isDisposed?.()) return SIGN_OUT_REFUSAL
    if (options.createCloudLsp === undefined) {
      if (canPublish()) patch(id, { intel: { state: "unavailable", note: CLOUD_TUNNEL_ABSENT } })
      return CLOUD_TUNNEL_ABSENT
    }
    if (ctx.store.collections.cloudSessions.get("cloud")?.state !== "signed-in") return refuseCloudSignIn(ctx)
    const found = workspaceFor(repo)
    if ("refusal" in found) {
      if (canPublish()) patch(id, { intel: { state: "unavailable", note: found.refusal } })
      return found.refusal
    }
    const { workspace } = found
    const language = lspLanguageFor(path)
    const served = workspace.lspLanguages ?? null
    if (language === null || (served !== null && !served.includes(language))) {
      const extension = /\.[^./]+$/.exec(path)?.[0]
      const noun = extension === undefined ? "this file" : `${extension} files`
      const refusal = served === null
        ? `No workspace language server handles ${noun}.`
        : `No workspace language server handles ${noun} — "${workspace.name}" (${workspace.id}) serves ${served.length === 0 ? "no language" : served.join(", ")}.`
      if (canPublish()) patch(id, { intel: { state: "unavailable", note: refusal } })
      return refusal
    }
    const owner = captureCloudOwner(ctx)
    const current = () => !cloudWatch.disposed && owner()
    const unread = await ensureCard(repo, path, anchor)
    if (!current()) return SIGN_OUT_REFUSAL
    if (unread !== undefined) return unread
    const card = fileCard(id)
    if (card === undefined) return `${path} in ${repo} could not be rendered.`
    if (card.payload.binary === true) return `${path} in ${repo} is a binary file; a language server has nothing to read there.`
    if (card.payload.truncated) {
      const refusal = `${path} in ${repo} is larger than the card cap; hover, definitions and diagnostics need the whole file.`
      if (canPublish()) patch(id, { intel: { state: "unavailable", note: refusal } })
      return refusal
    }
    const client = watchCloud()
    return {
      client,
      current,
      canPublish,
      repo,
      path,
      id,
      workspace: { id: workspace.id, name: workspace.name },
      document: { repo, workspaceId: workspace.id, language, path, content: card.payload.content }
    }
  }

  /** The target, its card, and the subscription, or the honest refusal — shared by the three acts. */
  const targetFor = (pathArg: string, repoArg: string | undefined) => {
    const target = resolveFileTarget(ctx.store, pathArg, repoArg)
    if ("error" in target) return target.error
    if (target.path === "") return "code intelligence needs a file path"
    if (target.kind !== "cloud") return `${target.path} is not in a cloud repository; code intelligence runs inside a workspace.`
    return target
  }
  const prepare = async (pathArg: string, repoArg: string | undefined, anchor?: FileAnchor): Promise<Prepared | string> => {
    const target = targetFor(pathArg, repoArg)
    return typeof target === "string" ? target : prepareCloud(target.repo, target.path, anchor)
  }

  /** The refusal, stated on the card and to the model, in the workspace's terms. */
  const refuse = (prepared: Prepared, refusal: LspRefusal): string => {
    const { intel, text } = refusedCloud(refusal, prepared.document, prepared.workspace)
    if (prepared.canPublish()) patch(prepared.id, { intel })
    return text
  }

  /** True when the card still shows the text the client sent, which the answer is about. */
  const current = (prepared: Prepared): boolean =>
    fileCard(prepared.id)?.payload.content === prepared.document.content

  return {
    hover: async (pathArg, line, column, repoArg) => {
      const target = targetFor(pathArg, repoArg)
      if (typeof target === "string") return target
      // Claim the card before file preparation; user and agent calls share it.
      const id = cardIdOf(target.repo, target.path)
      const token = Symbol()
      cloudWatch.hovers.set(id, token)
      const canPublish = () => cloudWatch.hovers.get(id) === token
      try {
        const prepared = await prepareCloud(target.repo, target.path, { line, column }, canPublish)
        if (typeof prepared === "string") return prepared
        if (!prepared.current()) return SIGN_OUT_REFUSAL
        const { path, repo } = prepared
        const answer = await request(prepared, () => prepared.client.hover(prepared.document, { line, character: column }))
        if (!prepared.current()) return SIGN_OUT_REFUSAL
        if ("refusal" in answer) return refuse(prepared, answer.refusal)
        const { hover } = answer.ok
        if (canPublish()) {
          if (current(prepared)) {
            patch(id, {
              intel: { state: "ready" },
              hover: hover === null ? null : { line, character: column, contents: hover.contents, ...(hover.truncated ? { truncated: true } : {}) }
            })
          } else {
            patch(id, { intel: { state: "ready" } })
          }
        }
        return {
          value: hover === null
            ? `The language server has nothing at ${path}:${line}:${column} in ${repo}.`
            : `${path}:${line}:${column} in ${repo}\n${hover.contents}${hover.truncated ? `\n${HOVER_CUT}` : ""}`
        }
      } finally {
        if (canPublish()) cloudWatch.hovers.delete(id)
      }
    },

    definition: async (pathArg, line, column, repoArg) => {
      const prepared = await prepare(pathArg, repoArg, { line, column })
      if (typeof prepared === "string") return prepared
      if (!prepared.current()) return SIGN_OUT_REFUSAL
      const { path, id } = prepared
      const repo = prepared.repo
      const answer = await request(prepared, () => prepared.client.definition(prepared.document, { line, character: column }))
      if (!prepared.current()) return SIGN_OUT_REFUSAL
      if ("refusal" in answer) return refuse(prepared, answer.refusal)
      const { locations, total, omitted } = answer.ok
      const at = `${path}:${line}:${column} in ${repo}`
      const [first, ...rest] = locations
      if (first === undefined) {
        /*
         * The server found nothing, or found it only outside the repository
         * (a linked package, a lib.d.ts): two different facts. The second is
         * the common one for a checkout without its own node_modules, and
         * "no definition found" would be false. The card states it too.
         */
        const outside = omitted === 0 ? undefined : `outside the repository (${plural(omitted, "location")} not openable here)`
        patch(id, { intel: outside === undefined ? { state: "ready" } : { state: "ready", note: `Definition of ${path}:${line}:${column}: ${outside}` } })
        return { value: outside === undefined ? `No definition found for ${at}.` : `${at} is defined ${outside}.` }
      }
      patch(id, { intel: { state: "ready" } })
      /*
       * The card effect (§4): the first target opens at its line through
       * files.read's anchor — the same card id, the same dedupe, the same
       * scroll. The read's own value stays out of this answer: the model
       * asked where, not what; it reads the target with files.read. A
       * refusal still belongs in the answer because the target did not open.
       */
      const opened = await options.readFile(first.path, repo, { line: first.line, column: first.character })
      if (!prepared.current()) return SIGN_OUT_REFUSAL
      const more = total - omitted - locations.length
      const trailer = [
        ...(more > 0 ? [`… and ${more} more`] : []),
        ...(omitted > 0 ? [`(${plural(omitted, "more location")} outside the repository, not openable here)`] : [])
      ]
      return { value: `${at} is defined at:\n${[first, ...rest].map(locationRow).join("\n")}${trailer.length === 0 ? "" : `\n${trailer.join("\n")}`}${typeof opened === "string" ? `; the target could not be opened: ${opened}` : ""}` }
    },

    diagnostics: async (pathArg, repoArg) => {
      const prepared = await prepare(pathArg, repoArg)
      if (typeof prepared === "string") return prepared
      if (!prepared.current()) return SIGN_OUT_REFUSAL
      const { path, id } = prepared
      const repo = prepared.repo
      const answer = await request(prepared, () => prepared.client.diagnostics(prepared.document))
      if (!prepared.current()) return SIGN_OUT_REFUSAL
      if ("refusal" in answer) return refuse(prepared, answer.refusal)
      const { items, total } = answer.ok
      if (items === null || total === null) {
        // The server published nothing within the wait: the card keeps no count rather than a false zero.
        patch(id, { intel: { state: "ready" } })
        return { value: `The language server published no diagnostics for ${path} in ${repo} within ${LSP_REQUEST_TIMEOUT_MS / 1000} s.` }
      }
      if (current(prepared)) patch(id, { intel: { state: "ready" }, ...diagnosticsFields(items, total) })
      else patch(id, { intel: { state: "ready" } })
      const shown = total > items.length ? ` (first ${items.length} shown)` : ""
      return {
        value: items.length === 0
          ? `${path} in ${repo}: no diagnostics.`
          : `${path} in ${repo}: ${plural(total, "diagnostic")}${shown}\n${items.map(diagnosticRow).join("\n")}`
      }
    },

    dispose: () => {
      cloudWatch.disposed = true
      retire()
      for (const subscription of cloudWatch.subscriptions ?? []) subscription.unsubscribe()
      cloudWatch.subscriptions = []
    }
  }
}
