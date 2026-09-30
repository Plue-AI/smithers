/**
 * Records the deterministic signals S1-S5 of one public repository at one pinned commit (#3150).
 * The tree is read with the host's limits and the churn window ends at the pinned commit's own
 * time, so a rerun of the same SHA yields the same values whatever the date.
 */
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { deterministicSignals } from "../cleanup.ts"
import { agentTrace, churn, DAY, LOG_FORMAT, parseLog } from "../history.ts"
import { ADOPTION_MARKERS } from "../history.ts"
import { BINARY, FILE_BYTES, isSource, TREE_BYTES, type Tree } from "../tree.ts"
import type { CorpusCase, Deterministic } from "./fit.ts"

const run = promisify(execFile)

export type Language = CorpusCase["language"]
export type Band = CorpusCase["band"]
export type Label = CorpusCase["label"]

/** Size band by analyzed source lines. */
export const BAND_LIMITS = { small: 5_000, medium: 50_000 } as const
export const bandOf = (lines: number): Band =>
  lines < BAND_LIMITS.small ? "small" : lines <= BAND_LIMITS.medium ? "medium" : "large"

const LANGUAGE_OF: ReadonlyArray<readonly [RegExp, Language]> = [
  [/\.(ts|tsx|js|jsx|mjs|cjs)$/, "ts"],
  [/\.py$/, "python"],
  [/\.go$/, "go"],
  [/\.rs$/, "rust"]
]
/** The language among the four with the most analyzed lines; undefined when none is a source language of the corpus. */
export const dominantLanguage = (tree: Tree): Language | undefined => {
  const lines = new Map<Language, number>()
  for (const file of tree.files.filter((entry) => isSource(entry.path))) {
    const language = LANGUAGE_OF.find(([pattern]) => pattern.test(file.path))?.[1]
    if (language !== undefined) lines.set(language, (lines.get(language) ?? 0) + file.text.split("\n").length)
  }
  return [...lines.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

/** One manifest row: a repository pinned at a commit with its authorship label and the evidence for it. */
export interface ManifestEntry {
  readonly id: string
  readonly repo: string
  readonly sha: string
  readonly language: Language
  readonly band: Band
  readonly label: Label
  readonly evidence: string
}

/** A recorded repository: the corpus case plus what was measured. */
export interface RealCase extends CorpusCase {
  readonly repo: string
  readonly sha: string
  /** Analyzed source lines of the pinned tree. */
  readonly lines: number
  readonly coverage: number
  /** Commits in the 180-day window before the pinned commit, and how many carry agent-trace evidence. */
  readonly commits: number
  readonly traced: number
  readonly markers: ReadonlyArray<string>
}

export type Recorded =
  | { readonly ok: true; readonly recorded: RealCase; readonly measuredLanguage: Language | undefined }
  | { readonly ok: false; readonly reason: string }

const git = async (dir: string, args: ReadonlyArray<string>, input?: string) => {
  const child = run("git", ["-C", dir, ...args], { maxBuffer: 512 * 1024 * 1024, timeout: 600_000, encoding: "utf8" })
  if (input !== undefined) child.child.stdin?.end(input)
  return (await child).stdout
}

const round = (value: number) => Math.round(value * 10_000) / 10_000

/** Reads the pinned tree exactly as the host does: regular text files under the size limits. */
const readTree = async (dir: string, sha: string) => {
  const entries = (await git(dir, ["ls-tree", "-r", "-l", "-z", sha])).split("\0").flatMap((line) => {
    const match = /^(\d+) blob ([0-9a-f]+)\s+(\d+|-)\t(.+)$/s.exec(line)
    return match === null ? [] : [{
      path: match[4]!,
      size: match[3] === "-" ? 0 : Number(match[3]),
      regular: match[1] === "100644" || match[1] === "100755"
    }]
  })
  let budget = TREE_BYTES
  const files: Array<{ path: string; text: string }> = []
  const readable = new Map<string, number>()
  for (const entry of entries) {
    if (!entry.regular || entry.size > FILE_BYTES || BINARY.test(entry.path) || budget - entry.size < 0) continue
    budget -= entry.size
    const bytes = await readFile(join(dir, entry.path)).catch(() => undefined)
    if (bytes === undefined || bytes.includes(0)) continue
    const text = bytes.toString("utf8")
    files.push({ path: entry.path, text })
    readable.set(entry.path, text.split("\n").length)
  }
  const sourceLines = entries.filter((entry) => isSource(entry.path))
    .reduce((sum, entry) => sum + (readable.get(entry.path) ?? Math.ceil(entry.size / 40)), 0)
  return { tree: { paths: entries.map((entry) => entry.path), files } satisfies Tree, sourceLines }
}

/** Fetches `sha` with the 180 days before it (blobless), reads it, and computes S1-S5. Deletes its clone. */
export const recordRepository = async (
  entry: Pick<ManifestEntry, "id" | "repo" | "sha" | "language" | "band" | "label">,
  work = tmpdir()
): Promise<Recorded> => {
  const dir = await mkdtemp(join(work, "calibration-"))
  try {
    await git(dir, ["init", "-q"])
    await git(dir, ["config", "gc.auto", "0"])
    await git(dir, ["config", "maintenance.auto", "false"])
    await git(dir, ["remote", "add", "origin", `https://github.com/${entry.repo}.git`])
    await git(dir, ["fetch", "-q", "--depth=1", "--filter=blob:none", "origin", entry.sha])
    const now = Number((await git(dir, ["log", "-1", "--format=%ct", entry.sha])).trim())
    const since = new Date((now - 190 * DAY) * 1000).toISOString()
    await git(dir, ["fetch", "-q", "--filter=blob:none", `--shallow-since=${since}`, "origin", entry.sha])
    await git(dir, ["checkout", "-q", "--detach", entry.sha])
    const { tree, sourceLines } = await readTree(dir, entry.sha)
    // A shallow boundary commit has no parent, so git would list its whole tree as added.
    const boundary = new Set(
      (await readFile(join(dir, ".git", "shallow"), "utf8").catch(() => "")).split("\n").filter((line) => line !== "")
    )
    const log = await git(dir, ["log", "-n", "50000", `--format=${LOG_FORMAT}`, "--numstat", entry.sha])
    const commits = parseLog(log).filter((commit) => !boundary.has(commit.sha))
    const window = commits.filter((commit) => commit.time > now - 180 * DAY)
    const measured = deterministicSignals(tree, sourceLines, churn(commits, now))
    if (measured.values === null) return { ok: false, reason: `coverage ${measured.coverage.toFixed(2)} or no source` }
    const values = Object.fromEntries(
      Object.entries(measured.values).map(([id, value]) => [id, value === null ? null : round(value)])
    ) as Record<Deterministic, number | null>
    return {
      ok: true,
      measuredLanguage: dominantLanguage(tree),
      recorded: {
        id: entry.id,
        repo: entry.repo,
        sha: entry.sha,
        language: entry.language,
        band: bandOf(measured.analyzed),
        label: entry.label,
        lines: measured.analyzed,
        coverage: Math.round(measured.coverage * 100) / 100,
        commits: window.length,
        traced: window.filter((commit) => agentTrace(commit) !== undefined).length,
        markers: ADOPTION_MARKERS.filter((marker) =>
          tree.paths.includes(marker) || tree.paths.some((path) => path.startsWith(`${marker}/`))
        ),
        values
      }
    }
  } catch (error) {
    return { ok: false, reason: String((error as Error).message ?? error).split("\n")[0]!.slice(0, 200) }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  }
}
