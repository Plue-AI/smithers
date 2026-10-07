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
    for (const [fixture, file, profile] of [
      ["codex-0.160", "rollout.jsonl", "codex/0.160.0"],
      ["claude-code-2.1", "session.jsonl", "claude-code/2.1.0"],
      ["codex-machine-0.160", "rollout.jsonl", "codex/0.160.0"]
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
      const golden = JSON.parse(await readFile(new URL(`../../../packages/smithers/agent/harness/test/fixtures/external/${fixture}/drafts.expected.json`, import.meta.url), "utf8"))
      // Independent committed expectations, adapted only to the registered HTTP identities.
      const expected = golden.entries.map(entry => ({...entry,
        id: JSON.stringify([entry.agent,context.session_id,context.source_generation,entry.source_offset,entry.source_id,JSON.parse(entry.id)[5]]),
        owner_id:context.owner_id,participant_id:context.participant_id,session_id:context.session_id,
        author_id:entry.kind === "prompt" ? context.owner_id : context.participant_id
      }))
      assert.deepEqual(entries, expected)
      assert.deepEqual(state.context, context)
      if(fixture === "codex-machine-0.160") {
        assert(entries.some(entry=>entry.kind === "edit" && entry.failed))
        assert(entries.some(entry=>entry.kind === "tool_result" && entry.failed))
      }
      const record = "{}"
      const next = { profile, context, record, start: offset, end: offset + 3, state }
      for (const forged of [
        { ...next, start: offset + 1 }, { ...next, end: Number.MAX_SAFE_INTEGER + 1 },
        { ...next, context: { ...context, owner_id: "../../other-home" } },
        { ...next, context: { ...context, owner_id: "43" } },
        { ...next, context: { ...context, session_id: "10" } },
        { ...next, context: { ...context, participant_id: "03000000-0000-0000-0000-000000000000" } },
        { ...next, context: { ...context, source_generation: "02000000-0000-0000-0000-000000000000:2" } },
        { ...next, state: { ...state, native: { ...state.native, pending: "unfinished" } } },
        { ...next, state: { ...state, native: { ...state.native, seq: -1 } } },
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
