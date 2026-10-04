import { describe, expect, test } from "bun:test"
import { BEN, createDesignWorld, DESIGN_SCRIPT, GITHUB_CHECKS_MS, LEARNING_MS, MAYA, mergeReadiness, ALICE, type DesignTimers } from "./index"

/** A fake clock: timers fire only when the test advances time. */
const fakeClock = () => {
  let now = 0
  let seq = 0
  const queue = new Map<number, { at: number; run: () => void }>()
  const timers: DesignTimers = {
    set: (run, ms) => { const id = ++seq; queue.set(id, { at: now + ms, run }); return id },
    clear: handle => { queue.delete(handle as number) }
  }
  const advance = (ms: number): void => {
    const end = now + ms
    for (;;) {
      const next = [...queue.entries()].filter(([, each]) => each.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (next === undefined) break
      queue.delete(next[0])
      now = next[1].at
      next[1].run()
    }
    now = end
  }
  return { timers, advance, pending: () => queue.size }
}

const make = () => {
  const clock = fakeClock()
  const design = createDesignWorld({ timers: clock.timers, viewer: MAYA })
  return { clock, design, todo: (id: string) => design.world().todos.find(each => each.id === id)! }
}
const SCRIPT_MS = DESIGN_SCRIPT.reduce((sum, each) => sum + each.ms, 0)

describe("DesignWorld seed", () => {
  test("seeds the design's j1 world", () => {
    const { design } = make()
    const world = design.world()
    expect(world.members.map(each => [each.id, each.role])).toEqual([[MAYA, "owner"], [BEN, "maintainer"], [ALICE, "member"]])
    expect(world.repo.stack).toEqual(["t-stripe", "t-retry", "t-checkout", "t-log"])
    expect(world.todos.map(each => [each.ref, each.state])).toEqual([["T8", "in-review"], ["T9", "needs-you"], ["T10", "working"], ["T11", "queued"]])
    expect(world.repo.capacity).toBe(3)
    expect(mergeReadiness(world, world.todos[0]!)).toEqual({ state: "ready" })
    expect(world.issues.some(each => each.number === 212)).toBe(true)
    expect(world.secrets).toHaveLength(2)
    expect(world.traces.filter(each => each.todo === "t-retry")).toHaveLength(2)
    expect(design.viewer()).toBe(MAYA)
  })

  test("nothing runs until the first reader subscribes", () => {
    const { clock, design } = make()
    expect(clock.pending()).toBe(0)
    design.subscribe(() => {})
    expect(design.pendingTimers()).toContain("t-checkout")
  })
})

describe("DesignWorld scheduler", () => {
  test("T10 works through the remaining steps, then lands In review with evidence; T11 then starts", () => {
    const { clock, design, todo } = make()
    design.start()
    expect(todo("t-checkout").step).toBe("implement")
    clock.advance(6000)
    expect(todo("t-checkout").step).toBe("verify")
    clock.advance(5000 + 3000 + 2000)
    const t10 = todo("t-checkout")
    expect(t10.state).toBe("in-review")
    expect(t10.evidence?.checks.every(check => check.state === "passed")).toBe(true)
    expect(t10.pr).toBe(215)
    expect(design.world().branches.find(each => each.id === "b-checkout")?.machine).toBe("asleep")
    // A slot freed: T11 left the queue.
    expect(todo("t-log").state).toBe("starting")
    expect(todo("t-log").queue).toBeUndefined()
    clock.advance(GITHUB_CHECKS_MS)
    expect(todo("t-checkout").evidence?.github).toEqual({ passed: 5, total: 5 })
  })

  test("a queued TODO walks Starting → Plan … Propose → In review in about 20 s", () => {
    const { clock, design, todo } = make()
    design.start()
    design.drop("t-checkout", MAYA)
    expect(todo("t-log").state).toBe("starting")
    const seen: Array<string> = []
    for (let elapsed = 0; elapsed <= SCRIPT_MS; elapsed += 500) {
      const item = todo("t-log")
      const word = item.state === "working" ? item.step! : item.state
      if (seen.at(-1) !== word) seen.push(word)
      clock.advance(500)
    }
    expect(seen).toEqual(["starting", "plan", "implement", "verify", "review", "propose", "in-review"])
    expect(design.world().traces.find(each => each.todo === "t-log")?.state).toBe("held")
  })

  test("answer resumes T9 at its step; a second answer is refused", () => {
    const { design, todo } = make()
    design.start()
    const answered = design.answer("t-retry", "Use backoff", BEN)
    expect(answered).toEqual({ ok: true, ack: "Answered T9" })
    expect(todo("t-retry").state).toBe("working")
    expect(todo("t-retry").step).toBe("verify")
    expect(todo("t-retry").question?.answer).toEqual({ by: BEN, text: "Use backoff" })
    expect(design.answer("t-retry", "again", MAYA).ok).toBe(false)
  })

  test("stop pauses and frees the slot; resume requeues", () => {
    const { design, todo } = make()
    design.start()
    expect(design.stop("t-checkout", ALICE).ok).toBe(true)
    expect(todo("t-checkout").state).toBe("paused")
    expect(design.pendingTimers()).not.toContain("t-checkout")
    // The freed slot admits T11.
    expect(todo("t-log").state).toBe("starting")
    expect(design.resume("t-checkout", ALICE).ok).toBe(true)
    expect(todo("t-checkout").state).toBe("queued")
    expect(todo("t-checkout").queue).toBe(1)
    expect(design.retry("t-checkout", ALICE).ok).toBe(false)
  })

  test("retry of a failed TODO bumps the attempt and requeues", () => {
    const { design, todo } = make()
    design.start()
    design.setTodo("t-checkout", { state: "failed", failure: "pnpm test failed" })
    const result = design.retry("t-checkout", ALICE, "Await the save")
    expect(result.ok).toBe(true)
    expect(todo("t-checkout").attempts).toBe(2)
    expect(todo("t-checkout").failure).toBeUndefined()
    expect(["queued", "starting"]).toContain(todo("t-checkout").state)
  })

  test("drop closes the branch and the PR", () => {
    const { design, todo } = make()
    design.start()
    expect(design.drop("t-stripe", MAYA).ok).toBe(true)
    expect(todo("t-stripe").state).toBe("dropped")
    expect(design.world().prs.find(each => each.number === 88)?.state).toBe("closed")
    expect(design.world().branches.find(each => each.id === "b-stripe")?.machine).toBe("closed")
  })

  test("merge: a member is refused; the owner merges, main moves, learning runs", () => {
    const { clock, design, todo } = make()
    design.start()
    expect(design.merge("t-stripe", ALICE)).toEqual({ ok: false, refusal: "A maintainer merges" })
    const before = design.world().repo
    expect(design.merge("t-stripe", MAYA, "0".repeat(40)).ok).toBe(false)
    expect(design.merge("t-stripe", MAYA).ok).toBe(true)
    const after = design.world().repo
    expect(todo("t-stripe").state).toBe("merged")
    expect(after.mainSha).not.toBe(before.mainSha)
    expect(after.mergedSinceLook).toBe(before.mergedSinceLook + 1)
    expect(after.mainHead?.text).toBe("#88 merged")
    expect(design.world().runs.find(each => each.id === "learn-88")?.state).toBe("running")
    clock.advance(LEARNING_MS)
    expect(design.world().runs.find(each => each.id === "learn-88")?.state).toBe("done")
    expect(todo("t-stripe").lessons).toBe(2)
  })

  test("a committed draft joins the stack queued and starts when a machine frees", () => {
    const { clock, design, todo } = make()
    design.start()
    const draft = design.newDraft(MAYA, { title: "Expire reset links after 30 minutes", prompt: "Expire password reset links after 30 minutes." })
    expect(draft.ok && draft.id !== undefined).toBe(true)
    expect(design.commitDraft(draft.ok ? draft.id! : "", BEN).ok).toBe(false)
    const committed = design.commitDraft(draft.ok ? draft.id! : "", MAYA)
    expect(committed).toEqual({ ok: true, ack: "Committed as T12", id: "t-t12" })
    expect(design.world().repo.stack.at(-1)).toBe("t-t12")
    expect(todo("t-t12").state).toBe("queued")
    // T10 reaches In review, T11 starts; T12 waits #1.
    clock.advance(SCRIPT_MS)
    expect(todo("t-t12").queue).toBe(1)
    // T11 finishes too; T12 starts.
    clock.advance(SCRIPT_MS + GITHUB_CHECKS_MS)
    expect(["starting", "working", "in-review"]).toContain(todo("t-t12").state)
  })

  test("move swaps stack order and reruns checks", () => {
    const { design } = make()
    design.start()
    expect(design.move("t-retry", "up", MAYA).ok).toBe(true)
    expect(design.world().repo.stack.slice(0, 2)).toEqual(["t-retry", "t-stripe"])
    expect(design.move("t-retry", "up", MAYA).ok).toBe(false)
  })

  test("dispose clears every timer", () => {
    const { clock, design } = make()
    design.start()
    expect(clock.pending()).toBeGreaterThan(0)
    design.dispose()
    expect(clock.pending()).toBe(0)
  })
})

describe("DesignWorld write surface", () => {
  test("generic writes and direct collection writes both notify readers", () => {
    const { design } = make()
    let calls = 0
    design.subscribe(() => { calls += 1 })
    const start = design.version()
    design.patch("todos", "t-log", { title: "Log retries" })
    expect(design.world().todos.find(each => each.id === "t-log")?.title).toBe("Log retries")
    design.activity("b-log", { who: MAYA, kind: "steer", text: "Include the delay" })
    design.present("b-log", MAYA, { kind: "branch" })
    design.setBranch("b-log", { rebasePending: "main" })
    design.put("secrets", { name: "NEW_KEY", scope: "main only" })
    const branch = design.world().branches.find(each => each.id === "b-log")!
    expect(branch.activity.at(-1)?.text).toBe("Include the delay")
    expect(branch.presence).toEqual([{ who: MAYA, where: { kind: "branch" } }])
    expect(branch.rebasePending).toBe("main")
    expect(design.version()).toBeGreaterThan(start)
    const seen = calls
    design.collections.secrets.insert({ name: "DIRECT", scope: "all branches" })
    expect(calls).toBeGreaterThan(seen)
    expect(design.world().secrets.some(each => each.name === "DIRECT")).toBe(true)
  })
})
