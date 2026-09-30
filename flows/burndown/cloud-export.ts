/** Read-only export of READY trees before their Cloud workspace is released. */
import { Effect } from "effect"
import { type CloudCommit as Commit, type CloudFile as File, cloudHandoffLimits } from "./cloud-handoff.ts"

export type ReadCommand = (
  program: string,
  args: ReadonlyArray<string>,
  stdin?: Uint8Array
) => Effect.Effect<string, string>
export interface ExportOptions {
  /** Known credentials are scrubbed in addition to common token formats. */
  readonly redactions?: ReadonlyArray<string>
}
/** Bounded terminal-safe diagnostics; never retain command argv or an SSH grant. */
export const cloudDiagnostic = (value: string, redactions: ReadonlyArray<string> = []): string => {
  let text = value
  for (const secret of redactions) if (secret) text = text.replaceAll(secret, "[redacted]")
  return text.replaceAll(/Bearer\s+[^\s"']+|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "[redacted]")
    .replaceAll(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, 2048)
}
type Entry = { oid: string; type: "file" | "symlink"; executable: boolean }

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const validPath = (path: string) =>
  path.length > 0 && path.length <= 4096 &&
  !path.startsWith("/") && !path.includes("\\") &&
  !Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
  !path.split("/").some((part) => ["", ".", "..", ".git", ".jj"].includes(part.toLowerCase()))
const decodeBytes = (raw: string, error: string): Buffer => {
  const encoded = raw.replaceAll(/\s/g, "")
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.toString("base64") !== encoded) throw new Error(error)
  return bytes
}
const treeChanges = (bytes: Buffer): Array<{ path: string; before: Entry | null; after: Entry | null }> => {
  const text = bytes.toString("utf8")
  if (!Buffer.from(text).equals(bytes)) throw new Error("Cloud handoff contains an unsafe or unsupported tree entry")
  const fields = text.split("\0")
  if (fields.pop() !== "" || fields.length % 2 !== 0) throw new Error("Cloud handoff metadata is invalid")
  const entry = (mode: string, oid: string): Entry | null => {
    if (mode === "000000") {
      if (oid !== "0".repeat(40)) throw new Error("Cloud handoff metadata is invalid")
      return null
    }
    if (!["100644", "100755", "120000"].includes(mode)) {
      throw new Error("Cloud handoff contains an unsafe or unsupported tree entry")
    }
    if (oid === "0".repeat(40)) throw new Error("Cloud handoff metadata is invalid")
    return { oid, type: mode === "120000" ? "symlink" : "file", executable: mode === "100755" }
  }
  const changes: Array<{ path: string; before: Entry | null; after: Entry | null }> = []
  const seen = new Set<string>()
  for (let i = 0; i < fields.length; i += 2) {
    const header = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([ADMT])$/.exec(fields[i]!)
    if (header === null) throw new Error("Cloud handoff metadata is invalid")
    const path = fields[i + 1]!
    if (!validPath(path)) throw new Error("Cloud handoff contains an unsafe or unsupported tree entry")
    if (seen.has(path)) throw new Error("Cloud handoff metadata is invalid")
    seen.add(path)
    const before = entry(header[1]!, header[3]!)
    const after = entry(header[2]!, header[4]!)
    if (
      (header[5] === "A" && (before !== null || after === null)) ||
      (header[5] === "D" && (before === null || after !== null)) ||
      (["M", "T"].includes(header[5]!) && (before === null || after === null))
    ) throw new Error("Cloud handoff metadata is invalid")
    changes.push({ path, before, after })
  }
  return changes
}

/** Exports only committed changes, retaining full before/after bytes for conflict checks. */
export const exportCloudCommits = (
  repository: string,
  ids: ReadonlyArray<string>,
  read: ReadCommand,
  options: ExportOptions = {}
) =>
  Effect.gen(function*() {
    if (ids.length === 0 || ids.length > cloudHandoffLimits.commits || ids.some((sha) => !/^[0-9a-f]{40}$/.test(sha))) {
      return yield* Effect.fail("Cloud handoff requires one to twenty full READY commit IDs")
    }
    const commits: Array<Commit> = []
    let total = 0
    let paths = 0
    for (const sha of ids) {
      const readBytes = (stage: string, command: string, limit: number, oversized: string) =>
        Effect.gen(function*() {
          const raw = yield* read("sh", ["-c", [
            "set -e",
            't=$(mktemp); e=""',
            `trap 'rm -f "$t" "$e"' EXIT`,
            'e=$(mktemp)',
            "set +e",
            `${command} > "$t" 2> "$e"`,
            "code=$?",
            "set -e",
            'if [ "$code" -ne 0 ]; then',
            `  printf '#git-error:%s:' "$code"`,
            '  head -c 8192 "$e" | base64',
            "  exit 0",
            "fi",
            `if [ "$(wc -c < "$t")" -gt ${limit} ]; then printf '#oversized'; else base64 < "$t"; fi`
          ].join("\n")]).pipe(Effect.mapError((error) =>
            `Cloud export ${stage} ${sha}: command transport failed: ${cloudDiagnostic(error, options.redactions)}`
          ))
          const failed = /^#git-error:(\d{1,3}):([A-Za-z0-9+/=\s]*)$/.exec(raw)
          if (failed !== null) {
            const diagnostic = cloudDiagnostic(Buffer.from(failed[2]!, "base64").toString("utf8"), options.redactions)
            return yield* Effect.fail(`Cloud export ${stage} ${sha}: Git exit ${failed[1]}: ${diagnostic}`)
          }
          if (raw === "#oversized") return yield* Effect.fail(oversized)
          return raw
        })
      const encodedMetadata = yield* readBytes(
        "metadata",
        `git show -s --format=format:%H%x00%P%x00%B ${quote(sha + "^{commit}")}`,
        64 * 1024,
        "Cloud handoff metadata is oversized"
      )
      const raw = yield* Effect.try({
        try: () => decodeBytes(encodedMetadata, "Cloud handoff metadata is invalid").toString("utf8"),
        catch: () => "Cloud handoff metadata is invalid"
      })
      const metadata = yield* Effect.try({
        try: () => {
          const fields = /^([^\0]*)\0([^\0]*)\0([^\0]*)$/.exec(raw)
          if (fields === null) throw new Error("invalid commit metadata")
          return { sha: fields[1]!, parents: fields[2]!.split(" ").filter(Boolean), message: fields[3]! }
        },
        catch: () => "Cloud handoff metadata is invalid"
      })
      if (
        metadata.sha !== sha || metadata.parents.length !== 1 ||
        !/^[0-9a-f]{40}$/.test(metadata.parents[0]!) ||
        (commits.length > 0 && metadata.parents[0] !== commits.at(-1)!.sha)
      ) {
        return yield* Effect.fail("Cloud handoff requires ordered, conflict-free single-parent commits")
      }
      const diff = yield* readBytes(
        "tree",
        `git diff-tree --no-commit-id -r --raw -M --no-renames --no-abbrev -z ${quote(sha)}`,
        cloudHandoffLimits.files * (4096 * 4 + 128),
        "Cloud handoff exceeds changed-path limit"
      )
      const changed = yield* Effect.try({
        try: () => treeChanges(decodeBytes(diff, "Cloud handoff metadata is invalid")),
        catch: (error) => (error as Error).message
      })
      if (changed.length === 0) {
        return yield* Effect.fail("Cloud handoff requires ordered, conflict-free single-parent commits")
      }
      paths += changed.length
      if (paths > cloudHandoffLimits.files) return yield* Effect.fail("Cloud handoff exceeds changed-path limit")
      const snapshot = (entry: Entry | null): Effect.Effect<File | null, string> =>
        entry === null ? Effect.succeed(null) : Effect.gen(function*() {
          const encoded = yield* readBytes(
            "blob",
            `git cat-file blob ${quote(entry.oid)}`,
            cloudHandoffLimits.fileBytes,
            "Cloud handoff file bytes are invalid or oversized"
          )
          const bytes = yield* Effect.try({
            try: () => decodeBytes(encoded, "Cloud handoff file bytes are invalid"),
            catch: () => "Cloud handoff file bytes are invalid"
          })
          if (entry.type === "symlink" && bytes.byteLength > cloudHandoffLimits.symlinkBytes) {
            return yield* Effect.fail("Cloud symlink target exceeds portable host limit")
          }
          if (bytes.byteLength > cloudHandoffLimits.fileBytes) {
            return yield* Effect.fail("Cloud handoff file bytes are invalid or oversized")
          }
          total += bytes.byteLength
          if (total > cloudHandoffLimits.totalBytes) return yield* Effect.fail("Cloud handoff exceeds total-byte limit")
          return {
            type: entry.type,
            mode: entry.type === "symlink" ? "120000" : entry.executable ? "755" : "644",
            data: bytes.toString("base64")
          }
        })
      const changes: Array<Commit["changes"][number]> = []
      for (const { path, before, after } of changed) {
        changes.push({
          path,
          before: yield* snapshot(before),
          after: yield* snapshot(after)
        })
      }
      commits.push({ sha, parent: metadata.parents[0]!, message: metadata.message, changes })
    }
    return { version: 1 as const, repository, base: commits[0]!.parent, commits }
  })
