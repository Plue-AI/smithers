import { describe, expect, test } from "bun:test"
import { cleanTitle, createTimelineTitleSeam, modelStreamTitles, TITLE_INPUT_LINES, TITLE_INSTRUCTIONS, titlePrompt, type FoldRun, type TitleWriter } from "./TimelineTitleSeam"

const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5) }
const run = (key: string, count = 3): FoldRun => ({ key, lines: Array.from({ length: count }, (_, index) => ({ kind: index === 0 ? "prompt" : "event", title: `${key} line ${index}` })) })

/** A model double: every call is recorded with its prompt and signal, and answered by `answer` or held until released. */
const model = (answer?: (prompt: string) => Promise<string>) => {
  const calls: Array<{ readonly prompt: string; readonly signal: AbortSignal; readonly resolve: (text: string) => void; readonly reject: (error: Error) => void }> = []
  const write: TitleWriter = (prompt, signal) => new Promise<string>((resolve, reject) => {
    calls.push({ prompt, signal, resolve, reject })
    if (answer !== undefined) void answer(prompt).then(resolve, reject)
  })
  return { calls, write }
}
const keyOf = (prompt: string) => /line 0/.test(prompt) ? /: (\S+) line 0/.exec(prompt)![1]! : ""

describe("the title seam", () => {
  test("without a writer (no `model.turn`) nothing is asked and no title appears", async () => {
    const seam = createTimelineTitleSeam({ debounceMs: 1 })
    const asked = seam.ask([run("a")])
    expect(seam.ask([run("b")])).toBe(asked)
    const stop = asked.subscribe(() => {})
    await Bun.sleep(20)
    expect(asked.get().size).toBe(0)
    stop()
    seam.dispose()
  })

  test("asks once per key after the debounce, caches the cleaned answer, and tells subscribers", async () => {
    const { calls, write } = model(async prompt => `**${keyOf(prompt)} work done.**`)
    const seam = createTimelineTitleSeam({ write, debounceMs: 20 })
    const runs = [run("a"), run("b")]
    const asked = seam.ask(runs)
    // The same runs give the same handle, so the rail's subscription holds still across renders.
    expect(seam.ask([run("a"), run("b")])).toBe(asked)
    let notified = 0
    const stop = asked.subscribe(() => { notified++ })
    expect(calls).toHaveLength(0)
    await Bun.sleep(5)
    expect(calls).toHaveLength(0)
    await until(() => asked.get().size === 2)
    expect([...asked.get()]).toEqual([["a", "a work done"], ["b", "b work done"]])
    expect(notified).toBe(2)
    expect(calls.map(call => keyOf(call.prompt))).toEqual(["a", "b"])
    // Folding the same runs again, or a set holding an answered one, asks nothing more for it.
    stop()
    const again = seam.ask([run("b"), run("c")])
    const stopAgain = again.subscribe(() => {})
    await until(() => again.get().size === 3)
    expect(calls.map(call => keyOf(call.prompt))).toEqual(["a", "b", "c"])
    expect(again.get().get("a")).toBe("a work done")
    stopAgain()
    seam.dispose()
  })

  test("debounces: while the folded set keeps changing nothing is asked, then only the set that held still", async () => {
    const { calls, write } = model(async prompt => `${keyOf(prompt)} title`)
    const seam = createTimelineTitleSeam({ write, debounceMs: 30, maxWaitMs: 10_000 })
    for (const key of ["a", "b", "c"]) {
      const stop = seam.ask([run(key)]).subscribe(() => {})
      await Bun.sleep(10)
      stop()
    }
    const held = seam.ask([run("d")])
    held.subscribe(() => {})
    await Bun.sleep(15)
    expect(calls).toHaveLength(0)
    await until(() => held.get().has("d"))
    expect(calls.map(call => keyOf(call.prompt))).toEqual(["d"])
    seam.dispose()
  })

  test("a set that never holds still is still asked once the longest wait has passed", async () => {
    const { calls, write } = model(async prompt => `${keyOf(prompt)} title`)
    const seam = createTimelineTitleSeam({ write, debounceMs: 30, maxWaitMs: 60 })
    const started = Date.now()
    const stops: Array<() => void> = []
    for (let index = 0; calls.length === 0 && index < 40; index++) {
      stops.push(seam.ask([run("live"), run(`grow${index}`)]).subscribe(() => {}))
      await Bun.sleep(10)
    }
    expect(calls.length).toBeGreaterThan(0)
    expect(Date.now() - started).toBeLessThan(200)
    for (const stop of stops) stop()
    seam.dispose()
  })

  test("at most `concurrency` requests run at once; the rest wait their turn", async () => {
    const { calls, write } = model()
    const seam = createTimelineTitleSeam({ write, debounceMs: 1, concurrency: 2 })
    const asked = seam.ask(["a", "b", "c", "d"].map(key => run(key)))
    asked.subscribe(() => {})
    await until(() => calls.length === 2)
    await Bun.sleep(20)
    expect(calls).toHaveLength(2)
    calls[0]!.resolve("First")
    await until(() => calls.length === 3)
    expect(calls.map(call => keyOf(call.prompt))).toEqual(["a", "b", "c"])
    seam.dispose()
  })

  test("a run the rail stopped folding before its turn is not asked", async () => {
    const { calls, write } = model()
    const seam = createTimelineTitleSeam({ write, debounceMs: 1, concurrency: 1 })
    const stop = seam.ask([run("a"), run("b")]).subscribe(() => {})
    await until(() => calls.length === 1)
    stop()
    calls[0]!.resolve("Title a")
    await Bun.sleep(30)
    expect(calls).toHaveLength(1)
    seam.dispose()
  })

  test("a refusal, a failure, an empty answer or an internal word leaves the key untitled, silently, and it is never asked again", async () => {
    const answers: Record<string, () => Promise<string>> = {
      refused: async () => { throw new Error("The model door answered 503.") },
      empty: async () => "  \n ",
      internal: async () => "Finished the retry task",
      fine: async () => "Retries cover store.ts"
    }
    const { calls, write } = model(async prompt => await answers[keyOf(prompt)]!())
    const seam = createTimelineTitleSeam({ write, debounceMs: 1, concurrency: 4 })
    const runs = Object.keys(answers).map(key => run(key))
    const stop = seam.ask(runs).subscribe(() => {})
    await until(() => seam.ask(runs).get().size === 1)
    await Bun.sleep(20)
    expect([...seam.ask(runs).get()]).toEqual([["fine", "Retries cover store.ts"]])
    stop()
    seam.ask([...runs, run("next")]).subscribe(() => {})
    await until(() => calls.length === 5)
    await Bun.sleep(20)
    expect(calls.map(call => keyOf(call.prompt))).toEqual(["refused", "empty", "internal", "fine", "next"])
    seam.dispose()
  })

  test("a request that outlives its deadline is aborted and its key settles untitled; a late answer is dropped", async () => {
    const { calls, write } = model()
    const seam = createTimelineTitleSeam({ write, debounceMs: 1, timeoutMs: 20, concurrency: 1 })
    const asked = seam.ask([run("slow"), run("next")])
    let notified = 0
    asked.subscribe(() => { notified++ })
    await until(() => calls.length === 1)
    await until(() => calls[0]!.signal.aborted)
    // The deadline freed the seat: the next key is asked while the slow one never is again.
    await until(() => calls.length === 2)
    calls[0]!.resolve("Late title")
    calls[1]!.resolve("Next title")
    await until(() => asked.get().size === 1)
    await Bun.sleep(20)
    expect([...asked.get()]).toEqual([["next", "Next title"]])
    expect(notified).toBe(1)
    expect(calls).toHaveLength(2)
    seam.dispose()
  })

  test("dispose aborts what is in flight, drops its answers and asks nothing more", async () => {
    const { calls, write } = model()
    const seam = createTimelineTitleSeam({ write, debounceMs: 1, concurrency: 1 })
    const asked = seam.ask([run("a"), run("b")])
    let notified = 0
    asked.subscribe(() => { notified++ })
    await until(() => calls.length === 1)
    seam.dispose()
    expect(calls[0]!.signal.aborted).toBe(true)
    calls[0]!.resolve("Too late")
    await Bun.sleep(20)
    expect(asked.get().size).toBe(0)
    expect(notified).toBe(0)
    expect(calls).toHaveLength(1)
    // A rail that renders after dispose gets a handle that asks for nothing.
    seam.ask([run("c")]).subscribe(() => {})
    await Bun.sleep(20)
    expect(calls).toHaveLength(1)
  })
})

describe("the request", () => {
  test("states the entry count and lists every line by kind when it fits", () => {
    expect(titlePrompt([{ kind: "prompt", title: "“Fix the flaky\n test”" }, { kind: "event", title: "Ran 2 commands · 1 failed" }]))
      .toBe("This stretch holds 2 entries. Its lines, in order:\nprompt: “Fix the flaky test”\nevent: Ran 2 commands · 1 failed")
  })

  test("caps the lines it carries: the first ones, the count between, the last ten; and each line's length", () => {
    const lines = Array.from({ length: 237 }, (_, index) => ({ kind: "event" as const, title: `step ${index} ${"x".repeat(index === 0 ? 400 : 0)}` }))
    const rows = titlePrompt(lines).split("\n")
    expect(rows).toHaveLength(1 + TITLE_INPUT_LINES + 1)
    expect(rows[0]).toBe("This stretch holds 237 entries. Its lines, in order:")
    expect(rows[1]!.length).toBe("event: ".length + 160)
    expect(rows[1]!.endsWith("…")).toBe(true)
    expect(rows[30]).toBe("event: step 29")
    expect(rows[31]).toBe("… 197 more …")
    expect(rows[32]).toBe("event: step 227")
    expect(rows.at(-1)).toBe("event: step 236")
    expect(titlePrompt(lines.slice(0, TITLE_INPUT_LINES)).split("\n")).toHaveLength(1 + TITLE_INPUT_LINES)
  })

  test("the answer becomes a plain title of at most eight words, or nothing", () => {
    expect(cleanTitle("Hardened webhook retries.")).toBe("Hardened webhook retries")
    expect(cleanTitle("\n  Title: **“Moved retries into store.ts”**\nBecause the tests…")).toBe("Moved retries into store.ts")
    expect(cleanTitle("# `Webhook` retries")).toBe("Webhook retries")
    expect(cleanTitle("one two three four five six seven eight nine ten")).toBe("one two three four five six seven eight")
    expect(cleanTitle("Fixed the flaky test —")).toBe("Fixed the flaky test")
    expect(cleanTitle("")).toBeUndefined()
    expect(cleanTitle("“”")).toBeUndefined()
    for (const word of ["thread", "Tasks", "workflow", "lane", "sandboxes", "VM"]) expect(cleanTitle(`Set up the ${word} again`)).toBeUndefined()
    // Words that merely contain one stay.
    expect(cleanTitle("Multitasking planes in the vmstat output")).toBe("Multitasking planes in the vmstat output")
  })
})

describe("the model door", () => {
  const ndjson = (frames: unknown[]) => frames.map(frame => JSON.stringify(frame)).join("\n") + "\n"
  const door = (status: number, body: string) => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = []
    const http = async (url: string, init?: RequestInit) => { requests.push({ url, init }); return new Response(body, { status }) }
    return { requests, write: modelStreamTitles(http, "https://app.test") }
  }

  test("posts one user message under the title instructions, with no tools, and joins the text deltas to done", async () => {
    const { requests, write } = door(200, ndjson([
      { runId: "host-run", type: "delta", kind: "reasoning", text: "thinking" },
      { runId: "host-run", type: "delta", kind: "text", text: "Hardened " },
      { runId: "host-run", type: "delta", kind: "text", text: "webhook retries" },
      { runId: "host-run", type: "done", reason: "stop" },
      { runId: "host-run", type: "delta", kind: "text", text: " after done" }
    ]) + "not json\n")
    const signal = new AbortController().signal
    expect(await write("This stretch holds 3 entries.", signal)).toBe("Hardened webhook retries")
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe("https://app.test/api/model/stream")
    expect(requests[0]!.init?.method).toBe("POST")
    expect(requests[0]!.init?.signal).toBe(signal)
    const body = JSON.parse(String(requests[0]!.init?.body)) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(["instructions", "messages", "runId"])
    expect(body.instructions).toBe(TITLE_INSTRUCTIONS)
    expect(body.messages).toEqual([{ role: "user", content: "This stretch holds 3 entries." }])
    expect(String(body.runId)).toStartWith("timeline-title-")
  })

  test("a refused request, a done that carries an error and a stream that ends early all reject", async () => {
    const signal = new AbortController().signal
    await expect(door(503, JSON.stringify({ error: { code: "credential_missing" } })).write("p", signal)).rejects.toThrow("The model door answered 503.")
    await expect(door(200, ndjson([{ runId: "r", type: "delta", kind: "text", text: "Half" }, { runId: "r", type: "done", error: "refused · 429" }])).write("p", signal)).rejects.toThrow("refused · 429")
    await expect(door(200, ndjson([{ runId: "r", type: "delta", kind: "text", text: "Half" }])).write("p", signal)).rejects.toThrow("The model stream ended before its answer.")
  })
})
