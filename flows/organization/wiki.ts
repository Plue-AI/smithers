/**
 * `wiki.commit`: the host commits what it wrote to the wiki's git
 * repository — receipts, documents, meeting notes and bookings under the
 * generated directory, hired profiles under `<rosterDir>/Specialists/`, and
 * the status page — and nothing else. It never pushes.
 *
 * The commit is limited to those paths (`git commit -- <paths>`), so the
 * owner's own edits elsewhere, staged or not, stay exactly as they were.
 * Hooks and signing are skipped: the commit is the host's record, made
 * unattended. A repository busy with another git command is left for the
 * next attempt.
 *
 * Pages roles edit with `wiki-edit` (and any page the host writes elsewhere,
 * through {@link recordWritten}) are kept in a journal inside the wiki's git
 * directory (`smithers-organization-edits.jsonl`) until a commit takes them,
 * and the commit names the roles that edited. {@link journal} is the role
 * hosts' side of it: a page with uncommitted changes the host did not make
 * is refused, so the owner's own work is never overwritten.
 */
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { Effect } from "effect"
import * as Config from "../../packages/smithers/agent/organization/src/Config.ts"
import type * as RoleHost from "../../packages/smithers/agent/organization/src/RoleHost.ts"

/**
 * The wiki paths the host writes, relative to the root: the generated
 * directory, hired profiles, the status page, then `extra` (directories or
 * files the host writes besides them).
 */
export const hostPaths = (
  organization: Pick<Config.Organization, "rosterDir" | "wiki">,
  extra: ReadonlyArray<string> = []
): ReadonlyArray<string> => [
  organization.wiki.generatedDir.replace(/\/+$/, ""),
  `${organization.rosterDir.replace(/\/+$/, "")}/Specialists`,
  organization.wiki.statusFile,
  ...extra.map((path) => path.replace(/\/+$/, ""))
]

/** One journaled write: the page, and the role that wrote it (absent for the host itself). */
export interface Written {
  readonly path: string
  readonly principal?: string | undefined
}

const journalName = "smithers-organization-edits.jsonl"

/** The journal file in the wiki's git directory, or `undefined` outside a git work tree. */
export const journalFile = (root: string): string | undefined => {
  const found = spawnSync("git", ["-C", root, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" })
  const directory = found.stdout.trim()
  return found.status === 0 && isAbsolute(directory) ? join(directory, journalName) : undefined
}

const readJournal = (file: string): ReadonlyArray<Written> => {
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8").split("\n").flatMap((line) => {
    try {
      const entry = JSON.parse(line) as Written
      return typeof entry.path === "string" ? [entry] : []
    } catch {
      // A line cut by a crash mid-append is not an entry.
      return []
    }
  })
}

/** Everything journaled and not yet committed, including a commit still being made. */
export const pending = (root: string): ReadonlyArray<Written> => {
  const file = journalFile(root)
  return file === undefined ? [] : [...readJournal(`${file}.committing`), ...readJournal(file)]
}

/**
 * Journals pages the host or a role wrote, so the next commit takes them.
 * Nothing happens outside a git work tree.
 */
export const recordWritten = (root: string, written: ReadonlyArray<Written>): void => {
  const file = journalFile(root)
  if (file === undefined || written.length === 0) return
  appendFileSync(file, written.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { mode: 0o600 })
}

/**
 * Why `path` must not be written now, or `undefined`: a page git reports as
 * changed (staged, unstaged, or untracked) that no journaled write explains
 * holds the owner's own uncommitted work.
 */
export const conflict = (root: string, path: string): string | undefined => {
  if (journalFile(root) === undefined) return undefined
  if (pending(root).some((entry) => entry.path === path)) return undefined
  if (changed(root, [path]).length === 0) return undefined
  return "has uncommitted changes the host did not make; commit or discard them first"
}

/**
 * The role hosts' journal over the wiki at `root`: a write is refused over
 * the owner's uncommitted changes, and each edit is journaled for the next
 * commit when `commits` (the organization page's `wiki.commit`) is on.
 */
export const journal = (root: string, commits: boolean): RoleHost.WikiJournal => ({
  guard: (path) => {
    const reason = conflict(root, path)
    return reason === undefined ? Effect.void : Effect.fail(reason)
  },
  record: (edit) =>
    Effect.sync(() => {
      if (commits) recordWritten(root, [{ path: edit.path, principal: edit.principal }])
    })
})

/** What one commit recorded. */
export interface Committed {
  readonly revision: string
  readonly files: ReadonlyArray<string>
  readonly message: string
}

const git = (root: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: env ?? process.env })

/** The files under `paths` git reports as changed, untracked ones included. */
export const changed = (root: string, paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths])
  if (status.status !== 0) return []
  const files: Array<string> = []
  const fields = status.stdout.split("\0")
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    if (field.length < 4) continue
    files.push(field.slice(3))
    // A rename carries its source path in the next field.
    if (field[0] === "R" || field[0] === "C") files.push(fields[++index]!)
  }
  return files.sort()
}

const brief = (names: ReadonlyArray<string>, max = 4) =>
  names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} +${names.length - max}`

/** The commit message: which runs, hires and pages the host recorded, and which roles edited. */
export const message = (
  paths: ReadonlyArray<string>,
  files: ReadonlyArray<string>,
  editors: ReadonlyArray<string> = []
): string => {
  const [generated, specialists, status] = paths
  const under = (prefix: string | undefined) =>
    prefix === undefined
      ? []
      : [...new Set(files.filter((file) => file.startsWith(`${prefix}/`)).map((file) => file.slice(prefix.length + 1).split("/")[0]!))]
  const runs = under(generated)
  const hires = under(specialists).map((file) => file.replace(/\.md$/, ""))
  const parts = [
    ...(runs.length === 0 ? [] : [`runs ${brief(runs)}`]),
    ...(hires.length === 0 ? [] : [`specialists ${brief(hires)}`]),
    ...(status !== undefined && files.includes(status) ? ["status"] : []),
    ...(editors.length === 0 ? [] : [`edits by ${brief(editors)}`])
  ]
  return `organization: record ${parts.length === 0 ? `${files.length} file(s)` : parts.join("; ")}`
}

/** Committer used only when the repository names none. */
const fallbackIdentity = {
  GIT_AUTHOR_NAME: "Smithers organization host",
  GIT_AUTHOR_EMAIL: "organization@localhost",
  GIT_COMMITTER_NAME: "Smithers organization host",
  GIT_COMMITTER_EMAIL: "organization@localhost"
}

/**
 * Commits the host's changed files under `paths` in the wiki repository at
 * `root`. `undefined` when the root is not a git work tree or nothing under
 * the paths changed; throws with git's first line when the commit fails.
 */
export const commit = (root: string, paths: ReadonlyArray<string>): Committed | undefined => {
  if (git(root, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true") return undefined
  // The journal is moved aside for this commit; a write journaled meanwhile
  // waits for the next one, and a failed commit keeps it for a retry.
  const file = journalFile(root)!
  if (existsSync(file)) {
    const kept = readJournal(`${file}.committing`)
    renameSync(file, `${file}.committing`)
    if (kept.length > 0) appendFileSync(`${file}.committing`, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""))
  }
  const journaled = readJournal(`${file}.committing`)
  const all = [...new Set([...paths, ...journaled.map((entry) => entry.path)])]
  const files = changed(root, all)
  const done = () => rmSync(`${file}.committing`, { force: true })
  if (files.length === 0) {
    done()
    return undefined
  }
  const present = all.filter((path) => existsSync(join(root, path)) || git(root, ["ls-files", "--", path]).stdout !== "")
  const env = git(root, ["config", "user.email"]).stdout.trim() === ""
    ? { ...process.env, ...fallbackIdentity }
    : process.env
  const editors = [
    ...new Set(journaled.flatMap((entry) => entry.principal === undefined || !files.includes(entry.path) ? [] : [entry.principal]))
  ].sort()
  const text = message(paths, files, editors)
  const add = git(root, ["add", "-A", "--", ...present], env)
  if (add.status !== 0) throw new Error(`git add: ${add.stderr.trim().split("\n")[0]}`)
  const made = git(
    root,
    ["-c", "commit.gpgsign=false", "commit", "--no-verify", "--quiet", "-m", text, "--", ...present],
    env
  )
  if (made.status !== 0) throw new Error(`git commit: ${(made.stderr || made.stdout).trim().split("\n")[0]}`)
  done()
  return { revision: git(root, ["rev-parse", "HEAD"]).stdout.trim(), files, message: text }
}

/**
 * The host's paths under `root` when its organization page asks for
 * `wiki.commit`; `undefined` otherwise, or when the page does not parse.
 */
export const committedPaths = (root: string): ReadonlyArray<string> | undefined => {
  const file = join(root, Config.defaultOrganizationFile)
  if (!existsSync(file)) return undefined
  const parsed = Effect.runSync(Effect.result(Config.parseOrganization(Config.defaultOrganizationFile, readFileSync(file, "utf8"))))
  return parsed._tag === "Success" && parsed.success.wiki.commit ? hostPaths(parsed.success) : undefined
}

/** How often a serving host commits what it wrote. */
export const interval = "30 seconds"

/**
 * The serving host's committer: commits every {@link interval} and once
 * more when the host stops. A failed commit is logged and retried on the
 * next tick; it never stops the host.
 */
export const committer = (root: string, paths: ReadonlyArray<string>, log: (line: string) => void) => {
  const once = Effect.sync(() => {
    try {
      const made = commit(root, paths)
      if (made !== undefined) log(`wiki ${made.revision.slice(0, 12)}: ${made.message}`)
    } catch (error) {
      log(`wiki commit failed: ${(error as Error).message}`)
    }
  })
  return Effect.addFinalizer(() => once).pipe(
    Effect.andThen(once.pipe(Effect.delay(interval), Effect.forever))
  )
}
