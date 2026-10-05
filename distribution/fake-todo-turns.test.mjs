import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import { createServer } from "node:net"
import { test } from "node:test"
import { CHANGELOG_STEP, GREETING, markersOf, QUESTION, REVIEW_ANSWER, SMOKE_PATH, SMOKE_REWRITTEN, SMOKE_TEST, todoTurn } from "./fake-todo-turns.mjs"

// A turn as the coding host sends it: the step's teaching, then its task.
const turn = (teaching, payload, ...user) => [
  { role: "system", content: `${teaching}\nThe task for this run: ${JSON.stringify(payload)}` },
  ...user.map((content) => ({ role: "user", content }))
]
const REVIEW = "Review a coding request against supplied repository memory and native history before planning changes."
const PLAN = "Plan one linear mythical coding progression"
const EDIT = "Implement the single atomic change in the owning workspace using the provided filesystem tools."
const REPAIR = "Select one existing JJ atom owned by this Change to correct the supplied findings. Return its exact changeId."

/** The value a scripted cell settles with, run against an in-memory working copy. */
const run = async (content, files = {}) => {
  const source = /^```cell\n([\s\S]*)\n```$/.exec(content)?.[1]
  assert.ok(source !== undefined, `not one cell: ${content}`)
  const tree = new Map(Object.entries(files))
  let settled
  const ctx = {
    call: async (name, input) => {
      if (name === "read") return tree.has(input.path) ? { ok: true, content: tree.get(input.path) } : { ok: false, error: { message: "missing" } }
      if (name === "write") return tree.set(input.path, input.content), { ok: true }
      throw new Error(`unexpected tool ${name}`)
    },
    done: (value) => { settled = value }
  }
  await new (Object.getPrototypeOf(async () => {}).constructor)("ctx", source)(ctx)
  return { settled, tree: Object.fromEntries(tree) }
}

/** The plan's one atom for a TODO prompt, and the answer to its question. */
const plan = async (prompt, extra = {}) => {
  const answered = todoTurn(turn(PLAN, { input: { prompt, feedback: extra.feedback ?? [] }, context: { checks: [] }, answer: extra.answer ?? "" }))
  assert.equal(answered.step, "coding/draft-plan")
  return (await run(answered.content)).settled.changes[0].atoms[0]
}

test("markers are bracketed words; [FIXED] ends [FAIL]", () => {
  assert.deepEqual(markersOf("Add a greeting"), { ask: false, fail: false, fixed: false, pr: false, hold: undefined, resolve: true, file: undefined, flowedit: false, changelog: false, droptest: false, restoretest: false })
  assert.equal(markersOf("ASK FAIL HOLD").ask, false)
  const all = markersOf("[ASK] [FAIL] [PR] [HOLD t-2] [NORESOLVE] [FILE notes/t2.md] [FLOWEDIT]")
  assert.deepEqual(all, { ask: true, fail: true, fixed: false, pr: true, hold: "t-2", resolve: false, file: "notes/t2.md", flowedit: true, changelog: false, droptest: false, restoretest: false })
  assert.equal(markersOf(["[FAIL] add it", ["steer: [FIXED]"]]).fail, false)
})

test("an unmarked TODO plans, edits and settles exactly as the J1 rehearsal's", async () => {
  const review = todoTurn(turn(REVIEW, { input: { prompt: "Add a greeting to JOURNEY.md", feedback: [] }, context: {} }))
  assert.equal((await run(review.content)).settled.clarification, "")
  const atom = await plan("Add a greeting to JOURNEY.md")
  assert.deepEqual(atom, { changeId: null, message: "📝 docs: add a greeting to JOURNEY.md", intent: "Append a greeting line to JOURNEY.md.", reads: ["JOURNEY.md"], writes: ["JOURNEY.md"] })
  const edit = todoTurn(turn(EDIT, { atom }))
  assert.equal(edit.hold, undefined)
  const { settled, tree } = await run(edit.content, { "JOURNEY.md": "Add a greeting to JOURNEY.md\n" })
  assert.deepEqual(tree, { "JOURNEY.md": `Add a greeting to JOURNEY.md\n${GREETING}\n` })
  assert.deepEqual(settled, { summary: "Appended a greeting to JOURNEY.md.", reads: ["JOURNEY.md"], writes: ["JOURNEY.md"] })
})

test("[ASK] asks one question, and the edit writes the answer", async () => {
  const review = todoTurn(turn(REVIEW, { input: { prompt: "[ASK] Add a greeting", feedback: [] }, context: {} }))
  assert.equal((await run(review.content)).settled.clarification, QUESTION)
  const atom = await plan("[ASK] Add a greeting", { answer: "Say hi" })
  const { tree } = await run(todoTurn(turn(EDIT, { atom })).content, { "JOURNEY.md": "x\n" })
  assert.equal(tree["JOURNEY.md"], `x\n${GREETING} Say hi\n`)
})

test("[ASK]'s answer reaches the edit as the coding host hands it the atom: JSON beside the request", async () => {
  const atom = await plan("[ASK] Add a greeting", { answer: "Say \"hi\"" })
  const hosted = { ...atom, intent: JSON.stringify({ request: "[ASK] Add a greeting", feedback: "", change: "JOURNEY.md carries a greeting.", atom: atom.intent }) }
  const { tree } = await run(todoTurn(turn(EDIT, { atom: hosted })).content, { "JOURNEY.md": "x\n" })
  assert.equal(tree["JOURNEY.md"], `x\n${GREETING} Say "hi"\n`)
})

test("[FILE path] and [HOLD key] reach the edit through the plan", async () => {
  const atom = await plan("[PR] [FILE notes/t2.md] [HOLD t2] Add a greeting")
  assert.deepEqual(atom.writes, ["notes/t2.md"])
  const edit = todoTurn(turn(EDIT, { atom }))
  assert.equal(edit.hold, "t2")
  const { tree, settled } = await run(edit.content, { "JOURNEY.md": "keep\n" })
  assert.deepEqual(tree, { "JOURNEY.md": "keep\n", "notes/t2.md": `${GREETING}\n` })
  assert.deepEqual(settled.writes, ["notes/t2.md"])
})

test("[FAIL] empties JOURNEY.md until a steer or retry feedback says [FIXED]", async () => {
  const failing = await plan("[FAIL] [FILE t3.md] Add a greeting")
  assert.deepEqual(failing.writes, ["t3.md", "JOURNEY.md"])
  assert.equal((await run(todoTurn(turn(EDIT, { atom: failing })).content, { "JOURNEY.md": "x\n" })).tree["JOURNEY.md"], "")
  // The correction keeps failing until [FIXED] reaches the run.
  const repair = (...user) => todoTurn(turn(REPAIR, { owner: { atoms: [{ changeId: "c1", intent: failing.intent }] }, findings: [] }, ...user))
  assert.match((await run(repair().content)).settled.intent, /\[FAIL\]/)
  assert.doesNotMatch((await run(repair("Steer: [FIXED] keep the file").content)).settled.intent, /\[FAIL\]/)
  const fixed = await plan("[FAIL] [FILE t3.md] Add a greeting", { feedback: ["[FIXED]"] })
  assert.deepEqual(fixed.writes, ["t3.md"])
  assert.equal((await run(todoTurn(turn(EDIT, { atom: fixed })).content, { "JOURNEY.md": "x\n" })).tree["JOURNEY.md"], "x\n")
})

test("[DROPTEST] drops the existing adds test until the test guard's repair restores it", async () => {
  const atom = await plan("[DROPTEST] [FILE t3.md] Add a greeting")
  assert.match(atom.intent, /\[DROPTEST\]/)
  assert.deepEqual(atom.writes, ["t3.md", SMOKE_PATH])
  const dropped = await run(todoTurn(turn(EDIT, { atom })).content, { [SMOKE_PATH]: SMOKE_TEST })
  assert.equal(dropped.tree[SMOKE_PATH], SMOKE_REWRITTEN)
  assert.doesNotMatch(SMOKE_REWRITTEN, /test\("adds"/)
  // The guard's finding asks for the test back; the repair intent restores it.
  const findings = [{ owner: "greeting", sourceCommitId: "c", message: `Restore the existing test "adds" in ${SMOKE_PATH}: this change deletes it, and the request does not ask for its removal.` }]
  const selected = await run(todoTurn(turn(REPAIR, { implementation: { atoms: [{ changeId: "jj-1", intent: atom.intent }] }, findings })).content)
  assert.match(selected.settled.intent, /\[RESTORETEST\]/)
  const repaired = { ...atom, intent: `${atom.intent}\n\nCorrection: ${selected.settled.intent}` }
  const restored = await run(todoTurn(turn(EDIT, { atom: repaired })).content, { [SMOKE_PATH]: SMOKE_REWRITTEN })
  assert.equal(restored.tree[SMOKE_PATH], SMOKE_TEST)
  // Any other finding leaves the drop in place.
  const other = await run(todoTurn(turn(REPAIR, { implementation: { atoms: [{ changeId: "jj-1", intent: atom.intent }] }, findings: [{ message: "lint" }] })).content)
  assert.doesNotMatch(other.settled.intent, /\[RESTORETEST\]/)
})

test("[FLOWEDIT] writes only the TODO flow, whose changelog step later TODOs follow", async () => {
  const atom = await plan("[FLOWEDIT] Every TODO must update the changelog")
  assert.deepEqual(atom.writes, ["flows/todo/flow.ts"])
  const { tree, settled } = await run(todoTurn(turn(EDIT, { atom })).content, { "CHANGELOG.md": "# Changes\n" })
  assert.deepEqual(Object.keys(tree).sort(), ["CHANGELOG.md", "flows/todo/flow.ts"])
  assert.equal(tree["CHANGELOG.md"], "# Changes\n")
  assert.deepEqual(settled.writes, ["flows/todo/flow.ts"])
  assert.match(tree["flows/todo/flow.ts"], /Flow\.make\("todo"/)
  assert.ok(tree["flows/todo/flow.ts"].includes(CHANGELOG_STEP), "the flow carries no changelog step")
  // A TODO the edited flow runs carries [CHANGELOG] and appends one line.
  const next = await plan(`Add a greeting\n\n${CHANGELOG_STEP}`)
  assert.deepEqual(next.writes, ["JOURNEY.md", "CHANGELOG.md"])
  const after = await run(todoTurn(turn(EDIT, { atom: next })).content, { "JOURNEY.md": "x\n", "CHANGELOG.md": "# Changes\n" })
  assert.equal(after.tree["CHANGELOG.md"], `# Changes\n- ${GREETING}\n`)
})

test("a conflict turn resolves keeping both sides, or gives up for [NORESOLVE]", async () => {
  const conflicted = [
    "intro",
    "<<<<<<< Conflict 1 of 1",
    "%%%%%%% Changes from base to side #1",
    " base",
    "+ours",
    "+++++++ Contents of side #2",
    "base",
    "theirs",
    ">>>>>>> Conflict 1 of 1 ends",
    ""
  ].join("\n")
  const prompt = `Resolve the conflict in path "notes/c.md" on jj change "abc" in repository o/r.`
  const resolved = todoTurn([{ role: "system", content: "agent" }, { role: "user", content: prompt }])
  assert.equal(resolved.step, "conflict/resolve")
  const { tree, settled } = await run(resolved.content, { "notes/c.md": conflicted })
  assert.equal(tree["notes/c.md"], "intro\nbase\nours\nbase\ntheirs\n")
  assert.equal(settled.resolved, true)
  const refused = todoTurn([{ role: "user", content: `${prompt} [NORESOLVE]` }])
  assert.equal(refused.step, "conflict/noresolve")
  assert.equal((await run(refused.content)).settled.resolved, false)
  // A planned file's own [NORESOLVE] answers its later conflict turn.
  await plan("[NORESOLVE] [FILE notes/d.md] Add a greeting")
  assert.equal(todoTurn([{ role: "user", content: `Resolve the conflict in path "notes/d.md" on jj change "x"` }]).step, "conflict/noresolve")
})

const freePort = async () => {
  const listener = createServer()
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  return port
}

test("the provider holds a [HOLD key] edit turn until POST /release/<key>", { timeout: 15_000 }, async (t) => {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const provider = spawn(process.execPath, [new URL("./fake-todo-provider.mjs", import.meta.url).pathname], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  })
  const exited = new Promise((resolve) => provider.once("exit", resolve))
  t.after(async () => {
    provider.kill()
    await exited
  })
  for (const deadline = Date.now() + 5000; ;) {
    try {
      if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(250) })).ok) break
    } catch { /* still starting */ }
    assert.ok(Date.now() < deadline, "provider did not start")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const atom = { changeId: null, message: "m", intent: "Append a greeting line to t4.md. [HOLD t4] [FILE t4.md]", reads: ["t4.md"], writes: ["t4.md"] }
  const answered = fetch(`${origin}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: turn(EDIT, { atom }) }) }).then((response) => response.text())
  let settled = false
  void answered.then(() => { settled = true })
  for (const deadline = Date.now() + 5000; ;) {
    const held = await (await fetch(`${origin}/held`)).json()
    if (held.includes("t4")) break
    assert.ok(Date.now() < deadline, "the edit turn was not held")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(settled, false, "a held turn answered before its release")
  assert.equal((await fetch(`${origin}/release/t4`, { method: "POST" })).status, 204)
  const body = await answered
  assert.match(body, /t4\.md/)
  assert.match(body, /\[DONE\]/)
  assert.deepEqual(await (await fetch(`${origin}/held`)).json(), [])
  // A released key holds nothing later.
  const again = await (await fetch(`${origin}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: turn(EDIT, { atom }) }) })).text()
  assert.match(again, /\[DONE\]/)
})

test("with TODO_RELAY_URL the provider relays every call to a real model and scripts nothing", { timeout: 15_000 }, async (t) => {
  // The upstream stands in for the AI Gateway: it records what it was sent.
  const seen = []
  const upstream = createHttpServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    seen.push({ url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) })
    if (request.url === "/v4/ai/evaluation-model" && seen.length > 2) return void response.writeHead(400).end("bad question")
    response.writeHead(200, { "content-type": request.url === "/v1/chat/completions" ? "text/event-stream" : "application/json" })
    response.end(request.url === "/v1/chat/completions" ? "data: {\"real\":true}\n\ndata: [DONE]\n\n" : "{\"answers\":{}}")
  })
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  t.after(() => upstream.close())
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const provider = spawn(process.execPath, [new URL("./fake-todo-provider.mjs", import.meta.url).pathname], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      TODO_RELAY_URL: `http://127.0.0.1:${upstream.address().port}`,
      TODO_RELAY_MODEL: "anthropic/claude-sonnet-4.5",
      TODO_RELAY_KEY: "relay-key"
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  const exited = new Promise((resolve) => provider.once("exit", resolve))
  t.after(async () => {
    provider.kill()
    await exited
  })
  for (const deadline = Date.now() + 5000; ;) {
    try {
      if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(250) })).ok) break
    } catch { /* still starting */ }
    assert.ok(Date.now() < deadline, "provider did not start")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const chat = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer proxy-key" },
    body: JSON.stringify({ model: "gpt-oss-120b", stream: true, messages: turn(EDIT, { atom: { intent: "Append a greeting line to JOURNEY.md." } }) })
  })
  assert.equal(await chat.text(), "data: {\"real\":true}\n\ndata: [DONE]\n\n", "the real answer, not a scripted cell")
  const evaluator = { method: "POST", headers: { "ai-model-id": "typesafe-ai/jev", "ai-gateway-protocol-version": "0.0.1", authorization: "Bearer proxy-key" }, body: JSON.stringify({ questions: { route: {} } }) }
  assert.equal(await (await fetch(`${origin}/v4/ai/evaluation-model`, evaluator)).text(), "{\"answers\":{}}")
  const refused = await fetch(`${origin}/v4/ai/evaluation-model`, evaluator)
  assert.deepEqual([refused.status, await refused.text()], [400, "bad question"])
  assert.deepEqual(seen.map(({ url, body }) => [url, body.model]), [
    ["/v1/chat/completions", "anthropic/claude-sonnet-4.5"],
    ["/v4/ai/evaluation-model", undefined],
    ["/v4/ai/evaluation-model", undefined]
  ])
  // The relay's own key replaces the proxy's; the Gateway's protocol headers pass.
  assert.ok(seen.every(({ headers }) => headers.authorization === "Bearer relay-key"))
  assert.deepEqual([seen[1].headers["ai-model-id"], seen[1].headers["ai-gateway-protocol-version"]], ["typesafe-ai/jev", "0.0.1"])
  const turns = await (await fetch(`${origin}/turns`)).json()
  assert.deepEqual([turns.chat, turns.evaluator, turns.refused, turns.steps["coding/edit-atom"]], [1, 2, 1, 1])
})

test("the stack's review of the pull request approves on its first line, then summarizes", async () => {
  // review/change is a prompt flow: its body is the system teaching and its
  // arguments a "# Arguments" section (flows/review/change/flow.mdx).
  const body = readFileSync(new URL("../flows/review/change/flow.mdx", import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "")
  const args = "Pull request #3.\n\n<untrusted-title>\nGreet visitors\n</untrusted-title>\n\n<untrusted-diff>\n+Hello\n</untrusted-diff>\n"
  const answered = todoTurn([{ role: "system", content: `${body}\n# Arguments\n\n## args\n\n${args}` }, { role: "user", content: "Begin." }])
  assert.equal(answered?.step, "review/change")
  const { settled } = await run(answered.content)
  assert.equal(settled, REVIEW_ANSWER)
  // The stack reads the verdict from the first line (mythicalReviewVerdict)
  // and the summary from the labeled lines under it (mythicalReviewSummary).
  assert.equal(settled.split("\n")[0], "approve")
  assert.deepEqual(settled.split("\n").slice(1, 4).map((line) => line.split(":")[0]), ["Changed", "Checks", "Risks"])
  assert.match(settled, /\n\n- JOURNEY\.md:1 /, "a finding under the summary")
  // No coding step's turn reads as the review.
  assert.notEqual(todoTurn(turn(REVIEW, { input: { prompt: "Add a greeting", feedback: [] }, context: {} }))?.step, "review/change")
})
