import { expect, test } from "bun:test"
import { createCloudLspClient } from "./CloudLspClient"
import { createCloudTerminalClient } from "./CloudTerminalClient"

const until = async (ready: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !ready(); attempt += 1) await Bun.sleep(1)
  expect(ready()).toBe(true)
}

class FakeSocket {
  binaryType: BinaryType = "blob"
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(readonly url: string, readonly rpc = false) {
    if (rpc) queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.({} as Event)
    })
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (!this.rpc || typeof data !== "string") return
    const message = JSON.parse(data) as { readonly id?: number; readonly method?: string }
    if (message.id === undefined) return
    const result = message.method === "initialize" ? { capabilities: {} } : null
    queueMicrotask(() => this.onmessage?.({
      data: JSON.stringify({ jsonrpc: "2.0", id: message.id, result })
    } as MessageEvent))
  }

  close(): void {
    this.readyState = 3
  }

  drop(): void {
    this.readyState = 3
    this.onclose?.({ code: 1006, reason: "", wasClean: false } as CloseEvent)
  }
}

test("terminal reconnect mints a fresh single-use ticket", async () => {
  const authorized: string[] = []
  const sockets: FakeSocket[] = []
  const terminal = createCloudTerminalClient({
    auth: "ticket",
    socketUrl: () => "wss://api.example.test/api/terminal",
    authorizeSocket: async (url) => {
      const ticket = `ticket-${authorized.length + 1}`
      authorized.push(ticket)
      return `${url}?ticket=${ticket}`
    },
    openSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    reconnectMs: 0,
    maxReconnectMs: 0,
    maxReconnectsPerMinute: 10
  })
  terminal.attach("owner/repo", "session", { onOutput: () => {} })
  await until(() => sockets.length === 1)
  sockets[0]!.drop()
  await until(() => sockets.length === 2)
  expect(authorized).toEqual(["ticket-1", "ticket-2"])
  expect(sockets.map((socket) => new URL(socket.url).searchParams.get("ticket"))).toEqual(["ticket-1", "ticket-2"])
  terminal.dispose()
})

test("LSP reconnect mints a fresh single-use ticket", async () => {
  const authorized: string[] = []
  const sockets: FakeSocket[] = []
  const lsp = createCloudLspClient({
    openSession: async () => Response.json({
      id: "lsp-1",
      workspace_id: "workspace-1",
      status: "running",
      kind: "exec",
      language: "typescript",
      idle_timeout_secs: 600
    }, { status: 201 }),
    socketUrl: () => "wss://api.example.test/api/lsp",
    authorizeSocket: async (url) => {
      const ticket = `ticket-${authorized.length + 1}`
      authorized.push(ticket)
      return `${url}?ticket=${ticket}`
    },
    socketFactory: (url) => {
      const socket = new FakeSocket(url, true)
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    reconnectMs: 0
  })
  const document = {
    repo: "owner/repo",
    workspaceId: "workspace-1",
    language: "typescript" as const,
    path: "src/index.ts",
    content: "const value = 1\n"
  }
  await expect(lsp.hover(document, { line: 0, character: 1 })).resolves.toEqual({ ok: { hover: null } })
  sockets[0]!.drop()
  await expect(lsp.hover(document, { line: 0, character: 1 })).resolves.toEqual({ ok: { hover: null } })
  expect(sockets).toHaveLength(2)
  expect(authorized).toEqual(["ticket-1", "ticket-2"])
  expect(sockets.map((socket) => new URL(socket.url).searchParams.get("ticket"))).toEqual(["ticket-1", "ticket-2"])
  lsp.dispose()
})
