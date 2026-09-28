import * as NodeServices from "@effect/platform-node/NodeServices"
import { Cause, Effect, Exit } from "effect"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as NodeLanguageServer from "../src/NodeLanguageServer.ts"

/**
 * The language server runs on the host as the host user. These cases plant a
 * program in the workspace that would leave a marker if the host ran it, and
 * spawn through the real Node spawner, so a regression runs the planted file.
 */
let root: string
let workspace: string
let marker: string

beforeEach(() => {
  root = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "smithers-lsp-"))
  workspace = NodePath.join(root, "workspace")
  marker = NodePath.join(root, "ran")
  NodeFs.mkdirSync(NodePath.join(workspace, "node_modules", ".bin"), { recursive: true })
  const script = `#!/bin/sh\ntouch '${marker}'\n`
  NodeFs.writeFileSync(NodePath.join(workspace, "node_modules", ".bin", "planted-server"), script, { mode: 0o755 })
  NodeFs.writeFileSync(
    NodePath.join(workspace, "planted.js"),
    `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`
  )
  NodeFs.mkdirSync(NodePath.join(workspace, "tools", "lsp"), { recursive: true })
  NodeFs.writeFileSync(
    NodePath.join(workspace, "tools", "lsp", "index.js"),
    `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`
  )
  NodeFs.symlinkSync(process.execPath, NodePath.join(workspace, "node"))
})

afterEach(() => {
  NodeFs.rmSync(root, { recursive: true, force: true })
})

const start = (config: NodeLanguageServer.Config) =>
  Effect.runPromise(Effect.exit(Effect.scoped(
    NodeLanguageServer.make({ timeoutMs: 2_000, ...config }).pipe(Effect.provide(NodeServices.layer))
  )))

const failure = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons.find(Cause.isFailReason)
  return (reason?.error as { readonly code?: unknown } | undefined)?.code
}

describe("NodeLanguageServer refuses a program the workspace supplies", () => {
  it.each([
    ["a relative command", () => ({ command: "./node_modules/.bin/planted-server", cwd: workspace })],
    [
      "an absolute command",
      () => ({ command: NodePath.join(workspace, "node_modules/.bin/planted-server"), cwd: workspace })
    ],
    [
      "a bare name found through a workspace PATH entry",
      () => ({ command: "planted-server", cwd: workspace, environment: { PATH: "node_modules/.bin" } })
    ],
    ["a workspace symlink to a host binary", () => ({ command: "./node", args: ["-e", "0"], cwd: workspace })],
    [
      "a host interpreter given a workspace script",
      () => ({ command: process.execPath, args: ["planted.js"], cwd: workspace })
    ],
    [
      "a host interpreter given a workspace directory, whose index.js it runs",
      () => ({ command: process.execPath, args: ["./tools/lsp"], cwd: workspace })
    ],
    [
      "a workspace file passed as an option value",
      () => ({
        command: process.execPath,
        args: [`--require=${NodePath.join(workspace, "planted.js")}`],
        cwd: workspace
      })
    ]
  ])("refuses %s before spawning it", async (_name, config) => {
    const exit = await start(config())
    expect(failure(exit)).toBe("permission_denied")
    expect(NodeFs.existsSync(marker)).toBe(false)
  })

  it.each([
    ["sh -c", () => ({ command: "sh", args: ["-c", "node_modules/.bin/planted-server --stdio"], cwd: workspace })],
    [
      "an absolute shell",
      () => ({ command: "/bin/sh", args: ["-c", "./node_modules/.bin/planted-server"], cwd: workspace })
    ],
    ["bash -lc", () => ({ command: "bash", args: ["-lc", "planted-server"], cwd: workspace })],
    ["env", () => ({ command: "env", args: ["node_modules/.bin/planted-server"], cwd: workspace })],
    ["npx", () => ({ command: "npx", args: ["planted-server", "--stdio"], cwd: workspace })],
    ["pnpm exec", () => ({ command: "pnpm", args: ["exec", "planted-server"], cwd: workspace })],
    ["yarn", () => ({ command: "yarn", args: ["planted-server"], cwd: workspace })],
    ["bunx", () => ({ command: "bunx", args: ["planted-server"], cwd: workspace })],
    ["bun x", () => ({ command: "bun", args: ["x", "planted-server"], cwd: workspace })],
    [
      "node -e requiring a workspace script",
      () => ({ command: process.execPath, args: ["-e", "require('./planted.js')"], cwd: workspace })
    ],
    [
      "node --import of a workspace module",
      () => ({ command: "node", args: ["--import=./planted.js", "/opt/lsp/server.js"], cwd: workspace })
    ]
  ])("refuses the launcher %s, whose arguments choose what runs", async (_name, config) => {
    const exit = await start(config())
    expect(failure(exit)).toBe("permission_denied")
    expect(NodeFs.existsSync(marker)).toBe(false)
  })

  it("starts a host program and forwards initializationOptions", async () => {
    const server = `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const at = buffer.indexOf("\\r\\n\\r\\n");
  if (at < 0) return;
  const length = Number(/Content-Length: (\\d+)/.exec(buffer.slice(0, at))[1]);
  if (buffer.length < at + 4 + length) return;
  const request = JSON.parse(buffer.slice(at + 4, at + 4 + length));
  buffer = buffer.slice(at + 4 + length);
  if (request.method !== "initialize") return;
  if (JSON.stringify(request.params.initializationOptions) !== '{"tsserver":{"path":"/host/tsserver.js"}}') process.exit(3);
  const body = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { capabilities: {} } });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
});`
    const script = NodePath.join(root, "server.js")
    NodeFs.writeFileSync(script, server)
    const exit = await start({
      command: process.execPath,
      args: [script],
      cwd: workspace,
      initializationOptions: { tsserver: { path: "/host/tsserver.js" } }
    })
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
