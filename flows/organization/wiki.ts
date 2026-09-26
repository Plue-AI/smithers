/**
 * `wiki.commit`: the host commits what it wrote to the wiki's git
 * repository — receipts, documents, meeting notes and bookings under the
 * generated directory, hired profiles under `<rosterDir>/Specialists/`, and
 * the status page, and with `autonomy` the team, proposals and requests
 * directories — and nothing else. With `wiki.sync: push` it then rebases
 * onto the wiki's upstream and pushes ({@link sync}); otherwise it never
 * pushes.
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
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { Effect } from "effect"
import * as Config from "../../packages/smithers/agent/organization/src/Config.ts"
import type * as RoleHost from "../../packages/smithers/agent/organization/src/RoleHost.ts"

/**
 * The wiki paths the host writes, relative to the root: the generated
 * directory, hired profiles, the status page, with `autonomy` the team,
 * proposals and requests directories, then `extra`.
 */
export const hostPaths = (
  organization: Pick<Config.Organization, "rosterDir" | "wiki" | "autonomy">,
  extra: ReadonlyArray<string> = []
): ReadonlyArray<string> => [
  organization.wiki.generatedDir.replace(/\/+$/, ""),
  `${organization.rosterDir.replace(/\/+$/, "")}/Specialists`,
  organization.wiki.statusFile,
  ...(organization.autonomy === undefined ? [] : [
    organization.autonomy.teamDir ?? "Org/Team",
    organization.autonomy.proposalsDir ?? "Org/Proposals",
    organization.autonomy.requestsDir ?? "Org/Requests"
  ]),
  ...extra
].map((path) => path.replace(/\/+$/, ""))

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

/** How often a syncing host pulls and pushes when it committed nothing. */
export const syncEvery = 5 * 60_000

/** What `<state>/wiki-sync.json` holds: the last sync, and the conflict holding it up. */
export interface SyncState {
  readonly syncedAt?: number | undefined
  readonly conflict?: { readonly at: number; readonly message: string } | undefined
}

/** How one sync ended. */
export interface Synced {
  readonly status: "synced" | "conflict" | "skipped" | "failed"
  readonly message: string
  /** Set when this sync recorded a conflict other than the one already recorded. */
  readonly announce?: string | undefined
}

const syncFile = (stateDir: string) => join(stateDir, "wiki-sync.json")

/** The recorded sync state; empty before the first sync. */
export const syncState = (stateDir: string): SyncState => {
  try {
    return JSON.parse(readFileSync(syncFile(stateDir), "utf8")) as SyncState
  } catch {
    return {}
  }
}

const saveSync = (stateDir: string, state: SyncState) => {
  writeFileSync(`${syncFile(stateDir)}.tmp`, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  renameSync(`${syncFile(stateDir)}.tmp`, syncFile(stateDir))
}

const first = (result: ReturnType<typeof git>) => (result.stderr || result.stdout).trim().split("\n")[0] ?? ""

const rebasing = (root: string) => {
  const directory = git(root, ["rev-parse", "--absolute-git-dir"]).stdout.trim()
  return existsSync(join(directory, "rebase-merge")) || existsSync(join(directory, "rebase-apply"))
}

/**
 * Brings the wiki checkout at `root` level with its upstream (its branch's
 * tracking branch) and pushes the host's commits there: fetch, rebase the
 * local commits onto the upstream with the owner's uncommitted edits
 * stashed around it (index included) and put back, push. Nothing is ever forced or discarded:
 *
 * - uncommitted edits to a page the upstream also changed hold the sync
 *   until the owner commits or discards them;
 * - a rebase that conflicts is aborted, which restores the checkout and its
 *   stashed edits exactly, and the local commits wait;
 * - stashed edits that do not apply again stay in the stash, named in the
 *   conflict;
 * - a push the upstream refused (it moved meanwhile) is retried next time.
 *
 * A conflict is recorded in `<stateDir>/wiki-sync.json` until a sync
 * succeeds; `announce` is set the first time it is seen.
 */
export const sync = (root: string, stateDir: string, now: number = Date.now()): Synced => {
  if (git(root, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true") {
    return { status: "skipped", message: "the wiki is not a git work tree" }
  }
  const upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
  const tracking = upstream.stdout.trim()
  const slash = tracking.indexOf("/")
  if (upstream.status !== 0 || slash <= 0) return { status: "skipped", message: "the wiki branch has no upstream" }
  const remote = tracking.slice(0, slash)
  const branch = tracking.slice(slash + 1)
  const recorded = syncState(stateDir)
  const conflict = (message: string): Synced => {
    const fresh = recorded.conflict?.message !== message
    saveSync(stateDir, { ...recorded, conflict: { at: fresh ? now : recorded.conflict!.at, message } })
    return { status: "conflict", message, ...(fresh ? { announce: message } : {}) }
  }
  const fetched = git(root, ["fetch", "--quiet", remote, branch])
  if (fetched.status !== 0) return { status: "failed", message: `git fetch: ${first(fetched)}` }
  const behind = Number(git(root, ["rev-list", "--count", "HEAD..@{u}"]).stdout.trim())
  if (behind > 0) {
    const dirty = new Set(changed(root, ["."]))
    const incoming = git(root, ["diff", "--name-only", "HEAD...@{u}"]).stdout.split("\n").filter((file) => file !== "")
    const overlap = incoming.filter((file) => dirty.has(file))
    if (overlap.length > 0) {
      return conflict(`uncommitted edits to ${brief(overlap, 3)} overlap upstream changes; commit or discard them`)
    }
    // The owner's uncommitted edits are stashed with their index around the
    // rebase and put back exactly, staged or not; untracked pages stay put.
    const count = () => git(root, ["stash", "list"]).stdout.split("\n").filter((entry) => entry !== "").length
    const stashes = count()
    git(root, ["stash", "push", "--quiet", "-m", "smithers organization wiki sync"])
    const stashed = count() > stashes
    const restore = () => !stashed || git(root, ["stash", "pop", "--index", "--quiet"]).status === 0
    const rebased = git(root, ["-c", "commit.gpgsign=false", "rebase", "--quiet", "@{u}"])
    if (rebased.status !== 0 || rebasing(root)) {
      if (rebasing(root)) git(root, ["rebase", "--abort"])
      const restored = restore()
      return conflict(
        `rebase onto ${tracking} stopped: ${first(rebased)}; local commits kept${restored ? "" : "; uncommitted edits kept in stash@{0}"}`
      )
    }
    if (!restore()) return conflict("uncommitted edits did not apply after the rebase; they are kept in stash@{0}")
  }
  const ahead = Number(git(root, ["rev-list", "--count", "@{u}..HEAD"]).stdout.trim())
  if (ahead > 0) {
    const pushed = git(root, ["push", "--quiet", remote, `HEAD:refs/heads/${branch}`])
    if (pushed.status !== 0) return { status: "failed", message: `git push: ${first(pushed)}` }
  }
  saveSync(stateDir, { syncedAt: now })
  return { status: "synced", message: ahead > 0 ? `pushed ${ahead} commit(s) to ${tracking}` : `level with ${tracking}` }
}

/** What a syncing committer needs besides the root and its paths. */
export interface SyncOptions {
  readonly stateDir: string
  /** Told once of each new conflict, as one line for the team channel. */
  readonly announce?: ((text: string) => Effect.Effect<unknown, unknown>) | undefined
}

/**
 * The serving host's committer: commits every {@link interval} and once
 * more when the host stops. With `syncing`, it then syncs with the wiki's
 * upstream after each commit and at least every {@link syncEvery}. A failed
 * commit or sync is logged and retried on the next tick; it never stops the
 * host.
 */
export const committer = (
  root: string,
  paths: ReadonlyArray<string>,
  log: (line: string) => void,
  syncing?: SyncOptions | undefined
) => {
  let lastSync = 0
  const once = Effect.suspend(() => {
    let made: Committed | undefined
    try {
      made = commit(root, paths)
      if (made !== undefined) log(`wiki ${made.revision.slice(0, 12)}: ${made.message}`)
    } catch (error) {
      log(`wiki commit failed: ${(error as Error).message}`)
    }
    const now = Date.now()
    if (syncing === undefined || (made === undefined && now - lastSync < syncEvery)) return Effect.void
    lastSync = now
    const synced = sync(root, syncing.stateDir, now)
    if (synced.status !== "synced" && synced.status !== "skipped") log(`wiki sync ${synced.status}: ${synced.message}`)
    else if (made !== undefined || synced.message.startsWith("pushed")) log(`wiki sync: ${synced.message}`)
    return synced.announce === undefined || syncing.announce === undefined
      ? Effect.void
      : syncing.announce(`Wiki sync conflict: ${synced.announce}`).pipe(
        Effect.catchCause(() => Effect.sync(() => log("wiki sync conflict could not be posted")))
      )
  })
  return Effect.addFinalizer(() => once).pipe(
    Effect.andThen(once.pipe(Effect.delay(interval), Effect.forever))
  )
}

/**
 * Whether the wiki at `root` can sync: its branch tracks an upstream, and
 * the upstream accepts a push (a dry run of its own commit, so nothing
 * moves).
 */
export const syncCheck = (root: string): { readonly ok: boolean; readonly detail: string; readonly fix?: string } => {
  const upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
  const tracking = upstream.stdout.trim()
  const slash = tracking.indexOf("/")
  if (upstream.status !== 0 || slash <= 0) {
    return {
      ok: false,
      detail: `${root} has no upstream to sync with`,
      fix: `git -C ${root} branch --set-upstream-to=origin/main`
    }
  }
  const remote = tracking.slice(0, slash)
  const branch = tracking.slice(slash + 1)
  const probe = git(root, ["push", "--dry-run", "--quiet", remote, `${tracking}:refs/heads/${branch}`])
  return probe.status === 0
    ? { ok: true, detail: `pushes to ${tracking} (${git(root, ["remote", "get-url", "--push", remote]).stdout.trim()})` }
    : { ok: false, detail: `${tracking} refuses a push: ${first(probe)}`, fix: `check push access to ${remote}` }
}
