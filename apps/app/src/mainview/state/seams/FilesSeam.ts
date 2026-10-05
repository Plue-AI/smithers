import { preparedView,type ViewAction,type ViewResult } from "../PreparedView"
/*
 * The repo files seam: GET /api/repos/{owner}/{repo}/contents[/path] lists a
 * directory ("file-list" card) or reads a file ("file" card, capped). The
 * agent shares these commands, so reads must stay bounded. Reference: multi
 * src/files/filesClient.ts — buildContentsPath (:61, per-segment encoding via
 * encodeRepoPath :53), the directory answer is a JSON array of {name, path,
 * type: "file"|"dir"} entries (fetchDir :202, parseEntry :84), and the file
 * answer is one {path, content, encoding, size} record whose content is
 * base64 when encoding === "base64" (fetchFile :215, parseFile :122,
 * decodeContent :117). Parsing is defensive: unknown JSON in, typed card
 * payload out, malformed rows drop; failures are honest strings, never throws.
 */
import { FileCardSchema, type FileCard } from "@smthrs/rpc/FileCard"
import { fileListCard, type FileListEntry } from "@smthrs/rpc/FileList"
import { fileReadCard } from "@smthrs/rpc/FileRead"
import { refusalOf } from "@smthrs/rpc/Refusal"
import { refusalLine } from "@smthrs/rpc/RefusalCopy"
import type { AppStore } from "../AppStore"
import { resolveTargetRepo } from "../RepoContext"
import type { SeamContext } from "./SeamContext"
import { readContentsPages } from "./ContentsPages"
import { refusalWords,readErrorMessage,unreachableSentence } from "./SeamContext"

/*
 * Both commands answer a `value` beside the card: the card is what the human
 * sees, the value is what the MODEL reads. 2026-09-01: asked "what does the
 * README say?", the model called files.read, got back only "executed
 * /files.read", and wrote a README that does not exist — the card it had
 * just rendered never reaches its context. A read the model cannot read is
 * a confabulation waiting to happen.
 */
export interface FilesSeam {
  /** Dark S2 operations; production supplies no activation receipts yet. */
  readonly branchFiles: BranchFileOperations
  readonly listFiles: ViewAction<[path: string, repo?: string]>
  /**
   * `ref` is the revision to read AT.
   *
   * Without one the answer is the working tree, which moves. With one the
   * answer is bytes that cannot change, the card records which revision it
   * holds, and a reader can bind what it shows to what ran (D-068). Only the
   * contents route serves the requested revision.
   */
  readonly readFile: ViewAction<[path: string, repo?: string, anchor?: FileAnchor, ref?: string]>
}

/**
 * The line anchor `files.read <path>:<line>[:<col>]` carries (docs/code-intel/
 * PLAN.md §1), 1-based. It is recorded on the card, which scrolls to and marks
 * the line; the read itself is the same read, so the card keeps its id.
 */
export interface FileAnchor {
  readonly line: number
  readonly column?: number
}

/** The payload fields an anchor writes; nothing when there is none, so an unanchored re-read clears a stale line. */
const anchored = (anchor: FileAnchor | undefined): { readonly line?: number; readonly column?: number } =>
  anchor === undefined ? {} : { line: anchor.line, ...(anchor.column === undefined ? {} : { column: anchor.column }) }


const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** "" and "/" (and any slash dressing) normalize to the root: the empty path. */
const normalizePath = (path: string): string => path.trim().replace(/^\/+/, "").replace(/\/+$/, "")

/*
 * The global address space (lane piper step 6, ADR 0001): every file has a
 * global path `/org/repo/path`. A command's first token in that shape names
 * the repo AND the path in one — but only when the two-segment prefix is a
 * repository this app knows (the inventory or a working copy), so a
 * root-relative absolute path (`/src/lib`) keeps its old
 * meaning instead of becoming a cloud read of a repo that is not one.
 */
const GLOBAL_PATH = /^\/([\w.-]+\/[\w.-]+)(?:\/(.*))?$/

const knownRepo = (store: AppStore, id: string): boolean =>
  store.collections.repositories.get(id) !== undefined ||
  [...store.collections.workingCopies.values()].some((copy) => copy.repoId === id)

const splitGlobalPath = (
  store: AppStore,
  path: string,
  explicitRepo: string | undefined
): { readonly repo: string; readonly path: string } | null => {
  if (explicitRepo !== undefined && explicitRepo !== "") return null
  const match = GLOBAL_PATH.exec(path.trim())
  if (match === null) return null
  const repo = match[1] ?? ""
  return knownRepo(store, repo) ? { repo, path: match[2] ?? "" } : null
}

/** The card addressing (lane piper step 5): the global path, and the position a cloud read was taken at. */
const cloudAddressing = (
  store: AppStore,
  repo: string,
  normalized: string
): { readonly address: string; readonly readAt?: { readonly changeId: string | null; readonly commitId: string | null; readonly source: "head" } } => {
  const head = store.collections.repositories.get(repo)?.head ?? null
  return {
    address: `/${repo}/${normalized}`,
    ...(head === null ? {} : { readAt: { changeId: head.changeId, commitId: head.commitId, source: "head" as const } })
  }
}

/**
 * A path that leaves the repository's namespace, in the one place that
 * decides it. `encodeRepoPath` does not escape a dot, and a URL parser
 * collapses `..` before the request leaves the page, so
 * `/api/repos/{o}/{r}/contents/../../../../user/secrets` resolves to
 * `/api/user/secrets` and is sent same-origin with the visitor's cookies.
 * Every route that spends a caller's path on a URL asks this first: the
 * files flows here, and the sidebar's tree seam (RepoTreeSeam.loadDirectory).
 */
export const unsafePath = (path: string): boolean => {
  const slashNormalized = path.replace(/\\/g, "/")
  return slashNormalized.split("/").some((segment) => {
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return true
    }
    return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")
  })
}

/** Per-segment encoding, mirroring multi filesClient.ts encodeRepoPath (:53). */
export const encodeRepoPath = (path: string): string => path.split("/").filter(Boolean).map(encodeURIComponent).join("/")

/** The last path segment, for wire entries that answer a path but no name. */
const fileName = (path: string): string => {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** One directory row off the wire {name?, path?, type} shape; malformed rows drop. */
export const parseEntry = (value: unknown): FileListEntry | null => {
  if (!isRecord(value)) return null
  if (value.type !== "file" && value.type !== "dir") return null
  const name = typeof value.name === "string" && value.name !== ""
    ? value.name
    : typeof value.path === "string" && value.path !== ""
    ? fileName(value.path)
    : null
  if (name === null) return null
  return { name, kind: value.type }
}

/**
 * Base64 → UTF-8, honest about binary: NUL bytes or an undecodable byte
 * sequence answer `binary` instead of mojibake (multi decodeBase64 :101, made
 * strict — the card refuses binary rather than rendering replacement chars).
 */
const decodeBase64 = (value: string): { readonly text: string; readonly binary: boolean } => {
  try {
    const raw = atob(value.replace(/\s+/g, ""))
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0))
    if (bytes.includes(0)) return { text: "", binary: true }
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), binary: false }
  } catch {
    return { text: "", binary: true }
  }
}

/**
 * Where a file command's path resolves, by the rules the files flows apply:
 * a global `/org/repo/path` first token names both, an unsafe path is
 * refused, and the target follows the one repo-resolution rule. Shared with the code-intel
 * seam (CodeIntelSeam.ts), whose acts address the same files.
 */
export type FileTarget =
  | { readonly kind: "cloud"; readonly repo: string; readonly path: string }
  | { readonly error: string }

export const resolveFileTarget = (store: AppStore, pathArg: string, explicitRepoArg: string | undefined): FileTarget => {
  const global = splitGlobalPath(store, pathArg, explicitRepoArg)
  const path = global?.path ?? pathArg
  const explicitRepo = global?.repo ?? explicitRepoArg
  if (unsafePath(path)) return { error: "File paths must stay inside the repository." }
  const target = resolveTargetRepo(store, explicitRepo)
  return "error" in target ? target : { kind: "cloud", repo: target.repo, path: normalizePath(path) }
}

export const createFilesSeam = (ctx: SeamContext, branchOptions?: BranchFileOptions): FilesSeam => {
  const contentsUrl = (repo: string, path: string, ref?: string): string => {
    const [owner = "", name = ""] = repo.split("/")
    const base = `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents`
    const addressed = path === "" ? base : `${base}/${encodeRepoPath(path)}`
    /* The route's own parameter: the revision to answer at, not the head. */
    return ref === undefined ? addressed : `${addressed}?ref=${encodeURIComponent(ref)}`
  }


  // A missing repository and a missing path share a code; never infer an import.
  const explain404 = async (response: Response, fallback: string): Promise<string> => {
    const body: unknown = await response.json().catch(() => null)
    const refusal = refusalOf({ body, status: response.status, message: refusalWords(body, fallback, response.status) })
    return refusal.code === "not_found" ? fallback : refusalLine(refusal, fallback)
  }

  const readers: { listFiles: (path: string, repo?: string) => Promise<ViewResult>; readFile: (path: string, repo?: string, anchor?: FileAnchor, ref?: string) => Promise<ViewResult> } = {
    listFiles: async (pathArg, explicitRepoArg) => {
      const target = resolveFileTarget(ctx.store, pathArg, explicitRepoArg)
      if ("error" in target) return target.error
      const { repo, path: normalized } = target
      const label = normalized === "" ? "/" : normalized

      let body: unknown
      {
        let response: Response
        try {
          const answer = await readContentsPages(ctx.http, contentsUrl(repo, normalized))
          if (answer.kind === "error") return answer.error
          response = answer.response
          body = answer.body
        } catch (error) {
          return unreachableSentence(`the backend to list ${label} in ${repo}`, error)
        }
        if (response.status === 404) {
          return explain404(response, `Path not found: ${label} in ${repo}`)
        }
        if (!response.ok) {
          return readErrorMessage(response, `Listing ${label} in ${repo} failed (${response.status})`)
        }
      }
      if (!Array.isArray(body)) {
        // The contents route answers a record (content/encoding) for a file path.
        if (isRecord(body) && ("content" in body || "encoding" in body)) {
          return `${normalized} in ${repo} is a file — run /files.read ${normalized} instead`
        }
        return `The backend answered ${label} in ${repo} with an unreadable payload`
      }
      const entries = body.flatMap((entry) => {
        const parsed = parseEntry(entry)
        return parsed === null ? [] : [parsed]
      })
      const { readAt } = cloudAddressing(ctx.store, repo, normalized)
      return fileListCard(
        { repo, path: normalized, entries, ...(readAt === undefined ? {} : { readAt }) },
        ctx.nextOrdinal(),
        Date.now()
      )
    },

    readFile: async (pathArg, explicitRepoArg, anchor, ref) => {
      const target = resolveFileTarget(ctx.store, pathArg, explicitRepoArg)
      if ("error" in target) return target.error
      const { repo, path: normalized } = target
      if (normalized === "") return "files.read needs a file path"
      let response: Response
      try {
        response = await ctx.http(contentsUrl(repo, normalized, ref))
      } catch (error) {
        return unreachableSentence(`the backend to read ${normalized} in ${repo}`, error)
      }
      if (response.status === 404) {
        return ref === undefined
          ? explain404(response, `Path not found: ${normalized} in ${repo}`)
          : `Path not found: ${normalized} in ${repo} at ${ref}`
      }
      if (!response.ok) {
        return readErrorMessage(
          response,
          `Reading ${normalized} in ${repo} failed (${response.status})`
        )
      }

      const body: unknown = await response.json().catch(() => null)
      if (Array.isArray(body)) {
        return `${normalized} in ${repo} is a directory — run /files.list ${normalized} instead`
      }
      if (!isRecord(body) || typeof body.content !== "string" || (body.type !== undefined && body.type !== "file")) {
        return `The backend answered ${normalized} in ${repo} with an unreadable payload`
      }
      const rawContent = typeof body.content === "string" ? body.content : ""
      /*
       * §8.27: a binary file is STATED, not printed. The card says so rather
       * than laying out 42 000 pixels of base64 the reader can neither use
       * nor reach — and it is a card, because the read succeeded and the
       * answer is about the file.
       *
       * The declared encoding is not trusted on its own: the platform
       * answers `encoding: "utf-8"` for a file whose content is plainly
       * base64-encoded bytes. Only check for mislabelled binary when the
       * stripped body's length matches base64's expansion of the byte size.
       * Plain UTF-8 text (including word and hash lists) cannot have more
       * characters than bytes, so it keeps its declared encoding.
       */
      /*
       * A revision read is its own card, and it is not addressed at the head.
       * `cloudAddressing` states the position a plain read was taken at —
       * the repository's head as this session last saw it — which is exactly
       * what this read did NOT ask for, so a revision read carries the
       * revision it asked for instead.
       */
      const { readAt } = cloudAddressing(ctx.store, repo, normalized)
      const at = ref !== undefined ? { ref } : readAt === undefined ? {} : { readAt }
      const shown = (content: string, binary: boolean): ViewResult =>
        fileReadCard(
          { repo, path: normalized, content, binary, ...at, ...(binary ? {} : anchored(anchor)) },
          ctx.nextOrdinal(),
          Date.now()
        )
      if (body.encoding === "base64") {
        const decoded = decodeBase64(rawContent)
        return shown(decoded.text, decoded.binary)
      }
      if (rawContent.includes("\u0000")) return shown("", true)
      const size = body.size
      const hasBase64Length = typeof size === "number" && Number.isSafeInteger(size) && size > 0 &&
        rawContent.replace(/\s+/g, "").length === 4 * Math.ceil(size / 3)
      if (hasBase64Length && decodeBase64(rawContent).binary) return shown("", true)
      return shown(rawContent, false)
    }
  }
  const plan = (kind: "file" | "files", path: string, repo?: string, anchor?: FileAnchor, ref?: string) => {
    const target = resolveFileTarget(ctx.store, path, repo)
    if ("error" in target) return target.error
    if (kind === "file" && !target.path) return "files.read needs a file path"
    const repoId = target.repo
    const label = target.repo
    const maximized = ctx.store.collections.cards.get(ctx.store.session().maximizedCardId ?? "")
    const ownerCard = maximized?.kind === "file" || maximized?.kind === "file-list"
      ? maximized
      : [...(maximized === undefined ? [] : ctx.store.collections.cardHistories.get(maximized.id)?.entries ?? [])]
        .reverse().find((card) => card.kind === "file" || card.kind === "file-list")
    const owner = ownerCard?.kind === "file" || ownerCard?.kind === "file-list"
      ? ownerCard.payload.localRepoId ?? ownerCard.payload.repo
      : undefined
    const pane = owner === repoId ? maximized : undefined
    /* The revision is part of the address: one path at two revisions is two files. */
    const id = `${kind}-${repoId}-${target.path || "/"}${ref === undefined ? "" : `@${ref}`}`
    return { id, title: `${kind === "file" ? "File" : "Files"} · ${label} · ${target.path || "/"}`, key: JSON.stringify([id, anchor]), target: pane,
      read: () => kind === "file" ? readers.readFile(path, repo, anchor, ref) : readers.listFiles(path, repo),
    }
  }
  return {
    branchFiles: branchFileOperations(ctx, branchOptions),
    listFiles: preparedView(ctx, (path: string, repo?: string) => plan("files", path, repo)),
    readFile: preparedView(ctx, (path: string, repo?: string, anchor?: FileAnchor, ref?: string) => plan("file", path, repo, anchor, ref)),
  }
}

export const fileTargetKey = (store: AppStore, repo?: string): string | undefined => {
  const target = resolveFileTarget(store, "", repo)
  return "error" in target ? undefined : target.repo
}

/** Bounded breadth-first inventory, using the same repository contents route as files.read. No cards. */
export const fileOptions = async (
  ctx: Pick<SeamContext, "store" | "http" | "baseUrl">,
  repo?: string,
): Promise<{ options: Array<{ value: string; label: string }>; error?: string }> => {
  const target = resolveFileTarget(ctx.store, "", repo)
  if ("error" in target) return { options: [], error: target.error }
  const options: Array<{ value: string; label: string }> = []
  const queue = [""]
  const seen = new Set<string>()
  for (let index = 0; index < queue.length && index < 32 && options.length < 200; index++) {
    const path = queue[index]!
    if (seen.has(path)) continue
    seen.add(path)
    let entries: ReadonlyArray<{ name: string; kind: "file" | "dir" }>
    const [owner, name] = target.repo.split("/")
    try {
      const response = await ctx.http(`${ctx.baseUrl}/api/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/contents${path ? `/${encodeRepoPath(path)}` : ""}`)
      if (!response.ok) return { options, error: await readErrorMessage(response, `Could not list files in ${target.repo} (${response.status}).`) }
      const body: unknown = await response.json()
      if (!Array.isArray(body)) return { options, error: "The file chooser expected a directory." }
      entries = body.flatMap(row => { const entry = parseEntry(row); return entry ? [entry] : [] })
    } catch { return { options, error: `Could not list files in ${target.repo}.` } }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (unsafePath(entry.name) || entry.name.includes("/")) continue
      const child = path ? `${path}/${entry.name}` : entry.name
      if (entry.kind === "dir") { if (queue.length < 32) queue.push(child) }
      else if (options.length < 200) options.push({ value: child, label: child })
    }
  }
  return { options }
}

/** Host-owned activation evidence, never populated from repository or card bytes. */
export const BRANCH_FILE_PROVIDERS = [
  "T-COL-04", "T-APP-15", "T-UI-16", "T-APP-22", "T-APP-09", "T-CAT-01",
  "T-ACC-03", "T-COL-02", "T-MCH-11", "T-STK-12", "T-MCH-08"
] as const
export interface BranchFileOptions {
  readonly ready: (provider: typeof BRANCH_FILE_PROVIDERS[number]) => boolean
  /** Authenticated host scope; null after removal/sign-out. Sleeping reads require a captured head. */
  readonly scope: () => { branch: string; member: string; revision: number; sleeping: boolean; capturedHead?: string } | null
}
export type BranchFileAnswer<T> = { readonly ok: T } | { readonly error: string }
export interface BranchFileOperations {
  readonly read: (branch: string, path: string, digest?: string) => Promise<BranchFileAnswer<FileCard>>
  readonly reload: (file: FileCard, event: { path: string; post_digest: string; actor: FileCard["last_writer"] }) => Promise<BranchFileAnswer<FileCard> | undefined>
  readonly restore: (file: FileCard, burst: { version: string; post_digest: string }, deleted?: boolean) => Promise<BranchFileAnswer<FileCard> | { readonly compare: unknown }>
  readonly compare: (file: FileCard, version: string) => Promise<BranchFileAnswer<unknown>>
  readonly follow: (file: FileCard) => Promise<BranchFileAnswer<FileCard>>
}

/* Reuses this seam's fetch, path validation and decoder. No subscription, renderer,
 * command registration or wake is installed until provider receipts are supplied.
 * The existing immutable contents reader above remains the pinned-history path. */
const branchFileOperations = (ctx: SeamContext, options?: BranchFileOptions): BranchFileOperations => {
  const generations = new Map<string, number>()
  let nextGeneration = 0
  const reloads = new Map<string, { digest: string; answer: Promise<BranchFileAnswer<FileCard>> }>()
  const scopeFor = (branch: string, path: string, write = false) => {
    if (!options || BRANCH_FILE_PROVIDERS.some(provider => !options.ready(provider))) return { error: "Branch files are unavailable." } as const
    const scope = options.scope()
    if (!scope || scope.branch !== branch || !scope.member || ctx.isDisposed?.()) return { error: "Branch access was removed." } as const
    if (!path || unsafePath(path) || path.startsWith("/") || path.endsWith("/")) return { error: "File paths must stay inside the repository." } as const
    if (scope.sleeping && (write || !scope.capturedHead)) return { error: "The branch is asleep." } as const
    return scope
  }
  const current = (scope: Exclude<ReturnType<typeof scopeFor>, { error: string }>) => {
    const next = options?.scope()
    return !ctx.isDisposed?.() && next?.branch === scope.branch && next.member === scope.member && next.revision === scope.revision
      && next.sleeping === scope.sleeping && next.capturedHead === scope.capturedHead
      && BRANCH_FILE_PROVIDERS.every(provider => options?.ready(provider))
  }
  const url = (branch: string, path: string) => `${ctx.baseUrl}/api/branches/${encodeURIComponent(branch)}/files/${encodeRepoPath(path)}`
  const read: BranchFileOperations["read"] = async (branch, path, digest) => {
    const scope = scopeFor(branch, path)
    if ("error" in scope) return scope
    const key = JSON.stringify([scope.member, branch, path])
    const generation = ++nextGeneration
    generations.delete(key)
    generations.set(key, generation)
    if (generations.size > 30) generations.delete(generations.keys().next().value!)
    const query = new URLSearchParams()
    if (digest !== undefined) query.set("digest", digest)
    if (scope.sleeping) query.set("at", scope.capturedHead!)
    try {
      const response = await ctx.http(`${url(branch, path)}${query.size ? `?${query}` : ""}`)
      if (!current(scope) || generations.get(key) !== generation) return { error: "The file changed while loading." }
      if (!response.ok) return { error: await readErrorMessage(response, "Could not read the file.") }
      const parsed = FileCardSchema.safeParse(await response.json())
      if (!current(scope) || generations.get(key) !== generation) return { error: "The file changed while loading." }
      if (!parsed.success || parsed.data.branch !== branch || parsed.data.path !== path || (digest !== undefined && parsed.data.digest !== digest)) return { error: "The file response was malformed." }
      return { ok: { ...parsed.data, mode: "read_only" } }
    } catch { return { error: "Could not read the file." } }
  }
  const compare: BranchFileOperations["compare"] = async (file, version) => {
    const scope = scopeFor(file.branch, file.path)
    if ("error" in scope) return scope
    try {
      const query = new URLSearchParams({ compare: version })
      if (scope.sleeping) query.set("at", scope.capturedHead!)
      const response = await ctx.http(`${url(file.branch, file.path)}?${query}`)
      if (!response.ok) return { error: await readErrorMessage(response, "Could not compare the file.") }
      const body: unknown = await response.json()
      return current(scope) ? { ok: body } : { error: "Branch access was removed." }
    } catch { return { error: "Could not compare the file." } }
  }
  return {
    read, compare,
    reload: async (file, event) => {
      if (event.path !== file.path || event.post_digest === file.digest) return undefined
      const scope = scopeFor(file.branch, file.path)
      if ("error" in scope) return scope
      const key = JSON.stringify([scope.member, scope.revision, scope.sleeping, scope.capturedHead, file.branch, file.path])
      const previous = reloads.get(key)
      if (previous?.digest === event.post_digest) return previous.answer
      const answer = read(file.branch, file.path, event.post_digest).then(result =>
        "ok" in result ? { ok: { ...result.ok, ...(event.actor === undefined ? {} : { last_writer: event.actor }) } } : result)
      reloads.set(key, { digest: event.post_digest, answer })
      // Retain only a bounded set of open-card reloads, as preparedView does.
      if (reloads.size > 30) reloads.delete(reloads.keys().next().value!)
      const result = await answer
      if ("error" in result && reloads.get(key)?.answer === answer) reloads.delete(key)
      return result
    },
    follow: file => file.gone?.kind === "renamed" ? read(file.branch, file.gone.to) : Promise.resolve({ error: "The file was not renamed." }),
    restore: async (file, burst, deleted = false) => {
      const scope = scopeFor(file.branch, file.path, true)
      if ("error" in scope) return scope
      try {
        const response = await ctx.http(url(file.branch, file.path), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: deleted ? "restore-deleted" : "restore", version: burst.version, base_digest: deleted ? "absent" : burst.post_digest })
        })
        if (!current(scope)) return { error: "Branch access was removed." }
        if (response.status === 409) {
          if (deleted) return read(file.branch, file.path)
          const compared = await compare(file, burst.version)
          return "ok" in compared ? { compare: compared.ok } : compared
        }
        if (!response.ok) return { error: await readErrorMessage(response, "Could not restore the file.") }
        return read(file.branch, file.path)
      } catch { return { error: "Could not restore the file." } }
    }
  }
}
