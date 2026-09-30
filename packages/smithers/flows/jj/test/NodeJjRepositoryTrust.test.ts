import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isJjError, Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"

const jjInstalled = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

/**
 * Whatever runs in a checkout (an agent, a cloned repository's scripts) can
 * write its `.jj/` and its bookmarks. The engine's own jj commands must still
 * act on the revision the journal recorded and must not start a program that
 * repository config names.
 */
describe.skipIf(!jjInstalled)("NodeJj against a repository its occupant controls", () => {
  let directory: string
  let repository: string
  const saved: Record<string, string | undefined> = {}

  // stderr is piped, not ignored, so a failing command's error message carries
  // jj's own reason (Node appends the captured stderr to "Command failed").
  const jjIn = (args: ReadonlyArray<string>) =>
    execFileSync("jj", [...args], { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "flows-node-jj-trust-"))
    // jj keeps repository config under the user config directory; point it at
    // a scratch one so a migrated planted config never lands in the real one.
    for (const key of ["HOME", "XDG_CONFIG_HOME", "JJ_CONFIG"]) saved[key] = process.env[key]
    process.env.HOME = directory
    process.env.XDG_CONFIG_HOME = join(directory, "config")
    const userConfig = join(directory, "user.toml")
    await writeFile(userConfig, "[user]\nname = \"Test\"\nemail = \"test@example.com\"\n")
    process.env.JJ_CONFIG = userConfig
    repository = join(directory, "repo")
    execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
  })

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  })

  const layer = () => NodeJj.layerAt(repository)

  it.effect("refuses a revset in place of a revision before spawning jj", () =>
    Effect.gen(function*() {
      const jj = yield* Effect.provide(Jj, layer())
      const lane = join(directory, "revset-lane")
      const attempts = [
        jj.restore("root()"),
        jj.diff("x) | root() | (x", "@"),
        jj.revert!("all()"),
        jj.workspaceAdd("revset-lane", lane, "x) | root() | (x")
      ]
      for (const attempt of attempts) {
        const error = yield* Effect.flip(attempt)
        expect(isJjError(error) && error.code).toBe("invalid_ref")
        expect(isJjError(error) && error.message).toContain("is not a commit id or change id")
      }
      expect(existsSync(lane)).toBe(false)
    }).pipe(Effect.provideService(NodeJj.StartupTimeoutMs, 60_000)))

  it.effect("restores the recorded commit even when a bookmark is named after it", () =>
    Effect.gen(function*() {
      const jj = yield* Effect.provide(Jj, layer())
      const note = join(repository, "note.txt")
      yield* Effect.promise(() => writeFile(note, "recorded\n"))
      const { commitId, changeId } = yield* jj.snapshot("recorded")
      yield* Effect.promise(() => writeFile(note, "later\n"))
      yield* jj.snapshot("later")

      // A bare symbol resolves a bookmark first, so these would name root().
      jjIn(["bookmark", "create", "-r", "root()", commitId])
      jjIn(["bookmark", "create", "-r", "root()", changeId])

      yield* jj.restore(commitId)
      expect(readFileSync(note, "utf8")).toBe("recorded\n")
      yield* Effect.promise(() => writeFile(note, "later\n"))
      expect(yield* jj.diff(commitId, "@")).toContain("+later")
      // The snapshot opened no change, so its change id is still `@`'s.
      expect(yield* jj.diff(changeId, "@")).toBe("")

      const lane = join(directory, "pinned-lane")
      yield* jj.workspaceAdd("pinned-lane", lane, commitId)
      expect(readFileSync(join(lane, "note.txt"), "utf8")).toBe("recorded\n")
      yield* jj.workspaceForget("pinned-lane")
      rmSync(lane, { recursive: true, force: true })
    }).pipe(Effect.provideService(NodeJj.StartupTimeoutMs, 60_000)))

  const marker = () => join(directory, "signer-ran")

  /** A signer that signs and reports every signature good, leaving a marker. */
  const writeSigner = () =>
    Effect.promise(async () => {
      const signer = join(directory, "signer.sh")
      await writeFile(
        signer,
        `#!/bin/sh\necho "$*" >> "${marker()}"\n`
          + "case \"$*\" in *--verify*) echo '[GNUPG:] GOODSIG 0 x'; exit 0;; esac\n"
          + "printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nabc\\n-----END PGP SIGNATURE-----\\n'\n"
      )
      chmodSync(signer, 0o755)
      // A program written a moment before it is executed can still be open for
      // writing in a forked sibling, and exec then fails with ETXTBSY. jj would
      // report that as a failed signature, which reads as a product bug. Run the
      // signer once, retrying while it is busy, so it is quiescent before jj
      // execs it; the probe's marker is not evidence of anything and is removed.
      for (let attempt = 0;; attempt += 1) {
        try {
          execFileSync(signer, ["--probe"], { stdio: "ignore" })
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ETXTBSY" || attempt >= 100) throw error
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      rmSync(marker(), { force: true })
      return signer
    })

  it.effect("refuses to run while the checkout holds config jj would import", () =>
    Effect.gen(function*() {
      const jj = yield* Effect.provide(Jj, layer())
      const note = join(repository, "note.txt")
      yield* Effect.promise(() => writeFile(note, "recorded\n"))
      const { commitId } = yield* jj.snapshot("recorded")
      const signer = yield* writeSigner()
      const dotJj = join(repository, ".jj")
      const planted = `[revset-aliases]\n"commit_id(x)" = "root()"\n`
        + `[signing]\nbehavior = "own"\nbackend = "gpg"\n[signing.backends.gpg]\nprogram = "${signer}"\n`

      // Workspace config first: with its id file gone, jj imports the legacy file.
      rmSync(join(dotJj, "workspace-config-id"), { force: true })
      yield* Effect.promise(() => writeFile(join(dotJj, "workspace-config.toml"), planted))
      const workspaceRefusal = yield* Effect.flip(jj.snapshot("planted workspace config"))
      expect(isJjError(workspaceRefusal) && workspaceRefusal.message).toContain("unmigrated repository config")
      expect(existsSync(join(dotJj, "workspace-config-id"))).toBe(false)
      rmSync(join(dotJj, "workspace-config.toml"))

      rmSync(join(dotJj, "repo", "config-id"), { force: true })
      yield* Effect.promise(() => writeFile(join(dotJj, "repo", "config.toml"), planted))
      for (
        const attempt of [
          jj.snapshot("planted repo config"),
          jj.restore(commitId),
          jj.diff(commitId, "@"),
          jj.root!(note)
        ]
      ) {
        const error = yield* Effect.flip(attempt)
        expect(isJjError(error) && error.message).toContain("unmigrated repository config")
      }
      // jj never ran: running it would have imported the file and written the id.
      expect(existsSync(join(dotJj, "repo", "config-id"))).toBe(false)
      expect(existsSync(marker())).toBe(false)

      // The control fired: jj imports the planted file on any command, and the
      // alias then turns the adapter's id lookup into root().
      expect(jjIn(["log", "-r", `exactly(commit_id(${commitId}), 1)`, "--no-graph", "-T", "commit_id"]))
        .toBe("0".repeat(40))
      expect(existsSync(join(dotJj, "repo", "config-id"))).toBe(true)
    }).pipe(Effect.provideService(NodeJj.StartupTimeoutMs, 60_000)))

  it.effect("follows a secondary workspace's repository pointer to the config jj would import", () =>
    Effect.gen(function*() {
      const lane = join(directory, "pointer-lane")
      const decoy = join(directory, "decoy", ".jj", "repo")
      const pointer = join(lane, ".jj", "repo")
      yield* Effect.promise(async () => {
        await mkdir(join(lane, ".jj"), { recursive: true })
        await mkdir(decoy, { recursive: true })
        await writeFile(join(decoy, "config.toml"), "[revset-aliases]\n\"commit_id(x)\" = \"root()\"\n")
        await writeFile(pointer, "../../decoy/.jj/repo\n")
      })
      const jj = yield* Effect.provide(Jj, NodeJj.layerAt(lane))
      const redirected = yield* Effect.flip(jj.status())
      expect(isJjError(redirected) && redirected.message).toContain(join(decoy, "config.toml"))

      // A pointer this process cannot read is jj's to report, not a refusal.
      chmodSync(pointer, 0o000)
      const unreadable = yield* Effect.flip(jj.status())
      chmodSync(pointer, 0o644)
      expect(isJjError(unreadable) && unreadable.message).not.toContain("unmigrated repository config")
      rmSync(join(directory, "decoy"), { recursive: true, force: true })
      rmSync(lane, { recursive: true, force: true })
    }).pipe(Effect.provideService(NodeJj.StartupTimeoutMs, 60_000)))

  it.effect("never runs a signing program or journals template output once jj has imported the config", () =>
    Effect.gen(function*() {
      const signer = yield* writeSigner()
      // What the previous test's unguarded jj left in the trusted store, plus a
      // template alias that asks jj to verify @'s signature.
      const trusted = jjIn(["config", "path", "--repo"]).trim()
      yield* Effect.promise(() =>
        writeFile(
          trusted,
          `[signing]\nbehavior = "own"\nbackend = "gpg"\n[signing.backends.gpg]\nprogram = "${signer}"\n`
            + `[template-aliases]\ncommit_id = 'if(self.signature(), self.signature().status(), "nosig")'\n`
        )
      )
      // The control fired: an unguarded jj signs @ with the planted program.
      yield* Effect.promise(() => writeFile(join(repository, "signed.txt"), "one\n"))
      jjIn(["describe", "-m", "signed"])
      expect(existsSync(marker())).toBe(true)
      rmSync(marker())

      const jj = yield* Effect.provide(Jj, layer())
      // @ is signed and unchanged, so the aliased template verifies it.
      const verified = yield* Effect.flip(jj.snapshot("signed @"))
      expect(isJjError(verified) && verified.message).toContain("are not a commit id, change id, and operation id")
      expect(existsSync(marker())).toBe(false)
      // Rewriting a signed @ would re-sign it under `signing.behavior=keep`.
      yield* Effect.promise(() => writeFile(join(repository, "signed.txt"), "two\n"))
      const rewritten = yield* Effect.flip(jj.snapshot("rewritten @"))
      expect(isJjError(rewritten) && rewritten.message).toContain("are not a commit id, change id, and operation id")
      yield* jj.root!(repository)
      yield* jj.status()
      expect(existsSync(marker())).toBe(false)
    }).pipe(Effect.provideService(NodeJj.StartupTimeoutMs, 60_000)))
})
