/**
 * The checkpoint, against real repositories.
 *
 * Every case here builds a real temporary git repository (and a real jj one
 * where `jj` is on PATH) and runs the real binaries: a checkpoint that only
 * works against a mocked spawner proves nothing about the working copy it is
 * supposed to protect.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Checkpoint from "@smthrs/migrate/flow/Checkpoint"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { userInfo } from "node:os"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

const platform = NodeServices.layer

const has = (binary: string): boolean => {
  try {
    execFileSync(binary, ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const jjAvailable = has("jj")

const temporaries: Array<string> = []
const scratch = (name: string): string => {
  const target = mkdtempSync(join(tmpdir(), `migrate-checkpoint-${name}-`))
  temporaries.push(target)
  return target
}
process.on("exit", () => {
  for (const target of temporaries) rmSync(target, { recursive: true, force: true })
})

const write = (root: string, file: string, text: string): void => {
  mkdirSync(join(root, file, "..").replace(/\/\.\.$/, ""), { recursive: true })
  writeFileSync(join(root, file), text)
}

/** Every file under `directory`, as paths relative to it. */
const listRecursive = (directory: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  const visit = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current)) {
      const absolute = join(current, entry)
      const key = prefix === "" ? entry : `${prefix}/${entry}`
      if (statSync(absolute).isDirectory()) visit(absolute, key)
      else found.push(key)
    }
  }
  visit(directory, "")
  return found
}

const gitProject = (name: string): string => {
  const root = scratch(name)
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: root, stdio: "ignore" })
  git("init", "-q")
  git("config", "user.email", "lane@local")
  git("config", "user.name", "lane")
  git("config", "commit.gpgsign", "false")
  write(root, "workflow.jsx", "old workflow\n")
  write(root, "README.md", "committed readme\n")
  git("add", "-A")
  git("commit", "-q", "-m", "baseline")
  return root
}

const payload = (root: string, files: ReadonlyArray<string>, allowNoVcs = false) => ({
  root,
  unit: "workflow:demo",
  files,
  backupDir: join(root, ".smithers-migrate", "backup"),
  allowNoVcs
})

describe("Checkpoint.detectVcs", () => {
  it.effect("reports none for a plain directory and git for a repository", () =>
    Effect.gen(function*() {
      expect(yield* Checkpoint.detectVcs(scratch("plain"))).toBe("none")
      expect(yield* Checkpoint.detectVcs(gitProject("detect"))).toBe("git")
    }).pipe(Effect.provide(platform)))

  it.effect("follows a relative Git worktree pointer and refuses a dangling one", () =>
    Effect.gen(function*() {
      const main = gitProject("linked-detect")
      const linked = scratch("linked-detect-worktree")
      execFileSync("git", ["worktree", "add", "--detach", linked, "HEAD"], { cwd: main, stdio: "ignore" })
      const gitFile = join(linked, ".git")
      const original = readFileSync(gitFile, "utf8")
      const metadata = original.trim().slice("gitdir: ".length)
      try {
        writeFileSync(gitFile, `gitdir: ${relative(linked, metadata)}\r\n`)
        expect(yield* Checkpoint.detectVcs(linked)).toBe("git")
        writeFileSync(gitFile, "gitdir: missing-worktree-metadata\n")
        expect(yield* Checkpoint.detectVcs(linked)).toBe("none")
      } finally {
        writeFileSync(gitFile, original)
        execFileSync("git", ["worktree", "remove", "--force", linked], { cwd: main, stdio: "ignore" })
      }
    }).pipe(Effect.provide(platform)))
})

describe("Checkpoint.take on git", () => {
  it.effect("refuses to overwrite an unresolved checkpoint before changing any backup bytes", () =>
    Effect.gen(function*() {
      const root = gitProject("pending-retry")
      const requested = payload(root, ["workflow.jsx"])
      const first = yield* Checkpoint.take(requested)
      const marker = join(root, ".smithers-migrate", "pending-unit.json")
      const markerBytes = readFileSync(marker)
      const backupBytes = readFileSync(join(first.backup, "workflow.jsx"))
      const treeBytes = readFileSync(first.tree)
      write(root, "workflow.jsx", "half migrated\n")
      const refused = yield* Effect.flip(Checkpoint.take(requested))
      expect(refused.code).toBe("checkpoint-failed")
      expect(refused.message).toContain(marker)
      expect(readFileSync(marker)).toEqual(markerBytes)
      expect(readFileSync(join(first.backup, "workflow.jsx"))).toEqual(backupBytes)
      expect(readFileSync(first.tree)).toEqual(treeBytes)
      yield* Checkpoint.restore(root, first, ["workflow.jsx"])
      expect(readFileSync(join(root, "workflow.jsx"), "utf8")).toBe("old workflow\n")
      yield* Checkpoint.clearPending(requested.backupDir, first)
      yield* Checkpoint.take(requested)
    }).pipe(Effect.provide(platform)))

  it.effect("leaves a recovery instruction before any transform can start", () =>
    Effect.gen(function*() {
      const root = gitProject("pending")

      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx", "flows/demo/flow.ts"]))
      write(root, "workflow.jsx", "half migrated\n")

      const marker = join(root, ".smithers-migrate", "pending-unit.json")
      const pending = JSON.parse(readFileSync(marker, "utf8")) as {
        unit: string
        root: string
        checkpoint: { ref: string; restore: string }
        instruction: string
      }
      expect(pending.unit).toBe("workflow:demo")
      expect(pending.root).toBe(root)
      expect(pending.checkpoint).toMatchObject({ ref: ref.ref, restore: ref.restore })
      expect(pending.instruction).toContain(ref.restore)
    }).pipe(Effect.provide(platform)))

  it.effect("writes a ref, leaves the working tree alone, and survives an unrelated dirty file", () =>
    Effect.gen(function*() {
      const root = gitProject("ref")
      // Work nobody asked the migration to touch, uncommitted on purpose.
      write(root, "unrelated.txt", "the operator's own edit\n")
      write(root, "README.md", "edited readme\n")

      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx", "flows/demo/flow.ts"]))

      expect(ref.vcs).toBe("git")
      expect(ref.ref).toMatch(/^refs\/smithers-migrate\/workflow-demo\/\d+$/)
      expect(ref.restore).toBe(`git checkout ${ref.ref} -- .`)
      expect(ref.files).toEqual(["workflow.jsx"])
      // The ref exists and the working tree still holds both dirty files.
      expect(execFileSync("git", ["rev-parse", "--verify", ref.ref], { cwd: root }).toString().trim()).toHaveLength(40)
      expect(readFileSync(join(root, "unrelated.txt"), "utf8")).toBe("the operator's own edit\n")
      expect(readFileSync(join(root, "README.md"), "utf8")).toBe("edited readme\n")
      expect(readFileSync(join(root, "workflow.jsx"), "utf8")).toBe("old workflow\n")
      // `git stash list` is never disturbed: this is a ref, not a stash entry.
      expect(execFileSync("git", ["stash", "list"], { cwd: root }).toString()).toBe("")
    }).pipe(Effect.provide(platform)))

  for (
    const component of [
      ".smithers-migrate",
      ".smithers-migrate/backup",
      ".smithers-migrate/backup/workflow",
      ".smithers-migrate/backup/workflow/demo/nested",
      ".smithers-migrate/backup/workflow/demo/nested/private.env"
    ]
  ) {
    it.effect(`refuses a symlink at backup component ${component}`, () =>
      Effect.gen(function*() {
        const root = gitProject("backup-symlink")
        const outside = scratch("outside-backup")
        write(root, "nested/private.env", "secret bytes\n")
        write(outside, "sentinel", "outside bytes\n")
        mkdirSync(join(root, component, ".."), { recursive: true })
        symlinkSync(component.endsWith(".env") ? join(outside, "sentinel") : outside, join(root, component))

        const result = yield* Effect.result(Checkpoint.take(payload(root, ["nested/private.env"])))

        expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside bytes\n")
        expect(listRecursive(outside)).toEqual(["sentinel"])
        expect(result._tag).toBe("Failure")
      }).pipe(Effect.provide(platform)))
  }

  for (const leaf of [false, true]) {
    it.effect(`refuses a symlinked post-checkpoint ${leaf ? "file" : "directory"} before deleting an addition`, () =>
      Effect.gen(function*() {
        const root = gitProject("post-backup-symlink")
        const ref = yield* Checkpoint.take({
          ...payload(root, ["workflow.jsx"]),
          treeExclude: [".smithers-migrate"]
        })
        const outside = scratch("outside-post-backup")
        write(outside, "sentinel", "outside bytes\n")
        write(root, "added.env", "new secret bytes\n")
        const directory = `${ref.backup}.post-checkpoint`
        if (leaf) mkdirSync(directory)
        symlinkSync(leaf ? join(outside, "sentinel") : outside, leaf ? join(directory, "added.env") : directory)

        const result = yield* Effect.result(Checkpoint.rollback(root, ref, { paths: ["workflow.jsx"] }))

        expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside bytes\n")
        expect(listRecursive(outside)).toEqual(["sentinel"])
        expect(readFileSync(join(root, "added.env"), "utf8")).toBe("new secret bytes\n")
        expect(result._tag).toBe("Failure")
      }).pipe(Effect.provide(platform)))
  }

  for (const through of ["file", "directory"] as const) {
    it.effect(`refuses a declared source reached through a symlinked ${through}`, () =>
      Effect.gen(function*() {
        // Copying through the link would put a file from outside the project
        // into the backup; a later restore would write the backup through it.
        const root = gitProject("source-symlink")
        const outside = scratch("outside-source")
        write(outside, "shared.ts", "outside bytes\n")
        symlinkSync(
          through === "file" ? join(outside, "shared.ts") : outside,
          join(root, through === "file" ? "shared.ts" : "linked")
        )
        const declared = through === "file" ? "shared.ts" : "linked/shared.ts"

        const failure = yield* Effect.flip(Checkpoint.take(payload(root, [declared])))

        expect(failure.code).toBe("checkpoint-failed")
        expect(failure.message).toContain("symbolic link")
        expect(existsSync(join(root, ".smithers-migrate/backup/workflow/demo", declared))).toBe(false)
        expect(listRecursive(outside)).toEqual(["shared.ts"])
      }).pipe(Effect.provide(platform)))
  }

  it.effect("refuses to restore through a target that became a symlink after the checkpoint", () =>
    Effect.gen(function*() {
      const root = gitProject("restore-symlink")
      const outside = scratch("outside-restore")
      write(outside, "shared.ts", "outside bytes\n")
      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx"]))
      rmSync(join(root, "workflow.jsx"))
      symlinkSync(join(outside, "shared.ts"), join(root, "workflow.jsx"))

      const failure = yield* Effect.flip(Checkpoint.restore(root, ref, ["workflow.jsx"]))

      expect(failure.code).toBe("checkpoint-failed")
      expect(failure.message).toContain("symbolic link")
      expect(readFileSync(join(outside, "shared.ts"), "utf8")).toBe("outside bytes\n")
    }).pipe(Effect.provide(platform)))

  it.effect("records a symlinked file in the tree by what it names, never by the bytes behind it", () =>
    Effect.gen(function*() {
      const root = gitProject("tree-file-link")
      const outside = scratch("outside-tree")
      write(outside, "shared.ts", "outside bytes\n")
      symlinkSync(join(outside, "shared.ts"), join(root, "shared.ts"))
      const ref = yield* Checkpoint.take({ ...payload(root, ["workflow.jsx"]), treeExclude: [".smithers-migrate"] })

      write(outside, "shared.ts", "outside bytes, edited elsewhere\n")

      expect(yield* Checkpoint.treeDiff(root, ref)).toEqual([])
    }).pipe(Effect.provide(platform)))

  it.effect("digests a run-state link by what it names and never walks through it", () =>
    Effect.gen(function*() {
      const root = gitProject("digest-link")
      const outside = scratch("outside-digest")
      write(outside, "secret.db", "outside bytes\n")
      mkdirSync(join(root, ".smithers"), { recursive: true })
      symlinkSync(outside, join(root, ".smithers", "state"))

      const digests = yield* Checkpoint.digest(root, [".smithers"])

      expect(digests.map((entry) => entry.path)).toEqual([".smithers/state"])
    }).pipe(Effect.provide(platform)))

  it.effect("refuses dangling links and privately replaces regular backup files", () =>
    Effect.gen(function*() {
      for (const link of [false, true]) {
        const root = gitProject("existing-backup")
        const outside = scratch("dangling-backup")
        const directory = join(root, ".smithers-migrate/backup/workflow/demo")
        mkdirSync(directory, { recursive: true })
        const destination = join(directory, "workflow.jsx")
        if (link) symlinkSync(join(outside, "missing"), destination)
        else writeFileSync(destination, "earlier recovery bytes\n")

        const result = yield* Effect.result(Checkpoint.take(payload(root, ["workflow.jsx"])))

        expect(result._tag).toBe(link ? "Failure" : "Success")
        expect(readdirSync(outside)).toEqual([])
        if (!link) {
          expect(readFileSync(destination, "utf8")).toBe("old workflow\n")
          expect(statSync(destination).mode & 0o777).toBe(0o600)
        }
      }
    }).pipe(Effect.provide(platform)))

  it.effect("keeps checkpoint and post-checkpoint copies private under umask 022", () =>
    Effect.gen(function*() {
      const root = gitProject("private-backup")
      write(root, "nested/private.env", "secret bytes\n")
      chmodSync(join(root, "nested/private.env"), 0o600)
      // Command may have already created the report directory with default permissions.
      mkdirSync(join(root, ".smithers-migrate"), { mode: 0o755 })
      const previous = process.umask(0o022)
      try {
        const ref = yield* Checkpoint.take({
          ...payload(root, ["nested/private.env"]),
          treeExclude: [".smithers-migrate"]
        })
        expect(statSync(join(ref.backup, "nested/private.env")).mode & 0o777).toBe(0o600)
        for (
          const directory of [
            ".smithers-migrate",
            ".smithers-migrate/backup",
            ".smithers-migrate/backup/workflow",
            ".smithers-migrate/backup/workflow/demo",
            ".smithers-migrate/backup/workflow/demo/nested"
          ]
        ) {
          expect(statSync(join(root, directory)).mode & 0o777).toBe(0o700)
        }
        expect(ref.entries[0]?.mode).toBe(0o600)
        write(root, "new/private.env", "new secret bytes\n")
        chmodSync(join(root, "new/private.env"), 0o600)
        const rolled = yield* Checkpoint.rollback(root, ref, { paths: ["nested/private.env"] })
        const preserved = rolled.deletedAdds.find((entry) => entry.path === "new/private.env")!
        expect(readFileSync(preserved.backup, "utf8")).toBe("new secret bytes\n")
        expect(statSync(preserved.backup).mode & 0o777).toBe(0o600)
        expect(statSync(`${ref.backup}.post-checkpoint`).mode & 0o777).toBe(0o700)
        expect(statSync(join(`${ref.backup}.post-checkpoint`, "new")).mode & 0o777).toBe(0o700)
      } finally {
        process.umask(previous)
      }
    }).pipe(Effect.provide(platform)))

  it.effect("recovers dirty tracked bytes with the advertised native Git command", () =>
    Effect.gen(function*() {
      const root = gitProject("git-recovery")
      const git = (...args: Array<string>) => execFileSync("git", args, { cwd: root }).toString().trim()
      write(root, "README.md", "staged readme\n")
      git("add", "README.md")
      write(root, "README.md", "unstaged readme\n")
      expect(git("show", "HEAD:README.md")).toBe("committed readme")
      expect(git("show", ":README.md")).toBe("staged readme")

      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx"]))

      expect(git("rev-parse", `${ref.ref}^{tree}`)).not.toBe(git("rev-parse", "HEAD^{tree}"))
      expect(git("show", `${ref.ref}:README.md`)).toBe("unstaged readme")
      expect(git("show", ":README.md")).toBe("staged readme")
      write(root, "README.md", "migration overwrote this\n")
      write(root, "workflow.jsx", "migration overwrote this too\n")
      execFileSync("sh", ["-c", ref.restore], { cwd: root })
      expect(readFileSync(join(root, "README.md"), "utf8")).toBe("unstaged readme\n")
      expect(readFileSync(join(root, "workflow.jsx"), "utf8")).toBe("old workflow\n")
    }).pipe(Effect.provide(platform)))

  it.effect("restores the mode a file carried, executable and read-only bits included", () =>
    Effect.gen(function*() {
      const root = gitProject("modes")
      write(root, "bin/run.sh", "#!/bin/sh\necho hi\n")
      chmodSync(join(root, "bin", "run.sh"), 0o755)
      chmodSync(join(root, "workflow.jsx"), 0o444)

      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx", "bin/run.sh"]))

      expect(ref.entries.find((entry) => entry.path === "bin/run.sh")?.mode).toBe(0o755)
      expect(ref.entries.find((entry) => entry.path === "workflow.jsx")?.mode).toBe(0o444)

      // What a unit does: deletes one, rewrites the other. The read-only file
      // is made writable first, which is what any editor has to do.
      rmSync(join(root, "bin", "run.sh"))
      chmodSync(join(root, "workflow.jsx"), 0o644)
      writeFileSync(join(root, "workflow.jsx"), "migrated\n")

      yield* Checkpoint.restore(root, ref, ["workflow.jsx", "bin/run.sh"])

      expect(statSync(join(root, "bin", "run.sh")).mode & 0o777).toBe(0o755)
      expect(statSync(join(root, "workflow.jsx")).mode & 0o777).toBe(0o444)
      expect(readFileSync(join(root, "workflow.jsx"), "utf8")).toBe("old workflow\n")
      chmodSync(join(root, "workflow.jsx"), 0o644)
    }).pipe(Effect.provide(platform)))

  it.effect("restores a checkpoint recorded before entries carried a mode, the way it always did", () =>
    Effect.gen(function*() {
      const root = gitProject("modeless")
      const taken = yield* Checkpoint.take(payload(root, ["workflow.jsx"]))
      // An older checkpoint has no mode field; restore must not demand one.
      const ref = {
        ...taken,
        entries: taken.entries.map((entry) => ({
          path: entry.path,
          state: entry.state,
          ...(entry.digest === undefined ? {} : { digest: entry.digest })
        }))
      }

      write(root, "workflow.jsx", "migrated\n")
      yield* Checkpoint.restore(root, ref, ["workflow.jsx"])

      expect(readFileSync(join(root, "workflow.jsx"), "utf8")).toBe("old workflow\n")
    }).pipe(Effect.provide(platform)))

  it.effect("digests an absolute run-state root where it is, keyed by its own path", () =>
    Effect.gen(function*() {
      const root = gitProject("absolute-digest")
      // Gateway state lives outside the project; joining it under the root
      // used to digest a path that holds nothing and call the file covered.
      const gateway = join(scratch("gateway"), "smithers-gateway")
      mkdirSync(gateway, { recursive: true })
      writeFileSync(join(gateway, "workspace.json"), `{"workspace":${JSON.stringify(root)}}\n`)

      const digested = yield* Checkpoint.digest(root, [gateway])

      expect(digested).toEqual([{
        path: join(gateway, "workspace.json"),
        digest: createHash("sha256").update(readFileSync(join(gateway, "workspace.json"))).digest("hex")
      }])
    }).pipe(Effect.provide(platform)))

  it.effect("leaves the report directory without a temporary file behind every JSON it writes", () =>
    Effect.gen(function*() {
      const root = gitProject("atomic")

      yield* Checkpoint.take(payload(root, ["workflow.jsx"]))

      // The pending marker and the tree manifest land atomically: a crash
      // mid-write leaves a `.tmp-<pid>-<n>` file, a finished write leaves
      // none.
      const reportDir = join(root, ".smithers-migrate")
      const leftovers = listRecursive(reportDir).filter((entry) => entry.includes(".tmp-"))
      expect(leftovers).toEqual([])
    }).pipe(Effect.provide(platform)))

  it.effect("diffs only the paths the unit touched, and restores only those", () =>
    Effect.gen(function*() {
      const root = gitProject("diff")
      write(root, "unrelated.txt", "operator work\n")
      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx", "flows/demo/flow.ts"]))

      write(root, "workflow.jsx", "migrated workflow\n")
      write(root, "flows/demo/flow.ts", "export default 1\n")
      write(root, "unrelated.txt", "operator work, edited again\n")

      const changes = yield* Checkpoint.diff(root, ref, ["workflow.jsx", "flows/demo/flow.ts"])
      expect(changes).toEqual([
        { path: "flows/demo/flow.ts", change: "added", bytes: 17 },
        { path: "workflow.jsx", change: "modified", bytes: 18 }
      ])

      const restored = yield* Checkpoint.restore(root, ref, ["workflow.jsx", "flows/demo/flow.ts"])
      expect(restored).toEqual(["flows/demo/flow.ts", "workflow.jsx"])
      expect(readFileSync(join(root, "workflow.jsx"), "utf8")).toBe("old workflow\n")
      expect(() => readFileSync(join(root, "flows/demo/flow.ts"), "utf8")).toThrow()
      // The dirty file the unit never claimed is untouched by the restore.
      expect(readFileSync(join(root, "unrelated.txt"), "utf8")).toBe("operator work, edited again\n")
    }).pipe(Effect.provide(platform)))

  it.effect("removes a nonempty directory at a path checkpointed as absent", () =>
    Effect.gen(function*() {
      const root = gitProject("absent-directory")
      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx", "b.txt"]))
      write(root, "workflow.jsx", "after\n")
      write(root, "b.txt/nested.txt", "unexpected directory contents\n")

      const restored = yield* Checkpoint.restore(root, ref, ["workflow.jsx", "b.txt"])

      expect(restored).toEqual(["b.txt", "workflow.jsx"])
      expect(existsSync(join(root, "b.txt"))).toBe(false)
      expect(readFileSync(join(root, "workflow.jsx"), "utf8")).toBe("old workflow\n")
    }).pipe(Effect.provide(platform)))

  it.effect("restores exact bytes for a target that existed before migration", () =>
    Effect.gen(function*() {
      const root = gitProject("existing-target")
      write(root, "flows/demo/flow.ts", "user target before migration\n")
      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx", "flows/demo/flow.ts"]))

      write(root, "flows/demo/flow.ts", "generated replacement\n")
      yield* Checkpoint.restore(root, ref, ["flows/demo/flow.ts"])

      expect(readFileSync(join(root, "flows/demo/flow.ts"), "utf8")).toBe("user target before migration\n")
      expect(ref.entries).toContainEqual({
        path: "flows/demo/flow.ts",
        state: "file",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        mode: expect.any(Number)
      })
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a corrupted backup before overwriting the current target", () =>
    Effect.gen(function*() {
      const root = gitProject("corrupt-backup")
      write(root, "flows/demo/flow.ts", "original target\n")
      const ref = yield* Checkpoint.take(payload(root, ["flows/demo/flow.ts"]))
      write(root, "flows/demo/flow.ts", "current target\n")
      writeFileSync(join(ref.backup, "flows/demo/flow.ts"), "corrupted backup\n")

      const failure = yield* Effect.flip(Checkpoint.restore(root, ref, ["flows/demo/flow.ts"]))

      expect(failure.code).toBe("checkpoint-failed")
      expect(readFileSync(join(root, "flows/demo/flow.ts"), "utf8")).toBe("current target\n")
    }).pipe(Effect.provide(platform)))

  it.effect("records an absent target as an explicit manifest fact and a present one with its digest", () =>
    Effect.gen(function*() {
      const root = gitProject("manifest")

      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx", "flows/demo/flow.ts", "workflow.jsx"]))

      // Deduplicated, sorted, and explicit about what was not there.
      expect(ref.entries).toEqual([
        { path: "flows/demo/flow.ts", state: "absent" },
        {
          path: "workflow.jsx",
          state: "file",
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          mode: expect.any(Number)
        }
      ])
      expect(ref.files).toEqual(["workflow.jsx"])
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a declared path that is a directory rather than guessing what to copy", () =>
    Effect.gen(function*() {
      const root = gitProject("directory")
      mkdirSync(join(root, "flows", "demo"), { recursive: true })

      const failure = yield* Effect.flip(Checkpoint.take(payload(root, ["workflow.jsx", "flows/demo"])))

      expect(failure.code).toBe("checkpoint-failed")
      expect(failure.message).toContain("flows/demo")
      expect(failure.message).toContain("not a regular file")
    }).pipe(Effect.provide(platform)))

  it.effect.skipIf(userInfo().uid === 0)(
    "reports an unreadable source as an I/O failure, never as an absent file",
    () =>
      Effect.gen(function*() {
        // Root reads everything, so this case has nothing to prove when the
        // suite runs as root. Everywhere else, a file the tool cannot read is
        // a file it must not describe as missing: that description is what a
        // later restore would act on by deleting the path.
        const root = gitProject("unreadable")
        chmodSync(join(root, "workflow.jsx"), 0o000)
        try {
          const failure = yield* Effect.flip(Checkpoint.take(payload(root, ["workflow.jsx"])))

          expect(failure.code).toBe("io")
          expect(failure.message).toContain("workflow.jsx")
          expect(failure.message).not.toContain("absent")
        } finally {
          chmodSync(join(root, "workflow.jsx"), 0o644)
        }
      }).pipe(Effect.provide(platform))
  )

  it.effect("refuses to diff, restore, or roll back a path the manifest never declared", () =>
    Effect.gen(function*() {
      const root = gitProject("undeclared")
      const ref = yield* Checkpoint.take({ ...payload(root, ["workflow.jsx"]), treeExclude: [".smithers-migrate"] })
      write(root, "README.md", "edited\n")

      // A path outside the manifest has no recorded state to compare against
      // or put back, and deleting it on a guess is the defect this refuses.
      const diffed = yield* Effect.flip(Checkpoint.diff(root, ref, ["README.md"]))
      expect(diffed.code).toBe("checkpoint-failed")
      const restored = yield* Effect.flip(Checkpoint.restore(root, ref, ["README.md"]))
      expect(restored.code).toBe("checkpoint-failed")
      const rolled = yield* Effect.flip(Checkpoint.rollback(root, ref, { paths: ["README.md"] }))
      expect(rolled.code).toBe("checkpoint-failed")
      expect(readFileSync(join(root, "README.md"), "utf8")).toBe("edited\n")
    }).pipe(Effect.provide(platform)))

  it.effect("rolls a pre-existing target back byte for byte, and deletes only what was absent", () =>
    Effect.gen(function*() {
      const root = gitProject("rollback-target")
      write(root, "flows/demo/flow.ts", "the operator's own flow\n")
      const ref = yield* Checkpoint.take({
        ...payload(root, ["workflow.jsx", "flows/demo/flow.ts", "flows/seats.ts"]),
        treeExclude: [".smithers-migrate"]
      })

      write(root, "flows/demo/flow.ts", "overwritten by the migration\n")
      write(root, "flows/seats.ts", "export const seats = {}\n")
      write(root, "workflow.jsx", "half migrated\n")
      write(root, "scratch/notes.md", "undeclared\n")

      const rollback = yield* Checkpoint.rollback(root, ref, {
        paths: ["workflow.jsx", "flows/demo/flow.ts", "flows/seats.ts"]
      })

      expect(readFileSync(join(root, "flows/demo/flow.ts"), "utf8")).toBe("the operator's own flow\n")
      expect(readFileSync(join(root, "workflow.jsx"), "utf8")).toBe("old workflow\n")
      expect(() => readFileSync(join(root, "flows/seats.ts"))).toThrow()
      expect(() => readFileSync(join(root, "scratch/notes.md"))).toThrow()
      expect([...rollback.restored].sort()).toEqual(["flows/demo/flow.ts", "flows/seats.ts", "workflow.jsx"])
      expect(rollback.unrestored).toEqual([])
      // Every path that was absent at the checkpoint got a recovery copy
      // before it went, the unit's own new target included; the target that
      // was present was restored, so it is not a deletion and is not listed.
      expect(rollback.deletedAdds.map((entry) => entry.path).sort()).toEqual(["flows/seats.ts", "scratch/notes.md"])
    }).pipe(Effect.provide(platform)))

  it.effect("reports a deleted file and hands the checks the recorded sources", () =>
    Effect.gen(function*() {
      const root = gitProject("deleted")
      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx"]))
      rmSync(join(root, "workflow.jsx"))

      expect(yield* Checkpoint.diff(root, ref, ["workflow.jsx"])).toEqual([
        { path: "workflow.jsx", change: "deleted", bytes: 0 }
      ])
      const sources = yield* Checkpoint.sources(ref)
      expect(sources.get("workflow.jsx")).toBe("old workflow\n")
    }).pipe(Effect.provide(platform)))
})

describe("Checkpoint.take with no version control", () => {
  it.effect("refuses, naming --allow-no-vcs", () =>
    Effect.gen(function*() {
      const root = scratch("novcs")
      write(root, "workflow.jsx", "old workflow\n")

      const failure = yield* Effect.flip(Checkpoint.take(payload(root, ["workflow.jsx"])))

      expect(failure.code).toBe("no-vcs")
      expect(failure.message).toContain("--allow-no-vcs")
    }).pipe(Effect.provide(platform)))

  it.effect("accepts the file copy as the checkpoint once the operator allows it", () =>
    Effect.gen(function*() {
      const root = scratch("novcs-allowed")
      write(root, "workflow.jsx", "old workflow\n")

      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx"], true))
      expect(ref.vcs).toBe("none")
      expect(ref.files).toEqual(["workflow.jsx"])

      write(root, "workflow.jsx", "migrated\n")
      yield* Checkpoint.restore(root, ref, ["workflow.jsx"])
      expect(readFileSync(join(root, "workflow.jsx"), "utf8")).toBe("old workflow\n")
    }).pipe(Effect.provide(platform)))
})

describe("Checkpoint.take on jj", () => {
  it.effect.skipIf(!jjAvailable)(
    "records the working-copy change and opens a new one for the migration",
    () =>
      Effect.gen(function*() {
        const root = scratch("jj")
        execFileSync("jj", ["git", "init"], { cwd: root, stdio: "ignore" })
        write(root, "workflow.jsx", "old workflow\n")
        write(root, "unrelated.txt", "operator work\n")
        const before = execFileSync("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id"], { cwd: root })
          .toString().trim()

        const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx"]))

        expect(ref.vcs).toBe("jj")
        expect(ref.ref).toBe(before)
        expect(ref.restore).toBe(`jj restore --from ${before}`)
        // The migration works in a new change, so the operator's edits stay in
        // the change they were made in.
        const now = execFileSync("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id"], { cwd: root })
          .toString().trim()
        expect(now).not.toBe(before)
        expect(readFileSync(join(root, "unrelated.txt"), "utf8")).toBe("operator work\n")

        write(root, "workflow.jsx", "migrated\n")
        yield* Checkpoint.restore(root, ref, ["workflow.jsx"])
        expect(readFileSync(join(root, "workflow.jsx"), "utf8")).toBe("old workflow\n")
        expect(readFileSync(join(root, "unrelated.txt"), "utf8")).toBe("operator work\n")
      }).pipe(Effect.provide(platform))
  )

  it.skipIf(jjAvailable)("is skipped because `jj` is not on PATH", () => {
    expect(jjAvailable).toBe(false)
  })
})

describe("Checkpoint.tree", () => {
  it.effect("digests the project, and finds every change afterwards including the ones nobody declared", () =>
    Effect.gen(function*() {
      const root = gitProject("tree")
      write(root, "src/app.ts", "export const a = 1\n")
      write(root, "node_modules/left/index.js", "module.exports = 1\n")
      const ref = yield* Checkpoint.take({
        ...payload(root, ["workflow.jsx"]),
        treeExclude: [".smithers-migrate"]
      })

      // One declared edit, one file nobody declared, one file removed, and one
      // write into a directory the manifest never walks.
      write(root, "workflow.jsx", "migrated\n")
      write(root, "src/app.ts", "export const a = 2\n")
      write(root, "scratch.txt", "undeclared\n")
      write(root, "node_modules/left/index.js", "module.exports = 2\n")
      rmSync(join(root, "README.md"))

      const changes = yield* Checkpoint.treeDiff(root, ref)

      expect(changes).toEqual([
        { path: "README.md", change: "deleted", bytes: 0 },
        { path: "scratch.txt", change: "added", bytes: 11 },
        { path: "src/app.ts", change: "modified", bytes: 19 },
        { path: "workflow.jsx", change: "modified", bytes: 9 }
      ])
      // `.git` and `node_modules` are the tools' own storage, not the project's
      // files, so neither is walked and neither can fail a unit.
      expect(changes.some((change) => change.path.startsWith("node_modules/"))).toBe(false)
      expect(changes.some((change) => change.path.startsWith(".git/"))).toBe(false)
    }).pipe(Effect.provide(platform)))

  it.effect("leaves out what the caller excluded, so run state and the report directory are not its business", () =>
    Effect.gen(function*() {
      const root = gitProject("tree-exclude")
      write(root, ".smithers/smithers.db", "run state\n")
      const ref = yield* Checkpoint.take({
        ...payload(root, ["workflow.jsx"]),
        runStateRoots: [".smithers"],
        treeExclude: [".smithers-migrate"]
      })

      write(root, ".smithers/smithers.db", "clobbered\n")

      expect(yield* Checkpoint.treeDiff(root, ref)).toEqual([])
      // It is excluded from the tree because it has a stricter check of its
      // own: the digests the same checkpoint took.
      expect(ref.digests.map((entry) => entry.path)).toEqual([".smithers/smithers.db"])
    }).pipe(Effect.provide(platform)))

  it.effect("records when it was taken, from the clock rather than the wall", () =>
    Effect.gen(function*() {
      const root = gitProject("taken-at")

      const ref = yield* Checkpoint.take(payload(root, ["workflow.jsx"]))

      // `it.effect` runs on a test clock, so this is the clock's answer and not
      // the machine's — which is exactly what makes a duration testable.
      expect(ref.takenAt).toBe(yield* Clock.currentTimeMillis)
      expect(ref.ref).toBe(`refs/smithers-migrate/workflow-demo/${ref.takenAt}`)
    }).pipe(Effect.provide(platform)))

  it.effect("terminates over a symlinked directory cycle, recording the link by where it points", () =>
    Effect.gen(function*() {
      // `stat` follows symlinks, so a link pointing at an ancestor is a cycle a
      // walk that descends into it never leaves, and this walk runs at least
      // twice per unit. A project can hold one for ordinary reasons: a `latest`
      // link beside the versions it aliases, an `assets` link up out of a docs
      // directory.
      const root = gitProject("symlink-cycle")
      write(root, "docs/page.md", "page\n")
      symlinkSync(".", join(root, "docs", "latest"), "dir")
      symlinkSync("../..", join(root, "docs", "up"), "dir")

      const ref = yield* Checkpoint.take({
        ...payload(root, ["workflow.jsx"]),
        treeExclude: [".smithers-migrate"]
      })
      const walked = JSON.parse(readFileSync(ref.tree, "utf8")) as { files: Record<string, string> }

      // The links are recorded, so a change to where one points is a change the
      // diff sees, and neither is descended into.
      expect(Object.keys(walked.files)).toContain("docs/latest")
      expect(Object.keys(walked.files)).toContain("docs/up")
      expect(Object.keys(walked.files).some((file) => file.startsWith("docs/latest/"))).toBe(false)
      expect(Object.keys(walked.files).some((file) => file.startsWith("docs/up/"))).toBe(false)
      expect(walked.files["docs/latest"]).not.toBe(walked.files["docs/up"])

      // And the diff over the same tree still terminates and reports nothing.
      expect(yield* Checkpoint.treeDiff(root, ref)).toEqual([])
    }).pipe(Effect.provide(platform)))
})

describe("Checkpoint paths stay inside the project", () => {
  for (const escape of ["../victim.txt", "/tmp/victim.txt", "nested/../../victim.txt", ""]) {
    it.effect(`refuses to take a checkpoint of ${JSON.stringify(escape)}`, () =>
      Effect.gen(function*() {
        const root = gitProject("escape-take")
        const failure = yield* Effect.flip(Checkpoint.take(payload(root, [escape])))
        expect(failure.code).toBe("checkpoint-failed")
      }).pipe(Effect.provide(platform)))
  }

  it.effect("refuses a forged manifest entry that would remove or overwrite a file outside the root", () =>
    Effect.gen(function*() {
      // The manifest travels through the journal and the report directory, so
      // restore must not trust its paths: `path.join(root, "../x")` is outside.
      const outside = scratch("escape-victim")
      const root = join(outside, "project")
      mkdirSync(root)
      write(outside, "victim.txt", "operator file\n")
      const ref = yield* Checkpoint.take({ ...payload(root, []), allowNoVcs: true })
      for (
        const forged of [
          { ...ref, entries: [{ path: "../victim.txt", state: "absent" as const }] },
          {
            ...ref,
            entries: [{ path: "../victim.txt", state: "file" as const, digest: createHash("sha256").digest("hex") }]
          }
        ]
      ) {
        const failure = yield* Effect.flip(Checkpoint.restore(root, forged, ["../victim.txt"]))
        expect(failure.code).toBe("checkpoint-failed")
        expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("operator file\n")
      }
    }).pipe(Effect.provide(platform)))
})
