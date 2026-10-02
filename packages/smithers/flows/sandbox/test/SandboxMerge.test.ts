import { describe, expect, it } from "@effect/vitest"
import { RepositoryMutationTimeoutMs } from "@smthrs/jj/node/NodeJj"
import { Effect, Fiber, FileSystem } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll } from "vitest"
import * as Sandbox from "../src/Sandbox/index.ts"
import * as SandboxMerge from "../src/SandboxMerge/index.ts"
import { output } from "../src/SandboxMerge/Repository.ts"
import { rawPlatform } from "./helpers/containedPlatform.ts"
import {
  advanceMain,
  anonymousJjConfig,
  cleanup,
  commitOf,
  directory,
  gitClone,
  host,
  hostRepository,
  identity,
  quote,
  scratch,
  seeded
} from "./helpers/sandboxRepos.ts"

const root = scratch("sandbox-merge")
const machines = scratch("sandbox-merge-machines")
afterAll(() => cleanup(root, machines))

let counter = 0

// Each test runs real sessions and real jj; a host loaded by parallel suites stretches them past the 30 s default.
const slow = { timeout: 300_000 }
const fresh = (): string => `${root}/${++counter}`

/** Runs a real session on a clone of `repository`'s main that writes `files`, and answers its work. */
const workOn = (repository: string, files: Readonly<Record<string, string>>, session = `s${++counter}`) =>
  Effect.gen(function*() {
    const provider = seeded(yield* directory(machines), gitClone(repository))
    const { work } = yield* Sandbox.run(
      provider,
      { session },
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        for (const [file, content] of Object.entries(files)) yield* fs.writeFileString(file, content)
      })
    )
    return work as Sandbox.Changed
  })

const apply = <E = never, R = never>(
  work: Sandbox.Work,
  options: Partial<SandboxMerge.ApplyOptions<E, R>> & {
    readonly repository: string
  }
) => SandboxMerge.apply(work, { onto: "main", message: "sandbox work", ...options }).pipe(Effect.provide(rawPlatform))

const jj = (repository: string, args: string): string => host(repository, `jj --ignore-working-copy ${args}`)

/** Every visible commit of `change`, one commit id per line. */
const commitsOf = (repository: string, change: string): Array<string> =>
  jj(repository, `log --no-graph -r 'present(change_id(${change}))' -T 'commit_id ++ "\\n"'`).split("\n").filter(
    (line) => line !== ""
  )

const parentOf = (repository: string, commit: string): string =>
  jj(repository, `log --no-graph -r ${commit} -T 'parents.map(|p| p.commit_id()).join(",")'`).trim()

const fileAt = (repository: string, revision: string, path: string): string =>
  jj(repository, `file show -r ${quote(revision)} ${quote(path)}`)

const gitDirOf = (repository: string): string => jj(repository, "git root").trim()

const bookmarks = (repository: string): string => jj(repository, "bookmark list -T 'name ++ \"\\n\"'")

/**
 * Leaves the repository where an `apply` that crashed after importing its
 * change, and before rebasing it, would: the change exists on its base under
 * the temporary `smithers-sandbox/<change>` bookmark.
 */
const crashAfterImport = (repository: string, work: Sandbox.Changed, change: string): string => {
  const git = `git --git-dir ${quote(gitDirOf(repository))}`
  const patch = join(fresh(), "work.patch")
  mkdirSync(join(patch, ".."), { recursive: true })
  writeFileSync(patch, work.patch)
  const index = `GIT_INDEX_FILE=${quote(`${patch}.index`)}`
  host(repository, `${index} ${git} read-tree ${work.base} && ${index} ${git} apply --cached --binary ${quote(patch)}`)
  const tree = host(repository, `${index} ${git} write-tree`).trim()
  const signature = "Crash Test <crash@example.invalid> 1700000000 +0000"
  writeFileSync(
    `${patch}.commit`,
    `tree ${tree}\nparent ${work.base}\nauthor ${signature}\ncommitter ${signature}\nchange-id ${change}\n\ncrashed\n`
  )
  const commit = host(repository, `${git} hash-object -t commit -w --stdin < ${quote(`${patch}.commit`)}`).trim()
  host(
    repository,
    `${git} update-ref refs/heads/smithers-sandbox/${change} ${commit} && jj --ignore-working-copy git import`
  )
  return commit
}

/** A conflicting pair: the guest and the host's later main both rewrite README.md's only line. */
const conflicting = () =>
  Effect.gen(function*() {
    const repo = hostRepository(fresh(), { "README.md": "seed\n", "other.txt": "other\n" })
    const work = yield* workOn(repo.path, { "README.md": "guest\n" })
    const main = advanceMain(repo.path, { "README.md": "host\n" })
    return { repo, work, main }
  })

describe("SandboxMerge.apply", slow, () => {
  it.effect("merges onto a main that moved since the base, with main as the change's parent", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "a.txt": "a\n", "b.txt": "b\n" })
      const work = yield* workOn(repo.path, { "a.txt": "a from the guest\n" })
      const main = advanceMain(repo.path, { "b.txt": "b from the host\n" })
      const outcome = yield* apply(work, { repository: repo.path })
      expect(outcome._tag).toBe("Merged")
      const merged = outcome as SandboxMerge.Merged
      expect(merged.onto).toBe(main)
      expect(parentOf(repo.path, merged.commit)).toBe(main)
      expect(fileAt(repo.path, merged.commit, "a.txt")).toBe("a from the guest\n")
      expect(fileAt(repo.path, merged.commit, "b.txt")).toBe("b from the host\n")
      expect(jj(repo.path, `log --no-graph -r ${merged.commit} -T description`)).toBe("sandbox work\n")
      // The temporary import bookmark is gone, and no working copy moved.
      expect(bookmarks(repo.path)).not.toContain("smithers-sandbox/")
      expect(host(repo.path, "jj log --no-graph -r @ -T 'empty'")).toBe("true")
    }))

  it.live("recovers the same imported change after an active shared Git index lock is released", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "a.txt": "a\n", "b.txt": "b\n" })
      const work = yield* workOn(repo.path, { "a.txt": "captured\n" })
      const main = advanceMain(repo.path, { "b.txt": "host\n" })
      const change = yield* SandboxMerge.changeIdOf(`${work.session}\0${work.base}\0${work.patch}`)
      crashAfterImport(repo.path, work, change)
      const checkout = jj(repo.path, "log --no-graph -r @ -T commit_id")
      writeFileSync(join(repo.path, "untracked.txt"), "unrelated host contents\n")
      const indexLock = join(gitDirOf(repo.path), "index.lock")
      writeFileSync(indexLock, "active writer", { flag: "wx" })
      const bin = join(fresh(), "bin")
      mkdirSync(bin, { recursive: true })
      const saved = process.env.PATH
      const real = host(bin, "command -v jj").trim()
      const failed = join(bin, "failed")
      const calls = join(bin, "calls")
      writeFileSync(
        join(bin, "jj"),
        `#!/bin/sh
case " $* " in
  *" rebase "*) echo attempt >> ${quote(calls)} ;;
esac
# Delegation must not resolve this recording shim again.
PATH=${quote(saved ?? "/usr/bin:/bin")} ${quote(real)} "$@"
code=$?
if [ "$code" != 0 ]; then echo failed > ${quote(failed)}; fi
exit "$code"
`
      )
      chmodSync(join(bin, "jj"), 0o755)
      process.env.PATH = `${bin}:${saved}`
      const [outcome, duplicate] = yield* Effect.acquireUseRelease(
        Effect.forkChild(Effect.all([
          apply(work, { repository: repo.path }),
          apply(work, { repository: repo.path })
        ], { concurrency: 2 })),
        (applying) =>
          Effect.gen(function*() {
            yield* Effect.promise(async (signal) => {
              const deadline = Date.now() + 10_000
              while (!existsSync(failed)) {
                signal.throwIfAborted()
                if (Date.now() >= deadline) throw new Error("jj did not encounter the active index lock")
                await new Promise((resolve) => setTimeout(resolve, 10))
              }
            })
            expect(readFileSync(indexLock, "utf8")).toBe("active writer")
            unlinkSync(indexLock)
            return yield* Fiber.join(applying)
          }),
        (applying) =>
          Fiber.interrupt(applying).pipe(Effect.andThen(Effect.sync(() => {
            process.env.PATH = saved
            if (existsSync(indexLock)) unlinkSync(indexLock)
          })))
      )
      expect(outcome._tag).toBe("Merged")
      const merged = outcome as SandboxMerge.Merged
      expect((duplicate as SandboxMerge.Merged).commit).toBe(merged.commit)
      expect(merged.change).toBe(change)
      expect(merged.onto).toBe(main)
      expect(commitsOf(repo.path, change)).toEqual([merged.commit])
      expect(fileAt(repo.path, merged.commit, "a.txt")).toBe("captured\n")
      expect(fileAt(repo.path, merged.commit, "b.txt")).toBe("host\n")
      expect(bookmarks(repo.path)).not.toContain("smithers-sandbox/")
      expect(readFileSync(join(repo.path, "untracked.txt"), "utf8")).toBe("unrelated host contents\n")
      expect(jj(repo.path, "log --no-graph -r @ -T commit_id")).toBe(checkout)
      const attempts = readFileSync(calls, "utf8").trim().split("\n").length
      expect(attempts).toBeGreaterThan(1)
      expect(attempts).toBeLessThan(5)
      expect(((yield* apply(work, { repository: repo.path })) as SandboxMerge.Merged).commit).toBe(merged.commit)
    }))

  it.live("bounds and cancels contention without discarding captured work or deleting an active lock", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "a.txt": "a\n" })
      const work = yield* workOn(repo.path, { "a.txt": "captured\n" })
      const change = yield* SandboxMerge.changeIdOf(`${work.session}\0${work.base}\0${work.patch}`)
      const captured = crashAfterImport(repo.path, work, change)
      const indexLock = join(gitDirOf(repo.path), "index.lock")
      writeFileSync(indexLock, "active writer", { flag: "wx" })
      yield* Effect.ensuring(
        Effect.gen(function*() {
          const error = yield* Effect.flip(
            apply(work, { repository: repo.path }).pipe(
              Effect.provideService(RepositoryMutationTimeoutMs, 150)
            )
          )
          expect(error.reason).toBe("vcs_failed")
          expect(error.message).toContain("timed out")
          expect(readFileSync(indexLock, "utf8")).toBe("active writer")
          const applying = yield* Effect.forkChild(apply(work, { repository: repo.path }))
          yield* Effect.sleep(150)
          yield* Fiber.interrupt(applying)
          expect(readFileSync(indexLock, "utf8")).toBe("active writer")
          expect(commitsOf(repo.path, change)).toEqual([captured])
          expect(bookmarks(repo.path)).toContain(`smithers-sandbox/${change}`)
          unlinkSync(indexLock)
          const outcome = yield* apply(work, { repository: repo.path })
          expect(outcome._tag).toBe("Merged")
          expect((outcome as SandboxMerge.Merged).change).toBe(change)
          expect(commitsOf(repo.path, change)).toEqual([(outcome as SandboxMerge.Merged).commit])
        }),
        Effect.sync(() => {
          if (existsSync(indexLock)) unlinkSync(indexLock)
        })
      )
    }))

  it.effect("records an overlapping edit as a jj conflict with repository-relative paths by default", () =>
    Effect.gen(function*() {
      const { main, repo, work } = yield* conflicting()
      // This process runs outside the repository, so jj's paths must not be relative to it.
      expect(process.cwd().startsWith(repo.path)).toBe(false)
      const outcome = yield* apply(work, { repository: repo.path })
      expect(outcome._tag).toBe("Conflicted")
      const conflicted = outcome as SandboxMerge.Conflicted
      expect(conflicted.paths).toEqual(["README.md"])
      expect(conflicted.onto).toBe(main)
      expect(commitsOf(repo.path, conflicted.change)).toEqual([conflicted.commit])
      const shown = fileAt(repo.path, conflicted.commit, "README.md")
      expect(shown).toContain("<<<<<<<")
      expect(shown).toContain(">>>>>>>")
      expect(shown).toContain("guest")
      expect(shown).toContain("host")
    }))

  it.effect("abandons the conflicted change and fails with conflict under failOnConflict", () =>
    Effect.gen(function*() {
      const { repo, work } = yield* conflicting()
      const error = yield* Effect.flip(apply(work, { repository: repo.path, strategy: SandboxMerge.failOnConflict }))
      expect(error.reason).toBe("conflict")
      expect(error.paths).toEqual(["README.md"])
      expect(error.message).toContain("in README.md")
      const change = yield* SandboxMerge.changeIdOf(`${work.session}\0${work.base}\0${work.patch}`)
      expect(commitsOf(repo.path, change)).toEqual([])
    }))

  it.effect("accepts a resolver's verified resolution as Merged", () =>
    Effect.gen(function*() {
      const { main, repo, work } = yield* conflicting()
      const seen: Array<SandboxMerge.Conflicted> = []
      const strategy = SandboxMerge.resolveWith((conflicted: SandboxMerge.Conflicted) =>
        Effect.sync(() => {
          seen.push(conflicted)
          // Resolve the way an agent would: edit a child of the change and squash it in.
          host(repo.path, `jj new --quiet ${conflicted.commit}`)
          writeFileSync(join(repo.path, "README.md"), "guest and host\n")
          host(repo.path, "jj squash --quiet -u")
          return { change: conflicted.change }
        })
      )
      const outcome = yield* apply(work, { repository: repo.path, strategy })
      expect(seen).toHaveLength(1)
      expect(seen[0]!._tag).toBe("Conflicted")
      expect(seen[0]!.paths).toEqual(["README.md"])
      expect(outcome._tag).toBe("Merged")
      const merged = outcome as SandboxMerge.Merged
      expect(merged.change).toBe(seen[0]!.change)
      expect(merged.onto).toBe(main)
      expect(merged.commit).not.toBe(seen[0]!.commit)
      expect(fileAt(repo.path, merged.commit, "README.md")).toBe("guest and host\n")
    }))

  it.effect("rejects a resolution that still conflicts, does not descend from onto, or names no single commit", () =>
    Effect.gen(function*() {
      const { repo, work } = yield* conflicting()
      const rejection = (answer: (conflicted: SandboxMerge.Conflicted) => string) =>
        Effect.flip(apply(work, {
          repository: repo.path,
          strategy: SandboxMerge.resolveWith((conflicted: SandboxMerge.Conflicted) =>
            Effect.succeed({ change: answer(conflicted) })
          )
        }))
      const still = yield* rejection((conflicted) => conflicted.change)
      expect(still.reason).toBe("resolution_rejected")
      expect(still.message).toContain("still has conflicts")
      const unrelated = yield* rejection(() => work.base)
      expect(unrelated.reason).toBe("resolution_rejected")
      expect(unrelated.message).toContain("does not descend from")
      const nothing = yield* rejection(() => "no-such-revision")
      expect(nothing.message).toContain("names no commit")
      const empty = yield* rejection(() => "none()")
      expect(empty.message).toContain("must name exactly one commit")
      const two = yield* rejection((conflicted) => `${conflicted.commit} | ${conflicted.onto}`)
      expect(two.message).toContain("must name exactly one commit")
      // Every rejection left the conflicted change as it was.
      const change = yield* SandboxMerge.changeIdOf(`${work.session}\0${work.base}\0${work.patch}`)
      expect(commitsOf(repo.path, change)).toHaveLength(1)
    }))

  it.effect("is idempotent per key: applying the same work twice lands one change", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "a.txt": "a\n" })
      const work = yield* workOn(repo.path, { "a.txt": "twice\n" })
      const first = (yield* apply(work, { repository: repo.path, message: "keyed\n" })) as SandboxMerge.Merged
      const second = (yield* apply(work, { repository: repo.path, message: "keyed\n" })) as SandboxMerge.Merged
      expect(second).toEqual(first)
      expect(commitsOf(repo.path, first.change)).toEqual([first.commit])
      expect(jj(repo.path, `log --no-graph -r ${first.commit} -T description`)).toBe("keyed\n")
      // A different key is a different application of the same work.
      const third = (yield* apply(work, { repository: repo.path, key: "another" })) as SandboxMerge.Merged
      expect(third.change).toBe(yield* SandboxMerge.changeIdOf("another"))
      expect(third.change).not.toBe(first.change)
    }))

  it.effect("finishes an application that crashed between importing the change and rebasing it", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "a.txt": "a\n", "b.txt": "b\n" })
      const work = yield* workOn(repo.path, { "a.txt": "crashed\n" })
      const main = advanceMain(repo.path, { "b.txt": "moved\n" })
      const change = yield* SandboxMerge.changeIdOf("crash")
      const imported = crashAfterImport(repo.path, work, change)
      expect(commitsOf(repo.path, change)).toEqual([imported])
      expect(parentOf(repo.path, imported)).toBe(work.base)
      expect(bookmarks(repo.path)).toContain(`smithers-sandbox/${change}`)
      const outcome = (yield* apply(work, { repository: repo.path, key: "crash" })) as SandboxMerge.Merged
      expect(outcome._tag).toBe("Merged")
      expect(outcome.change).toBe(change)
      expect(outcome.onto).toBe(main)
      expect(parentOf(repo.path, outcome.commit)).toBe(main)
      expect(commitsOf(repo.path, change)).toEqual([outcome.commit])
      expect(bookmarks(repo.path)).not.toContain("smithers-sandbox/")
      expect(host(repo.path, `git --git-dir ${quote(gitDirOf(repo.path))} for-each-ref refs/heads/smithers-sandbox`))
        .toBe("")
    }))

  it.effect("fails with vcs_failed when the key's change has diverged", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "a.txt": "a\n" })
      const work = yield* workOn(repo.path, { "a.txt": "diverged\n" })
      const merged = (yield* apply(work, { repository: repo.path, key: "diverge" })) as SandboxMerge.Merged
      // A second commit carrying the same change id makes the change divergent.
      crashAfterImport(repo.path, work, merged.change)
      expect(commitsOf(repo.path, merged.change)).toHaveLength(2)
      const error = yield* Effect.flip(apply(work, { repository: repo.path, key: "diverge" }))
      expect(error.reason).toBe("vcs_failed")
      expect(error.message).toContain(`the change ${merged.change} names 2 commits`)
    }))

  it.effect("fetches a missing base from the remote and lands on the fetched onto", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const upstream = hostRepository(dir, { "a.txt": "a\n", "b.txt": "b\n" }, "upstream")
      host(dir, `jj git clone --quiet --colocate ${quote(upstream.path)} clone`)
      const clone = join(dir, "clone")
      const stale = commitOf(clone, "main")
      const fetched = advanceMain(upstream.path, { "b.txt": "b upstream\n" })
      const work = yield* workOn(upstream.path, { "a.txt": "a from the guest\n" })
      expect(work.base).toBe(fetched)
      expect(stale).not.toBe(fetched)
      const outcome = (yield* apply(work, { repository: clone })) as SandboxMerge.Merged
      expect(outcome._tag).toBe("Merged")
      // The fetch moved main, and the change sits on the fetched main, not the stale one.
      expect(outcome.onto).toBe(fetched)
      expect(parentOf(clone, outcome.commit)).toBe(fetched)
      expect(fileAt(clone, outcome.commit, "b.txt")).toBe("b upstream\n")
    }))

  it.effect("fetches with the given arguments, and never fetches when fetch is false", () =>
    Effect.gen(function*() {
      const dir = fresh()
      const upstream = hostRepository(dir, { "a.txt": "a\n" }, "upstream")
      host(dir, `jj git clone --quiet --colocate ${quote(upstream.path)} clone`)
      const clone = join(dir, "clone")
      advanceMain(upstream.path, { "a.txt": "upstream\n" })
      const work = yield* workOn(upstream.path, { "new.txt": "new\n" })
      const refused = yield* Effect.flip(apply(work, { repository: clone, fetch: false }))
      expect(refused).toEqual(
        new SandboxMerge.MergeError({
          reason: "base_not_found",
          message: `the work's base ${work.base} is not in ${clone}`
        })
      )
      const wrongRemote = yield* Effect.flip(apply(work, { repository: clone, fetch: ["--remote", "nowhere"] }))
      expect(wrongRemote.reason).toBe("vcs_failed")
      const outcome = yield* apply(work, { repository: clone, fetch: ["--remote", "origin"] })
      expect(outcome._tag).toBe("Merged")
    }))

  it.effect("fails with base_not_found when the base is nowhere to fetch", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "a.txt": "a\n" })
      const elsewhere = hostRepository(fresh(), { "a.txt": "elsewhere\n" })
      const work = yield* workOn(elsewhere.path, { "a.txt": "edit\n" })
      // A repository without remotes fetches nothing; the base is still missing.
      const error = yield* Effect.flip(apply(work, { repository: repo.path, fetch: [] }))
      expect(error.reason).toBe("vcs_failed")
      const unfetched = yield* Effect.flip(apply(work, { repository: repo.path, fetch: false }))
      expect(unfetched.reason).toBe("base_not_found")
    }))

  it.effect("refuses an onto that names no commit or several", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "a.txt": "a\n" })
      const work = yield* workOn(repo.path, { "a.txt": "edit\n" })
      const none = yield* Effect.flip(apply(work, { repository: repo.path, onto: "none()" }))
      expect(none).toEqual(
        new SandboxMerge.MergeError({ reason: "onto_unresolved", message: `none() names 0 commits in ${repo.path}` })
      )
      const two = yield* Effect.flip(apply(work, { repository: repo.path, onto: "main | main-" }))
      expect(two.reason).toBe("onto_unresolved")
      expect(two.message).toContain("names 2 commits")
    }))

  it.effect("rejects a patch that does not apply to its own base and leaves no change", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "a.txt": "a\n" })
      const work = yield* workOn(repo.path, { "a.txt": "edit\n" })
      const corrupted = new Sandbox.Changed({
        ...work,
        patch: work.patch.replace("-a\n", "-not what the base holds\n")
      })
      const error = yield* Effect.flip(apply(corrupted, { repository: repo.path }))
      expect(error.reason).toBe("patch_rejected")
      expect(error.message).toContain(`the patch does not apply to its base ${work.base}`)
      const change = yield* SandboxMerge.changeIdOf(`${work.session}\0${work.base}\0${corrupted.patch}`)
      expect(commitsOf(repo.path, change)).toEqual([])
      // The private index is removed even though the apply failed.
      expect(readdirSync(gitDirOf(repo.path)).filter((name) => name.startsWith("smithers-sandbox-"))).toEqual([])
    }))

  it.effect("signs as Smithers without a jj identity and runs git with the host environment", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "a.txt": "a\n" })
      const work = yield* workOn(repo.path, { "a.txt": "anonymous\n" })
      // A `git` first on PATH that logs each call, then runs the real one.
      const bin = join(fresh(), "bin")
      mkdirSync(bin, { recursive: true })
      const log = join(bin, "calls.log")
      // git's own binary, not a PATH entry that might itself wrap `git` and loop back here.
      const real = `${host(bin, "git --exec-path").trim()}/git`
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\necho "$GIT_INDEX_FILE $*" >> ${quote(log)}\nexec ${quote(real)} "$@"\n`
      )
      chmodSync(join(bin, "git"), 0o755)
      const saved = { PATH: process.env.PATH, JJ_CONFIG: process.env.JJ_CONFIG }
      process.env.PATH = `${bin}:${saved.PATH}`
      process.env.JJ_CONFIG = anonymousJjConfig
      const outcome = yield* Effect.ensuring(
        apply(work, { repository: repo.path }),
        Effect.sync(() => Object.assign(process.env, saved))
      )
      expect(outcome._tag).toBe("Merged")
      const commit = (outcome as SandboxMerge.Merged).commit
      expect(jj(repo.path, `log --no-graph -r ${commit} -T 'author.name() ++ " " ++ author.email()'`)).toBe(
        "Smithers sandbox@smithers.invalid"
      )
      // The private-index commands kept PATH, so they ran through the same `git`.
      const calls = readFileSync(log, "utf8")
      expect(calls).toMatch(/smithers-sandbox-\w+\.index --git-dir \S+ read-tree /)
      expect(calls).toMatch(/smithers-sandbox-\w+\.index --git-dir \S+ write-tree/)
      expect(identity.JJ_CONFIG).toBe(process.env.JJ_CONFIG)
    }))

  it.effect("returns Unchanged work as it is, without touching the repository", () =>
    Effect.gen(function*() {
      const work = new Sandbox.Unchanged({ session: "s", base: "0".repeat(40) })
      expect(yield* apply(work, { repository: "/nonexistent" })).toBe(work)
    }))

  it.effect("reports a host command that cannot start as vcs_failed", () =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.pipe(Effect.provide(rawPlatform))
      const error = yield* Effect.flip(output(spawner, "smthrs-no-such-command", []))
      expect(error.reason).toBe("vcs_failed")
      expect(error.message).toContain("smthrs-no-such-command could not run")
    }))

  it.effect("derives one stable reverse-hex change id per key", () =>
    Effect.gen(function*() {
      const id = yield* SandboxMerge.changeIdOf("key")
      expect(id).toMatch(/^[k-z]{32}$/)
      expect(yield* SandboxMerge.changeIdOf("key")).toBe(id)
      expect(yield* SandboxMerge.changeIdOf("other")).not.toBe(id)
    }))
})
