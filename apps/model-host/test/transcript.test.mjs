import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

test("packaged transcript HTTP normalization preserves inert identities, checkpoints and real-agent correlations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-transcript-host-"))
  const bundle = join(directory, "host.mjs")
  execFileSync(process.execPath, [new URL("../build.mjs", import.meta.url).pathname, bundle])
  const child = spawn(process.execPath, [bundle, "serve", "--port", "0"], {
    env: { ...process.env, SMITHERS_CHAT_HOST_TOKEN: "transcript-token", SMITHERS_CHAT_CALLBACK_URL: "http://127.0.0.1:9", SMITHERS_CHAT_MODEL: "{}" },
    stdio: ["ignore", "pipe", "pipe"]
  })
  const exited = once(child, "exit")
  try {
    const ready = await new Promise((resolve, reject) => {
      let text = ""
      child.stdout.on("data", chunk => {
        text += chunk
        if (text.includes("\n")) resolve(JSON.parse(text.split("\n")[0]))
      })
      exited.then(() => reject(new Error("host exited before ready")))
    })
    const endpoint = `http://127.0.0.1:${ready.port}/v1/transcript/normalize`
    const post = (input, token = "transcript-token") => fetch(endpoint, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input)
    })
    assert.equal((await post({}, "wrong")).status, 401)
    assert.equal((await post({})).status, 422)
    const context = { owner_id: "42", participant_id: "01000000-0000-0000-0000-000000000000", session_id: "9", source_generation: "02000000-0000-0000-0000-000000000000:1" }
    for (const [fixture, file, profile, count, firstSource, toolCall] of [
      ["codex-0.160", "rollout.jsonl", "codex/0.160.0", 32, "01a10d62-91c7-7163-b038-72dab55a2e8c:10", "exec-72424bde-7b89-43fe-9962-8fe21e4a3d4b"],
      ["claude-code-2.1", "session.jsonl", "claude-code/2.1.0", 36, "93469675-c700-423f-be09-43aefb36a280:6", "toolu_01JD3dL8cHy7FW7iBubC6yjY"]
    ]) {
      const bytes = await readFile(new URL(`../../../packages/smithers/agent/harness/test/fixtures/external/${fixture}/${file}`, import.meta.url), "utf8")
      let state
      let offset = 0
      const entries = []
      for (const record of bytes.trimEnd().split("\n")) {
        const end = offset + Buffer.byteLength(record) + 1
        const input = { profile, context, record, start: offset, end, ...(state === undefined ? {} : { state }) }
        const response = await post(input)
        assert.equal(response.status, 200, `record at ${offset}: ${await response.clone().text()}`)
        const output = await response.json()
        // Replaying the same committed checkpoint is deterministic, including
        // tool calls that span records. The host has no mutable process state.
        assert.deepEqual(await (await post(input)).json(), output)
        assert.equal(output.needs_more, false)
        assert.equal(output.state.offset, end)
        assert.equal(output.state.pending, "")
        entries.push(...output.entries)
        state = JSON.parse(JSON.stringify(output.state))
        offset = end
      }
      assert.equal(entries.length, count)
      assert.equal(entries[0].source_id, firstSource)
      assert.equal(entries[0].author_id, "42")
      assert.equal(entries[0].kind, "prompt")
      if (fixture === "codex-0.160") assert.equal(entries[0].body, "How do I use ultrafast")
      const tool = entries.find(entry => entry.call_id === toolCall)
      assert.equal(tool.kind, "tool_result")
      assert.equal(tool.author_id, context.participant_id)
      assert.equal(tool.body.call_id, toolCall)
      for (const entry of entries) {
        assert.equal(entry.session_id, "9")
        assert.equal(entry.participant_id, context.participant_id)
        assert.equal(entry.owner_id, "42")
        assert.equal(entry.origin, "external")
        assert.equal(entry.read_only, true)
        assert.equal(entry.id, `${context.source_generation}:${entry.source_id}`)
      }
      const record = "{}"
      const next = { profile, context, record, start: offset, end: offset + 3, state }
      for (const forged of [
        { ...next, start: offset + 1 }, { ...next, end: Number.MAX_SAFE_INTEGER + 1 },
        { ...next, context: { ...context, owner_id: "../../other-home" } },
        { ...next, context: { ...context, source_generation: "02000000-0000-0000-0000-000000000000:2" } },
        { ...next, state: { ...state, decoder: { ...state.decoder, pending: "unfinished" } } },
        { ...next, state: { ...state, decoder: { ...state.decoder, seq: -1 } } },
        { ...next, profile: "codex/unsupported" }, { ...next, record: "{}\n{}" }
      ]) assert.equal((await post(forged)).status, 422)
    }
    const unsupported = '{"type":"session_meta","payload":{"id":"other","cli_version":"99.0.0"}}'
    assert.equal((await post({ profile: "codex/0.160.0", context, record: unsupported, start: 0, end: Buffer.byteLength(unsupported) + 1 })).status, 422)
  } finally {
    child.kill("SIGTERM")
    await exited
    await rm(directory, { recursive: true, force: true })
  }
})
