import * as NodeRuntime from "@smthrs/flows/BunRuntime"
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import History, { generateHistory, registration as historyRegistration } from "./history/flow.ts"
import { commitEnvironment, git } from "./tutorial2-background_flows-git.ts"

const repository = async () => {
  const root = await mkdtemp(join(tmpdir(), "tutorial2-background_flows-"))
  await git(root, ["init", "-b", "main"])
  await git(root, ["config", "user.name", "Test"])
  await git(root, ["config", "user.email", "test@example.invalid"])
  await writeFile(join(root, "README.md"), "# A real repository\n")
  await git(root, ["add", "README.md"])
  await git(root, ["commit", "-m", "Initial source"])
  return root
}

describe("Librarian generation against real Git", () => {
  test("Git errors name the command for silent failures and retain stderr", async () => {
    const root = await repository()
    try {
      await git(root, ["checkout", "--detach"])
      await expect(git(root, ["symbolic-ref", "-q", "HEAD"])).rejects.toThrow("git symbolic-ref -q HEAD exited 1")
      await expect(git(root, ["rev-parse", "--verify", "refs/heads/missing^{commit}"])).rejects.toThrow(
        /git rev-parse --verify refs\/heads\/missing\^\{commit\} exited 128: fatal:/
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
  for (const shape of ["default branch", "other branch", "no branch"] as const) {
    test(`detached HEAD with ${shape} creates both refs and preserves its source tree`, async () => {
      const root = await repository()
      try {
        const head = await git(root, ["rev-parse", "HEAD"])
        const tree = await git(root, ["rev-parse", "HEAD^{tree}"])
        await git(root, ["checkout", "--detach", head])
        await git(root, ["branch", "aaa", head])
        if (shape === "default branch") {
          await git(root, ["branch", "release", head])
          await git(root, ["update-ref", "refs/remotes/origin/release", head])
          await git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release"])
        } else {
          await git(root, ["branch", "-D", "main"])
          if (shape === "no branch") await git(root, ["branch", "-D", "aaa"])
        }
        // Git reports the refs actually locked by the transaction, including verifies.
        await writeFile(
          join(root, ".git/hooks/reference-transaction"),
          "#!/bin/sh\nif [ \"$1\" = prepared ]; then cat > .git/history-transaction; fi\n",
          { mode: 0o755 }
        )
        const receipt = await generateHistory(root, "will/demo")
        expect(receipt.treeEqual).toBe(true)
        expect(receipt.sourceHead).toBe(head)
        expect(receipt.sourceTree).toBe(tree)
        expect(await git(root, ["rev-parse", "refs/heads/mythical"])).toBe(receipt.mythicalHead)
        expect(await git(root, ["rev-parse", "refs/notes/mythical"])).toBe(receipt.notesHead)
        expect(await git(root, ["rev-parse", "mythical^{tree}"])).toBe(tree)
        expect(await git(root, ["rev-parse", "HEAD"])).toBe(head)
        expect(await readFile(join(root, ".git/HEAD"), "utf8")).toBe(`${head}\n`)
        const transaction = await readFile(join(root, ".git/history-transaction"), "utf8")
        const refs = transaction.trim().split("\n").map((line) => line.split(" ")[2]).sort()
        expect(refs).toEqual([
          ...(shape === "default branch" ? ["refs/heads/release"] : shape === "other branch" ? ["refs/heads/aaa"] : []),
          "refs/heads/mythical",
          "refs/notes/mythical"
        ].sort())
        expect(await generateHistory(root, "will/demo")).toEqual(receipt)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 30000)
  }
  test(
    "an unborn HEAD fails with a typed error naming the missing bookmark, including through the engine",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "tutorial2-unborn-"))
      try {
        await git(root, ["init", "-b", "missing-release"])
        // A clone can have remote commits while its own HEAD bookmark is absent.
        const tree = await git(root, ["mktree"], "")
        const head = await git(
          root,
          ["commit-tree", tree],
          "Remote source\n",
          commitEnvironment("2026-09-14T00:00:00Z")
        )
        await git(root, ["update-ref", "refs/remotes/origin/release", head])
        const checkFailure = (failure: unknown) => {
          expect(failure).toMatchObject({ _tag: "librarian/MissingSourceBookmark", bookmark: "missing-release" })
          expect((failure as Error).message).toContain("bookmark \"missing-release\"")
          expect((failure as Error).message).toContain("no commit")
          expect(Schema.is(History.errorSchema)(failure)).toBe(true)
        }
        const failure = await generateHistory(root, "will/demo").then(() => undefined, (cause) => cause)
        checkFailure(failure)
        const host = NodeRuntime.layerHost({
          filename: join(root, "engine.db"),
          workspaceRoot: root,
          owner: { hostId: "unborn-history" },
          signals: []
        }, historyRegistration(root))
        const result = await Effect.runPromise(
          Effect.scoped(
            History.execute({ repo: "will/demo" }, { executionId: crypto.randomUUID() }).pipe(
              Effect.catch((cause) => Effect.succeed(cause)),
              Effect.provide(host)
            )
          )
        )
        checkFailure(result)
        expect(await git(root, ["for-each-ref", "--format=%(refname)", "refs/heads/mythical", "refs/notes/mythical"]))
          .toBe("")
        expect(await git(root, ["symbolic-ref", "HEAD"])).toBe("refs/heads/missing-release")
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    60000
  )
  test(
    "mythical and notes are real refs, source tree/main/dirty worktree are unchanged, replay is idempotent",
    async () => {
      const root = await repository()
      try {
        const before = await git(root, ["rev-parse", "HEAD"])
        await writeFile(join(root, "README.md"), "Uncommitted human edit\n")
        const dirty = await git(root, ["diff"])
        const receipt = await generateHistory(root, "will/demo")
        expect(receipt.treeEqual).toBe(true)
        expect(await git(root, ["rev-parse", "mythical^{tree}"])).toBe(await git(root, ["rev-parse", "main^{tree}"]))
        expect(await git(root, ["rev-parse", "HEAD"])).toBe(before)
        expect(await git(root, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main")
        expect(await git(root, ["diff"])).toBe(dirty)
        const note = await git(root, ["notes", "--ref=mythical", "show", receipt.mythicalHead])
        expect(note).toContain(`Source commit: ${before}`)
        expect(note).toContain("## Evidence")
        expect(await generateHistory(root, "will/demo")).toEqual(receipt)
        await git(root, ["add", "README.md"])
        await git(root, ["commit", "-m", "Human change"])
        await expect(generateHistory(root, "will/demo")).rejects.toThrow("already exists")
        expect(await git(root, ["rev-parse", "mythical"])).toBe(receipt.mythicalHead)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    30000
  )
})

test("a durable engine execution replays its recorded output after the host is recreated", async () => {
  const root = await repository()
  try {
    const host = () =>
      NodeRuntime.layerHost({
        filename: join(root, "engine.db"),
        workspaceRoot: root,
        owner: { hostId: "tutorial2-background_flows" },
        signals: []
      }, historyRegistration(root))
    const executionId = crypto.randomUUID()
    const history = () =>
      Effect.runPromise(
        Effect.scoped(History.execute({ repo: "will/demo" }, { executionId }).pipe(Effect.provide(host())))
      )
    const first = await history()
    expect(first.sourceHead).toBe(await git(root, ["rev-parse", "HEAD"]))
    // Re-executing after a new source commit would refuse; replay returns the record.
    await writeFile(join(root, "README.md"), "Human change\n")
    await git(root, ["commit", "-am", "Human change"])
    expect(await history()).toEqual(first)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60000)
