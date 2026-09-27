/** Safe, local action-cache inspection and retention operations.
 * @since 0.1.0
 */

import * as Config from "@smthrs/targets/Config"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { type CachedResult, entryLimit, sanitizeKey } from "./Cache.ts"

/** Metadata for an individually removable local action-result file.
 * @category models
 * @since 0.1.0
 */
export interface Entry {
  readonly path: string
  readonly bytes: number
  readonly modifiedAt: string
  readonly inode: number
}

/** Resolves an existing cache directory without creating it or following links.
 * @category querying
 * @since 0.1.0
 */
export const directory = async (root: string, cacheDirectory: string): Promise<string | undefined> => {
  let current = await Fs.realpath(root)
  for (const part of [...Config.normalizeCacheDirectory(cacheDirectory).split("/"), "cache"]) {
    current = Path.join(current, part)
    const stat = await Fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (stat === undefined) return undefined
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`cache path is not a plain directory: ${current}`)
  }
  return current
}

/** Lists only regular files in the local result cache's shard layout.
 * @category querying
 * @since 0.1.0
 */
export const entries = async (root: string, cacheDirectory: string): Promise<ReadonlyArray<Entry>> => {
  const base = await directory(root, cacheDirectory)
  if (base === undefined) return []
  const result: Array<Entry> = []
  for (const shard of await Fs.readdir(base, { withFileTypes: true })) {
    if (!shard.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]?$/.test(shard.name)) continue
    const shardPath = Path.join(base, shard.name)
    if ((await Fs.lstat(shardPath)).isSymbolicLink()) continue
    for (const name of await Fs.readdir(shardPath)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/.test(name) || !name.startsWith(shard.name)) continue
      const path = Path.join(shardPath, name)
      const stat = await Fs.lstat(path).catch(() => undefined)
      if (stat?.isFile() && !stat.isSymbolicLink()) {
        result.push({ path, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), inode: stat.ino })
      }
    }
  }
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

/** Reads only metadata from the requested local result, without hydrating or creating state.
 * @category querying
 * @since 0.1.0
 */
export const inspect = async (
  root: string,
  cacheDirectory: string,
  key: string
): Promise<Pick<CachedResult, "key" | "target" | "label" | "exitOk" | "storedAt"> | undefined> => {
  const safe = sanitizeKey(key)
  const base = await directory(root, cacheDirectory)
  if (base === undefined) return undefined
  const shard = Path.join(base, safe.slice(0, 2))
  const shardStat = await Fs.lstat(shard).catch(() => undefined)
  if (!shardStat?.isDirectory() || shardStat.isSymbolicLink()) return undefined
  const path = Path.join(shard, `${safe}.json`)
  const stat = await Fs.lstat(path).catch(() => undefined)
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > entryLimit) return undefined
  const data: unknown = await Fs.readFile(path, "utf8").then(JSON.parse).catch(() => undefined)
  if (typeof data !== "object" || data === null) return undefined
  const entry = data as Partial<CachedResult>
  if (
    entry.key !== key || typeof entry.label !== "string" || typeof entry.target !== "string" ||
    typeof entry.exitOk !== "boolean" || typeof entry.storedAt !== "string"
  ) return undefined
  return { key, label: entry.label, target: entry.target, exitOk: entry.exitOk, storedAt: entry.storedAt }
}

/** Removes individual action result files; never removes a directory or other run state.
 * @category execution
 * @since 0.1.0
 */
export const remove = async (options: {
  readonly root: string
  readonly cacheDirectory: string
  readonly olderThanDays?: number | undefined
  readonly dryRun: boolean
  readonly yes: boolean
  readonly now?: number | undefined
}) => {
  if (!options.dryRun && !options.yes) {
    throw new Error("cache deletion requires --yes; use --dry-run to inspect candidates")
  }
  const cutoff = options.olderThanDays === undefined ?
    Infinity :
    (options.now ?? Date.now()) - options.olderThanDays * 86_400_000
  const candidates = (await entries(options.root, options.cacheDirectory))
    .filter((entry) => Date.parse(entry.modifiedAt) < cutoff)
  let removed = 0
  let bytes = 0
  for (const entry of candidates) {
    if (options.dryRun) continue
    const base = await directory(options.root, options.cacheDirectory)
    if (base === undefined || Path.dirname(Path.dirname(entry.path)) !== base) {
      throw new Error("cache path changed during deletion")
    }
    const shard = await Fs.lstat(Path.dirname(entry.path))
    if (!shard.isDirectory() || shard.isSymbolicLink()) throw new Error("cache shard changed during deletion")
    const current = await Fs.lstat(entry.path).catch(() => undefined)
    if (
      !current?.isFile() || current.isSymbolicLink() || current.ino !== entry.inode ||
      current.mtime.toISOString() !== entry.modifiedAt
    ) continue
    await Fs.unlink(entry.path)
    removed += 1
    bytes += entry.bytes
  }
  return {
    scope: "local-action-results",
    dryRun: options.dryRun,
    candidates: candidates.length,
    candidateBytes: candidates.reduce((sum, entry) => sum + entry.bytes, 0),
    removed,
    bytes,
    recoverable: false
  }
}
