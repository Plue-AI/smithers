import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { hasSourceCommits, sourceRequest } from "../repository/retention.ts"
import type { Event } from "../repository/schema.ts"

test("retention selects canonical PR identities and original signed push identities without accepting event URLs", async () => {
  const head = "b".repeat(40), base = "a".repeat(40)
  const event: typeof Event.Type = {
    source: "github",
    type: "push",
    action: "",
    deliveryKey: "github:signed-push",
    issueNumber: 0,
    payload: { before: base, after: head, ref: "refs/heads/main", repository: { full_name: "original/source" } }
  }
  assert.deepEqual(
    await Effect.runPromise(
      sourceRequest(event, {
        candidateCommitId: "c".repeat(40),
        clone_url: "https://attacker.example",
        pull_request: { source: "github", number: 999, head: { sha: "c".repeat(40) }, base: { sha: base } }
      })
    ),
    { kind: "push", head, base, ref: "refs/heads/main", delivery_key: "github:signed-push" }
  )
  const trial: typeof Event.Type = {
    ...event,
    source: "smithers-cloud",
    type: "issues",
    action: "opened",
    issueNumber: 1,
    trial: true,
    payload: { issue: { title: "Review trial", body: "https://github.com/original/source/pull/7" } }
  }
  assert.equal(
    await Effect.runPromise(sourceRequest(trial, trial.payload)),
    undefined,
    "an issue's link alone is not a verified PR"
  )
  const resolved = {
    pull_request: {
      source: "github",
      number: 7,
      head: { sha: head, repo: { full_name: "contributor/fork" } },
      base: { sha: base }
    }
  }
  assert.deepEqual(await Effect.runPromise(sourceRequest(trial, resolved)), {
    kind: "pull_request",
    number: 7,
    head,
    base
  })
  const deleted = { ...event, payload: { before: base, after: "0".repeat(40), ref: "refs/heads/main", deleted: true } }
  assert.equal(await Effect.runPromise(sourceRequest(deleted, deleted.payload)), undefined)
  await assert.rejects(
    Effect.runPromise(
      sourceRequest({ ...trial, source: "github", type: "pull_request" }, {
        pull_request: { number: 7, head: { sha: "main" }, base: { sha: base } }
      })
    ),
    /exact retainable source identity/
  )
  // A captured PR event records the head and base the host read, not the delivery
  // that named the pull request. There is nothing to ask the remote for, and a
  // commit this host already holds stays readable.
  const captured: typeof Event.Type = {
    source: "github",
    type: "pull_request",
    action: "opened",
    deliveryKey: "github:captured-pr",
    payload: {}
  }
  assert.equal(
    await Effect.runPromise(
      sourceRequest(captured, {
        pull_request: { title: "Canary", body: "A durable fixture.", head: { sha: head }, base: { sha: base } }
      })
    ),
    undefined
  )
})

test("native commit lookup requires the exact nonempty set even when JJ exits zero for a missing commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "repository-source-lookup-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  await writeFile(join(root, "source.txt"), "actual source\n")
  jj("status")
  const head = jj("log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", "commit_id").trim()
  const operationId = JSON.parse(jj("op", "log", "-n", "1", "--no-graph", "-T", "json(self)")).id
  const missing = "f".repeat(40)
  assert.equal(
    jj(
      "log",
      "--ignore-working-copy",
      `--at-op=${operationId}`,
      "--no-graph",
      "-r",
      `commit_id("${missing}")`,
      "-T",
      "commit_id"
    ),
    ""
  )
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const lookup = (commits: string[]) =>
    Effect.runPromise(
      hasSourceCommits({ repositoryPath: root, fs, environment: { PATH: process.env.PATH! } }, commits, operationId)
        .pipe(Effect.provide(NodeServices.layer))
    )
  assert.equal(await lookup([head]), true)
  assert.equal(await lookup([missing]), false)
  assert.equal(await lookup([head, missing]), false, "one known commit cannot hide the missing comparison base")
  await assert.rejects(lookup(["@"]), /full native identities/)
  assert.equal(JSON.parse(jj("op", "log", "-n", "1", "--no-graph", "-T", "json(self)")).id, operationId)
})
