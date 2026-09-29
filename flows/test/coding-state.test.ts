import * as ApprovalAuthority from "@smthrs/control/ApprovalAuthority"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import * as ControlDatabasePath from "../../packages/smithers/src/internal/ControlDatabasePath.ts"
import * as ExecutionDatabasePath from "../../packages/smithers/src/internal/ExecutionDatabasePath.ts"
import { platform } from "../../packages/smithers/src/internal/NodeControlHost.ts"
import { layer } from "../coding/host.ts"
import { changedPaths, driftOf, staleRevisionMessage } from "../coding/planning.ts"
import * as CodingState from "../coding/state.ts"
import { makeHostJudge } from "./fixtures/scripted-judge.ts"

const options = {
  gatewayId: "11111111-1111-4111-8111-111111111111",
  implementationModel: "test:model",
  approvalAuthority: ApprovalAuthority.local
}

test("host state resolves beside the served working copy and never inside it", () => {
  const root = "/home/developer/workspace"
  const stateRoot = CodingState.resolveStateRoot({ root })
  assert.equal(stateRoot, "/home/developer/.smithers-coding-state/workspace")
  assert.equal(CodingState.inside(root, stateRoot), false)
  // The two databases the 2026-09-15 workspace failure put inside the checkout.
  assert.equal(
    ControlDatabasePath.databasePath(stateRoot),
    "/home/developer/.smithers-coding-state/workspace/.flows/control.db"
  )
  assert.equal(
    ExecutionDatabasePath.executionDatabasePath(stateRoot),
    "/home/developer/.smithers-coding-state/workspace/.flows/engine.db"
  )
  for (
    const path of [ControlDatabasePath.databasePath(stateRoot), ExecutionDatabasePath.executionDatabasePath(stateRoot)]
  ) {
    assert.equal(CodingState.inside(root, path), false)
  }
  // A root with no parent of its own still resolves outside itself.
  const orphan = CodingState.resolveStateRoot({ root: "/", environment: { XDG_STATE_HOME: "/var/state" } })
  assert.match(orphan, /^\/var\/state\/smithers\/coding\/[0-9a-f]{16}$/)
})

test("an explicit state directory is honored, and an in-root one is refused by name", () => {
  const root = "/home/developer/workspace"
  assert.equal(CodingState.resolveStateRoot({ root, explicit: "/srv/coding-state" }), "/srv/coding-state")
  assert.equal(CodingState.resolveStateRoot({ root, explicit: "../elsewhere" }), "/home/developer/elsewhere")
  assert.equal(
    CodingState.resolveStateRoot({ root, environment: { [CodingState.directoryVariable]: "/srv/from-env" } }),
    "/srv/from-env"
  )
  for (const explicit of [".", ".flows", "sub/state", root, `${root}/.flows`]) {
    assert.throws(() => CodingState.resolveStateRoot({ root, explicit }), /inside the served working copy/)
  }
  // The documented opt-in back to the pre-fix layout, for a local single
  // repository whose ignore file already covers `.flows/`.
  const environment = { [CodingState.inRootVariable]: "1" }
  assert.equal(CodingState.resolveStateRoot({ root, environment }), root)
  assert.equal(CodingState.resolveStateRoot({ root, explicit: ".flows", environment }), `${root}/.flows`)
})

test("the configured host refuses an in-root state directory before it opens a database", () => {
  const repositoryPath = "/home/developer/workspace"
  assert.throws(
    () =>
      layer({ ...platform, evaluator: makeHostJudge().layer }, {
        ...options,
        repositoryPath,
        stateRoot: `${repositoryPath}/.flows`
      }),
    /inside the served working copy/
  )
  assert.throws(
    () =>
      layer({ ...platform, evaluator: makeHostJudge().layer }, {
        ...options,
        repositoryPath,
        stateRoot: repositoryPath
      }),
    /stale_revision|freshness check/
  )
  assert.doesNotThrow(() => layer({ ...platform, evaluator: makeHostJudge().layer }, { ...options, repositoryPath }))
  assert.doesNotThrow(() =>
    layer({ ...platform, evaluator: makeHostJudge().layer }, {
      ...options,
      repositoryPath,
      stateRoot: "/srv/coding-state"
    })
  )
})

test("a sibling state symlink into the working copy is refused by the resolver and host", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-state-symlink-"))
  t.after(() => rm(temporary, { force: true, recursive: true }))
  const repositoryPath = join(temporary, "workspace")
  const repositoryLink = join(temporary, "linked-workspace")
  const stateLink = join(temporary, "linked-state")
  const outsideState = join(temporary, "outside-state")
  await mkdir(join(repositoryPath, "mutable-state"), { recursive: true })
  await mkdir(outsideState)
  await symlink(repositoryPath, repositoryLink, "dir")
  await symlink(join(repositoryPath, "mutable-state"), stateLink, "dir")

  for (const stateRoot of [stateLink, join(stateLink, "new-state")]) {
    assert.throws(
      () => CodingState.resolveStateRoot({ root: repositoryPath, explicit: stateRoot }),
      /inside the served working copy/
    )
    assert.throws(
      () => layer({ ...platform, evaluator: makeHostJudge().layer }, { ...options, repositoryPath, stateRoot }),
      /inside the served working copy/
    )
  }

  const stateInsidePhysicalWorkspace = join(repositoryPath, "mutable-state", "new-state")
  assert.throws(
    () => CodingState.resolveStateRoot({ root: repositoryLink, explicit: stateInsidePhysicalWorkspace }),
    /inside the served working copy/
  )
  assert.throws(
    () =>
      layer({ ...platform, evaluator: makeHostJudge().layer }, {
        ...options,
        repositoryPath: repositoryLink,
        stateRoot: stateInsidePhysicalWorkspace
      }),
    /inside the served working copy/
  )

  assert.equal(CodingState.resolveStateRoot({ root: repositoryPath, explicit: outsideState }), outsideState)
  assert.doesNotThrow(() =>
    layer({ ...platform, evaluator: makeHostJudge().layer }, { ...options, repositoryPath, stateRoot: outsideState })
  )
})

const jjAvailable = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "pipe" })
    return true
  } catch {
    return false
  }
})()

test("engine state written to the resolved directory leaves a JJ working copy clean", {
  skip: jjAvailable ? false : "jj is not installed"
}, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-state-"))
  t.after(() => rm(temporary, { force: true, recursive: true }))
  const root = join(temporary, "workspace")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "State Acceptance")
  jj("config", "set", "--repo", "user.email", "state@example.com")
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src/answer.ts"), "export const answer = 42\n")
  jj("describe", "-m", "🏗️ chore: stable foundation")
  jj("new", "-m", "✨ feat: current native tip")
  const clean = jj("status"), unchanged = jj("diff", "--stat")

  // No `.gitignore` entry for `.flows/`: this fixture reproduces the production
  // workspace, where the repository never agreed to ignore the host's state.
  const stateRoot = CodingState.resolveStateRoot({ root })
  assert.equal(stateRoot, join(temporary, ".smithers-coding-state", "workspace"))
  const databases = [
    ControlDatabasePath.databasePath(stateRoot),
    ExecutionDatabasePath.executionDatabasePath(stateRoot)
  ]
  await mkdir(join(stateRoot, ".flows"), { recursive: true })
  // Stand in for a wiki refresh and a plan cycle: the files the engine and the
  // control plane actually create, WAL companions included.
  for (const database of databases) {
    for (const suffix of ["", "-wal", "-shm"]) await writeFile(`${database}${suffix}`, "state\n")
  }
  for (const database of databases) assert.equal(existsSync(database), true)
  assert.equal(jj("status"), clean)
  assert.doesNotMatch(jj("status"), /\.flows/)
  // The wiki refresh previously dumped `.flows/engine.db-wal` into this output.
  assert.equal(jj("diff", "--stat"), unchanged)
  assert.doesNotMatch(unchanged, /\.flows/)

  // The same writes inside the root are exactly what the run card reported.
  await mkdir(join(root, ".flows"), { recursive: true })
  await writeFile(join(root, ".flows", "control.db"), "state\n")
  assert.match(jj("status"), /\.flows\/control\.db/)
  assert.notEqual(jj("status"), clean)
  assert.equal(CodingState.inside(root, resolve(root, ".flows/control.db")), true)
  t.diagnostic("Real JJ working copy stayed clean with host state beside it and dirtied with host state inside it.")
})

test("a stale_revision names the revisions and paths that moved", () => {
  const revision = {
    changeId: "kmnopqrstuvwxyzkmnopqrstuvwxyzkm",
    commitId: "a".repeat(40),
    treeId: "b".repeat(40),
    operationId: "f".repeat(128),
    parentCommitIds: ["c".repeat(40)]
  }
  assert.equal(driftOf(revision, { ...revision, kind: "resolved" }), undefined)
  assert.equal(
    driftOf(revision, { ...revision, kind: "resolved", treeId: "d".repeat(40) }),
    `${revision.changeId} tree bbbbbbbbbbbb->dddddddddddd`
  )
  assert.equal(driftOf(revision, { ...revision, kind: "conflicted" }), `${revision.changeId} is conflicted`)
  assert.equal(driftOf(revision, undefined), `${revision.changeId} is gone`)
  assert.equal(
    driftOf(revision, { ...revision, kind: "resolved", commitId: "e".repeat(40), parentCommitIds: [] }),
    `${revision.changeId} commit aaaaaaaaaaaa->eeeeeeeeeeee, parents differ`
  )

  const diff = [
    "diff --git a/.flows/control.db b/.flows/control.db",
    "new file mode 100644",
    "diff --git a/.flows/engine.db-wal b/.flows/engine.db-wal",
    "diff --git a/src/old.ts b/src/new.ts",
    "diff --git a/.flows/control.db b/.flows/control.db"
  ].join("\n")
  assert.deepEqual(changedPaths(diff), [".flows/control.db", ".flows/engine.db-wal", "src/old.ts -> src/new.ts"])
  assert.deepEqual(changedPaths(diff, 2), [".flows/control.db", ".flows/engine.db-wal", "and more"])
  assert.deepEqual(changedPaths("no diff headers here"), [])

  assert.equal(staleRevisionMessage(), "Native code changed during planning or clarification; gather and plan again")
  assert.equal(
    staleRevisionMessage([`head ${revision.changeId} tree bbbbbbbbbbbb->dddddddddddd`], [
      ".flows/control.db",
      ".flows/engine.db-wal"
    ]),
    "Native code changed during planning or clarification; gather and plan again" +
      ` (changed: head ${revision.changeId} tree bbbbbbbbbbbb->dddddddddddd; paths: .flows/control.db, .flows/engine.db-wal)`
  )
})
