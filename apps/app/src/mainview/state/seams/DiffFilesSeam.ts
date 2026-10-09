import type { Card } from "../AppState"
import type { ControllerContext } from "../controller/context"
import { randomUuid } from "../../runtime/RandomUuid"
import { projectBranchFiles } from "@smthrs/rpc/FileCard"
import { DiffCardSchema } from "@smthrs/rpc/DiffCard"
import { z } from "zod"
import { BRANCH_FILE_PROVIDERS, type BranchFileOptions, type BranchFileOperations } from "./FilesSeam"
import { CARD_CONTENT_CAP } from "@smthrs/rpc/FileRead"
import { encodeRepoPath,unsafePath } from "./FilesSeam"
import type { SeamContext } from "./SeamContext"
import { readErrorMessage,readResult } from "./SeamContext"
import { Data } from "effect"

export const createDiffFilesSeam = (ctx: SeamContext, options?: BranchFileOptions, files?: BranchFileOperations, installDiff?: (branch: string, entry?: string, path?: string) => Promise<string | undefined>) => {
  let generation = 0
  const watches = new Map<string, () => void>()
  options?.onDispose?.(() => { for (const stop of watches.values()) stop(); watches.clear(); generation++ })
  const branchDiff = async (branch = options?.scope()?.branch, entry?: string, path?: string) => {
    if (installDiff && branch) return installDiff(branch, entry, path)
    if (!options || BRANCH_FILE_PROVIDERS.some(provider => !options.ready(provider))) return "Branch files are unavailable."
    const scope = options.scope()
    if (!scope || !branch || scope.branch !== branch || !scope.member) return "Branch access was removed."
    if (scope.sleeping && !scope.capturedHead) return "The branch is asleep."
    const ownGeneration = ++generation
    const query = scope.sleeping ? `?at=${encodeURIComponent(scope.capturedHead!)}` : ""
    try {
      const response = await ctx.http(`${ctx.baseUrl}/api/branches/${encodeURIComponent(branch)}/diff${query}`)
      if (!response.ok) return readErrorMessage(response, "Could not read the diff.")
      const parsed = z.object({ files: z.array(DiffCardSchema) }).safeParse(await response.json())
      const now = options.scope()
      if (ctx.isDisposed?.() || ownGeneration !== generation || !now || JSON.stringify(now) !== JSON.stringify(scope) || BRANCH_FILE_PROVIDERS.some(provider => !options.ready(provider))) return "Branch access was removed."
      if (!parsed.success || parsed.data.files.some(file => file.branch !== branch || unsafePath(file.path))) return "The diff response was malformed."
      const id = `diff-branch-${branch}`
      const previous = ctx.store.collections.cards.get(id)
      await ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: {
        id, kind: "diff", title: branch, status: "active", createdAt: previous?.createdAt ?? Date.now(), ordinal: previous?.ordinal ?? ctx.nextOrdinal(),
        payload: { repo: branch, changeId: branch, from: "", to: "", pin: { changeId: branch, commitId: null, seq: null }, files: [], branchFiles: parsed.data.files }
      } }).isPersisted.promise
      if (options.topics && !watches.has(branch)) {
        const topic = `branch:${branch}:files`
        options.topics.registerProjection?.(topic, projectBranchFiles)
        let cursor = options.topics.getSnapshot(topic)?.cursor
        watches.set(branch, options.topics.subscribe(topic, () => {
          const snapshot = options.topics!.getSnapshot(topic)
          if (!snapshot || snapshot.error || snapshot.cursor === cursor) return
          cursor = snapshot.cursor
          void branchDiff(branch)
        }))
      }
      return readResult(JSON.stringify(parsed.data.files))
    } catch { return "Could not read the diff." }
  }
  return {
    branchDiff,
    openDiffFile: async (cardId: string, path: string) => {
      const card = ctx.store.collections.cards.get(cardId)
      if (card?.kind !== "diff") return "Open the diff before selecting a file."
      if (card.payload.branchFiles) {
        const selected = card.payload.branchFiles.find(file => file.path === path)
        if (!selected || unsafePath(path)) return "Select a file in this diff."
        return files ? files.open(path, selected.branch) : "Branch files are unavailable."
      }
      const file = card.payload.files.find(file => file.path === path)
      if (!file || unsafePath(path)) return "Select a file in this diff."
      if (file.changeType === "deleted") return "This file was deleted at the selected revision."
      if (file.isBinary) return "This file is binary."
      const commitId = card.payload.pin.commitId
      if (!commitId) return "This diff has no pinned commit to read. Refresh the diff first."
      let content: string
      {
        const [owner, repo] = card.payload.repo.split("/")
        try {
          const response = await ctx.http(`${ctx.baseUrl}/api/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(commitId)}`)
          if (!response.ok) return await readErrorMessage(response, `Could not read ${path} at ${commitId} (${response.status}).`)
          const body = await response.json() as { content?: unknown; encoding?: unknown }
          if (typeof body.content !== "string") return "The pinned file response contained no readable content."
          content = body.encoding === "base64" ? new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(body.content.replace(/\s+/g, "")), char => char.charCodeAt(0))) : body.content
          if (content.includes("\u0000")) return "This file is binary."
        } catch { return "Could not read the pinned file." }
      }
      if (ctx.store.collections.cards.get(cardId) !== card) return "The frame changed while the file was loading. Select the file again."
      await ctx.dispatch({ type: "card.navigated", actor: ctx.actor(), card: {
        ...card, kind: "file", title: `${path} · ${card.payload.repo}`, payload: { repo: card.payload.repo, path,
          content: content.slice(0, CARD_CONTENT_CAP), truncated: content.length > CARD_CONTENT_CAP,
          readAt: { changeId: card.payload.pin.changeId, commitId } }
      } }).isPersisted.promise
      return readResult(content.slice(0, CARD_CONTENT_CAP))
    }
  }
}

const Result = z.object({ files: z.array(DiffCardSchema) })
/** A sleeping branch with no captured head has no snapshot to diff; the request fails as "Diff unavailable". */
class BranchSnapshotUnavailable extends Data.TaggedError("BranchSnapshotUnavailable")<Record<never, never>> {}

/** One persisted request owns the read, its card and its debounced toast. */
export const createBranchDiffReader = (ctx: ControllerContext, options?: BranchFileOptions) => {
  const running = new Set<string>()
  const watches = new Map<string, () => void>()
  const changed = new Set<string>()
  const current = (id: string, request: string, epoch: number) => {
    const card = ctx.store.collections.cards.get(id)
    return !ctx.disposed && ctx.accountEpoch === epoch && card?.kind === "diff" && card.payload.branchDiffRequest === request ? card : undefined
  }
  const launch = (card: Extract<Card, { kind: "diff" }>) => {
    const request = card.payload.branchDiffRequest, branch = card.payload.branchDiffSource
    if (!request || !branch || !card.payload.branchDiffPending || running.has(request)) return
    running.add(request)
    const epoch = ctx.accountEpoch
    void ctx.withToast(`branch-diff.${request}`, card.title, card.title, async () => {
      let failure = "Diff unavailable"
      try {
        const scope = options?.scope(branch)
        if (!card.payload.branchDiffEntry && scope?.sleeping && !scope.capturedHead) throw new BranchSnapshotUnavailable()
        const selector = card.payload.branchDiffEntry ? `?entry=${encodeURIComponent(card.payload.branchDiffEntry)}` : scope?.sleeping ? `?at=${encodeURIComponent(scope.capturedHead!)}` : ""
        const response = await ctx.http(`${ctx.baseUrl.replace(/\/$/, "")}/api/branches/${encodeURIComponent(branch)}/diff${selector}`, { credentials: "same-origin" })
        const body: unknown = await response.json()
        const parsed = response.ok ? Result.safeParse(body) : undefined
        const latest = current(card.id, request, epoch)
        if (!latest) return true
        if (parsed?.success && parsed.data.files.every(file => file.branch === branch && !unsafePath(file.path) && (!file.renamed_to || !unsafePath(file.renamed_to)) && (!card.payload.branchDiffEntry || file.against.kind === "burst" && file.against.burst === card.payload.branchDiffEntry)) && (!card.payload.path || parsed.data.files.some(file => file.path === card.payload.path))) {
          await ctx.store.dispatch({ type: "card.upsert", actor: "system", card: { ...latest, status: "active",
            payload: { ...latest.payload, branchFiles: parsed.data.files, branchDiffPending: false } } }).isPersisted.promise
          return true
        }
        if (body && typeof body === "object" && "message" in body && typeof body.message === "string") failure = body.message
      } catch { /* The persisted request retains a retryable failure. */ }
      const latest = current(card.id, request, epoch)
      if (latest) await ctx.store.dispatch({ type: "card.upsert", actor: "system", card: { ...latest, status: "error",
        payload: { ...latest.payload, branchDiffPending: false, error: failure } } }).isPersisted.promise
      return failure
    }, false, () => current(card.id, request, epoch) !== undefined, card.id).finally(() => {
      running.delete(request)
      if (current(card.id, request, epoch) && changed.delete(branch)) void readBranchDiff(branch)
    })
  }
  const resume = () => {
    if (ctx.disposed || ctx.store.collections.identitySessions.get("identity")?.state !== "signed-in") return
    for (const card of ctx.store.collections.cards.values()) if (card.kind === "diff") launch(card)
  }
  const subscription = ctx.store.collections.identitySessions.subscribeChanges(() => queueMicrotask(resume))
  ctx.onDispose(() => { subscription.unsubscribe(); for (const stop of watches.values()) stop(); watches.clear() })
  queueMicrotask(resume)
  const readBranchDiff = async (branch: string, entry?: string, path?: string): Promise<string | undefined> => {
    branch = branch.trim()
    if (entry !== undefined && !/^[0-9a-f-]{36}$/.test(entry)) return "Choose a change"
    if (path !== undefined && unsafePath(path)) return "Choose a file"
    if (!branch || unsafePath(branch) || branch.startsWith("/") || branch.endsWith("/")) return "Choose a branch"
    if (!entry && ctx.services.live && !watches.has(branch)) {
      const topics = ctx.services.live
      const topic = `branch:${branch}:files`
      topics.registerProjection?.(topic, projectBranchFiles)
      let cursor = topics.getSnapshot(topic)?.cursor
      watches.set(branch, topics.subscribe(topic, () => {
        const snapshot = topics.getSnapshot(topic)
        if (!snapshot || snapshot.error || snapshot.cursor === cursor) return
        cursor = snapshot.cursor
        if (ctx.store.collections.identitySessions.get("identity")?.state !== "signed-in") return
        const existing = ctx.store.collections.cards.get(`diff-branch-${branch}`)
        if (existing?.kind !== "diff") return
        if (existing.payload.branchDiffPending) changed.add(branch)
        else void readBranchDiff(branch)
      }))
    }
    const id = entry ? `diff-burst-${branch}-${entry}-${path ?? ""}` : `diff-branch-${branch}`
    const existing = ctx.store.collections.cards.get(id)
    if (existing?.kind === "diff" && existing.payload.branchDiffPending) { launch(existing); return }
    const card: Extract<Card, { kind: "diff" }> = { id, kind: "diff", title: `Diff · ${branch}`, status: "active",
      createdAt: existing?.createdAt ?? Date.now(), ordinal: existing?.ordinal ?? ctx.store.nextOrdinal(),
      payload: { repo: "", changeId: branch, from: branch.startsWith("scratch/") ? "fork" : "item", to: "current", pin: { changeId: branch, seq: null, commitId: null }, files: [], branchFiles: existing?.kind === "diff" ? existing.payload.branchFiles ?? [] : [],
        branchDiffSource: branch, branchDiffEntry: entry, path, branchDiffRequest: randomUuid(), branchDiffPending: true } }
    await ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card }).isPersisted.promise
    launch(card)
  }
  return { readBranchDiff }
}
