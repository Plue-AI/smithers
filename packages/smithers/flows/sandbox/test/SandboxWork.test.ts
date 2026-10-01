import { describe, expect, it } from "@effect/vitest"
import { Data, Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { existsSync } from "node:fs"
import { afterAll } from "vitest"
import { sessionSlug } from "../src/internal/sessionSlug.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import * as SandboxMerge from "../src/SandboxMerge/index.ts"
import { rawPlatform } from "./helpers/containedPlatform.ts"
import {
  cleanup,
  commitOf,
  directory,
  gitClone,
  guest,
  host,
  hostRepository,
  identity,
  jjRefresh,
  quote,
  type Recorder,
  scratch,
  seeded
} from "./helpers/sandboxRepos.ts"

const root = scratch("sandbox-work")
const machines = scratch("sandbox-machines")
afterAll(() => cleanup(root, machines))

let counter = 0

// Each test runs real sessions and real jj; a host loaded by parallel suites stretches them past the 30 s default.
const slow = { timeout: 300_000 }
const fresh = (): string => `${root}/${++counter}`

/** Runs `script` in the guest through the body's own host surface, as an agent's shell tool would. */
const shell = (script: string) =>
  Effect.scoped(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", script], { env: identity }))
    const [stdout, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
      concurrency: "unbounded"
    })
    if (code !== 0) return yield* Effect.die(new Error(`guest body \`${script}\` exited ${code}`))
    return stdout
  }))

/** The tree id of the guest checkout's work tree, untracked files included, computed without touching it. */
const guestTree = shell(
  `index="$(git rev-parse --absolute-git-dir)/probe.index"
cp "$(git rev-parse --git-path index)" "$index" 2>/dev/null || true
GIT_INDEX_FILE="$index" git add -A . && GIT_INDEX_FILE="$index" git write-tree; rm -f "$index"`
).pipe(Effect.map((out) => out.trim()))

const treeOf = (repository: string, commit: string): string =>
  host(repository, `git --git-dir "$(jj --ignore-working-copy git root)" rev-parse ${commit}^{tree}`).trim()

const fileAt = (repository: string, revision: string, path: string): string =>
  host(repository, `jj --ignore-working-copy file show -r ${quote(revision)} ${quote(path)}`)

const apply = (work: Sandbox.Work, repository: string) =>
  SandboxMerge.apply(work, { repository, onto: "main", message: "sandbox work" }).pipe(Effect.provide(rawPlatform))

/** The jj operation the host repository is at: unchanged when nothing was written. */
const operation = (repository: string): string =>
  host(repository, "jj --ignore-working-copy op log --no-graph -n 1 -T 'id'").trim()

class BodyFailed extends Data.TaggedError("BodyFailed")<{ readonly reason: string }> {}

const captureLine = "spawn:set -e"

describe("Sandbox.run", slow, () => {
  it.effect("measures a jj-refreshed guest from the host-known commit and lands committed and uncommitted edits", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "README.md": "seed\n" })
      const provider = seeded(yield* directory(machines), jjRefresh(repo.path))
      const { result, work } = yield* Sandbox.run(
        provider,
        { session: "jj-refresh" },
        Effect.gen(function*() {
          // The refresh left `@` an empty commit only the guest has, and git's HEAD on the host's main.
          const guestOnly = (yield* shell("jj log --no-graph -r @ -T commit_id")).trim()
          const fs = yield* FileSystem.FileSystem
          yield* fs.writeFileString("committed.txt", "committed\n")
          yield* shell("jj describe --quiet -m 'guest commit' && jj new --quiet")
          yield* fs.writeFileString("uncommitted.txt", "uncommitted\n")
          yield* fs.writeFileString("README.md", "seed\nedited\n")
          return guestOnly
        })
      )
      expect(host(repo.path, `jj --ignore-working-copy log --no-graph -r 'present(${result})' -T commit_id`)).toBe("")
      expect(work._tag).toBe("Changed")
      // The base is the commit the host knows, not the guest's own `@`.
      expect(work.base).toBe(repo.main)
      expect(work.session).toBe("jj-refresh")
      const outcome = yield* apply(work, repo.path)
      expect(outcome._tag).toBe("Merged")
      const merged = outcome as SandboxMerge.Merged
      expect(merged.onto).toBe(repo.main)
      expect(fileAt(repo.path, merged.commit, "committed.txt")).toBe("committed\n")
      expect(fileAt(repo.path, merged.commit, "uncommitted.txt")).toBe("uncommitted\n")
      expect(fileAt(repo.path, merged.commit, "README.md")).toBe("seed\nedited\n")
    }))

  it.effect("captures committed, uncommitted, binary, renamed, deleted and mode-changed files byte for byte", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), {
        "keep.txt": "keep\n",
        "old-name.txt": "a file that moves\nwith several lines\nso rename detection pairs it\n",
        "doomed.txt": "deleted in the guest\n",
        "script.sh": "#!/bin/sh\necho hi\n",
        "nested/dir/file.txt": "nested\n"
      })
      const provider = seeded(yield* directory(machines), gitClone(repo.path))
      const binary = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x0a, 0x00, 0xc3, 0x28, 0x7f])
      const { result: guestTree_, work } = yield* Sandbox.run(
        provider,
        { session: "every-kind" },
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          yield* fs.writeFileString("keep.txt", "keep\ncommitted line\n")
          yield* shell("git mv old-name.txt new-name.txt && git commit -q -am 'guest commit'")
          yield* fs.writeFile("blob.bin", binary)
          yield* fs.remove("doomed.txt")
          yield* shell("chmod +x script.sh")
          yield* fs.writeFileString("nested/dir/file.txt", "nested\nuncommitted\n")
          yield* fs.writeFileString("untracked new.txt", "spaces in the name\n")
          return yield* guestTree
        })
      )
      expect(work._tag).toBe("Changed")
      const patch = (work as Sandbox.Changed).patch
      expect(patch).toContain("rename from old-name.txt")
      expect(patch).toContain("GIT binary patch")
      expect(patch).toContain("deleted file mode 100644")
      expect(patch).toContain("old mode 100644\nnew mode 100755")
      const outcome = yield* apply(work, repo.path)
      expect(outcome._tag).toBe("Merged")
      // Equal tree ids mean every path, byte and mode matches the guest's final tree.
      expect(treeOf(repo.path, (outcome as SandboxMerge.Merged).commit)).toBe(guestTree_)
      expect(
        host(
          repo.path,
          `jj --ignore-working-copy file show -r ${(outcome as SandboxMerge.Merged).commit} blob.bin | od -An -tx1`
        ).replace(/\s+/g, " ").trim()
      )
        .toBe("00 ff fe 80 0a 00 c3 28 7f")
    }))

  it.effect("reports a session that changed nothing as Unchanged, which applies as nothing", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "a.txt": "a\n" })
      const provider = seeded(yield* directory(machines), jjRefresh(repo.path))
      const { work } = yield* Sandbox.run(
        provider,
        { session: "idle" },
        shell("jj describe --quiet -m 'empty' && jj new --quiet")
      )
      expect(work).toEqual(new Sandbox.Unchanged({ session: "idle", base: repo.main }))
      const before = operation(repo.path)
      const outcome = yield* apply(work, repo.path)
      expect(outcome).toBe(work)
      expect(operation(repo.path)).toBe(before)
    }))

  it.effect("captures before the machine is released, so work survives a provider that deletes it", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "a.txt": "a\n" })
      const recorder: Recorder = { events: [] }
      const provider = seeded(yield* directory(machines), gitClone(repo.path), recorder)
      let workdir = ""
      const sandboxed = yield* Sandbox.run(
        provider,
        { session: "durable" },
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          yield* fs.writeFileString("a.txt", "a\nfrom the guest\n")
          workdir = (yield* shell("pwd -P")).trim()
          return 7
        })
      )
      // The provider removed the machine's directory on release, after the capture.
      expect(existsSync(workdir)).toBe(false)
      const capture = recorder.events.indexOf(captureLine)
      expect(capture).toBeGreaterThan(-1)
      expect(recorder.events.indexOf("release")).toBeGreaterThan(capture)
      expect(recorder.events.at(-1)).toBe("release")
      // The result and the work cross a journal as JSON and still apply.
      const codec = Sandbox.Sandboxed(Schema.Number)
      const journaled = JSON.stringify(Schema.encodeSync(codec)(sandboxed))
      const decoded = Schema.decodeSync(codec)(JSON.parse(journaled))
      expect(decoded.result).toBe(7)
      expect(decoded.work).toBeInstanceOf(Sandbox.Changed)
      expect(decoded.work).toEqual(sandboxed.work)
      const outcome = yield* apply(decoded.work, repo.path)
      expect(outcome._tag).toBe("Merged")
      expect(fileAt(repo.path, (outcome as SandboxMerge.Merged).commit, "a.txt")).toBe("a\nfrom the guest\n")
    }))

  it.effect("measures from a named base in a checkout below the workdir", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "a.txt": "a\n" })
      const second = commitOf(repo.path, "main")
      const provider = seeded(
        yield* directory(machines),
        (session) => guest(session, `git clone -q --branch main ${quote(repo.path)} repo`)
      )
      let checkout = ""
      const { work } = yield* Sandbox.run(
        provider,
        { session: "below", base: "main", checkout: `${machines}/${sessionSlug("below")}/repo` },
        Effect.gen(function*() {
          checkout = (yield* shell("cd repo && pwd -P")).trim()
          yield* shell("cd repo && echo more >> a.txt")
        })
      )
      expect(checkout).toBe(`${machines}/${sessionSlug("below")}/repo`)
      expect(work.base).toBe(second)
      expect((work as Sandbox.Changed).patch).toContain("+more")
    }))

  it.effect("fails with the body's error and captures nothing when the body fails", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "a.txt": "a\n" })
      const recorder: Recorder = { events: [] }
      const provider = seeded(yield* directory(machines), gitClone(repo.path), recorder)
      const error = yield* Effect.flip(
        Sandbox.run(provider, { session: "failing" }, Effect.fail(new BodyFailed({ reason: "no" })))
      )
      expect(error).toEqual(new BodyFailed({ reason: "no" }))
      expect(recorder.events).not.toContain(captureLine)
      expect(recorder.events.at(-1)).toBe("release")
    }))

  it.effect("refuses a checkout that is not a git work tree's top as not_a_repository", () =>
    Effect.gen(function*() {
      const empty = yield* Effect.flip(
        Sandbox.run(seeded(yield* directory(machines), () => Effect.void), { session: "empty" }, Effect.void)
      )
      expect(empty).toBeInstanceOf(Sandbox.CaptureError)
      expect((empty as Sandbox.CaptureError).reason).toBe("not_a_repository")
      const repo = hostRepository(fresh(), { "sub/a.txt": "a\n" })
      const nested = yield* Effect.flip(
        Sandbox.run(seeded(yield* directory(machines), gitClone(repo.path)), {
          session: "nested",
          checkout: `${machines}/${sessionSlug("nested")}/sub`
        }, Effect.void)
      )
      expect((nested as Sandbox.CaptureError).reason).toBe("not_a_repository")
      expect((nested as Sandbox.CaptureError).message).toContain(`${machines}/${sessionSlug("nested")}/sub`)
    }))

  it.effect("refuses a base revision the checkout cannot resolve as base_unresolved", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "a.txt": "a\n" })
      const provider = seeded(yield* directory(machines), gitClone(repo.path))
      const error = yield* Effect.flip(Sandbox.run(provider, { session: "bad-base", base: "no-such-ref" }, Effect.void))
      expect(error).toEqual(
        new Sandbox.CaptureError({
          reason: "base_unresolved",
          message: `no-such-ref names no commit in ${machines}/${sessionSlug("bad-base")}`
        })
      )
    }))
})

describe("Sandbox.capture and Sandbox.resolveBase", slow, () => {
  it.effect("resolve HEAD by default and refuse a base the checkout lacks", () =>
    Effect.gen(function*() {
      const repo = hostRepository(fresh(), { "a.txt": "a\n" })
      const provider = seeded(yield* directory(machines), gitClone(repo.path))
      const outcome = yield* Effect.scoped(Effect.gen(function*() {
        const session = yield* provider.acquire("direct")
        const base = yield* Sandbox.resolveBase(session)
        const missing = yield* Effect.flip(Sandbox.capture(session, { base: "0".repeat(40) }))
        const unchanged = yield* Sandbox.capture(session, { base })
        return { base, missing, unchanged }
      }))
      expect(outcome.base).toBe(repo.main)
      expect((outcome.missing as Sandbox.CaptureError).reason).toBe("base_unresolved")
      expect(outcome.unchanged).toEqual(new Sandbox.Unchanged({ session: "direct", base: repo.main }))
    }))

  it.effect("treat a guest without git as not_a_repository and any other git failure as capture_failed", () =>
    Effect.gen(function*() {
      const noGit = Sandbox.TestSession.make({ workdir: "/work" })
      const missing = yield* Effect.flip(
        Effect.scoped(Effect.flatMap(noGit.acquire("no-git"), (session) => Sandbox.resolveBase(session)))
      )
      expect(missing).toEqual(
        new Sandbox.CaptureError({
          reason: "not_a_repository",
          message: "/work is not the top of a git work tree in the session"
        })
      )
      const broken = Sandbox.TestSession.make({
        workdir: "/work",
        script: () => ({ exitCode: 128, stderr: "fatal: one\nfatal: two\nfatal: three\nfatal: index corrupt\n" })
      })
      const failed = yield* Effect.flip(
        Effect.scoped(Effect.flatMap(broken.acquire("broken"), (session) => Sandbox.capture(session, { base: "abc" })))
      )
      expect(failed).toEqual(
        new Sandbox.CaptureError({
          reason: "capture_failed",
          message: "git exited 128 in /work: fatal: two\nfatal: three\nfatal: index corrupt"
        })
      )
    }))
})

describe("Sandbox.hostContext", () => {
  it.effect("serves a held session's paths in its own dialect, trimming trailing slashes except at a root", () =>
    Effect.gen(function*() {
      const resolved = (workdir: string, ...paths: ReadonlyArray<string>) =>
        Effect.scoped(Effect.gen(function*() {
          const session = yield* Sandbox.TestSession.make({ workdir }).acquire("paths")
          const context = yield* Sandbox.hostContext(session)
          const path = yield* Effect.provide(Path.Path, context)
          return paths.map((each) => path.resolve(each))
        }))
      expect(yield* resolved("C:\\work", "C:/", "D:/other/", "sub/")).toEqual(["C:/", "D:/other", "C:/work/sub"])
      expect(yield* resolved("/guest/work", "/", "/a/b/", "sub/")).toEqual(["/", "/a/b", "/guest/work/sub"])
    }))
})
