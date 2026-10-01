/**
 * The land queue against real jj and git: checks run concurrently, the push
 * that moves `main` runs one at a time, a change tested on an older `main`
 * is retested only when the new `main` touched its packages, and a baseline
 * (main commit, label) is measured once.
 */
import { Effect } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { type Checked, type Checks, LandFailed, makeBaselines, makeLander } from "../land.ts"

const fixture = (t: { after: (fn: () => void) => void }) => {
  const root = mkdtempSync(join(tmpdir(), "issue-sweep-queue-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = join(root, "jj.toml")
  writeFileSync(config, "[user]\nname = \"t\"\nemail = \"t@t\"\n")
  Object.assign(process.env, {
    JJ_CONFIG: config,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t"
  })
  const cmd = (cwd: string, command: string, ...args: Array<string>) =>
    execFileSync(command, args, { cwd, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] })
  const other = join(root, "other")
  cmd(root, "git", "init", "-q", "-b", "main", other)
  for (const file of ["a/x.txt", "b/y.txt"]) {
    mkdirSync(join(other, file, ".."), { recursive: true })
    writeFileSync(join(other, file), "one\n")
  }
  cmd(other, "git", "add", "-A")
  cmd(other, "git", "commit", "-qm", "first")
  const origin = join(root, "origin.git")
  cmd(root, "git", "clone", "-q", "--bare", other, origin)
  cmd(other, "git", "remote", "add", "origin", origin)
  const host = join(root, "host")
  cmd(root, "jj", "git", "clone", "--quiet", origin, host)

  /** Another lander's commit on origin's main, touching `file`. */
  const pushElsewhere = (file: string) => {
    cmd(other, "git", "pull", "-q", "--ff-only", "origin", "main")
    mkdirSync(join(other, file, ".."), { recursive: true })
    writeFileSync(join(other, file), `${file}\n`)
    cmd(other, "git", "add", "-A")
    cmd(other, "git", "commit", "-qm", `elsewhere ${file}`)
    cmd(other, "git", "push", "-q", "origin", "main")
    return cmd(other, "git", "rev-parse", "HEAD").trim()
  }

  /** An agent's change in a workspace of its own: the change is `@-`, `@` is empty. */
  const change = (name: string, file: string) => {
    const workspace = join(root, name)
    cmd(host, "jj", "workspace", "add", "--quiet", workspace, "--name", name, "-r", "main@origin")
    mkdirSync(join(workspace, file, ".."), { recursive: true })
    writeFileSync(join(workspace, file), `${name}\n`)
    cmd(workspace, "jj", "commit", "--quiet", "-m", name)
    return { workspace, id: cmd(workspace, "jj", "log", "--no-graph", "-r", "@-", "-T", "change_id").trim() }
  }

  const originMain = () => cmd(origin, "git", "rev-parse", "main").trim()
  const subjects = () => cmd(origin, "git", "log", "--format=%s", "main").trim().split("\n")
  return { pushElsewhere, change, originMain, subjects, cmd, origin }
}

const index = [{ label: "//a:test", kinds: ["test"] }, { label: "//b:test", kinds: ["test"] }]

/** Checks that only record: every test run is green unless `onTest` says otherwise. */
const fakeChecks = (onTest: (workspace: string, labels: ReadonlyArray<string>) => Effect.Effect<Checked>) => {
  const tested: Array<string> = []
  const checks: Checks = {
    prepare: () => Effect.void,
    index: () => Effect.succeed(index),
    test: (workspace, labels) => {
      tested.push(labels.join(" "))
      return onTest(workspace, labels)
    },
    redOnMain: () => Effect.succeed([])
  }
  return { checks, tested }
}

const green: Checked = { _tag: "Green" }

test("two changes check concurrently, and their pushes run one at a time", { timeout: 60_000 }, async (t) => {
  const { change, subjects } = fixture(t)
  const one = change("one", "a/one.txt")
  const two = change("two", "b/two.txt")
  // Each check waits until the other has started: serial checks never finish.
  let started = 0
  let release: () => void = () => {}
  const both = new Promise<void>((resolve) => (release = resolve))
  const { checks, tested } = fakeChecks(() =>
    Effect.gen(function*() {
      started += 1
      if (started === 2) release()
      const met = yield* Effect.promise(() => both).pipe(Effect.timeoutOption("10 seconds"))
      return met._tag === "Some" ? green : { _tag: "Broken", message: "checks ran one at a time" } as Checked
    })
  )
  const pushes: Array<string> = []
  const land = makeLander({
    checks,
    beforePush: (id) =>
      Effect.gen(function*() {
        pushes.push(`start ${id}`)
        yield* Effect.sleep("100 millis")
        pushes.push(`end ${id}`)
      })
  })

  const landed = await Effect.runPromise(
    Effect.all([land(one.workspace, one.id), land(two.workspace, two.id)], { concurrency: "unbounded" })
  )

  assert.equal(landed.length, 2)
  // The pushes never overlapped.
  for (let i = 0; i < pushes.length; i += 2) {
    assert.match(pushes[i]!, /^start /)
    assert.equal(pushes[i + 1], pushes[i]!.replace("start", "end"))
  }
  // Disjoint packages: the second push rebased onto the first without testing again.
  assert.deepEqual(tested.sort(), ["//a:test", "//b:test"])
  assert.deepEqual(subjects().slice(0, 2).sort(), ["one", "two"])
})

test("a change tested on an older main lands without retesting when main moved elsewhere", {
  timeout: 60_000
}, async (t) => {
  const { change, pushElsewhere, cmd, origin } = fixture(t)
  const mine = change("mine", "a/mine.txt")
  let moved = ""
  const { checks, tested } = fakeChecks(() =>
    Effect.sync(() => {
      if (moved === "") moved = pushElsewhere("b/elsewhere.txt")
      return green
    })
  )

  const landed = await Effect.runPromise(makeLander({ checks })(mine.workspace, mine.id))

  assert.deepEqual(tested, ["//a:test"])
  assert.equal(cmd(origin, "git", "rev-parse", "main").trim(), landed)
  assert.equal(cmd(origin, "git", "rev-parse", `${landed}^`).trim(), moved)
})

test("a change tested on an older main is retested when main touched its packages", {
  timeout: 60_000
}, async (t) => {
  const { change, pushElsewhere, cmd, origin } = fixture(t)
  const mine = change("mine", "a/mine.txt")
  let moved = ""
  const { checks, tested } = fakeChecks(() =>
    Effect.sync(() => {
      if (moved === "") moved = pushElsewhere("a/elsewhere.txt")
      return green
    })
  )

  const landed = await Effect.runPromise(makeLander({ checks })(mine.workspace, mine.id))

  assert.deepEqual(tested, ["//a:test", "//a:test"])
  assert.equal(cmd(origin, "git", "rev-parse", `${landed}^`).trim(), moved)
})

test("re-landing a change main already contains answers its commit without checks", {
  timeout: 60_000
}, async (t) => {
  const { change, originMain } = fixture(t)
  const mine = change("mine", "a/mine.txt")
  const { checks, tested } = fakeChecks(() => Effect.succeed(green))
  const land = makeLander({ checks })
  const first = await Effect.runPromise(land(mine.workspace, mine.id))

  const again = await Effect.runPromise(land(mine.workspace, mine.id))

  assert.equal(again, first)
  assert.equal(originMain(), first)
  assert.deepEqual(tested, ["//a:test"])
})

test("a red label main also fails does not block; a new red does", { timeout: 60_000 }, async (t) => {
  const { change } = fixture(t)
  const mine = change("mine", "a/mine.txt")
  const { checks } = fakeChecks(() => Effect.succeed({ _tag: "Red", labels: ["//a:test"] } as Checked))
  const excused = makeLander({ checks: { ...checks, redOnMain: (labels) => Effect.succeed(labels) } })
  const blocked = makeLander({ checks })

  const failure = await Effect.runPromise(Effect.flip(blocked(mine.workspace, mine.id)))
  assert.match(failure.message, /checks red for .*: \/\/a:test/)
  assert.match(await Effect.runPromise(excused(mine.workspace, mine.id)), /^[0-9a-f]{40}$/)
})

test("the baseline cache measures a (commit, label) once, across concurrent asks and restarts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "issue-sweep-baseline-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "baseline.json")
  const measured: Array<string> = []
  const measure = (commit: string, labels: ReadonlyArray<string>) =>
    Effect.gen(function*() {
      measured.push(...labels.map((label) => `${commit} ${label}`))
      yield* Effect.sleep("50 millis")
      const red = labels.filter((label) => label === "//l2:test")
      return red.length === 0 ? green : { _tag: "Red", labels: red } as Checked
    })
  const redOn = makeBaselines({ file, measure })

  const [first, second] = await Effect.runPromise(Effect.all([
    redOn("c1", ["//l1:test", "//l2:test"]),
    redOn("c1", ["//l2:test", "//l3:test"])
  ], { concurrency: "unbounded" }))

  assert.deepEqual(first, ["//l2:test"])
  assert.deepEqual(second, ["//l2:test"])
  assert.deepEqual(measured.sort(), ["c1 //l1:test", "c1 //l2:test", "c1 //l3:test"])

  // A restarted host reads the file; another commit is measured afresh.
  const restarted = makeBaselines({ file, measure })
  assert.deepEqual(await Effect.runPromise(restarted("c1", ["//l3:test", "//l2:test"])), ["//l2:test"])
  assert.equal(measured.length, 3)
  assert.deepEqual(await Effect.runPromise(restarted("c2", ["//l2:test"])), ["//l2:test"])
  assert.equal(measured.length, 4)
})

test("a baseline that could not run excuses its labels but is not remembered", async () => {
  let runs = 0
  const redOn = makeBaselines({
    measure: () => Effect.sync(() => (runs += 1, { _tag: "Broken", message: "no install" } as Checked))
  })
  assert.deepEqual(await Effect.runPromise(redOn("c1", ["//a:test"])), ["//a:test"])
  assert.deepEqual(await Effect.runPromise(redOn("c1", ["//a:test"])), ["//a:test"])
  assert.equal(runs, 2)
})

test("a baseline that failed fails its askers and runs again on the next ask", async () => {
  let runs = 0
  const redOn = makeBaselines({
    measure: () =>
      Effect.suspend(() =>
        (runs += 1) === 1 ? Effect.fail(new LandFailed({ message: "jj workspace add" })) : Effect.succeed(green)
      )
  })
  const failure = await Effect.runPromise(Effect.flip(redOn("c1", ["//a:test"])))
  assert.equal(failure.message, "jj workspace add")
  assert.deepEqual(await Effect.runPromise(redOn("c1", ["//a:test"])), [])
  assert.equal(runs, 2)
})
