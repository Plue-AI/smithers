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
      ["codex-0.160", "rollout.jsonl", "codex-rollout/0.160", 34, "01a10d62-91c7-7163-b038-72dab55a2e8c:10", "exec-72424bde-7b89-43fe-9962-8fe21e4a3d4b"],
      ["codex-machine-0.160", "rollout.jsonl", "codex-rollout/0.160", 12, "01a1149b-f90c-7833-87d0-6c4ff981df9c:10", "exec-10bea587-3f23-46c4-acb7-30d36f92b5d5"],
      ["claude-code-2.1", "session.jsonl", "claude-code/2.1", 36, "93469675-c700-423f-be09-43aefb36a280:6", "toolu_01JD3dL8cHy7FW7iBubC6yjY"]
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
      assert.equal(entries[0].seq, 0)
      assert.equal(entries[0].at, { "codex-0.160": 1791225945426, "codex-machine-0.160": 1791347138159, "claude-code-2.1": 1789775623241 }[fixture])
      assert.equal(entries[0].body.type, "prompt")
      if (fixture === "codex-0.160") {
        assert.equal(entries[0].body.text, "How do I use ultrafast")
        // The recorded encrypted message body is one inert placeholder at its source record, never the ciphertext.
        const encrypted = entries.filter(entry => entry.body.type === "encrypted")
        assert.deepEqual(encrypted.map(entry => [entry.source_id, entry.kind, entry.author_id, entry.body]), [
          ["01a10d62-91c7-7163-b038-72dab55a2e8c:98", "attachment", context.participant_id, { type: "encrypted" }]
        ])
        assert.ok(!JSON.stringify(entries).includes("gAAAAABqw_FYg6K7"))
        // The owner's goal is the owner's, like a prompt.
        const goal = entries.find(entry => entry.body.type === "goal")
        assert.deepEqual([goal.kind, goal.author_id, goal.body.objective], ["prompt", "42", "finish the spec"])
      }
      if (fixture === "codex-machine-0.160") {
        // The failed script's request arrives two records before its report: the checkpoint carries it between
        // requests, so the failed tool keeps its command and the failed edit its file.
        const failed = entries.filter(entry => entry.call_id === "call_dbe0b931f54b4b7bbca20b5236d530ff")
        assert.deepEqual(failed.map(entry => [entry.source_id, entry.kind, entry.failed]), [
          ["01a1149b-f90c-7833-87d0-6c4ff981df9c:35", "tool_result", true],
          ["01a1149b-f90c-7833-87d0-6c4ff981df9c:35#1", "edit", true]
        ])
        assert.match(failed[0].body.command, /apply_patch/)
        assert.match(failed[0].body.output, /^Script failed\n/)
        assert.deepEqual(failed[1].body.files, [{ path: "/workspace/capture/sample.txt", change: "modified", diff: "" }])
        assert.deepEqual(entries.filter(entry => entry.kind === "edit").map(entry => entry.failed), [false, false, true])
      }
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
      // A record each decoder skips by name, so only the forged envelope can refuse the request.
      const record = profile.startsWith("codex") ? '{"type":"turn_context","payload":{}}' : '{"type":"mode","mode":"default"}'
      const next = { profile, context, record, start: offset, end: offset + Buffer.byteLength(record) + 1, state }
      assert.equal((await post(next)).status, 200)
      // A complete record of a kind the decoder does not name is the decoder's refusal: the answer names the
      // reason and the source line, so the backend can stop that source and show where it stopped.
      const future = profile.startsWith("codex") ? '{"type":"future_semantic_record","payload":{}}' : '{"type":"future-semantic-record"}'
      const lines = bytes.trimEnd().split("\n").length
      const refused = await post({ ...next, record: future, end: offset + Buffer.byteLength(future) + 1 })
      assert.equal(refused.status, 422)
      assert.deepEqual(await refused.json(), { code: "transcript_refused", reason: "unsupported_record", line: lines + 1 })
      const broken = await post({ ...next, record: "{not json", end: offset + 10 })
      assert.deepEqual([broken.status, await broken.json()], [422, { code: "transcript_refused", reason: "malformed_record", line: lines + 1 }])
      // A forged envelope or checkpoint is not the decoder's answer: it names no reason and stops no source.
      for (const forged of [
        { ...next, start: offset + 1 }, { ...next, end: Number.MAX_SAFE_INTEGER + 1 },
        { ...next, context: { ...context, owner_id: "../../other-home" } },
        { ...next, context: { ...context, source_generation: "02000000-0000-0000-0000-000000000000:2" } },
        { ...next, state: { ...state, decoder: { ...state.decoder, pending: "unfinished" } } },
        { ...next, state: { ...state, decoder: { ...state.decoder, seq: -1 } } },
        { ...next, profile: "codex/unsupported" }, { ...next, profile: "../claude-code/2.1" }, { ...next, record: "{}\n{}" }
      ]) {
        const response = await post(forged)
        assert.deepEqual([response.status, await response.json()], [422, { code: "transcript_invalid" }])
      }
    }
    // What the machine's reader sends for a line it cannot send as written (smithers-machined, transcript.rs): a
    // byte that is not UTF-8, or a NUL, arrives as `?`, one byte for one, and an empty line arrives as the leading
    // space of the record after it. Both are ordinary records with the source's own byte ranges: the entry is
    // shown with the mark in it, and everything the agent writes afterwards is read as before.
    for (const [fixture, file, profile] of [
      ["codex-machine-0.160", "rollout.jsonl", "codex-rollout/0.160"],
      ["claude-code-2.1", "session.jsonl", "claude-code/2.1"]
    ]) {
      const records = (await readFile(new URL(`../../../packages/smithers/agent/harness/test/fixtures/external/${fixture}/${file}`, import.meta.url), "utf8")).trimEnd().split("\n")
      const run = async sent => {
        let state
        let offset = 0
        const entries = []
        for (const record of sent) {
          const end = offset + Buffer.byteLength(record) + 1
          const response = await post({ profile, context, record, start: offset, end, ...(state === undefined ? {} : { state }) })
          assert.equal(response.status, 200, `${fixture} record at ${offset}: ${await response.clone().text()}`)
          const output = await response.json()
          assert.equal(output.state.offset, end)
          entries.push(...output.entries)
          state = output.state
          offset = end
        }
        return entries
      }
      const written = await run(records)
      const prompt = written[0].body.text
      // The record the prompt entry came from: its source id ends in that record's line number.
      const at = Number(written[0].source_id.split(":")[1]) - 1
      assert.ok(at > 0 && prompt.length > 8 && records[at].includes(JSON.stringify(prompt).slice(1, -1)))
      const marked = prompt.slice(0, 3) + "?" + prompt.slice(4, -1) + "?"
      const sent = records.map((record, index) => {
        // The owner's prompt held a byte that is not UTF-8 and ended in a NUL.
        if (index === at) return record.replaceAll(JSON.stringify(prompt).slice(1, -1), JSON.stringify(marked).slice(1, -1))
        // An empty line came before the next record and before the last one.
        return index === at + 1 || index === records.length - 1 ? " " + record : record
      })
      assert.equal(Buffer.byteLength(sent[at]), Buffer.byteLength(records[at]))
      const read = await run(sent)
      // The same entries, in the same order, under the same ids. The prompt shows its marks. A record led by an
      // empty line starts where that line did; the records after it start one byte later, where they are in the file.
      assert.equal(read.length, written.length)
      assert.equal(read[0].body.text, marked)
      const shifted = entry => entry.source_offset + (Number(entry.source_id.split(":")[1].split("#")[0]) > at + 2 ? 1 : 0)
      assert.deepEqual(read.slice(1).map(entry => ({ ...entry, body: undefined })), written.slice(1).map(entry => ({ ...entry, body: undefined, source_offset: shifted(entry) })))
      for (const [index, entry] of written.entries()) {
        if (!JSON.stringify(entry.body).includes(JSON.stringify(prompt).slice(1, -1))) assert.deepEqual(read[index].body, entry.body)
      }
    }
    // A source registered under a release line no decoder reads is refused as an unsupported version before any
    // record is read, at its first record and at a later one alike.
    for (const profile of ["claude-code/2.2", "codex-rollout/0.161"]) {
      const record = '{"type":"anything"}'
      const first = await post({ profile, context, record, start: 0, end: Buffer.byteLength(record) + 1 })
      assert.deepEqual([first.status, await first.json()], [422, { code: "transcript_refused", reason: "unsupported_version", line: 1 }])
    }
    // The transcript itself names a release the decoder does not read, or a supported line other than the one
    // the source was registered with.
    for (const [profile, record, line] of [
      ["codex-rollout/0.160", '{"type":"session_meta","payload":{"id":"other","cli_version":"99.0.0"}}', 1],
      ["codex-rollout/0.160", '{"type":"session_meta","payload":{"id":"older","cli_version":"0.159.2","cwd":"/work"}}', 1],
      ["claude-code/2.1", '{"type":"user","uuid":"u","sessionId":"s","version":"2.2.0","message":{"role":"user","content":"hi"}}', 1],
      ["claude-code/2.1", '{"type":"user","uuid":"u","sessionId":"s","message":{"role":"user","content":"hi"}}', 1]
    ]) {
      const response = await post({ profile, context, record, start: 0, end: Buffer.byteLength(record) + 1 })
      const reason = record.includes('"version"') || profile.startsWith("codex") ? "unsupported_version" : "missing_version"
      assert.deepEqual([response.status, await response.json()], [422, { code: "transcript_refused", reason, line }])
    }
    // The adapter supports both releases. A registered profile must match the
    // source metadata on first import and every recovered decoder checkpoint.
    const metadata159 = '{"type":"session_meta","payload":{"id":"older","cli_version":"0.159.2","cwd":"/work"}}'
    const older = { profile: "codex-rollout/0.159", context, record: metadata159, start: 0, end: Buffer.byteLength(metadata159) + 1 }
    const accepted159 = await post(older)
    assert.equal(accepted159.status, 200)
    const recovered159 = await accepted159.json()
    assert.deepEqual(recovered159.entries, [])
    assert.equal(recovered159.state.decoder.session.format_version, "codex-rollout/0.159")
    const context159 = '{"type":"turn_context","payload":{}}'
    const next159 = { profile: older.profile, context, record: context159, start: older.end, end: older.end + Buffer.byteLength(context159) + 1, state: recovered159.state }
    assert.equal((await post(next159)).status, 200)
    assert.deepEqual(await (await post({ ...older, profile: "codex-rollout/0.160" })).json(), { code: "transcript_refused", reason: "unsupported_version", line: 1 })
    assert.deepEqual(await (await post({ ...next159, profile: "codex-rollout/0.160" })).json(), { code: "transcript_invalid" })
    assert.equal((await post({ ...next159, state: { ...recovered159.state, decoder: { ...recovered159.state.decoder, session: { ...recovered159.state.decoder.session, format_version: "codex-rollout/0.160" } } } })).status, 422)
    // Constructed maximum-sized metadata record. Its escaped HTTP envelope
    // exceeds the model-turn body limit; normalization keeps its own bound.
    const maximum = JSON.stringify({ type: "session_meta", payload: { id: "large", cli_version: "0.160.0", cwd: "\\".repeat(524247) + "x" } })
    assert.equal(Buffer.byteLength(maximum), 1048576)
    const large = { profile: "codex-rollout/0.160", context, record: maximum, start: 0, end: 1048577 }
    assert.ok(Buffer.byteLength(JSON.stringify(large)) > 2097152)
    const maximumResponse = await post(large)
    assert.equal(maximumResponse.status, 200)
    const maximumOutput = await maximumResponse.json()
    assert.deepEqual(maximumOutput.entries, [])
    assert.equal(maximumOutput.state.offset, 1048577)
    assert.equal(maximumOutput.state.decoder.session.cwd.length, 524248)
    assert.equal((await post({ ...large, record: maximum + "x", end: 1048578 })).status, 422)
    assert.equal((await post({ blob: "x".repeat(8388608) })).status, 413)

  } finally {
    child.kill("SIGTERM")
    await exited
    await rm(directory, { recursive: true, force: true })
  }
})
