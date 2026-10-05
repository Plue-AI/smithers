import { expect, test } from "bun:test"
import type { BranchCard } from "@smthrs/rpc/BranchCard"
import { branchModel, createBrowserPresence, createInstallBranches } from "./BranchSeam"
const branch = { id: "b1", name: "Live branch", machine: { state: "asleep" as const }, presence: [], terminals: [], ssh_line: "ssh -p 2222 b1@localhost" }
test("live mapping uses captured facts and refuses missing or malformed topics", () => {
  expect(branchModel(branch, [], [], "b1")).toEqual({ ...branch, activity: [], changed_files: [] })
  for (const values of [[undefined, [], []], [branch, undefined, []], [branch, [], undefined], [{ ...branch, machine: { state: "magic" } }, [], []], [{ ...branch, id: "b2" }, [], []]]) {
    expect(branchModel(...values as [unknown, unknown, unknown], "b1")).toBeUndefined()
  }
})
test("server action data cannot enable commands while dependencies are dark", () => {
  const actor = { kind: "system", color_index: 7 }
  const activity = [{ id: "burst1", actor, kind: "change", text: "Changed", at: "2026-10-05", actions: [{ tag: "diff", label: "Bad", agent: "run" }] }]
  expect(branchModel(branch, activity, [], "b1")?.activity[0]?.actions).toEqual([])
})
test("presence uses the shared publisher on every move and every 10 seconds; disposal stops it", () => {
  const calls: unknown[] = []
  let tick!: () => void
  let cancelled = false
  const heartbeat = createBrowserPresence({ presence: where => calls.push(where), schedule: (fn, ms) => { expect(ms).toBe(10000); tick = fn; return 1 }, cancel: () => { cancelled = true } })
  heartbeat.move({ branch: "b1" })
  heartbeat.move({ branch: "b1", path: "a.ts", line: 3 })
  tick()
  heartbeat.move({ branch: "b1", terminal: "term1" })
  heartbeat.dispose()
  tick()
  heartbeat.move({ branch: "b2" })
  expect(calls).toEqual([{ branch: "b1" }, { branch: "b1", path: "a.ts", line: 3 }, { branch: "b1", path: "a.ts", line: 3 }, { branch: "b1", terminal: "term1" }])
  expect(cancelled).toBe(true)
})

/** Renderable: the model passes the validation the live branch topics get (branchModel). */
const renderable = (model: unknown) => {
  const card = model as BranchCard
  return branchModel(card, card.activity, card.changed_files, card.id) !== undefined
}
/* An install's served branch (createInstallBranches): GET /api/branches/{b}, its /diff and the TODO it holds. */
const served = { name: "smithers/greet", kind: "item", state: "awake", head: "c".repeat(40), item: { n: 3, title: "Greet", state: "working", place: 2 }, machine: { id: "w" } }
const diff = { files: [{ path: "a.txt", change: "renamed", renamed_to: "b.txt", branch: "smithers/greet", against: { kind: "item_base", rev: "b" }, hunks: [] }],
  commits: [{ sha: "d".repeat(40), subject: "fix: a", author: "Smithers", at: "2026-10-05T09:00:00Z" }] }
const routes = (answers: Record<string, () => Response | Promise<Response>>, reads: string[] = []) => async (path: string) => {
  reads.push(path)
  return answers[path]?.() ?? Response.json({ code: "not_found", class: "user", message: "branch not found" }, { status: 404 })
}

test("an install's branch reads the branch, its diff and its TODO once each, and maps a rename, a commit and no SSH line", async () => {
  const reads: string[] = []
  const branches = createInstallBranches(routes({ "/api/branches/smithers%2Fgreet": () => Response.json(served), "/api/branches/smithers%2Fgreet/diff": () => Response.json(diff),
    "/api/todos/3": () => Response.json({ not: "a todo" }) }, reads))
  let published = 0
  branches.subscribe(() => { published++ })
  const model = await branches.read("smithers/greet")
  expect(reads.sort()).toEqual(["/api/branches/smithers%2Fgreet", "/api/branches/smithers%2Fgreet/diff", "/api/todos/3"])
  expect(typeof model).toBe("object")
  expect(renderable(model)).toBe(true)
  expect(model).toMatchObject({ id: "smithers/greet", machine: { state: "awake" }, item: { n: 3, place: 2 }, ssh_line: "",
    changed_files: [{ path: "a.txt", change: "renamed", renamed_to: "b.txt", authors: [] }] })
  // A TODO the install answered unreadably leaves the branch without checks, never unopened.
  expect((model as { activity: { kind: string; text: string }[] }).activity.map(entry => [entry.kind, entry.text])).toEqual([["change", "fix: a"]])
  expect(branches.get("smithers/greet")).toEqual({ model })
  expect(published).toBe(1)
})

test("a refused, unreachable or malformed branch publishes the install's message; a later read replaces it", async () => {
  let answer: () => Response | Promise<Response> = () => Response.json({ code: "branch_unavailable", class: "infra", message: "the repository could not be read" }, { status: 503 })
  const branches = createInstallBranches(routes({ "/api/branches/smithers%2Fgreet": () => answer(), "/api/branches/smithers%2Fgreet/diff": () => Response.json(diff) }))
  expect(await branches.read("smithers/greet")).toBe("the repository could not be read")
  expect(branches.get("smithers/greet")).toEqual({ error: "the repository could not be read" })
  for (const [next, said] of [
    [() => { throw new TypeError("offline") }, "Branch unavailable"],
    [() => new Response("not json", { status: 502 }), "Branch unavailable"],
    [() => Response.json({ ...served, kind: "tag" }), "Branch unavailable"],
    [() => Response.json({ message: "" }, { status: 500 }), "Branch unavailable"]
  ] as const) {
    answer = next
    expect(await branches.read("smithers/greet")).toBe(said)
  }
  answer = () => Response.json({ ...served, kind: "scratch", item: undefined, forked_from: { kind: "item", ref: "T3", commit: "c", base: "b", item: 3 } })
  const model = await branches.read("smithers/greet")
  expect(branches.get("smithers/greet")).toEqual({ model })
  expect(model).toMatchObject({ scratch: { forked_from: { kind: "item", n: 3 } } })
  // A scratch branch's commits are a person's pushes: shown with their author, outside Smithers.
  expect((model as { activity: { actor: { kind: string }; text: string }[] }).activity).toMatchObject([{ actor: { kind: "outside" }, text: "fix: a · Smithers" }])
  expect(await createInstallBranches(routes({})).read("smithers/gone")).toBe("branch not found")
})

test("two reads of one branch publish only the later answer, whatever order they settle in", async () => {
  const release: Array<(response: Response) => void> = []
  const branches = createInstallBranches(async path => path.endsWith("/diff") ? Response.json({ files: [] })
    : new Promise<Response>(resolve => { release.push(resolve) }))
  const first = branches.read("smithers/greet"), second = branches.read("smithers/greet")
  await Bun.sleep(0)
  release[1]!(Response.json({ ...served, item: undefined, state: "asleep" }))
  await second
  release[0]!(Response.json({ ...served, item: undefined, state: "failed", machine: { failure_message: "boot failed" } }))
  await first
  expect(branches.get("smithers/greet")?.model?.machine).toEqual({ state: "asleep" })
})

/** A small deterministic generator: the property holds for every body it draws (seeded, so a failure reproduces). */
const random = (seed: number) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
const draw = (next: () => number, depth = 0): unknown => {
  const pick = Math.floor(next() * (depth > 2 ? 5 : 8))
  switch (pick) {
    case 0: return null
    case 1: return next() > 0.5
    case 2: return Math.floor(next() * 2000) - 1000
    case 3: return ["", "awake", "failed", "item", "scratch", "main", "added", "renamed", "smithers/x", "a\u0000b"][Math.floor(next() * 10)]
    case 4: return undefined
    case 5: return Array.from({ length: Math.floor(next() * 3) }, () => draw(next, depth + 1))
    default: {
      const keys = ["name", "kind", "state", "item", "n", "title", "place", "machine", "failure_message", "files", "commits", "path", "change", "sha", "subject", "author", "at", "forked_from", "evidence", "items"]
      return Object.fromEntries(Array.from({ length: Math.floor(next() * 6) }, () => [keys[Math.floor(next() * keys.length)]!, draw(next, depth + 1)]))
    }
  }
}
test("whatever the install answers, a read settles to a renderable Branch card or a sentence, and never throws", async () => {
  const next = random(20261005)
  for (let round = 0; round < 400; round++) {
    // Mostly well-formed branches with one field perturbed, then bodies drawn from nothing.
    const body = round % 2 === 0 ? { ...served, [["state", "kind", "item", "machine", "forked_from", "name"][round % 6]!]: draw(next) } : draw(next)
    const diffBody = round % 3 === 0 ? diff : draw(next)
    const status = [200, 200, 200, 404, 500][Math.floor(next() * 5)]!
    const branches = createInstallBranches(async path => path === "/api/branches/b" ? Response.json(body ?? null, { status })
      : path === "/api/branches/b/diff" ? Response.json(diffBody ?? null) : Response.json(draw(next) ?? null))
    const read = await branches.read("b")
    if (typeof read === "string") {
      expect(read.length).toBeGreaterThan(0)
      expect(branches.get("b")).toEqual({ error: read })
    } else {
      expect(renderable(read)).toBe(true)
      expect(branches.get("b")).toEqual({ model: read })
    }
  }
})
