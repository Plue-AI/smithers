import { CARD_CONTENT_CAP,encodeRepoPath,unsafePath } from "./FilesSeam"
import type { SeamContext } from "./SeamContext"
import { readErrorMessage,readResult } from "./SeamContext"

export const createDiffFilesSeam = (ctx: SeamContext) => {
  return {
    openDiffFile: async (cardId: string, path: string) => {
      const card = ctx.store.collections.cards.get(cardId)
      if (card?.kind !== "diff") return "Open the diff before selecting a file."
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
