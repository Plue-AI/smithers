/**
 * The MCP server every subprocess suite spawns.
 *
 * One `node -e` source, switched by `process.argv[1]`: it keeps the OS process
 * boundary and real stdio timing while remaining deterministic and offline, and
 * its modes reproduce the protocol and lifecycle failures an in-memory process
 * handle cannot. Every suite spawns this one source, so a fix to the shared
 * shapes (the initialize reply, the tool catalog) is made once.
 *
 * `process.argv[2]` is an optional path for lifecycle or cancellation receipts,
 * `process.argv[3]` the container depth the JSON
 * limit modes nest to, and `MCP_DIAGNOSTIC_TEST_SECRET` the private value the
 * privacy modes plant in the protocol positions an error may leak from.
 *
 * @since 0.1.0
 */
export const source = String.raw`
const fs = require("node:fs")
const readline = require("node:readline")
const mode = process.argv[1] || "normal"
const closeMarker = process.argv[2]
const depth = Number(process.argv[3] || 0)
const secret = process.env.MCP_DIAGNOSTIC_TEST_SECRET

if (closeMarker && mode === "normal") fs.writeFileSync(closeMarker, String(process.pid))

const startupDiagnostic = mode === "stderr-exit"
  ? { text: "distinctive startup diagnostic\ntoken=sk-ant-test-0123456789abcdef\n", code: 17 }
  : mode === "stderr-short-exit"
  ? { text: "token=x", code: 19 }
  : mode === "stderr-tail-exit"
  ? { text: "DROP-".repeat(400) + "KEEP-THIS-TAIL-1234567890\n", code: 18 }
  : mode === "private-stderr"
  ? { text: "API_TOKEN=" + secret + "\n", code: 1 }
  : undefined
if (startupDiagnostic) {
  process.stderr.write(startupDiagnostic.text, () => process.exit(startupDiagnostic.code))
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n")
const sendRaw = (request, result) => process.stdout.write('{"jsonrpc":"2.0","id":' + request.id + ',"result":' + result + '}\n')
const nested = () => '{"value":'.repeat(depth) + '{}' + '}'.repeat(depth)
const nestedSchema = () => '{"type":"object","properties":{"value":'.repeat(depth) + '{}' + '}}'.repeat(depth)
const replyId = (request) => mode === "string-reply-id" ? String(request.id) : request.id
const succeed = (request, result) => send({ jsonrpc: "2.0", id: replyId(request), result })
const fail = (request, code, message, data) => {
  const error = { code, message }
  if (data !== undefined) error.data = data
  send({ jsonrpc: "2.0", id: replyId(request), error })
}

const addTool = {
  name: "add",
  description: "Adds two numbers",
  inputSchema: { type: "object", properties: { a: {}, b: {} } }
}
if (["structured-valid", "structured-invalid-type", "structured-missing-required", "structured-only"].includes(mode)) {
  addTool.outputSchema = {
    type: "object",
    properties: { answer: { type: "number" } },
    required: ["answer"]
  }
}
if (mode === "structured-enum-invalid") {
  addTool.outputSchema = {
    type: "object",
    properties: { answer: { enum: [5, 6] } },
    required: ["answer"]
  }
}
if (mode === "structured-array-invalid") {
  addTool.outputSchema = {
    type: "object",
    properties: { values: { type: "array", items: { type: "number" } } },
    required: ["values"]
  }
}
if (mode === "structured-unsupported-keyword") {
  addTool.outputSchema = {
    type: "object",
    properties: { answer: { type: "string", minLength: 10 } },
    required: ["answer"]
  }
}
const errorTool = {
  name: "error",
  description: 42,
  inputSchema: { type: "object" }
}
const namedTool = (name) => ({ name, inputSchema: { type: "object" } })

const reader = startupDiagnostic === undefined ? readline.createInterface({ input: process.stdin }) : undefined
let serverExchange
reader?.on("line", (line) => {
  const request = JSON.parse(line)
  if (serverExchange && !Object.hasOwn(request, "method")) {
    const expected = serverExchange.pending.get(request.id)
    if (expected === undefined || JSON.stringify(request) !== JSON.stringify(expected)) {
      fail(serverExchange.request, -32000, "incorrect server-request response")
      return
    }
    serverExchange.pending.delete(request.id)
    serverExchange.replies.push(request)
    if (serverExchange.pending.size === 0) {
      succeed(serverExchange.request, { content: [], structuredContent: { replies: serverExchange.replies } })
      serverExchange = undefined
    }
    return
  }
  if (request.method === "notifications/cancelled") {
    if (mode === "capture-cancellation" && closeMarker) {
      fs.appendFileSync(closeMarker, JSON.stringify(request) + "\n")
    }
    return
  }
  if (request.method === "initialize") {
    if (mode === "hang-handshake") return
    if (mode === "stderr-timeout") {
      process.stderr.write("ordinary timeout diagnostic\ntoken=sk-ant-")
      setImmediate(() => process.stderr.write("test-0123456789abcdef\n"))
      return
    }
    if (mode === "oversized-frame") {
      process.stdout.write("x".repeat(1024) + "\n")
      return
    }
    if (mode === "malformed-frames") {
      process.stdout.write("\nnot json\n42\n")
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
      send({ jsonrpc: "2.0", id: 999, result: {} })
    }
    if (mode === "wrong-jsonrpc-version") {
      send({ jsonrpc: "1.0", id: request.id, result: {} })
      return
    }
    if (mode === "reply-without-id") {
      send({ jsonrpc: "2.0", result: {} })
      return
    }
    if (mode === "malformed-initialize-result") {
      succeed(request, null)
      return
    }
    const protocolVersion = mode === "wrong-protocol-version"
      ? "1999-01-01"
      : mode === "older-protocol-version"
      ? "2024-11-05"
      : mode === "malformed-protocol-version"
      ? 42
      : mode === "private-version"
      ? secret
      : "2025-06-18"
    const capabilities = mode === "no-tools-capability"
      ? {}
      : mode === "malformed-capabilities"
      ? null
      : { tools: {} }
    succeed(request, { protocolVersion, capabilities, serverInfo: { name: "fixture" } })
    if (mode === "stop-reading-after-initialize") {
      reader.pause()
      process.stdin.pause()
      setInterval(() => {}, 1000)
      setTimeout(() => {
        reader.resume()
        process.stdin.resume()
      }, 250)
    }
    return
  }

  if (request.method === "tools/list") {
    if (mode.startsWith("private-")) {
      const probe = { name: "probe", inputSchema: { type: "object" }, outputSchema: { type: "object", required: [secret] } }
      succeed(request, mode === "private-duplicate"
        ? { tools: [{ ...probe, name: secret }, { ...probe, name: secret }] }
        : mode === "private-cursor"
        ? { tools: [], nextCursor: secret }
        : { tools: [probe] })
      return
    }
    if (mode.startsWith("nested-")) {
      sendRaw(request, '{"tools":[{"name":"probe","inputSchema":{"type":"object"},"outputSchema":' +
        (mode === "nested-schema" ? nestedSchema() : mode === "nested-enum" ? '{"enum":[' + nested() + ']}' : '{}') + '}]}')
      return
    }
    if (mode === "list-rpc-error") {
      fail(request, -32_601, "catalog unavailable")
      return
    }
    if (mode === "malformed-reply") {
      send({ jsonrpc: "2.0", id: request.id, error: null })
      return
    }
    if (mode === "list-not-array") {
      succeed(request, { notTools: [] })
      return
    }
    if (mode === "list-result-not-object") {
      succeed(request, null)
      return
    }
    if (mode === "list-no-name") {
      succeed(request, { tools: [{}] })
      return
    }
    if (mode === "list-empty-name") {
      succeed(request, { tools: [{ name: "", inputSchema: { type: "object" } }] })
      return
    }
    if (mode === "list-null-entry") {
      succeed(request, { tools: [addTool, null] })
      return
    }
    if (mode === "list-number-entry") {
      succeed(request, { tools: [addTool, 42] })
      return
    }
    if (mode === "list-array-entry") {
      succeed(request, { tools: [addTool, []] })
      return
    }
    if (mode === "list-duplicate-names") {
      succeed(request, { tools: [addTool, namedTool("add")] })
      return
    }
    if (mode === "list-two-pages") {
      succeed(request, request.params && request.params.cursor === "page-2"
        ? { tools: [errorTool] }
        : { tools: [addTool], nextCursor: "page-2" })
      return
    }
    if (mode === "list-three-pages") {
      const cursor = request.params && request.params.cursor
      succeed(request, cursor === "page-3"
        ? { tools: [namedTool("third")] }
        : cursor === "page-2"
        ? { tools: [errorTool], nextCursor: "page-3" }
        : { tools: [addTool], nextCursor: "page-2" })
      return
    }
    if (mode === "list-empty-middle-page") {
      const cursor = request.params && request.params.cursor
      succeed(request, cursor === "page-3"
        ? { tools: [errorTool] }
        : cursor === "page-2"
        ? { tools: [], nextCursor: "page-3" }
        : { tools: [addTool], nextCursor: "page-2" })
      return
    }
    if (mode === "list-repeated-cursor") {
      succeed(request, request.params && request.params.cursor === "again"
        ? { tools: [], nextCursor: "again" }
        : { tools: [addTool], nextCursor: "again" })
      return
    }
    if (mode === "list-bad-cursor") {
      succeed(request, { tools: [addTool], nextCursor: 42 })
      return
    }
    if (mode === "list-empty-cursor") {
      succeed(request, { tools: [addTool], nextCursor: "" })
      return
    }
    if (mode === "list-duplicate-across-pages") {
      succeed(request, request.params && request.params.cursor === "page-2"
        ? { tools: [namedTool("add")] }
        : { tools: [addTool], nextCursor: "page-2" })
      return
    }
    if (mode === "single-tool") {
      succeed(request, { tools: [addTool] })
      return
    }
    if (mode === "list-unbounded-pages") {
      const cursor = request.params && request.params.cursor
      const page = cursor === undefined ? 1 : Number(cursor.slice(5))
      succeed(request, { tools: [], nextCursor: "page-" + (page + 1) })
      return
    }
    succeed(request, {
      tools: [addTool, errorTool]
    })
    if (mode === "exit-after-list") setImmediate(() => process.exit(0))
    return
  }

  if (request.method === "tools/call") {
    if (mode === "close-stdin") {
      process.stdin.once("close", () => {
        // The stream and fd 0 can own separate handles. Close the original
        // descriptor after the stream releases its handle.
        try { fs.closeSync(0) } catch (error) { if (error.code !== "EBADF") throw error }
        if (closeMarker) fs.writeFileSync(closeMarker, JSON.stringify({
          method: request.method, requestId: request.id, pid: process.pid
        }))
      })
      setImmediate(() => {
        reader.close()
        process.stdin.destroy()
      })
      setInterval(() => {}, 1000)
      return
    }
    if (mode === "private-schema") {
      succeed(request, { content: [], structuredContent: {} })
      return
    }
    if (mode.startsWith("private-")) {
      fail(request, -32000, secret, "short-private-pin")
      return
    }
    if (mode.startsWith("nested-")) {
      sendRaw(request, '{"content":[],"structuredContent":' +
        (mode === "nested-echo" ? '{}' : mode === "nested-infinite" ? '{"value":1e999}' : nested()) + '}')
      return
    }
    if (mode === "server-requests") {
      const probes = [
        { id: request.id, method: "ping" },
        { id: String(request.id), method: "ping" },
        { id: "probe/😀", method: "ping" },
        { id: "", method: "ping" },
        { id: "unsupported", method: "sampling/createMessage" }
      ]
      const pending = new Map(probes.map((probe) => [probe.id, probe.method === "ping"
        ? { jsonrpc: "2.0", id: probe.id, result: {} }
        : { jsonrpc: "2.0", id: probe.id, error: { code: -32601, message: "Method not found" } }]))
      serverExchange = { request, pending, replies: [] }
      send({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })
      send({ jsonrpc: "2.0", method: "ping" })
      for (const probe of probes) send({ jsonrpc: "2.0", ...probe })
      return
    }
    if (mode === "exit-mid-call") process.exit(0)
    if (mode === "hang" || mode === "capture-cancellation") return
    if (mode === "call-rpc-error") {
      fail(request, -32_000, "remote exploded")
      return
    }
    if (mode === "call-invalid-params-unknown-tool") {
      fail(request, -32_602, "Unknown tool: add")
      return
    }
    if (mode === "call-invalid-params") {
      fail(request, -32_602, "Tool arguments are invalid")
      return
    }
    if (mode === "call-method-not-found-unknown-tool") {
      fail(request, -32_601, "Tool not found: add")
      return
    }
    if (mode === "call-rpc-error-string-data") {
      fail(request, -32_000, "remote exploded", "context")
      return
    }
    if (mode === "call-rpc-error-number-data") {
      fail(request, -32_000, "remote exploded", 7)
      return
    }
    if (mode === "call-rpc-error-boolean-data") {
      fail(request, -32_000, "remote exploded", true)
      return
    }
    if (mode === "call-rpc-error-long-data") {
      fail(request, -32_000, "remote exploded", "x".repeat(121))
      return
    }
    if (mode === "call-rpc-error-object-data") {
      fail(request, -32_000, "remote exploded", { secret: "hidden" })
      return
    }
    if (mode === "call-rpc-error-array-data") {
      fail(request, -32_000, "remote exploded", ["hidden"])
      return
    }
    if (mode === "echo-env") {
      succeed(request, {
        content: [{
          type: "environment",
          token: process.env.MCP_FIXTURE_TOKEN,
          hasPath: typeof process.env.PATH === "string" && process.env.PATH.length > 0,
          anthropic: process.env.ANTHROPIC_API_KEY,
          openai: process.env.OPENAI_API_KEY,
          github: process.env.GH_TOKEN,
          cwd: process.cwd()
        }],
        isError: false
      })
      return
    }
    if (mode === "call-result-not-object") {
      succeed(request, null)
      return
    }
    if (mode === "call-content-not-array") {
      succeed(request, { content: "malformed" })
      return
    }
    if (mode === "call-content-bad-entry") {
      succeed(request, { content: [{ type: "text" }, null] })
      return
    }
    if (mode === "call-content-string-entry") {
      succeed(request, { content: ["text"] })
      return
    }
    if (mode === "call-content-number-entry") {
      succeed(request, { content: [42] })
      return
    }
    if (mode === "call-content-array-entry") {
      succeed(request, { content: [[1]] })
      return
    }
    if (mode === "call-is-error-not-boolean") {
      succeed(request, { content: [], isError: "yes" })
      return
    }
    if (mode === "call-structured-content-not-object") {
      succeed(request, { content: [], structuredContent: [] })
      return
    }
    if (mode === "call-structured-content") {
      succeed(request, {
        content: [{ type: "text", text: "5" }],
        structuredContent: { sum: 5 },
        isError: false
      })
      return
    }
    if (mode === "structured-valid") {
      succeed(request, {
        content: [{ type: "text", text: "5" }],
        structuredContent: { answer: 5 },
        isError: false
      })
      return
    }
    if (mode === "structured-invalid-type") {
      succeed(request, { content: [], structuredContent: { answer: "five" }, isError: false })
      return
    }
    if (mode === "structured-missing-required") {
      succeed(request, { content: [], structuredContent: {}, isError: false })
      return
    }
    if (mode === "structured-enum-invalid") {
      succeed(request, { content: [], structuredContent: { answer: 7 }, isError: false })
      return
    }
    if (mode === "structured-array-invalid") {
      succeed(request, { content: [], structuredContent: { values: [1, "two"] }, isError: false })
      return
    }
    if (mode === "structured-unsupported-keyword") {
      succeed(request, { content: [], structuredContent: { answer: "x" }, isError: false })
      return
    }
    if (mode === "structured-no-output-schema") {
      succeed(request, { content: [], structuredContent: { arbitrary: ["accepted"] }, isError: false })
      return
    }
    if (mode === "structured-only") {
      succeed(request, { structuredContent: { answer: 5 }, isError: false })
      return
    }
    if (mode === "structured-neither") {
      succeed(request, { isError: false })
      return
    }
    if (request.params.name === "error") {
      succeed(request, { content: [], isError: true })
      return
    }
    succeed(request, {
      content: [{ type: "text", text: String(request.params.arguments.a + request.params.arguments.b) }],
      isError: false
    })
  }
})
`

/**
 * Windows libuv deliberately leaves descriptors 0–2 open in fs.closeSync.
 * Read and close the real stdin handle without Node's duplicated stdio handle;
 * stdout and the process stay alive so only the client's writer can fail.
 */
export const windowsCloseStdinSource = String.raw`
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$startupMarker = $env:MCP_CLOSE_STDIN_MARKER + '.startup'
function Set-FixtureStartupPhase($phase) {
  try { [System.IO.File]::WriteAllText($startupMarker, $phase) } catch {}
}
Set-FixtureStartupPhase 'compiling'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class McpStdin {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool ReadFile(IntPtr handle, [Out] byte[] data, uint size, out uint read, IntPtr overlapped);
  public static string ReadLine(IntPtr handle) {
    var bytes = new List<byte>();
    var data = new byte[1];
    uint read;
    while (ReadFile(handle, data, 1, out read, IntPtr.Zero) && read != 0) {
      if (data[0] == 10) return Encoding.UTF8.GetString(bytes.ToArray());
      bytes.Add(data[0]);
    }
    return null;
  }
}
'@
$stdinHandle = [McpStdin]::GetStdHandle(-10)
Set-FixtureStartupPhase 'reading'
:requests while ($null -ne ($line = [McpStdin]::ReadLine($stdinHandle))) {
  $request = ConvertFrom-Json -InputObject $line
  switch ($request.method) {
    'initialize' {
      $result = @{
        protocolVersion = '2025-06-18'
        capabilities = @{ tools = @{} }
        serverInfo = @{ name = 'fixture' }
      }
    }
    'tools/list' {
      $result = @{ tools = @(@{ name = 'add'; inputSchema = @{ type = 'object' } }) }
    }
    'tools/call' {
      if (-not [McpStdin]::CloseHandle($stdinHandle)) { throw 'Failed to close stdin' }
      $receipt = @{ method = $request.method; requestId = $request.id; pid = $PID } |
        ConvertTo-Json -Compress
      [System.IO.File]::WriteAllText($env:MCP_CLOSE_STDIN_MARKER, $receipt)
      while ($true) { Start-Sleep -Seconds 1 }
    }
    default { continue requests }
  }
  $response = @{ jsonrpc = '2.0'; id = $request.id; result = $result } |
    ConvertTo-Json -Depth 6 -Compress
  [Console]::WriteLine($response)
  Set-FixtureStartupPhase ('answered ' + $request.method)
}
`
