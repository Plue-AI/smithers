import { Seat } from "@smthrs/agent"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Fiber, Layer, Stream } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { liveModel } from "../create-app/template/aomi/test/support/liveModel.ts"
import * as Agents from "../src/Agents.ts"
import * as Application from "../src/Application.ts"
import * as CodexCode from "../src/internal/CodexCode.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Providers from "../src/Providers.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const request = (overrides: Partial<ModelRequest.ModelRequest> = {}) =>
  ModelRequest.ModelRequest.make({
    modelId: "gpt-6-sol",
    system: [ModelRequest.SystemPart.make({ text: "Write a cell." })],
    messages: [ModelRequest.Message.user("--prompt is text")],
    tools: [],
    toolChoice: "none",
    params: ModelRequest.GenerationParams.make({ reasoningEffort: "high" }),
    cacheKey: "run-1",
    ...overrides
  })
const fakeModel = (script: string, limits: { timeoutMs?: number; maxBytes?: number } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "smithers-codex-model-"))
  roots.push(root)
  const executable = join(root, "codex")
  writeFileSync(executable, `#!${process.execPath}\n${script}`, { mode: 0o755 })
  return {
    root,
    model: CodexCode.make({
      model: "gpt-6-sol",
      executable,
      environment: { HOME: root, CODEX_HOME: root, PATH: root },
      cwd: root,
      ...limits
    })
  }
}
const collect = (model: ReturnType<typeof CodexCode.make>, input = request()) =>
  Effect.runPromise(Stream.runCollect(model.stream(input)).pipe(Effect.map((events) => Array.from(events))))

describe("Codex vendor model", () => {
  const answer = "```cell\nreturn 2\n```"
  const success = [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "item.completed", item: { id: "message-1", type: "agent_message", text: answer } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 7 } }
  ]
  const emit = (events: Array<unknown>) =>
    `process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n") + "\n")});`

  it("declares openai as its OpenTelemetry GenAI provider name", () => {
    expect(fakeModel("process.exit(0)").model.providerName).toBe("openai")
  })

  it("encodes developer instructions with TOML-safe DEL and preserves valid Unicode", () => {
    const text = "say \"hello\"\n\u007f🦄"
    const args = CodexCode.command(
      { model: "gpt-6-sol", executable: "codex", environment: {} },
      request({
        system: [ModelRequest.SystemPart.make({ text })]
      })
    )
    expect(args).toContain("developer_instructions=\"say \\\"hello\\\"\\n\\u007f🦄\"")
  })

  it("loads the Smithers MCP server unless the seat is tool-free", () => {
    const mcp = "mcp_servers.smithers={command=\"smthrs\",args=[\"--mcp\"],required=true}"
    const options = { model: "gpt-6-sol", executable: "codex", environment: {} }
    expect(CodexCode.command(options, request())).toContain(mcp)
    const toolFree = CodexCode.command({ ...options, mcp: false }, request())
    expect(toolFree.some((arg) => arg.startsWith("mcp_servers."))).toBe(false)
    expect(toolFree).toContain("features.shell_tool=false")
    expect(toolFree).toContain("web_search=\"disabled\"")
    expect(toolFree).toContain("--ignore-user-config")
  })

  it.each(["\ud800", "\udfff"])(
    "refuses malformed Unicode %j in system and history before vendor launch",
    async (text) => {
      const fake = fakeModel("require('node:fs').writeFileSync('started', 'yes');")
      for (
        const input of [
          request({ system: [ModelRequest.SystemPart.make({ text })] }),
          request({ messages: [ModelRequest.Message.user(text)] }),
          request({
            messages: [
              ModelRequest.Message.tool(ModelRequest.ToolResultPart.make({ toolCallId: "tool-1", content: text }))
            ]
          })
        ]
      ) {
        const failure = await Effect.runPromise(Effect.flip(Stream.runCollect(fake.model.stream(input))))
        expect(failure).toMatchObject({
          code: "invalid_request",
          message: expect.stringContaining("malformed Unicode")
        })
        const sealed = await Effect.runPromise(Effect.flip(CodexCode.route("gpt-6-sol").prepare(input)))
        expect(sealed).toMatchObject({ code: "invalid_request" })
      }
      expect(() => readFileSync(join(fake.root, "started"))).toThrow()
    }
  )

  it("parses vendor text, usage and session while keeping the prompt off argv", async () => {
    const fake = fakeModel(`const fs = require('node:fs');
fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
let prompt = ''; process.stdin.on('data', x => prompt += x);
process.stdin.on('end', () => { fs.writeFileSync('prompt', prompt); ${emit(success)} });`)
    const events = await collect(fake.model)
    expect(ModelEvent.ModelEvent.settledMessage(events).message.content).toEqual([{ type: "text", text: answer }])
    expect(events.find((event) => event.type === "usage")).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 7
    })
    expect(events.at(-1)).toMatchObject({ type: "settle", sessionId: "thread-1" })
    const args = JSON.parse(readFileSync(join(fake.root, "argv.json"), "utf8")) as Array<string>
    expect(args.slice(0, 2)).toEqual(["exec", "--json"])
    expect(args).toContain("--ignore-user-config")
    expect(args).toContain("--ignore-rules")
    expect(args).toContain("--ephemeral")
    expect(args).toContain("read-only")
    expect(args).toContain("features.shell_tool=false")
    expect(args).not.toContain("--prompt is text")
    expect(readFileSync(join(fake.root, "prompt"), "utf8")).toContain("--prompt is text")
  })

  it("lets the vendor invoke the configured Smithers MCP command and records a real stdio tool receipt", async () => {
    const fake = fakeModel(`const fs = require('node:fs');
const { spawn } = require('node:child_process');
const config = process.argv.slice(2).find(x => x.startsWith('mcp_servers.smithers='));
const command = /command="([^"]+)"/.exec(config)[1];
const args = JSON.parse(/args=(\\[[^\\]]*\\])/.exec(config)[1]);
const mcp = spawn(command, args, { stdio: 'pipe' });
let buffer = ''; let receipt;
const send = (id, method, params) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
mcp.stdout.setEncoding('utf8');
mcp.stdout.on('data', chunk => {
  buffer += chunk; let newline;
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const response = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
    if (response.id === 1) send(2, 'tools/list', {});
    if (response.id === 2) send(3, 'tools/call', { name: response.result.tools[0].name, arguments: { value: 21 } });
    if (response.id === 3) { receipt = response.result; fs.writeFileSync('mcp-receipt.json', JSON.stringify(receipt)); mcp.stdin.end(); }
  }
});
mcp.on('close', code => { if (code !== 0 || !receipt) process.exit(9); ${emit(success)} });
send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-codex', version: '1' } });`)
    writeFileSync(
      join(fake.root, "smthrs"),
      `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync('mcp-argv.json', JSON.stringify(process.argv.slice(2)));
let buffer = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk; let newline;
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const msg = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
    fs.appendFileSync('mcp-requests.jsonl', JSON.stringify(msg) + '\\n');
    const result = msg.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'smithers-test', version: '1' } }
      : msg.method === 'tools/list' ? { tools: [{ name: 'double', inputSchema: { type: 'object', properties: { value: { type: 'number' } } } }] }
      : { content: [{ type: 'text', text: String(msg.params.arguments.value * 2) }], isError: false };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
`,
      { mode: 0o755 }
    )
    const events = await collect(fake.model)
    expect(events.at(-1)).toMatchObject({ type: "settle" })
    expect(JSON.parse(readFileSync(join(fake.root, "mcp-argv.json"), "utf8"))).toEqual(["--mcp"])
    expect(JSON.parse(readFileSync(join(fake.root, "mcp-receipt.json"), "utf8"))).toEqual({
      content: [{ type: "text", text: "42" }],
      isError: false
    })
    const requests = readFileSync(join(fake.root, "mcp-requests.jsonl"), "utf8").trim().split("\n").map((line) =>
      JSON.parse(line)
    )
    expect(requests.map((entry) => entry.method)).toEqual(["initialize", "tools/list", "tools/call"])
    expect(requests[2].params).toEqual({ name: "double", arguments: { value: 21 } })
  })

  it.each([
    ["malformed JSON", "process.stdout.write('not-json\\n');", "invalid_provider_output"],
    ["failed turn", emit([{ type: "turn.failed", error: { message: "vendor rejected turn" } }]), "provider_internal"],
    ["nonzero exit", "process.stderr.write('vendor failed'); process.exit(7);", "transport"],
    ["signalled exit", "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000);", "transport"],
    ["missing completion", emit([{ type: "thread.started", thread_id: "thread-1" }]), "invalid_provider_output"]
  ])("returns a typed model failure for %s", async (_name, script, code) => {
    const fake = fakeModel(script)
    const failure = await Effect.runPromise(Effect.flip(Stream.runCollect(fake.model.stream(request()))))
    expect(failure).toMatchObject({ code })
  })

  it("bounds a vendor that never completes", async () => {
    const fake = fakeModel("setInterval(() => {}, 1000);", { timeoutMs: 100 })
    const failure = await Effect.runPromise(Effect.flip(Stream.runCollect(fake.model.stream(request()))))
    expect(failure).toMatchObject({ code: "call_timeout" })
  })

  it("bounds vendor output before accepting an oversized reply", async () => {
    const fake = fakeModel(
      emit([
        { type: "item.completed", item: { id: "large", type: "agent_message", text: "x".repeat(4096) } },
        { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 4096 } }
      ]),
      { maxBytes: 128 }
    )
    const failure = await Effect.runPromise(Effect.flip(Stream.runCollect(fake.model.stream(request()))))
    expect(failure).toMatchObject({ code: "invalid_provider_output" })
  })

  it("preserves UTF-8 text split across vendor writes", async () => {
    const data = Buffer.from(
      [
        success[0],
        { type: "item.completed", item: { type: "agent_message", text: "雪☃️" } },
        success[2]
      ].map((event) => JSON.stringify(event)).join("\n") + "\n"
    )
    const index = data.indexOf(Buffer.from("雪")) + 1
    const fake = fakeModel(`process.stdout.write(Buffer.from(${JSON.stringify([...data.subarray(0, index)])}));
setTimeout(() => process.stdout.write(Buffer.from(${JSON.stringify([...data.subarray(index)])})), 20);`)
    expect(ModelEvent.ModelEvent.settledMessage(await collect(fake.model)).message.content).toEqual([
      { type: "text", text: "雪☃️" }
    ])
  })

  it("kills subprocesses holding stdout open after the vendor exits", async () => {
    const fake = fakeModel(`const { spawn } = require('node:child_process');
const fs = require('node:fs');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
fs.writeFileSync('descendant-pid', String(descendant.pid));
${emit(success)} process.exit(0);`)
    const events = await collect(fake.model)
    expect(events.at(-1)).toMatchObject({ type: "settle" })
    const pid = Number(readFileSync(join(fake.root, "descendant-pid"), "utf8"))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it("turns invalid executable arguments into a typed transport failure", async () => {
    const fake = fakeModel(emit(success))
    const model = CodexCode.make({ executable: "\0", model: "gpt-6-sol", environment: {}, cwd: fake.root })
    const failure = await Effect.runPromise(Effect.flip(Stream.runCollect(model.stream(request()))))
    expect(failure).toMatchObject({ code: "transport" })
  })

  it("reports an executable disappearing after discovery as a transport failure", async () => {
    const fake = fakeModel(emit(success))
    rmSync(join(fake.root, "codex"))
    const failure = await Effect.runPromise(Effect.flip(Stream.runCollect(fake.model.stream(request()))))
    expect(failure).toMatchObject({ code: "transport" })
  })

  it("keeps a vendor failure typed when it closes stdin before a large prompt is written", async () => {
    const fake = fakeModel("require('node:fs').closeSync(0); setTimeout(() => process.exit(7), 20);")
    const failure = await Effect.runPromise(Effect.flip(Stream.runCollect(fake.model.stream(request({
      messages: [ModelRequest.Message.user("x".repeat(1024 * 1024))]
    })))))
    expect(failure).toMatchObject({ code: "transport" })
  })

  it("refuses malformed requests both before a vendor launch and before sealing a route", async () => {
    const fake = fakeModel("require('node:fs').writeFileSync('started', 'yes');")
    const invalid = { ...request(), messages: "invalid" } as unknown as ModelRequest.ModelRequest
    const failure = await Effect.runPromise(Effect.flip(Stream.runCollect(fake.model.stream(invalid))))
    expect(failure).toMatchObject({ code: "invalid_request" })
    const sealed = await Effect.runPromise(Effect.flip(CodexCode.route("gpt-6-sol").prepare(invalid)))
    expect(sealed).toMatchObject({ code: "invalid_request" })
    expect(() => readFileSync(join(fake.root, "started"))).toThrow()
  })

  it("flattens tool receipts and omits private thinking from vendor prompt text", async () => {
    const fake = fakeModel(`const fs = require('node:fs'); let prompt = '';
process.stdin.on('data', x => prompt += x); process.stdin.on('end', () => { fs.writeFileSync('prompt', prompt); ${
      emit(success)
    } });`)
    await collect(
      fake.model,
      request({
        cacheKey: undefined,
        params: ModelRequest.GenerationParams.make(),
        messages: [
          ModelRequest.Message.tool(ModelRequest.ToolResultPart.make({ toolCallId: "call-1", content: "tool result" })),
          ModelRequest.Message.assistant(ModelRequest.ThinkingPart.make({ text: "private thinking" }))
        ]
      })
    )
    const prompt = readFileSync(join(fake.root, "prompt"), "utf8")
    expect(prompt).toContain("<tool>\ntool result\n</tool>")
    expect(prompt).not.toContain("private thinking")
  })

  it.each([
    ["maximum context length exceeded", "context_overflow"],
    ["quota exceeded", "quota_exceeded"],
    ["not logged in", "authentication"],
    ["internal vendor failure", "provider_internal"]
  ])("classifies vendor failure %s as %s", (message, code) => {
    try {
      CodexCode.parse(JSON.stringify({ type: "turn.failed", error: { message } }))
      throw new Error("Expected failure")
    } catch (error) {
      expect(error).toMatchObject({ code })
    }
  })

  it.each([
    ["non-object event", null],
    ["missing event type", {}],
    ["null item", { type: "item.completed", item: null }],
    ["array item", { type: "item.completed", item: [] }],
    ["missing item type", { type: "item.completed", item: {} }],
    ["non-text answer", { type: "item.completed", item: { type: "agent_message", text: 3 } }],
    ["invalid session", { type: "thread.started", thread_id: "" }],
    ["invalid usage", { type: "turn.completed", usage: [] }],
    ["negative token count", { type: "turn.completed", usage: { input_tokens: -1 } }],
    ["fractional token count", { type: "turn.completed", usage: { output_tokens: 1.2 } }],
    ["cached count exceeds input", { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 2 } }],
    ["overflowing total", {
      type: "turn.completed",
      usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }
    }]
  ])("refuses %s receipts", (_name, bad) => {
    expect(() => CodexCode.parse([success[0], success[1], bad].map((event) => JSON.stringify(event)).join("\n")))
      .toThrow(expect.objectContaining({ code: "invalid_provider_output" }))
  })

  it.each(["null", "[]", "42"])("refuses a JSONL line that is %s rather than an event object", (line) => {
    expect(() => CodexCode.parse(line)).toThrow(
      expect.objectContaining({ code: "invalid_provider_output", message: "Codex returned invalid JSONL" })
    )
  })

  it("refuses duplicate session announcements and events after the completed turn", () => {
    for (const events of [[success[0], ...success], [...success, { type: "turn.started" }]]) {
      expect(() => CodexCode.parse(events.map((event) => JSON.stringify(event)).join("\n")))
        .toThrow(expect.objectContaining({ code: "invalid_provider_output" }))
    }
  })

  it("accepts empty answers, omitted token counts and vendor metadata without an item id", () => {
    const events = CodexCode.parse(
      [
        { type: "thread.started", thread_id: "empty" },
        { type: "turn.started" },
        { type: "item.completed", item: { type: "mcp_tool_call", status: "completed" } },
        { type: "item.completed", item: { type: "agent_message", text: "" } },
        { type: "turn.completed", usage: {} }
      ].map((event) => JSON.stringify(event)).join("\n")
    )
    expect(events.at(-1)).toEqual({ type: "settle", stopReason: "stop", sessionId: "empty" })
    expect(events.find((event) => event.type === "usage")).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    })
  })

  it("reads top-level vendor errors and falls back to a typed generic failure", () => {
    for (const event of [{ type: "error", message: "not logged in" }, { type: "error" }]) {
      try {
        CodexCode.parse(JSON.stringify(event))
        throw new Error("Expected failure")
      } catch (error) {
        expect(error).toMatchObject({ code: "message" in event ? "authentication" : "provider_internal" })
      }
    }
  })

  it("replays an identical request locally and flattens history for the next vendor invocation", async () => {
    const fake = fakeModel(`const fs = require('node:fs');
fs.appendFileSync('launches', 'launch\\n');
let prompt = ''; process.stdin.on('data', x => prompt += x);
process.stdin.on('end', () => { fs.appendFileSync('prompts', JSON.stringify(prompt) + '\\n'); ${emit(success)} });`)
    const first = request()
    const once = await collect(fake.model, first)
    expect(await collect(fake.model, first)).toEqual(once)
    expect(readFileSync(join(fake.root, "launches"), "utf8")).toBe("launch\n")
    await collect(
      fake.model,
      request({
        messages: [
          ...first.messages,
          ModelEvent.ModelEvent.settledMessage(once).message,
          ModelRequest.Message.user("The cell returned 2")
        ]
      })
    )
    expect(readFileSync(join(fake.root, "launches"), "utf8")).toBe("launch\nlaunch\n")
    const prompts = readFileSync(join(fake.root, "prompts"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(prompts[1]).toContain("--prompt is text")
    expect(prompts[1]).toContain(answer)
    expect(prompts[1]).toContain("The cell returned 2")
  })

  it("bounds cached conversations and re-executes a request after its entry is evicted", async () => {
    const fake = fakeModel(`require('node:fs').appendFileSync('launches', 'launch\\n'); ${emit(success)}`)
    for (let key = 0; key < 65; key++) await collect(fake.model, request({ cacheKey: `run-${key}` }))
    await collect(fake.model, request({ cacheKey: "run-64" }))
    expect(readFileSync(join(fake.root, "launches"), "utf8").trim().split("\n")).toHaveLength(65)
    await collect(fake.model, request({ cacheKey: "run-0" }))
    expect(readFileSync(join(fake.root, "launches"), "utf8").trim().split("\n")).toHaveLength(66)
  })

  it("runs identical requests without a conversation key independently", async () => {
    const fake = fakeModel(`require('node:fs').appendFileSync('launches', 'launch\\n'); ${emit(success)}`)
    const input = request({ cacheKey: undefined })
    expect(input.cacheKey).toBeUndefined()
    await collect(fake.model, input)
    await collect(fake.model, input)
    expect(readFileSync(join(fake.root, "launches"), "utf8")).toBe("launch\nlaunch\n")
  })

  it.each([
    ["declared tools", {
      tools: [ModelRequest.ToolDefinition.make({ name: "t", description: "d", parameters: { type: "object" } })]
    }],
    ["provider tools", { serverTools: [{ type: "web_search" as const }] }]
  ])("refuses %s before invoking the vendor", async (_name, overrides) => {
    const fake = fakeModel("require('node:fs').writeFileSync('started', 'yes');")
    const failure = await Effect.runPromise(Effect.flip(Stream.runCollect(fake.model.stream(request(overrides)))))
    expect(failure).toMatchObject({ code: "invalid_request" })
    expect(() => readFileSync(join(fake.root, "started"))).toThrow()
  })

  it("fails a call whose supervisor is lost mid-call as a transport failure", async () => {
    const fake = fakeModel(`require('node:fs').writeFileSync('supervisor', String(process.ppid));
setInterval(() => {}, 1000);`)
    const failure = await Effect.runPromise(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.flip(Stream.runCollect(fake.model.stream(request()))))
      yield* Effect.promise(async () => {
        let supervisor = 0
        for (let attempt = 0; attempt < 1000 && supervisor === 0; attempt++) {
          try {
            supervisor = Number(readFileSync(join(fake.root, "supervisor"), "utf8"))
          } catch {}
          if (supervisor === 0) await new Promise((resolve) => setTimeout(resolve, 10))
        }
        process.kill(supervisor, "SIGKILL")
      })
      return yield* Fiber.join(fiber)
    }))
    expect(failure).toMatchObject({ code: "transport" })
  })

  it("launches the vendor under the contained spawner's supervisor and kills its whole tree on cancel", async () => {
    const fake = fakeModel(`const fs = require('node:fs');
const { spawn } = require('node:child_process');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync('tree', JSON.stringify({ vendor: process.pid, parent: process.ppid, descendant: descendant.pid }));
setInterval(() => {}, 1000);`)
    let tree: { vendor: number; parent: number; descendant: number } | undefined
    await Effect.runPromise(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Stream.runCollect(fake.model.stream(request())))
      yield* Effect.promise(async () => {
        for (let attempt = 0; attempt < 1000 && tree === undefined; attempt++) {
          try {
            tree = JSON.parse(readFileSync(join(fake.root, "tree"), "utf8"))
          } catch {}
          if (tree === undefined) await new Promise((resolve) => setTimeout(resolve, 10))
        }
      })
      yield* Fiber.interrupt(fiber)
    }))
    // A supervisor, not this process, is the vendor's parent (#3128).
    expect(tree?.parent).not.toBe(process.pid)
    for (const pid of [tree!.vendor, tree!.descendant]) {
      let alive = true
      for (let attempt = 0; attempt < 500 && alive; attempt++) {
        try {
          process.kill(pid, 0)
          await new Promise((resolve) => setTimeout(resolve, 10))
        } catch {
          alive = false
        }
      }
      expect(alive, `process ${pid} outlived the cancelled run`).toBe(false)
    }
  })

  it("terminates a running vendor when the model stream is cancelled", async () => {
    const fake = fakeModel(`const fs = require('node:fs');
fs.writeFileSync('pid', String(process.pid));
setInterval(() => {}, 1000);`)
    let pid = 0
    await Effect.runPromise(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Stream.runCollect(fake.model.stream(request())))
      yield* Effect.promise(async () => {
        // The file exists before its content: wait for a whole pid.
        for (let attempt = 0; attempt < 1000 && pid === 0; attempt++) {
          try {
            pid = Number(readFileSync(join(fake.root, "pid"), "utf8"))
          } catch {}
          if (pid === 0) await new Promise((resolve) => setTimeout(resolve, 10))
        }
      })
      yield* Fiber.interrupt(fiber)
    }))
    expect(pid).toBeGreaterThan(0)
    for (let attempt = 0; attempt < 500; attempt++) {
      try {
        process.kill(pid, 0)
      } catch {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`Cancelled Codex process ${pid} still runs`)
  })
})
const executor = RequestExecutor.RequestExecutor.of({
  execute: () => Effect.die(new Error("Codex seats must never use Smithers' HTTP transport"))
})
const vendor = (status: string, exit = 0) => {
  const root = mkdtempSync(join(tmpdir(), "smithers-codex-seat-"))
  roots.push(root)
  writeFileSync(
    join(root, "codex"),
    `#!/bin/sh
printf '%s\\n' "$@" >> "\${0%/*}/argv"
printf '%s\\n' '${status}' >&2
exit ${exit}
`,
    { mode: 0o755 }
  )
  // No auth.json exists: only the vendor is allowed to decide login status.
  return { root, environment: { PATH: root, HOME: root, CODEX_HOME: root } }
}
const resolve = (environment: Record<string, string | undefined>, seat = "codex:sol") =>
  Effect.scoped(NodeControl.seatResolver(environment, executor).resolve(seat))

describe("Codex vendor login probe caching", () => {
  const probeVendor = (status: string, exit = 0) => {
    const codex = vendor(status, exit)
    writeFileSync(join(codex.root, "status"), status)
    writeFileSync(join(codex.root, "exit"), String(exit))
    writeFileSync(
      join(codex.root, "codex"),
      `#!/bin/sh
printf '%s|%s\\n' "$HOME" "$CODEX_HOME" >> "\${0%/*}/probes"
/bin/sleep 0.05
/bin/cat "\${0%/*}/status" >&2
exit "$(/bin/cat "\${0%/*}/exit")"
`,
      { mode: 0o755 }
    )
    return codex
  }
  const probes = (root: string) => readFileSync(join(root, "probes"), "utf8").trim().split("\n")

  it("shares one in-flight vendor probe across concurrent seat resolves and fresh environment records", async () => {
    const codex = probeVendor("Logged in using ChatGPT")
    const first = Providers.codexLogin(codex.environment)
    expect(Providers.codexLogin({ ...codex.environment })).toBe(first)
    const seats = await Promise.all(
      ["codex:sol", "codex:luna"].map((seat) => Effect.runPromise(resolve({ ...codex.environment }, seat)))
    )
    expect(seats.map((seat) => seat.id)).toEqual(["codex:sol", "codex:luna"])
    expect(await first).toMatchObject({ loggedIn: true })
    expect(probes(codex.root)).toHaveLength(1)
  })

  it("isolates both vendor home variables, including empty and unset values", async () => {
    const codex = probeVendor("Logged in using ChatGPT")
    const environments = [
      codex.environment,
      { ...codex.environment, HOME: `${codex.root}/other` },
      { ...codex.environment, CODEX_HOME: `${codex.root}/other` },
      { ...codex.environment, HOME: "" },
      { ...codex.environment, HOME: undefined },
      { ...codex.environment, CODEX_HOME: "" },
      { ...codex.environment, CODEX_HOME: undefined }
    ]
    for (const environment of environments) {
      expect(await Providers.codexLogin(environment)).toMatchObject({ loggedIn: true })
    }
    expect(probes(codex.root)).toHaveLength(environments.length)
    await Providers.codexLogin({ ...codex.environment })
    expect(probes(codex.root)).toHaveLength(environments.length)
  })

  it("does not share a login receipt between installed vendor executables", async () => {
    const signedIn = probeVendor("Logged in using ChatGPT")
    const signedOut = probeVendor("Not logged in", 1)
    expect(await Providers.codexLogin(signedIn.environment)).toMatchObject({ loggedIn: true })
    expect(await Providers.codexLogin({ ...signedIn.environment, PATH: signedOut.root })).toMatchObject({
      loggedIn: false
    })
    expect(probes(signedIn.root)).toHaveLength(1)
    expect(probes(signedOut.root)).toHaveLength(1)
  })

  it.each([
    ["signed out", "Not logged in", 1, "Logged in using ChatGPT", 0],
    ["vendor error", "vendor login failed", 7, "Logged in using ChatGPT", 0],
    ["signed in", "Logged in using ChatGPT", 0, "Not logged in", 1]
  ])("re-probes %s status at the 30-second expiry boundary", async (_state, before, beforeExit, after, afterExit) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000)
    const codex = probeVendor(before, beforeExit)
    const first = await Providers.codexLogin(codex.environment)
    expect(first?.loggedIn).toBe(beforeExit === 0)
    writeFileSync(join(codex.root, "status"), after)
    writeFileSync(join(codex.root, "exit"), String(afterExit))
    now.mockReturnValue(1_029_999)
    expect(await Providers.codexLogin({ ...codex.environment })).toBe(first)
    expect(probes(codex.root)).toHaveLength(1)
    now.mockReturnValue(1_030_000)
    const retried = await Providers.codexLogin({ ...codex.environment })
    expect(retried?.loggedIn).toBe(afterExit === 0)
    expect(probes(codex.root)).toHaveLength(2)
  })

  it("does not value-read credential variables when keying or launching a probe", async () => {
    const codex = probeVendor("Logged in using ChatGPT")
    const environment: Record<string, string | undefined> = { ...codex.environment }
    const denied = [
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "CODEX_ACCESS_TOKEN",
      "CODEX_AUTH_TOKEN",
      "OPENAI_IDENTITY_TOKEN_FILE",
      "OPENAI_IDENTITY_TOKEN",
      "AI_GATEWAY_API_KEY",
      "NODE_OPTIONS",
      "NODE_PATH",
      "OpenAi_Api_Key",
      "CoDeX_Auth_Token",
      "OpenAi_Identity_Token_File",
      "openai_identity_token",
      "node_options"
    ]
    for (const name of denied) {
      Object.defineProperty(environment, name, {
        enumerable: true,
        get: () => {
          throw new Error(`Credential value was read: ${name}`)
        }
      })
    }
    expect(CodexCode.environment).toBe(Agents.codexEnvironment)
    expect(Agents.codexEnvironment(environment)).toEqual(codex.environment)
    expect(await Providers.codexLogin(environment)).toMatchObject({ loggedIn: true })
    expect(probes(codex.root)).toHaveLength(1)
  })
})

describe("Codex vendor seat resolution", () => {
  const templateEnvironment = (root: string, path = root) => {
    vi.stubEnv("PATH", path)
    vi.stubEnv("HOME", root)
    vi.stubEnv("CODEX_HOME", root)
    vi.stubEnv("OPENAI_API_KEY", undefined)
    vi.stubEnv("SMITHERS_OPENAI_AUTH", undefined)
    return vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Template Codex seats must never call HTTP")
    })
  }

  it.each(["signed out", "missing binary"])(
    "maps template recording %s refusal to a typed model authentication error",
    async (state) => {
      const codex = vendor("Not logged in", 1)
      const fetch = templateEnvironment(
        codex.root,
        state === "missing binary" ? join(codex.root, "absent") : codex.root
      )
      const failure = await Effect.runPromise(Effect.flip(Stream.runCollect(liveModel("codex:sol").stream(request()))))
      expect(failure).toMatchObject({ code: "authentication", message: expect.stringContaining("codex") })
      expect(failure).not.toBeInstanceOf(Seat.SeatUnresolved)
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it("records a successful template Codex turn through the vendor CLI without HTTP", async () => {
    const codex = vendor("Logged in using ChatGPT")
    writeFileSync(
      join(codex.root, "codex"),
      `#!${process.execPath}
if (process.argv[2] === 'login') { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }
process.stdin.resume(); process.stdin.on('end', () => {
  for (const event of [
    { type: 'thread.started', thread_id: 'template-session' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'template reply' } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }
  ]) process.stdout.write(JSON.stringify(event) + '\\n');
});
`,
      { mode: 0o755 }
    )
    const fetch = templateEnvironment(codex.root)
    const events = await collect(liveModel("codex:sol"))
    expect(ModelEvent.ModelEvent.settledMessage(events).message.content).toEqual([{
      type: "text",
      text: "template reply"
    }])
    expect(events.at(-1)).toMatchObject({ type: "settle", sessionId: "template-session" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("persists the Codex seat identity through the real native host journal", async () => {
    const codex = vendor("Logged in using ChatGPT")
    writeFileSync(
      join(codex.root, "codex"),
      `#!${process.execPath}
if (process.argv[2] === 'login') { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }
const events = [
 { type: 'thread.started', thread_id: 'journal-thread' },
 { type: 'item.completed', item: { id: 'journal-answer', type: 'agent_message', text: '\`\`\`cell\\nctx.done("journal-ok")\\n\`\`\`' } },
 { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 7 } }
];
process.stdin.resume(); process.stdin.on('end', () => { for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n'); });
`,
      { mode: 0o755 }
    )
    mkdirSync(join(codex.root, "flows", "proof"), { recursive: true })
    writeFileSync(
      join(codex.root, "flows", "proof", "flow.mdx"),
      "---\ndescription: Codex journal proof.\nmodel: codex:sol\n---\nReply journal-ok.\n"
    )
    const registry = NodeControl.layerRegistry(codex.root)
    const engine = NodeControl.engineDurable(codex.root, registry)
    const runs = NodeControl.layerExecutor(registry, engine, codex.root, {
      environment: { ...codex.environment, PATH: `${codex.root}:/usr/bin:/bin` },
      evaluator: ScriptedJudge.layerAll,
      grants: GrantStore.layerNoop,
      requestExecutor: Layer.succeed(RequestExecutor.RequestExecutor)(executor)
    })
    const layer = Application.layer({ root: codex.root }, registry, engine, runs) as Layer.Layer<Control.Control>
    const events = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const plan = yield* control.plan({ flowId: "proof", input: {} })
        yield* control.approve(plan.approval)
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: plan.planId,
          digest: plan.digest,
          envelope: plan.envelope,
          idempotencyKey: "codex-journal"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("Run was not accepted")
        return yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
          Stream.takeUntil((event) =>
            ["control.run.completed", "control.run.failed", "control.run.cancelled"].includes(event.kind)
          ),
          Stream.runCollect,
          Effect.map((events) => Array.from(events))
        )
      }).pipe(Effect.provide(layer), Effect.scoped)
    )
    expect(events.at(-1)?.kind).toBe("control.run.completed")
    const requested = events.filter((event) => event.kind === "control.agent.model-requested")
    expect(requested.length).toBeGreaterThan(0)
    expect(requested[0]?.payload).toMatchObject({ seat: "codex:sol" })
  })

  it("keeps codex:sol as its journal identity and prepares a credential-free vendor route", async () => {
    const codex = vendor("Logged in using ChatGPT")
    const seat = await Effect.runPromise(resolve(codex.environment))
    expect(seat.id).toBe("codex:sol")
    expect(seat.modelId).toBe("gpt-6.1-sol")
    const prepared = await Effect.runPromise(seat.route.prepare({
      modelId: seat.modelId,
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      params: {}
    } as never))
    expect(prepared.routeId).toBe("codex")
    expect(prepared.url).toBe(`codex:${seat.modelId}`)
    expect(prepared.publicHeaders).toEqual({})
    expect(readFileSync(join(codex.root, "argv"), "utf8")).toBe("login\nstatus\n")
  })

  it("refuses a signed-out vendor with a typed, actionable device-login instruction", async () => {
    const codex = vendor("Not logged in", 1)
    const failure = await Effect.runPromise(Effect.flip(resolve(codex.environment)))
    expect(failure).toBeInstanceOf(Seat.SeatUnresolved)
    expect(failure.seat).toBe("codex:sol")
    expect(failure.message).toContain("codex login --device-auth")
    expect(readFileSync(join(codex.root, "argv"), "utf8")).toBe("login\nstatus\n")
  })

  it("refuses a missing vendor without consulting a home credential file", async () => {
    const codex = vendor("unused")
    const failure = await Effect.runPromise(Effect.flip(resolve({
      ...codex.environment,
      PATH: join(codex.root, "absent")
    })))
    expect(failure).toBeInstanceOf(Seat.SeatUnresolved)
    expect(failure.message).toContain("codex")
    expect(failure.message).toContain("install")
  })

  it("refuses the vendor's API-key login as a subscription seat", async () => {
    const codex = vendor("Logged in using an API key")
    const failure = await Effect.runPromise(Effect.flip(resolve(codex.environment)))
    expect(failure).toBeInstanceOf(Seat.SeatUnresolved)
    expect(failure.message).toContain("codex login --device-auth")
  })
})
