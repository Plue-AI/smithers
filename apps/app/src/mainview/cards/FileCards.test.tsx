import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"

import type { Card } from "../state/AppState"
import { fileModel, FileCardAddressLine, FileCardBody, FileListCardBody } from "./FileCards"
import { renderCardBody } from "./CardRenderers"
import type { CardActions } from "./CardFamily"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { memoryStorage } from "../state/TestFixtures"

GlobalRegistrator.register()

/*
 * Every root is unmounted synchronously before the globals leave: a root
 * left mounted keeps React scheduler work queued, and that work reads
 * `window` on a later macrotask — after unregister, it throws into whichever
 * test file bun runs next in the same process (seen: FilesSeam.test.ts
 * failing with "window is not defined" right after this file).
 */
const mounted: Array<{ readonly root: Root; readonly host: HTMLElement; readonly dispose?: () => Promise<void> }> = []

afterEach(async () => {
  for (const { root, host, dispose } of mounted.splice(0)) {
    flushSync(() => root.unmount())
    host.remove()
    await dispose?.()
  }
})

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const fileCard = (path: string, content: string, extra: Partial<Extract<Card, { kind: "file" }>["payload"]> = {}): Extract<Card, { kind: "file" }> => ({
  id: `file-smithersai/smithers-${path}`,
  kind: "file",
  title: `File · smithersai/smithers · ${path}`,
  status: "active",
  createdAt: 1,
  ordinal: 1,
  payload: { repo: "smithersai/smithers", path, content, truncated: false, ...extra }
})

const render = (card: Extract<Card, { kind: "file" }>): HTMLElement => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  flushSync(() => root.render(<FileCardBody card={card} onRunCommand={() => {}} />))
  return host
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const loaded = async (host: HTMLElement) => {
  for (let i = 0; i < 300 && !host.querySelector('.cm-editor'); i++) await wait(10)
  expect(host.querySelector('.cm-editor')).not.toBeNull()
}

describe("S1 File mapping", () => {
  test("all text, including Markdown, uses the same read-only code renderer", async () => {
    for (const path of ["src/a.ts", "README.md", "LICENSE"]) {
      const host = render(fileCard(path, "literal file bytes\n"))
      await loaded(host)
      expect(host.querySelector(".cm-content")?.textContent).toBe("literal file bytes")
      expect(host.querySelector("textarea")).toBeNull()
      expect(host.querySelector('[data-mode="read_only"]')).not.toBeNull()
      expect(host.querySelector("h2")?.textContent).toBe(path)
    }
  })
  test("old binary journals remain readable without invented size or source bytes", () => {
    const host = render(fileCard("image.png", "secret bytes", { binary: true }))
    expect(host.textContent).toBe("Binary file")
    expect(host.querySelector("pre")).toBeNull()
  })
  test("an old truncation remains visible", async () => {
    const host = render(fileCard("a.ts", "prefix", { truncated: true }))
    await loaded(host)
    expect(host.textContent).toContain("Truncated")
  })
  test("persisted ready state grants no gesture while guest validation is unavailable", async () => {
    const host = render(fileCard("a.ts", "export const a = 1", { intel: { state: "ready" } }))
    await loaded(host)
    expect(host.querySelector("[data-flow]")).toBeNull()
    expect(host.querySelector("[data-flow-activate]")).toBeNull()
    expect(host.querySelector('[data-interactive]')).toBeNull()
  })
})

// No production provider, binding or daemon acknowledgment is available yet.
// Exercise the registered body rather than a second editor or a fake relay.
test("registered File cards cannot acquire live authority from persisted fields", async () => {
  const commands: string[] = []
  const actions: CardActions = {
    onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {},
    onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {},
    worldDocuments: [], onChangeWorldDocument: () => {},
    onRunCommand: name => { commands.push(name) }
  }
  const card = fileCard("retry.ts", "const retry = 1\n")
  Object.assign(card.payload, {
    mode: "live", saved: "saved", outside: { version: "retained-17", at: "2026-10-03T00:00:00Z" },
    unsaved: { count: 1, text: "unacknowledged" }, authors: [{ id: "forged-member" }],
    intel: { state: "ready" }
  })
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  flushSync(() => root.render(renderCardBody(card, actions)))
  await loaded(host)
  expect(host.querySelector('[data-mode="read_only"]')).not.toBeNull()
  expect(host.querySelector('[data-mode="live"], textarea, [contenteditable="true"]')).toBeNull()
  expect(host.querySelector('[data-flow="file.compare"], [data-flow="file.reapply"]')).toBeNull()
  expect(host.querySelector(".cm-content")?.textContent).toBe("const retry = 1")
  expect(host.textContent).not.toContain("Saved to the machine")
  expect(host.querySelector(".cm-ySelection")).toBeNull()
  expect(commands).toEqual([])
})

test("unavailable Compare and Reapply refuse in the production dispatcher without writes or cards", async () => {
  const requests: string[] = []
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, {
    available: false, startTurn: async () => ({ status: "error", message: "unavailable" }),
    cancelTurn: async () => {}, subscribe: () => () => {}
  }, { bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null }, fetchImpl: async input => { requests.push(String(input)); return new Response("{}", { status: 404 }) } })
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
    const cards = [...store.collections.cards.values()]
    const world = JSON.stringify(controller.design.world())
    requests.length = 0
    for (const name of ["file.compare", "file.reapply", "file.restore-deleted", "file.follow-rename"]) {
      expect((await controller.runCommandForResult(name, JSON.stringify({ path: "retry.ts", version: "retained-17" }))).status).toBe("failed")
    }
    expect([...store.collections.cards.values()]).toEqual(cards)
    expect(JSON.stringify(controller.design.world())).toBe(world)
    expect(requests).toEqual([])
  } finally { await controller.dispose() }
})

describe("file listing bindings", () => {
  test.each([undefined, "checkout with spaces"])("lists and reads in its repository scope (%s)", (localRepoId) => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    mounted.push({ root, host })
    const commands: Array<{ name: string; args?: string }> = []
    flushSync(() => root.render(<FileListCardBody
      card={{
        id: "listing", kind: "file-list", title: "Files", status: "active", createdAt: 1, ordinal: 1,
        payload: { repo: "smithersai/smithers", localRepoId, path: "my docs", entries: [
          { name: "examples", kind: "dir" }, { name: "read me.md", kind: "file" }
        ] }
      }}
      onRunCommand={(name, args) => { commands.push({ name, args }) }}
    />))
    const scope = localRepoId === undefined ? "smithersai/smithers" : '"checkout with spaces"'
    const buttons = host.querySelectorAll("button")
    const expected = [
      { name: "files", args: `"my docs/examples" ${scope}` },
      { name: "file", args: `"my docs/read me.md" ${scope}` }
    ]
    for (const [index, button] of Array.from(buttons).entries()) {
      expect(button.dataset.flow).toBe(expected[index]!.name)
      expect(button.dataset.flowArgs).toBe(expected[index]!.args)
      button.click()
    }
    expect(commands).toEqual(expected)
  })
})


test("a listing refresh uses its host's flow and scope", () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  const commands: Array<{ name: string; args?: string }> = []
  flushSync(() => root.render(<FileCardAddressLine
    repo="smithersai/smithers"
    path=""
    readAt={{ changeId: "old", commitId: "aaaa" }}
    head={{ changeId: "new", commitId: "bbbb" }}
    refreshCommand="files"
    refreshOperation="workspace"
    refreshScope="workspace with spaces"
    onRunCommand={(name, args) => { commands.push({ name, args }) }}
  />))
  const button = host.querySelector("button")!
  expect(button.dataset.flow).toBe("files")
  expect(JSON.parse(button.dataset.flowArgs!)).toEqual({ operation: "workspace", path: "", workspaceId: "workspace with spaces" })
  button.click()
  expect(commands).toEqual([{ name: "files", args: JSON.stringify({ operation: "workspace", path: "", workspaceId: "workspace with spaces" }) }])
})

test("oversized UTF-8 files stay read-only at the byte boundary", () => {
  const large = fileModel(fileCard("large.ts", "a".repeat(1_200_000)).payload)
  expect(large.mode).toBe("read_only")
  expect(large.content.kind).toBe("too_large")
  const boundary = fileModel(fileCard("unicode.ts", "é".repeat(524_288)).payload)
  expect(boundary.content.kind).toBe("text")
  expect(fileModel(fileCard("unicode.ts", "é".repeat(524_289)).payload).content.kind).toBe("too_large")
})

test("the served live seam mounts in the File card while an absent seam retains seeded text", async () => {
  const { LiveDocProvider } = await import("../runtime/LiveDocProvider")
  const { liveBinding } = await import("./liveDoc")
  const { EditorView } = await import("@codemirror/view")
  let receive: ((event: import("../runtime/LiveDocProvider").DocumentEvent) => void) | undefined
  const sent: unknown[] = []
  const provider = new LiveDocProvider("doc:code:T12:retry.ts", {
    subscribeDocument(_topic, callback) { receive = callback; return { send: (kind, payload) => { sent.push([kind, payload]) }, release() {} } }
  }, { contract: true, actor: true, file: true, recovery: true, catalog: true, machine: true })
  receive!({ kind: "assigned", epoch: "00000000000000000000000000000001", clientId: 7 })
  receive!({ kind: "sync", payload: Uint8Array.from([1, 2, 0, 0]) })
  provider.doc.getMap("authors").set("7", { kind: "person", login: "alice", name: "Alice", avatar_url: "https://example.com/alice", color_index: 2 })
  provider.doc.getText("content").insert(0, "served document")
  provider.awareness.getStates().set(8, { actor: { kind: "agent", id: "coding-8", agent: "coding", avatar_url: "https://example.com/agent", color_index: 6 }, line: 1 })
  const binding = liveBinding(provider.doc)
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  mounted.push({ root, host, dispose: async () => { binding.dispose(); provider.dispose() } })
  const card = fileCard("retry.ts", "seed fallback")
  flushSync(() => root.render(<FileCardBody card={card} live={{ provider, binding }} onRunCommand={() => {}} />))
  await loaded(host)
  expect(host.querySelector('[data-mode="live"]')).not.toBeNull()
  expect(host.querySelector(".cm-content")?.textContent).toBe("served document")
  expect(host.querySelector(".code-author")?.textContent).toBe("served document")
  expect(host.querySelector<HTMLElement>(".code-author")?.style.getPropertyValue("--who")).toBe("var(--lane-2)")
  expect(host.querySelector(".code-name-flag")?.textContent).toBe("Coding agent")
  expect(host.querySelector(".code-name-flag")?.getAttribute("data-kind")).toBe("agent")
  expect(host.querySelector(".code-saved")?.textContent).toBe("Saving…")
  const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!
  flushSync(() => editor.dispatch({ changes: { from: 15, insert: "!" } }))
  expect(provider.doc.getText("content").toString()).toBe("served document!")
  const { encodeStateVector } = await import("yjs")
  receive!({ kind: "saved", seq: 3, vector: encodeStateVector(provider.doc) })
  await loaded(host)
  // Re-render the same real seam after the disk acknowledgment.
  flushSync(() => root.render(<FileCardBody card={card} live={{ provider, binding }} onRunCommand={() => {}} />))
  expect(host.querySelector(".code-saved")?.textContent).toBe("Saved to the machine")
  const count = sent.length
  flushSync(() => root.render(<FileCardBody card={card} onRunCommand={() => {}} />))
  expect(host.querySelector('[data-mode="read_only"]')).not.toBeNull()
  expect(host.querySelector(".cm-content")?.textContent).toBe("seed fallback")
  expect(sent.length).toBe(count)
  expect(provider.doc.getText("content").toString()).toBe("served document!")
})

test.each(["contract", "actor", "file", "recovery", "catalog", "machine"] as const)("missing %s prerequisite keeps the mounted File read-only", async missing => {
  const { LiveDocProvider } = await import("../runtime/LiveDocProvider")
  const { liveBinding } = await import("./liveDoc")
  const provider = new LiveDocProvider("doc:code:T12:retry.ts", {
    subscribeDocument() { throw new Error("An unavailable document must not subscribe") }
  }, { contract: true, actor: true, file: true, recovery: true, catalog: true, machine: true, [missing]: false })
  const binding = liveBinding(provider.doc)
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  mounted.push({ root, host, dispose: async () => { binding.dispose(); provider.dispose() } })
  flushSync(() => root.render(<FileCardBody card={fileCard("retry.ts", "retained read-only text")} live={{ provider, binding }} onRunCommand={() => {}} />))
  await loaded(host)
  expect(host.querySelector('[data-mode="read_only"]')).not.toBeNull()
  expect(host.querySelector(".cm-content")?.textContent).toBe("retained read-only text")
  expect(host.querySelector(".code-author, .code-name-flag, .code-saved, .code-avatar-stack, button[data-flow]")).toBeNull()
  expect(host.querySelector(".cm-content")?.getAttribute("aria-readonly")).toBe("true")
})

// ADR 0003 ruling (8a, 2026-10-07): a closed socket (a host restart) is like
// a gap. Typing stays pending; the same assignment resends it, with no Reapply.
test("a closed socket keeps typing pending and the same assignment resends it without recovery", async () => {
  const { LiveChannel } = await import("../runtime/LiveChannel")
  const { LiveDocProvider } = await import("../runtime/LiveDocProvider")
  const { LiveFileContext, fileDocument } = await import("./liveDoc")
  const { EditorView } = await import("@codemirror/view")
  const Y = await import("yjs")
  const sync = await import("y-protocols/sync")
  const encoding = await import("lib0/encoding")
  const { encodeLiveDocBinary } = await import("@smthrs/rpc/LiveDoc")
  const sockets: import("../runtime/LiveChannel").LiveSocket[] = []
  const timers: Array<() => void> = []
  const sent: Array<string | Uint8Array> = []
  const channel = new LiveChannel({ documentFrames: true, socket: () => {
    const socket: import("../runtime/LiveChannel").LiveSocket = {
      readyState: 0, onopen: null, onclose: null, onmessage: null,
      send: frame => { sent.push(frame) }, close() {}
    }
    sockets.push(socket); return socket
  }, schedule: run => { timers.push(run); return run }, cancel() {} })
  const provider = new LiveDocProvider("doc:code:T12:retry.ts", channel,
    { contract: true, actor: true, file: true, recovery: true, catalog: true, machine: true })
  const documentBinding = fileDocument(provider)
  const server = new Y.Doc()
  server.getText("content").insert(0, "const retry = 1")
  const socket = sockets[0]!
  socket.readyState = 1; socket.onopen!()
  const assignment = { t: "snap", id: 1, cursor: 1, data: { epoch: "00000000000000000000000000000001", client_id: 7 } }
  socket.onmessage!({ data: JSON.stringify(assignment) })
  const encoder = encoding.createEncoder(); sync.writeSyncStep2(encoder, server)
  socket.onmessage!({ data: encodeLiveDocBinary({ kind: 1, id: 1, payload: encoding.toUint8Array(encoder) }) })
  const card = fileCard("retry.ts", "const retry = 1", { ref: "T12" })
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  mounted.push({ root, host, dispose: async () => { documentBinding.dispose(); channel.dispose(); server.destroy() } })
  const actions: CardActions = {
    onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {},
    onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {},
    worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {}
  }
  const paint = () => flushSync(() => root.render(<LiveFileContext value={{ resolve: () => documentBinding }}>{renderCardBody(card, actions)}</LiveFileContext>))
  paint(); await loaded(host)
  expect(host.querySelector('[data-mode="live"]')).not.toBeNull()
  const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!
  flushSync(() => editor.dispatch({ changes: { from: 15, insert: "!" } }))
  expect(provider.doc.getText("content").toString()).toBe("const retry = 1!")
  socket.readyState = 3; socket.onclose!()
  paint()
  expect(provider.unsaved).toBeUndefined()
  expect(host.textContent).not.toContain("Saved to the machine")
  const writes = sent.length
  flushSync(() => editor.dispatch({ changes: { from: 16, insert: "?" } }))
  expect(provider.doc.getText("content").toString()).toBe("const retry = 1!?")
  expect(sent.length).toBe(writes)
  timers[0]!()
  const reconnected = sockets[1]!
  reconnected.readyState = 1; reconnected.onopen!()
  expect(sent.at(-1)).toBe(JSON.stringify({ t: "sub", id: 1, topic: "doc:code:T12:retry.ts", client_id: 7 }))
  // A frame from the old socket cannot restore authority.
  socket.onmessage!({ data: JSON.stringify(assignment) })
  expect(sent.length).toBe(writes + 1)
  reconnected.onmessage!({ data: JSON.stringify(assignment) })
  reconnected.onmessage!({ data: encodeLiveDocBinary({ kind: 1, id: 1, payload: encoding.toUint8Array(encoder) }) })
  expect(provider.unsaved).toBeUndefined()
  expect(sent.length).toBe(writes + 4)
  reconnected.onmessage!({ data: JSON.stringify({ t: "saved", id: 1, seq: 2, sv: btoa(String.fromCharCode(...Y.encodeStateVector(provider.doc))) }) })
  paint()
  expect(provider.unsaved).toBeUndefined()
  expect(host.querySelector('[data-mode="live"]')).not.toBeNull()
  expect(host.querySelector(".cm-content")?.textContent).toBe("const retry = 1!?")
  expect(host.querySelector(".code-saved")?.textContent).toBe("Saved to the machine")
})

test("outside_change metadata projects and clears without replacing live text", async () => {
  const { LiveDocProvider } = await import("../runtime/LiveDocProvider")
  const { liveFileModel } = await import("./liveDoc")
  let receive!: (event: import("../runtime/LiveDocProvider").DocumentEvent) => void
  const provider = new LiveDocProvider("doc:code:T12:retry.ts", { subscribeDocument(_topic, callback) {
    receive = callback; return { send() {}, release() {} }
  } }, { contract: true, actor: true, file: true, recovery: true, catalog: true, machine: true })
  try {
    receive({ kind: "assigned", epoch: "00000000000000000000000000000001", clientId: 42 })
    receive({ kind: "sync", payload: Uint8Array.from([1, 2, 0, 0]) })
    provider.doc.getText("content").insert(0, "Alice's live edit")
    const model = { ...fileModel(fileCard("retry.ts", "old disk text").payload), branch: "T12" }
    provider.setFile({ ...model, outside: { version: "outside-17", at: "2026-10-05T12:00:00Z" } })
    expect(liveFileModel(model, provider)).toMatchObject({ content: { kind: "text", text: "Alice's live edit" }, outside: { version: "outside-17", at: "2026-10-05T12:00:00Z" } })
    provider.setFile(model)
    expect(liveFileModel(model, provider).outside).toBeUndefined()
    expect(provider.doc.getText("content").toString()).toBe("Alice's live edit")
  } finally { provider.dispose() }
})

test("production file command and mounted document share one branch-files projection", async () => {
  const { LiveChannel } = await import("../runtime/LiveChannel")
  const { ControllerContext } = await import("../ControllerContext")
  const sent: string[] = []
  const socket: import("../runtime/LiveChannel").LiveSocket = {
    readyState: 0, onopen: null, onclose: null, onmessage: null,
    send: data => { if (typeof data === "string") sent.push(data) }, close() {}
  }
  const channel = new LiveChannel({ documentFrames: true, socket: () => socket })
  const model: import("@smthrs/rpc/FileCard").FileCard = {
    branch: "T12", path: "retry.ts", language: "typescript", digest: "literal-digest",
    content: { kind: "text", text: "const retry = 1" }, mode: "read_only", diagnostics: [], authors: [], editors: []
  }
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, {
    available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {}
  }, {
    bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "none", sandbox: null },
    live: channel, documentOptions: { channel, prerequisites: { contract: true, actor: true, file: true, recovery: true, catalog: true, machine: true } },
    branchOptions: { ready: () => true, scope: () => ({ branch: "T12", member: "ben", revision: 1, sleeping: false }) },
    fetchImpl: async () => new Response(JSON.stringify(model))
  })
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  mounted.push({ root, host, dispose: async () => { await controller.dispose(); channel.dispose() } })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  expect((await controller.commands.submit({ name: "file", payload: { path: "retry.ts", branch: "T12" }, actor: "user" })).status).toBe("executed")
  const card = [...store.collections.cards.values()].find(card => card.kind === "file" && card.payload.path === "retry.ts")!
  const actions: CardActions = {
    onDecideApproval: () => {}, onConnectGitHub: () => {}, onRunWorkflow: () => {}, onStopRun: () => {}, onRetryRun: () => {}, onChooseWorkflowRepo: () => {},
    worldDocuments: [], onChangeWorldDocument: () => {}, onRunCommand: () => {}
  }
  flushSync(() => root.render(<ControllerContext value={controller}>{renderCardBody(card, actions)}</ControllerContext>))
  await loaded(host)
  expect(host.querySelector('[data-mode="read_only"]')).not.toBeNull()
  const provider = controller.fileDocuments!.resolve("T12", "retry.ts", model)!.provider
  socket.readyState = 1; socket.onopen!()
  const subscription = sent.map(frame => JSON.parse(frame)).find(frame => frame.topic === "branch:T12:files")
  expect(subscription).toBeDefined()
  socket.onmessage!({ data: JSON.stringify({ t: "snap", id: subscription.id, cursor: 1, data: [model] }) })
  socket.onmessage!({ data: JSON.stringify({ t: "delta", id: subscription.id, cursor: 2, data: { path: "retry.ts", outside_change: { version: "outside-1", at: "2026-10-06T00:00:00Z" } } }) })
  expect(provider.file?.outside).toEqual({ version: "outside-1", at: "2026-10-06T00:00:00Z" })
  socket.onmessage!({ data: JSON.stringify({ t: "delta", id: subscription.id, cursor: 3, data: { path: "retry.ts" } }) })
  expect(provider.file?.outside).toBeUndefined()
  expect(host.textContent).not.toContain("Saved to the machine")
})
