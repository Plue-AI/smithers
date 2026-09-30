import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { PAGE_RESPONSE_BYTES, type PageMetadata } from "../../src/SealedSnapshot"
import { SnapshotPageChain, type PageExpected, type SnapshotPayload } from "./sealed"

export const MAX_ARCHIVE_PAGES = 100_000
const MANIFEST_BYTES = 32_000_000
const sha256 = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex")
interface PageFile { file: string; bytes: number; sha256: string }
export interface PagedArchive {
  schema: "smithers-do-paged-archive/v1"
  expected: PageExpected
  scanId: string
  entries: number
  capturedAt: string
  finishedAt: string
  finalSnapshotSHA256: string
  pages: PageFile[]
}
const refuse = (reason: string): never => { throw new Error("SNAPSHOT_ARCHIVE_" + reason) }
const privateDirectory = (path: string) => {
  const st = lstatSync(path)
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) refuse("DIRECTORY_NOT_PRIVATE")
}
const safeFile = (file: string) => { if (!/^[A-Za-z0-9_.-]+\.json$/.test(file)) refuse("PATH") }
const privateRead = (directory: string, file: string, max: number) => {
  safeFile(file)
  const st = lstatSync(join(directory, file))
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || st.size > max) refuse("FILE")
  return readFileSync(join(directory, file), "utf8")
}
const write = (directory: string, file: string, text: string) => {
  safeFile(file)
  writeFileSync(join(directory, file), text, { mode: 0o600, flag: "wx" })
}
/** Never buffer an unbounded response, including a misbehaving proxy's body. */
export const boundedPageText = async (response: Response): Promise<string> => {
  if (!response.ok) refuse(`REFUSED_${response.status}`)
  if (!response.body) refuse("EMPTY_RESPONSE")
  const reader = response.body!.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > PAGE_RESPONSE_BYTES) refuse("RESPONSE_TOO_LARGE")
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(size)
    let start = 0
    for (const chunk of chunks) { bytes.set(chunk, start); start += chunk.length }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
type OnPage = (payload: SnapshotPayload, metadata: PageMetadata) => void | Promise<void>
const finishMatches = (a: PagedArchive, result: ReturnType<SnapshotPageChain["finish"]>) => {
  if (a.pages.length !== result.pages || a.scanId !== result.scanId || a.entries !== result.entries || a.capturedAt !== result.capturedAt ||
    a.finishedAt !== result.finishedAt || a.finalSnapshotSHA256 !== result.finalSnapshotSHA256) refuse("TOTALS")
}

/**
 * Reopen all ciphertext and validate the whole chain, in bounded page memory.
 * onPage is for staging only: callers must not commit an import until this resolves.
 * expected must come from the operator's independently verified plan.
 */
export const validatePagedArchive = async (directory: string, file: string, expected: PageExpected, privateJwk: JsonWebKey, onPage?: OnPage): Promise<PagedArchive> => {
  privateDirectory(directory)
  const a = JSON.parse(privateRead(directory, file, MANIFEST_BYTES)) as PagedArchive
  if (a.schema !== "smithers-do-paged-archive/v1" || !Array.isArray(a.pages) || a.pages.length < 1 || a.pages.length > MAX_ARCHIVE_PAGES || !isDeepStrictEqual(a.expected, expected)) refuse("PROVENANCE")
  const chain = new SnapshotPageChain(expected, privateJwk), files = new Set<string>()
  for (const ref of a.pages) {
    if (!ref || files.has(ref.file) || ref.file === file) refuse("DUPLICATE")
    files.add(ref.file)
    const text = privateRead(directory, ref.file, PAGE_RESPONSE_BYTES)
    if (Buffer.byteLength(text) !== ref.bytes || sha256(text) !== ref.sha256) refuse("DIGEST")
    const { response, payload } = await chain.include(text)
    await onPage?.(payload, response.snapshot.metadata)
  }
  finishMatches(a, chain.finish())
  return a
}

/** Immutable ciphertext pages can resume only by reopening the full retained prefix. */
export const collectPagedSnapshot = async (options: {
  directory: string; stem: string; expected: PageExpected; privateJwk: JsonWebKey
  fetchPage: (cursor: string | null) => Promise<Response>; onPage?: OnPage
}): Promise<{ file: string; sha256: string; bytes: number; archive: PagedArchive }> => {
  const { directory, stem, expected, privateJwk, onPage } = options
  privateDirectory(directory)
  if (!/^[A-Za-z0-9_-]+$/.test(stem)) refuse("PATH")
  const file = `${stem}.pages.json`
  if (existsSync(join(directory, file))) {
    const archive = await validatePagedArchive(directory, file, expected, privateJwk, onPage)
    const text = privateRead(directory, file, MANIFEST_BYTES)
    return { file, sha256: sha256(text), bytes: Buffer.byteLength(text), archive }
  }
  const chain = new SnapshotPageChain(expected, privateJwk), pages: PageFile[] = []
  let cursor: string | null = null
  for (let index = 0; index < MAX_ARCHIVE_PAGES; index++) {
    const pageFile = `${stem}.page-${String(index).padStart(6, "0")}.json`
    const cached = existsSync(join(directory, pageFile))
    const text = cached ? privateRead(directory, pageFile, PAGE_RESPONSE_BYTES) : await boundedPageText(await options.fetchPage(cursor))
    const { response, payload } = await chain.include(text)
    if (!cached) write(directory, pageFile, text)
    pages.push({ file: pageFile, sha256: sha256(text), bytes: Buffer.byteLength(text) })
    await onPage?.(payload, response.snapshot.metadata)
    cursor = response.cursor
    if (cursor === null) {
      const { pages: _, ...summary } = chain.finish()
      const archive: PagedArchive = { schema: "smithers-do-paged-archive/v1", expected, ...summary, pages }
      const manifest = JSON.stringify(archive)
      if (Buffer.byteLength(manifest) > MANIFEST_BYTES) refuse("MANIFEST_TOO_LARGE")
      write(directory, file, manifest)
      return { file, sha256: sha256(manifest), bytes: Buffer.byteLength(manifest), archive }
    }
  }
  return refuse("PAGE_LIMIT")
}
