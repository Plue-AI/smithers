import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { Effect } from "effect"
import { backup } from "./setup/backup.ts"
import { exampleRoot } from "./setup/settings.ts"
import * as Wiki from "./wiki.ts"

const scratch = mkdtempSync(join(tmpdir(), "org-wiki-"))
after(() => rmSync(scratch, { recursive: true, force: true }))

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

const organizationPage = (commit: boolean) =>
  readFileSync(join(exampleRoot, "Org", "Organization.md"), "utf8").replace("  commit: false", `  commit: ${commit}`)

const paths = ["Org/Runs", "Org/Specialists", "Org/Status.md"]

const write = (root: string, path: string, text: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true })
  writeFileSync(join(root, path), text)
}

/** A wiki repository with one commit, a bare remote, and the owner's own work in progress. */
const wiki = (name: string, commit = true) => {
  const root = join(scratch, name)
  const remote = join(scratch, `${name}.git`)
  git(scratch, "init", "-q", "--bare", remote)
  git(scratch, "init", "-q", "-b", "main", root)
  git(root, "config", "user.name", "Owner")
  git(root, "config", "user.email", "owner@example.invalid")
  write(root, "Org/Organization.md", organizationPage(commit))
  write(root, "Org/Roles/lead.md", "lead\n")
  write(root, "Org/Roles/docs.md", "docs\n")
  write(root, "Org/Specialists/lead.old.md", "old\n")
  git(root, "add", ".")
  git(root, "commit", "-qm", "wiki")
  git(root, "remote", "add", "origin", remote)
  git(root, "push", "-q", "origin", "main")
  // The owner's edits: one unstaged, one staged, one untracked.
  write(root, "Org/Roles/lead.md", "lead, edited\n")
  write(root, "Org/Roles/docs.md", "docs, staged\n")
  git(root, "add", "Org/Roles/docs.md")
  write(root, "Org/Notes.md", "mine\n")
  return { root, remote }
}

test("commits only what the host wrote, leaves the owner's edits, and never pushes", () => {
  const { root, remote } = wiki("host-writes")
  const before = git(remote, "rev-parse", "main")
  write(root, "Org/Runs/cli-readme/deliver.json", "{}\n")
  write(root, "Org/Runs/meetings/bookings.md", "booked\n")
  write(root, "Org/Specialists/lead.research.md", "hired\n")
  rmSync(join(root, "Org/Specialists/lead.old.md"))
  write(root, "Org/Status.md", "status\n")

  const made = Wiki.commit(root, paths)

  assert.ok(made !== undefined)
  assert.equal(made.message, "organization: record runs cli-readme, meetings; specialists lead.old, lead.research; status")
  assert.equal(made.revision, git(root, "rev-parse", "HEAD"))
  assert.equal(git(root, "log", "-1", "--format=%s"), made.message)
  assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), [
    "Org/Runs/cli-readme/deliver.json",
    "Org/Runs/meetings/bookings.md",
    "Org/Specialists/lead.old.md",
    "Org/Specialists/lead.research.md",
    "Org/Status.md"
  ])
  assert.deepEqual(git(root, "status", "--porcelain").split("\n"), [
    "M  Org/Roles/docs.md",
    " M Org/Roles/lead.md",
    "?? Org/Notes.md"
  ])
  assert.equal(readFileSync(join(root, "Org/Roles/lead.md"), "utf8"), "lead, edited\n")
  assert.equal(git(remote, "rev-parse", "main"), before)
  // Nothing new: no commit.
  assert.equal(Wiki.commit(root, paths), undefined)
})

test("commits a single kind of write, and names the identity only when the repository has none", () => {
  const { root } = wiki("identity")
  git(root, "config", "--unset", "user.email")
  git(root, "config", "--unset", "user.name")
  const global = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = join(scratch, "no-global-config")
  try {
    write(root, "Org/Status.md", "status\n")
    assert.equal(Wiki.commit(root, paths)?.message, "organization: record status")
    assert.equal(git(root, "log", "-1", "--format=%an <%ae>"), "Smithers organization host <organization@localhost>")
  } finally {
    if (global === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = global
  }
  write(root, "Org/Runs/a/x.json", "{}\n")
  write(root, "Org/Runs/b/x.json", "{}\n")
  write(root, "Org/Runs/c/x.json", "{}\n")
  write(root, "Org/Runs/d/x.json", "{}\n")
  write(root, "Org/Runs/e/x.json", "{}\n")
  assert.equal(Wiki.commit(root, paths)?.message, "organization: record runs a, b, c, d +1")
  // Paths outside the configured layout are named by count.
  assert.equal(Wiki.message(["Org/Runs"], ["Other/file.md"]), "organization: record 1 file(s)")
})

test("does nothing outside a git work tree, skips hooks, and reports a commit git refuses", () => {
  const plain = join(scratch, "plain")
  write(plain, "Org/Status.md", "status\n")
  assert.equal(Wiki.commit(plain, paths), undefined)
  assert.deepEqual(Wiki.changed(join(scratch, "missing"), paths), [])
  const { root } = wiki("locked")
  write(root, "Org/Status.md", "status\n")
  writeFileSync(join(root, ".git", "index.lock"), "")
  assert.throws(() => Wiki.commit(root, paths), /^Error: git add: /)
  rmSync(join(root, ".git", "index.lock"))
  write(root, ".git/hooks/pre-commit", "#!/bin/sh\nexit 1\n")
  execFileSync("chmod", ["+x", join(root, ".git/hooks/pre-commit")])
  assert.equal(Wiki.commit(root, paths)?.message, "organization: record status")
  // A rename names both of its paths.
  mkdirSync(join(root, "Org/Runs"), { recursive: true })
  git(root, "mv", "Org/Specialists/lead.old.md", "Org/Runs/moved.md")
  assert.deepEqual(Wiki.changed(root, paths), ["Org/Runs/moved.md", "Org/Specialists/lead.old.md"])
})

test("reads wiki.commit from the organization page", () => {
  const on = wiki("page-on").root
  assert.deepEqual(Wiki.committedPaths(on), paths)
  const off = wiki("page-off", false).root
  assert.equal(Wiki.committedPaths(off), undefined)
  write(off, "Org/Organization.md", "---\nnot: valid\n---\n")
  assert.equal(Wiki.committedPaths(off), undefined)
  assert.equal(Wiki.committedPaths(join(scratch, "missing")), undefined)
})

/** A host serving briefly: started, then stopped. */
const serve = (root: string, lines: Array<string>) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    yield* Effect.forkScoped(Wiki.committer(root, paths, (line) => lines.push(line)))
    yield* Effect.sleep("20 millis")
  })))

test("a serving host commits on its interval and when it stops, and logs a failure", async () => {
  const { root } = wiki("serving")
  const lines: Array<string> = []
  write(root, "Org/Runs/r1/deliver.json", "{}\n")
  await serve(root, lines)
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /^wiki [0-9a-f]{12}: organization: record runs r1$/)
  assert.equal(git(root, "log", "-1", "--format=%s"), "organization: record runs r1")
  write(root, "Org/Runs/r2/deliver.json", "{}\n")
  writeFileSync(join(root, ".git", "index.lock"), "")
  await serve(root, lines)
  assert.match(lines[1]!, /^wiki commit failed: git add: /)
  rmSync(join(root, ".git", "index.lock"))
  // Nothing changed: nothing logged.
  write(root, "Org/Runs/r2/deliver.json", "{}\n")
  git(root, "add", "Org/Runs")
  git(root, "commit", "-qm", "by hand")
  await serve(root, lines)
  assert.equal(lines.length, 2)
})

test("a backup commits the host's writes first, so its revision holds them", async () => {
  const { root } = wiki("backed-up")
  write(root, "Org/Runs/r1/deliver.json", "{}\n")
  const stateDir = join(scratch, "backed-up-state")
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(stateDir, ".env"), `SMITHERS_ORG_ROOT=${root}\n`, { mode: 0o600 })
  const manifest = await backup(stateDir, join(scratch, "backed-up-copy"))
  assert.equal(manifest.wiki?.revision, git(root, "rev-parse", "HEAD"))
  assert.equal(git(root, "log", "-1", "--format=%s"), "organization: record runs r1")
  assert.equal(git(root, "cat-file", "-t", `${manifest.wiki?.revision}:Org/Runs/r1/deliver.json`), "blob")
  // The owner's own edits are still uncommitted, and the manifest says so.
  assert.equal(manifest.wiki?.dirty, true)
})

test("commits the pages roles edited, names the roles, and never writes over the owner's uncommitted work", async () => {
  const { root } = wiki("role-edits")
  const journal = Wiki.journal(root, true)
  const guard = (path: string) => Effect.runPromise(Effect.flip(journal.guard(path)).pipe(Effect.orElseSucceed(() => "allowed")))
  // The owner's unstaged, staged and untracked pages are refused; a clean or new page is not.
  assert.equal(await guard("Org/Roles/lead.md"), "has uncommitted changes the host did not make; commit or discard them first")
  assert.equal(await guard("Org/Roles/docs.md"), "has uncommitted changes the host did not make; commit or discard them first")
  assert.equal(await guard("Org/Notes.md"), "has uncommitted changes the host did not make; commit or discard them first")
  assert.equal(await guard("Org/Organization.md"), "allowed")
  assert.equal(await guard("Org/Team/docs/Onboarding.md"), "allowed")
  // A role's edit is journaled, so its next edit of the same page is allowed.
  write(root, "Org/Team/docs/Onboarding.md", "# Onboarding\n")
  await Effect.runPromise(journal.record({ principal: "docs", path: "Org/Team/docs/Onboarding.md", op: "write", bytes: 13 }))
  assert.equal(await guard("Org/Team/docs/Onboarding.md"), "allowed")
  write(root, "Org/Proposals/2026-09-26-support-inbox.md", "proposal\n")
  Wiki.recordWritten(root, [{ path: "Org/Proposals/2026-09-26-support-inbox.md" }])
  Wiki.recordWritten(root, [])
  assert.deepEqual(Wiki.pending(root).map((entry) => entry.path), [
    "Org/Team/docs/Onboarding.md",
    "Org/Proposals/2026-09-26-support-inbox.md"
  ])
  // A failed commit keeps the journal for the next one.
  writeFileSync(join(root, ".git", "index.lock"), "")
  assert.throws(() => Wiki.commit(root, paths), /^Error: git add: /)
  rmSync(join(root, ".git", "index.lock"))
  write(root, "Org/Team/support/Onboarding.md", "# Support\n")
  Wiki.recordWritten(root, [{ path: "Org/Team/support/Onboarding.md", principal: "support" }])
  assert.equal(Wiki.pending(root).length, 3)
  const made = Wiki.commit(root, paths)
  assert.equal(made?.message, "organization: record edits by docs, support")
  assert.deepEqual(git(root, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), [
    "Org/Proposals/2026-09-26-support-inbox.md",
    "Org/Team/docs/Onboarding.md",
    "Org/Team/support/Onboarding.md"
  ])
  assert.deepEqual(Wiki.pending(root), [])
  // The owner's own edits are untouched.
  assert.deepEqual(git(root, "status", "--porcelain").split("\n"), [
    "M  Org/Roles/docs.md",
    " M Org/Roles/lead.md",
    "?? Org/Notes.md"
  ])
  // A journaled page that did not change commits nothing and clears the journal.
  Wiki.recordWritten(root, [{ path: "Org/Team/docs/Onboarding.md", principal: "docs" }])
  assert.equal(Wiki.commit(root, paths), undefined)
  assert.deepEqual(Wiki.pending(root), [])
  // With wiki.commit off nothing is journaled; outside git nothing is guarded or journaled.
  await Effect.runPromise(Wiki.journal(root, false).record({ principal: "docs", path: "Org/Team/x.md", op: "write", bytes: 1 }))
  assert.deepEqual(Wiki.pending(root), [])
  const plain = join(scratch, "plain-journal")
  write(plain, "Org/Notes.md", "mine\n")
  assert.equal(Wiki.conflict(plain, "Org/Notes.md"), undefined)
  assert.equal(Wiki.journalFile(plain), undefined)
  assert.deepEqual(Wiki.pending(plain), [])
  Wiki.recordWritten(plain, [{ path: "Org/Notes.md" }])
  // A line cut by a crash is skipped.
  writeFileSync(Wiki.journalFile(root)!, "{\"path\":\"Org/Team/a.md\"}\n{\"pa")
  assert.deepEqual(Wiki.pending(root), [{ path: "Org/Team/a.md" }])
  assert.deepEqual(Wiki.hostPaths(JSON.parse(JSON.stringify({ rosterDir: "Org/", wiki: { generatedDir: "Org/Runs/", statusFile: "Org/Status.md" } })), ["Org/Team/"]), [
    "Org/Runs",
    "Org/Specialists",
    "Org/Status.md",
    "Org/Team"
  ])
})

/** A second clone of a wiki's remote, as another writer: `change` is committed and pushed there. */
const otherWriter = (name: string, remote: string, change: (clone: string) => void) => {
  const clone = join(scratch, `${name}-other`)
  rmSync(clone, { recursive: true, force: true })
  git(scratch, "clone", "-q", "-b", "main", remote, clone)
  git(clone, "config", "user.name", "Other")
  git(clone, "config", "user.email", "other@example.invalid")
  change(clone)
  git(clone, "add", "-A")
  git(clone, "commit", "-qm", "other writer")
  git(clone, "push", "-q", "origin", "HEAD:main")
  return git(clone, "rev-parse", "HEAD")
}

const ownerEdits = (root: string) => ({
  lead: readFileSync(join(root, "Org/Roles/lead.md"), "utf8"),
  docs: readFileSync(join(root, "Org/Roles/docs.md"), "utf8"),
  notes: readFileSync(join(root, "Org/Notes.md"), "utf8")
})

test("sync pushes the host's commits, rebasing over another writer's, and keeps the owner's uncommitted edits", () => {
  const { root, remote } = wiki("sync-push")
  const state = join(scratch, "sync-push-state")
  mkdirSync(state, { recursive: true })
  assert.deepEqual(Wiki.sync(root, state), { status: "skipped", message: "the wiki branch has no upstream" })
  assert.deepEqual(Wiki.sync(join(scratch, "missing"), state), { status: "skipped", message: "the wiki is not a git work tree" })
  git(root, "branch", "--set-upstream-to=origin/main")
  assert.deepEqual(Wiki.sync(root, state, 1), { status: "synced", message: "level with origin/main" })
  write(root, "Org/Runs/r1/deliver.json", "{}\n")
  Wiki.commit(root, paths)
  const theirs = otherWriter("sync-push", remote, (clone) => write(clone, "Areas/Theirs.md", "theirs\n"))
  const before = ownerEdits(root)
  assert.deepEqual(Wiki.sync(root, state, 2), { status: "synced", message: "pushed 1 commit(s) to origin/main" })
  assert.equal(git(remote, "rev-parse", "main"), git(root, "rev-parse", "HEAD"))
  assert.equal(git(root, "rev-parse", "HEAD~1"), theirs)
  assert.equal(readFileSync(join(root, "Areas/Theirs.md"), "utf8"), "theirs\n")
  assert.deepEqual(ownerEdits(root), before)
  assert.deepEqual(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).split("\n").filter(Boolean).sort(), [
    " M Org/Roles/lead.md",
    "?? Org/Notes.md",
    "M  Org/Roles/docs.md"
  ])
  assert.deepEqual(Wiki.syncState(state), { syncedAt: 2 })
})

test("sync never forces or discards: a conflicting writer or overlapping owner edits hold it, recorded once", () => {
  const { root, remote } = wiki("sync-conflict")
  const state = join(scratch, "sync-conflict-state")
  mkdirSync(state, { recursive: true })
  git(root, "branch", "--set-upstream-to=origin/main")
  write(root, "Org/Runs/r1/deliver.json", "{\"host\":1}\n")
  Wiki.commit(root, paths)
  const local = git(root, "rev-parse", "HEAD")
  const theirs = otherWriter("sync-conflict", remote, (clone) => write(clone, "Org/Runs/r1/deliver.json", "{\"other\":1}\n"))
  const before = ownerEdits(root)
  const first = Wiki.sync(root, state, 10)
  assert.equal(first.status, "conflict")
  assert.match(first.message, /^rebase onto origin\/main stopped: .*; local commits kept$/)
  assert.equal(first.announce, first.message)
  assert.equal(git(root, "rev-parse", "HEAD"), local)
  assert.equal(git(remote, "rev-parse", "main"), theirs)
  assert.deepEqual(ownerEdits(root), before)
  assert.deepEqual(Wiki.syncState(state), { conflict: { at: 10, message: first.message } })
  // The same conflict again is not announced again.
  const again = Wiki.sync(root, state, 20)
  assert.equal(again.announce, undefined)
  assert.deepEqual(Wiki.syncState(state).conflict, { at: 10, message: first.message })
  // Resolved by hand: the host's next sync succeeds and clears it.
  git(root, "reset", "-q", "--keep", "origin/main")
  assert.equal(Wiki.sync(root, state, 30).status, "synced")
  assert.deepEqual(Wiki.syncState(state), { syncedAt: 30 })

  // The owner's uncommitted edit to a page another writer changed holds the sync.
  otherWriter("sync-conflict", remote, (clone) => write(clone, "Org/Roles/lead.md", "lead, theirs\n"))
  const held = Wiki.sync(root, state, 40)
  assert.deepEqual(held, {
    status: "conflict",
    message: "uncommitted edits to Org/Roles/lead.md overlap upstream changes; commit or discard them",
    announce: "uncommitted edits to Org/Roles/lead.md overlap upstream changes; commit or discard them"
  })
  assert.equal(readFileSync(join(root, "Org/Roles/lead.md"), "utf8"), "lead, edited\n")

  // A refused push and an unreachable remote are failures, retried later.
  git(root, "checkout", "-q", "Org/Roles/lead.md")
  write(root, "Org/Status.md", "status\n")
  Wiki.commit(root, paths)
  write(remote, "hooks/pre-receive", "#!/bin/sh\nexit 1\n")
  execFileSync("chmod", ["+x", join(remote, "hooks/pre-receive")])
  const refused = Wiki.sync(root, state, 50)
  assert.equal(refused.status, "failed")
  assert.match(refused.message, /^git push: /)
  rmSync(remote, { recursive: true, force: true })
  assert.match(Wiki.sync(root, state, 60).message, /^git fetch: /)
})

test("a syncing committer pushes after it commits, and posts a new conflict once", async () => {
  const { root, remote } = wiki("sync-serving")
  const state = join(scratch, "sync-serving-state")
  mkdirSync(state, { recursive: true })
  git(root, "branch", "--set-upstream-to=origin/main")
  const lines: Array<string> = []
  const posted: Array<string> = []
  const serveSyncing = () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* Effect.forkScoped(Wiki.committer(root, paths, (line) => lines.push(line), {
        stateDir: state,
        announce: (text) => Effect.sync(() => posted.push(text))
      }))
      yield* Effect.sleep("20 millis")
    })))
  write(root, "Org/Runs/r1/deliver.json", "{\"host\":1}\n")
  await serveSyncing()
  assert.equal(git(remote, "rev-parse", "main"), git(root, "rev-parse", "HEAD"))
  assert.match(lines.join("\n"), /wiki sync: pushed 1 commit\(s\) to origin\/main/)
  otherWriter("sync-serving", remote, (clone) => write(clone, "Org/Runs/r1/deliver.json", "{\"other\":1}\n"))
  write(root, "Org/Runs/r1/deliver.json", "{\"host\":2}\n")
  await serveSyncing()
  write(root, "Org/Runs/r1/deliver.json", "{\"host\":3}\n")
  await serveSyncing()
  assert.equal(posted.length, 1)
  assert.match(posted[0]!, /^Wiki sync conflict: rebase onto origin\/main stopped: /)
  assert.match(lines.join("\n"), /wiki sync conflict: rebase onto origin\/main stopped/)
  // An announcement that fails is logged, never fatal.
  rmSync(join(state, "wiki-sync.json"))
  write(root, "Org/Runs/r1/deliver.json", "{\"host\":4}\n")
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    yield* Effect.forkScoped(Wiki.committer(root, paths, (line) => lines.push(line), {
      stateDir: state,
      announce: () => Effect.fail("slack down")
    }))
    yield* Effect.sleep("20 millis")
  })))
  assert.match(lines.at(-1)!, /wiki sync conflict could not be posted/)
})

test("doctor's sync check: an upstream that takes a push, or the fix", () => {
  const { root, remote } = wiki("sync-check")
  const none = Wiki.syncCheck(root)
  assert.equal(none.ok, false)
  assert.equal(none.fix, `git -C ${root} branch --set-upstream-to=origin/main`)
  git(root, "branch", "--set-upstream-to=origin/main")
  assert.deepEqual(Wiki.syncCheck(root), { ok: true, detail: `pushes to origin/main (${remote})` })
  assert.equal(git(remote, "rev-parse", "main"), git(root, "rev-parse", "origin/main"))
  rmSync(remote, { recursive: true, force: true })
  const gone = Wiki.syncCheck(root)
  assert.equal(gone.ok, false)
  assert.match(gone.detail, /^origin\/main refuses a push: /)
})
