import { describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as World from "./world.ts"

const example = join(import.meta.dirname, "example", "world")

describe("World.load", () => {
  test("applies remove before add, so a case can replace an issue by removing and re-adding it", () => {
    const world = World.load(example, {
      remove: { issues: [7] },
      add: { issues: [{ number: 7, kind: "issue", title: "Signup button does nothing on Safari", state: "closed" }] }
    })
    const sevens = world.data.issues.filter((issue) => issue.number === 7)
    expect(sevens).toHaveLength(1)
    expect(sevens[0]!.state).toBe("closed")
    expect(world.data.issues.some((issue) => issue.number === 8)).toBe(true)
  })

  test("set replaces a key, remove drops by id or number, add appends and merges", () => {
    const world = World.load(example, {
      now: "2026-10-06T09:00:00-07:00",
      set: { notes: { likes: "short answers" } },
      remove: { issues: [8], calendar: ["ev-none"] },
      add: { issues: [{ number: 9, kind: "issue", title: "New", state: "open" }], answers: { engineering: [] } }
    })
    expect(world.data.now).toBe("2026-10-06T09:00:00-07:00")
    expect(world.data.notes).toEqual({ likes: "short answers" })
    expect(world.data.issues.map((issue) => issue.number)).toEqual([7, 9])
    expect(world.data.answers.engineering).toEqual([])
  })
})

describe("work tools", () => {
  const world = World.load(example)
  const role = "assistant"

  test("run_tests answers from the scripted results, the most specific match wins, and says when nothing is scripted", () => {
    const state = World.initialState(world)
    expect(World.call(world, role, state, "run_tests", { filter: "src/signup.test.ts" })).toMatchObject({
      status: "failed",
      passed: 2,
      failed: 1
    })
    expect(World.call(world, role, state, "run_tests", {})).toMatchObject({ status: "passed", passed: 41 })
    const bare = World.load(example, { set: { tests: undefined } })
    expect(World.call(bare, role, World.initialState(bare), "run_tests", {})).toMatchObject({ error: expect.any(String) })
    const strict = World.load(example, { set: { tests: [{ match: ["sync"], status: "passed", output: "ok" }] } })
    expect(World.call(strict, role, World.initialState(strict), "run_tests", { filter: "signup" })).toEqual({
      error: "No tests match \"signup\"."
    })
    // A case's entries append after the world's default; the more specific entry still wins.
    const appended = World.load(example, { set: { tests: [{ match: [], status: "passed", passed: 41, failed: 0, output: "41 passed" }] }, add: { tests: [{ match: ["sync"], status: "failed", passed: 0, failed: 1, output: "FAIL sync" }] } })
    expect(World.call(appended, role, World.initialState(appended), "run_tests", { filter: "sync" })).toMatchObject({ status: "failed" })
    expect(World.call(appended, role, World.initialState(appended), "run_tests", {})).toMatchObject({ status: "passed", passed: 41 })
  })

  test("ops_run answers from the scripted results by action and target, and the most specific match wins", () => {
    const state = World.initialState(world)
    expect(World.call(world, role, state, "ops_run", { action: "Rollback", target: "api to 1.4.1" })).toEqual({
      action: "Rollback",
      target: "api to 1.4.1",
      status: "succeeded",
      output: "api rolled back to 1.4.1 in 3m 40s; health checks pass"
    })
    expect(World.call(world, role, state, "ops_run", { action: "restart", target: "indexer" })).toMatchObject({
      status: "started"
    })
    const bare = World.load(example, { set: { ops: undefined } })
    expect(World.call(bare, role, World.initialState(bare), "ops_run", { action: "deploy", target: "1.5.0" })).toEqual({
      error: "No operations workspace is set up for this world."
    })
    const appended = World.load(example, { set: { ops: [{ status: "started", output: "Running" }] }, add: { ops: [{ action: "deploy", match: ["1.5.0"], status: "failed", output: "no" }] } })
    expect(World.call(appended, role, World.initialState(appended), "ops_run", { action: "deploy", target: "1.5.0" })).toMatchObject({ status: "failed" })
    const strict = World.load(example, { set: { ops: [{ action: "deploy", match: ["1.5.0"], status: "failed", output: "no" }] } })
    const strictState = World.initialState(strict)
    expect(World.call(strict, role, strictState, "ops_run", { action: "deploy", target: "1.5.0" })).toMatchObject({ status: "failed" })
    expect(World.call(strict, role, strictState, "ops_run", { action: "rollback", target: "1.5.0" })).toEqual({
      error: "No result is scripted for rollback \"1.5.0\"."
    })
  })

  test("repo_read and repo_search read the world's repo", () => {
    const state = World.initialState(world)
    expect(World.call(world, role, state, "repo_read", { path: "src/signup.ts" })).toMatchObject({
      path: "src/signup.ts",
      url: "https://example.invalid/acme/blob/main/src/signup.ts"
    })
    expect(World.call(world, role, state, "repo_read", { path: "nope.ts" })).toMatchObject({ error: expect.stringContaining("README.md") })
    expect(World.call(world, role, state, "repo_search", { query: "requestSubmit" })).toEqual([
      expect.objectContaining({ path: "src/signup.ts", line: 4 })
    ])
    expect(World.call(world, role, state, "repo_search", { query: " " })).toEqual([])
  })

  test("issue_create, issue_comment, issue_update and pr_open change the turn's issue list", () => {
    const state = World.initialState(world)
    expect(World.call(world, role, state, "issue_create", { title: "Pricing page 404s", body: "on mobile", assignee: "marketing" }))
      .toEqual({ number: 9, state: "open", url: "https://example.invalid/acme/issues/9" })
    expect(World.call(world, role, state, "issue_comment", { number: 9, text: "Duplicate of #7" })).toEqual({
      commented: true,
      url: "https://example.invalid/acme/issues/9"
    })
    expect(World.call(world, role, state, "issue_update", { number: 9, duplicateOf: 7 })).toMatchObject({
      updated: true,
      state: "closed",
      duplicateOf: 7,
      comments: ["assistant, 2026-10-05: Duplicate of #7"]
    })
    expect(World.call(world, role, state, "issue_update", { number: 9, state: "open" })).toMatchObject({ state: "open" })
    expect(World.call(world, role, state, "issue_update", { number: 9, state: "merged" })).toMatchObject({ error: expect.any(String) })
    expect(World.call(world, role, state, "issue_update", { number: 9, duplicateOf: 404 })).toMatchObject({ error: expect.any(String) })
    expect(World.call(world, role, state, "issue_update", { number: 77, state: "closed" })).toEqual({ error: "No such issue" })
    expect(World.call(world, role, state, "issue_comment", { number: 77, text: "x" })).toEqual({ error: "No such issue" })
    expect(World.call(world, role, state, "pr_open", { title: "Fix", body: "…", closes: 9 })).toEqual({
      number: 10,
      state: "open",
      checks: "pending",
      url: "https://example.invalid/acme/pull/10"
    })
    // The turn's reads see the writes; the loaded world does not change.
    expect(World.call(world, role, state, "issue_read", { number: 10 })).toMatchObject({ kind: "pr", closes: 9, author: role })
    expect((World.call(world, role, state, "issues_search", { kind: "pr", state: "open" }) as Array<unknown>).length).toBe(2)
    expect(world.data.issues.map((issue) => issue.number)).toEqual([7, 8])
  })
})

describe("wiki privacy", () => {
  const secret = { slug: "will-health", title: "Health", text: "Clinic on Tuesday", private: true, owner: "personal-assistant" }

  test("a role that cannot read a private page cannot overwrite it into a team page", () => {
    const world = World.load(example, { pages: [secret] })
    const state = World.initialState(world)
    expect(World.call(world, "assistant", state, "wiki_write", { page: "will-health", text: "public now" }))
      .toMatchObject({ error: expect.any(String) })
    expect(world.pages.get("will-health")).toMatchObject({ private: true, text: "Clinic on Tuesday" })
    expect(World.call(world, "personal-assistant", state, "wiki_read", { page: "will-health" }))
      .toMatchObject({ text: "Clinic on Tuesday" })
  })

  test("the page list a role sees on a miss names only the pages it can read", () => {
    const world = World.load(example, { pages: [secret] })
    const miss = World.call(world, "assistant", World.initialState(world), "wiki_read", { page: "nope" }) as {
      error: string
    }
    expect(miss.error).not.toContain("will-health")
    const owner = World.call(world, "personal-assistant", World.initialState(world), "wiki_read", { page: "nope" }) as {
      error: string
    }
    expect(owner.error).toContain("will-health")
  })
})

describe("fixture walk", () => {
  test("a symlink under repo/ is never followed into repo_read", () => {
    const dir = mkdtempSync(join(tmpdir(), "character-world-"))
    cpSync(example, dir, { recursive: true })
    const outside = mkdtempSync(join(tmpdir(), "character-secret-"))
    writeFileSync(join(outside, "auth.json"), "SECRET-TOKEN")
    mkdirSync(join(dir, "repo"), { recursive: true })
    symlinkSync(join(outside, "auth.json"), join(dir, "repo", "auth.json"))
    symlinkSync(outside, join(dir, "repo", "linked"))
    const world = World.load(dir)
    const state = World.initialState(world)
    expect(JSON.stringify(World.call(world, "assistant", state, "repo_read", { path: "auth.json" })))
      .not.toContain("SECRET-TOKEN")
    expect(JSON.stringify(World.call(world, "assistant", state, "repo_read", { path: "linked/auth.json" })))
      .not.toContain("SECRET-TOKEN")
  })

  test("a symlinked repo/ or wiki/ root is never followed", () => {
    const dir = mkdtempSync(join(tmpdir(), "character-world-"))
    cpSync(example, dir, { recursive: true })
    const outside = mkdtempSync(join(tmpdir(), "character-secret-"))
    writeFileSync(join(outside, "auth.json"), "SECRET-TOKEN")
    writeFileSync(join(outside, "leak.md"), "---\ntitle: Leak\n---\nSECRET-TOKEN\n")
    rmSync(join(dir, "repo"), { recursive: true, force: true })
    rmSync(join(dir, "wiki"), { recursive: true, force: true })
    symlinkSync(outside, join(dir, "repo"))
    symlinkSync(outside, join(dir, "wiki"))
    const world = World.load(dir)
    expect(JSON.stringify(world.repo)).not.toContain("SECRET-TOKEN")
    expect(JSON.stringify([...world.pages.values()])).not.toContain("SECRET-TOKEN")
  })
})
