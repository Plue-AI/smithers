import type { StorageApi } from "@tanstack/db"
import { PERSISTED_KEY_PREFIX } from "../chain/SchemaVersion"
import { z } from "zod"
import type { FileCard } from "@smthrs/rpc/FileCard"
import { FileCardSchema, branchFileRows, projectBranchFiles } from "@smthrs/rpc/FileCard"
import { fileDocument, type FileDocumentBinding } from "../cards/liveDoc"
import { LiveDocProvider, type DocumentPrerequisites } from "./LiveDocProvider"
import type { LiveChannel } from "./LiveChannel"
import type { BranchFileOperations } from "../state/seams/FilesSeam"

const Outside = z.object({ version: z.string(), at: z.string().optional() })
/** Host-owned document resources. The fake relay is never a production fallback. */
export class FileDocuments {
  private readonly documents = new Map<string, FileDocumentBinding & { dispose(): void }>()
  private readonly releases = new Map<string, () => void>()
  constructor(private readonly channel: LiveChannel, private readonly prerequisites: DocumentPrerequisites,
    private readonly files: BranchFileOperations,
    private readonly recovery?: { storage?: StorageApi | undefined; member: () => string | undefined }) {}
  resolve(branch: string, path: string, initial?: FileCard) {
    if (initial && initial.content.kind !== "text") return undefined
    const member = this.recovery?.member()
    const key = JSON.stringify([branch, path, member])
    let resource = this.documents.get(key)
    if (!resource && [this.prerequisites.contract, this.prerequisites.actor, this.prerequisites.file, this.prerequisites.recovery, this.prerequisites.catalog, this.prerequisites.machine].every(value => value === true)) {
      const provider = new LiveDocProvider(`doc:code:${branch}:${path}`, this.channel, this.prerequisites, member && this.recovery?.storage ? {
        read: () => { const raw = this.recovery!.storage!.getItem(`${PERSISTED_KEY_PREFIX}live-doc:${key}`); return raw ? JSON.parse(raw) : undefined },
        write: value => { const storage = this.recovery!.storage!; const storageKey = `${PERSISTED_KEY_PREFIX}live-doc:${key}`; if (value) storage.setItem(storageKey, JSON.stringify(value)); else storage.removeItem(storageKey) }
      } : undefined)
      resource = fileDocument(provider)
      this.documents.set(key, resource)
      if (initial) provider.setFile(initial)
      const topic = `branch:${branch}:files`
      this.channel.registerProjection(topic, projectBranchFiles)
      const update = () => {
        const snapshot = this.channel.getSnapshot(topic)
        if (snapshot?.error) { provider.revoke(); return }
        const data = branchFileRows(snapshot?.data)
        const rows = Array.isArray(data) ? data : []
        const row = rows.find(row => row?.path === path)
        if (row && typeof row === "object" && "branch" in row && row.branch !== branch) return
        const outside = Outside.safeParse(row?.outside_change)
        if (row?.outside_change != null && !outside.success) return
        const projected = outside.success ? { ...row, outside: { version: outside.data.version, at: outside.data.at ?? (typeof row.saved_at === "string" ? row.saved_at : "") } } : row
        const parsed = FileCardSchema.safeParse(projected)
        if (parsed.success && parsed.data.branch === branch) provider.setFile(parsed.data)
        else if (provider.file && row && typeof row === "object") {
          const { outside: _outside, ...base } = provider.file
          const merged = FileCardSchema.safeParse({ ...base, ...(row.gone ? { gone: row.gone } : { gone: undefined }), ...(outside.success ? { outside: { version: outside.data.version, at: outside.data.at ?? (typeof row.saved_at === "string" ? row.saved_at : "") } } : {}) })
          if (merged.success) provider.setFile(merged.data)
        } else if (provider.file) { const { outside: _outside, ...base } = provider.file; provider.setFile(base) }
      }
      this.releases.set(key, this.channel.subscribe(topic, update))
      update()
    }
    return resource
  }
  has(path: string, branch?: string) { return this.target(path, branch) !== undefined }
  private target(path: string, branch?: string) {
    const matches = [...this.documents.entries()].filter(([key]) => JSON.parse(key)[1] === path && (branch === undefined || JSON.parse(key)[0] === branch) && JSON.parse(key)[2] === (this.recovery?.member() ?? null))
    return matches.length === 1 ? matches[0]![1] : undefined
  }
  async recover(tag: "file.compare" | "file.restore-deleted" | "file.follow-rename" | "file.reapply", path: string, open?: (file: FileCard, from: string) => Promise<void>, branch?: string): Promise<string | { value: string }> {
    const resource = this.target(path, branch)
    if (!resource) return "File recovery is unavailable."
    const provider = resource.provider, model = provider.file
    if (!provider.available) return "Reconnect first."
    if (tag === "file.reapply") return provider.reapply() ? { value: "Reapplied" } : "Reconnect first."
    if (!model) return "File recovery is unavailable."
    if (tag === "file.compare") {
      if (!model.outside) return "No outside change."
      const result = await this.files.compare(model, model.outside.version)
      if ("error" in result) return result.error
      const snapshot = z.object({ before: z.string(), current: z.string() }).safeParse(result.ok)
      if (!snapshot.success) return "The comparison was malformed."
      if (!provider.available || provider.file?.outside?.version !== model.outside.version) return "The outside change moved."
      provider.setComparison({ version: model.outside.version, text: snapshot.data.before })
      return { value: JSON.stringify(result.ok) }
    }
    if (tag === "file.follow-rename") {
      const result = await this.files.follow(model)
      if ("error" in result) return result.error
      if (!provider.available) return "Branch access was removed."
      this.resolve(result.ok.branch, result.ok.path, result.ok)
      await open?.(result.ok, model.path)
      return { value: JSON.stringify(result.ok) }
    }
    if (model.gone?.kind !== "deleted") return "The file was not deleted."
    const result = await this.files.restoreDocument(model, provider.doc.getText("content").toString())
    return "error" in result ? result.error : { value: JSON.stringify(result.ok) }
  }
  dispose() { for (const release of this.releases.values()) release(); for (const resource of this.documents.values()) resource.dispose(); this.documents.clear(); this.releases.clear() }
}
