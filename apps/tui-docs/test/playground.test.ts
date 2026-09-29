import assert from "node:assert/strict"
import { test } from "node:test"
import { run } from "../src/playground/agent.ts"
import { canonical, Journal, path, seed, storageKey } from "../src/playground/store.ts"
const memory = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    }
  }
}
test("atomic persistence, reload, historical isolation, and branching", () => {
  const storage = memory(), journal = new Journal(storage)
  journal.start("fix", "run")
  journal.update((frame) => {
    frame.files["math.js"] = "fixed"
    frame.events.push({ kind: "answer", text: "future" })
  })
  assert.deepEqual(journal.branch.frames[0]!.files, seed)
  assert.deepEqual(journal.branch.frames[0]!.events, [])
  const restored = new Journal(storage)
  assert.equal(restored.head.files["math.js"], "fixed")
  restored.branchAt(0, "child")
  assert.deepEqual(restored.head.files, seed)
  restored.select("main")
  assert.equal(restored.head.files["math.js"], "fixed")
  const before = structuredClone(restored.state)
  storage.setItem = () => {
    throw new Error("quota")
  }
  assert.throws(() =>
    restored.update((frame) => {
      frame.files["math.js"] = "lost"
    }), /quota/)
  assert.deepEqual(restored.state, before)
})
test("refuses corrupt persisted data and paths outside the volume", () => {
  const storage = memory()
  storage.setItem(storageKey, "broken")
  assert.throws(() => new Journal(storage))
  for (const value of ["../secret", "/secret", "a/b.js", "__proto__", ""]) assert.throws(() => path(value))
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }))
})
test("serialized journal enforces UTF-8 bytes at each boundary and recovers after refusal", () => {
  for (const symbol of ["a", "界", "😀"]) {
    for (const offset of [-1, 0, 1]) {
      const storage = memory(), journal = new Journal(storage)
      const before = structuredClone(journal.state)
      const next = structuredClone(before)
      const frame = structuredClone(journal.head)
      frame.events.push({ kind: "answer", text: "" })
      next.branches[0]!.frames.push(frame)
      const overhead = Buffer.byteLength(JSON.stringify(next))
      const target = 4_000_000 + offset - overhead
      const width = Buffer.byteLength(symbol)
      const content = symbol.repeat(Math.floor(target / width)) + "a".repeat(target % width)
      frame.events[0]!.text = content
      const serialized = JSON.stringify(next)
      assert.equal(Buffer.byteLength(serialized), 4_000_000 + offset)
      if (symbol !== "a") assert.ok(serialized.length < 4_000_000)

      if (offset === 1) {
        assert.throws(() => journal.update((current) => {
          current.events.push({ kind: "answer", text: content })
        }), /Sandbox history is full/)
        assert.deepEqual(journal.state, before)
        assert.equal(storage.getItem(storageKey), null)
        journal.update((current) => current.events.push({ kind: "answer", text: "recovered" }))
        assert.equal(new Journal(storage).head.events.at(-1)?.text, "recovered")
      } else {
        journal.update((current) => current.events.push({ kind: "answer", text: content }))
        assert.equal(storage.getItem(storageKey), serialized)
        assert.equal(new Journal(storage).head.events.at(-1)?.text, content)
      }
    }
  }
})
test("production file flow enforces UTF-8 bytes for creation and overwrite", async () => {
  const previous = globalThis.fetch
  try {
    for (const symbol of ["a", "界", "😀"]) {
      for (const offset of [-1, 0, 1]) {
        const target = 8192 + offset
        const width = Buffer.byteLength(symbol)
        const content = symbol.repeat(Math.floor(target / width)) + "a".repeat(target % width)
        assert.equal(Buffer.byteLength(content), target)
        const storage = memory(), journal = new Journal(storage)
        let requests = 0
        const first = `\`\`\`cell\nfor (const name of ["limit.txt", "math.js"]) { try { console.log(await ctx.call("write", { path: name, content: ${JSON.stringify(content)} })); } catch (error) { console.log(String(error)); } }\n\`\`\``
        globalThis.fetch = async () => Response.json({
          choices: [{ finish_reason: "stop", message: { content: ++requests === 1 ? first : "```cell\nctx.done(\"Finished.\");\n```" } }]
        })
        journal.start("Check file limit", `byte-${width}-${offset}`)
        await run(journal, { baseUrl: "", apiKey: "", model: "" }, () => {}, new AbortController().signal)
        assert.equal(journal.head.run?.status, "done", `${symbol} ${offset}: ${journal.head.run?.error}`)
        assert.equal(requests, 2)
        const expected = offset === 1 ? undefined : content
        assert.equal(journal.head.files["limit.txt"], expected)
        assert.equal(journal.head.files["math.js"], offset === 1 ? seed["math.js"] : content)
        const restored = new Journal(storage)
        assert.deepEqual(restored.head.files, journal.head.files)
        const flows = restored.head.events.filter((event) => event.kind === "flow")
        assert.equal(flows.length, 2)
        for (const event of flows) assert.match(event.text, offset === 1 ? /"outcome":"failure"/ : /"outcome":"success"/)
      }
    }
  } finally {
    globalThis.fetch = previous
  }
})
test("production agent recovers committed calls and model replies after interruption", async () => {
  const storage = memory(), journal = new Journal(storage), previous = globalThis.fetch
  let requests = 0
  const first =
    "```cell\nawait ctx.call(\"write\", {path:\"math.js\",content:\"export const add = (a, b) => a + b\\n\"});\nconsole.log(await ctx.call(\"check\", {}));\n```"
  const last = "```cell\nctx.done(\"Fixed and checked.\");\n```"
  const controller = new AbortController()
  globalThis.fetch = async (_url, init) => {
    requests++
    if (requests === 2) {
      queueMicrotask(() => controller.abort())
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      )
    }
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: requests === 1 ? first : last } }] })
  }
  try {
    journal.start("Fix addition", "durable-example")
    await run(journal, { baseUrl: "", apiKey: "", model: "" }, () => {}, controller.signal)
    assert.equal(journal.head.run?.status, "failed")
    assert.match(journal.head.files["math.js"]!, /a \+ b/)
    const count = Object.keys(journal.head.run!.calls).length
    assert.equal(count, 2)
    const restored = new Journal(storage)
    await run(restored, { baseUrl: "", apiKey: "", model: "" }, () => {}, new AbortController().signal)
    assert.equal(restored.head.run?.status, "done", restored.head.run?.error)
    assert.equal(requests, 3, "completed first model response was replayed")
    assert.equal(Object.keys(restored.head.run!.calls).length, count, "completed flow calls were not duplicated")
    assert.equal(restored.head.events.filter((e) => e.kind === "flow").length, 2)
  } finally {
    globalThis.fetch = previous
  }
})
test("a provider refusal stays visible and retryable", async () => {
  const previous = globalThis.fetch, journal = new Journal(memory())
  globalThis.fetch = async () => Response.json({ error: "unavailable" }, { status: 503 })
  try {
    journal.start("fix", "refused")
    await run(journal, { baseUrl: "", apiKey: "", model: "" }, () => {}, new AbortController().signal)
    assert.equal(journal.head.run?.status, "failed")
    assert.match(journal.head.run?.error ?? "", /Settings|unavailable/i)
    assert.deepEqual(journal.head.files, seed)
  } finally {
    globalThis.fetch = previous
  }
})
