import { projectBranchFiles } from "@smthrs/rpc/FileCard"
import { DiffCardSchema } from "@smthrs/rpc/DiffCard"
import { z } from "zod"
import { BRANCH_FILE_PROVIDERS, type BranchFileOptions, type BranchFileOperations } from "./FilesSeam"
import { CARD_CONTENT_CAP } from "@smthrs/rpc/FileRead"
import { encodeRepoPath,unsafePath } from "./FilesSeam"
import type { SeamContext } from "./SeamContext"
import { readErrorMessage,readResult } from "./SeamContext"

export const createDiffFilesSeam = (ctx: SeamContext, options?: BranchFileOptions, files?: BranchFileOperations) => {
  let generation = 0
  const watches = new Map<string, () => void>()
  options?.onDispose?.(() => { for (const stop of watches.values()) stop(); watches.clear(); generation++ })
  const branchDiff = async (branch = options?.scope()?.branch) => {
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
