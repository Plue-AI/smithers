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
  }, { fetchImpl: async input => { requests.push(String(input)); return new Response("{}", { status: 404 }) } })
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
    const cards = [...store.collections.cards.values()]
    const world = JSON.stringify(controller.design.world())
    requests.length = 0
    for (const name of ["file.compare", "file.reapply", "file.restore-deleted", "file.follow-rename"]) {
      expect((await controller.runCommandForResult(name, JSON.stringify({ path: "retry.ts", version: "retained-17" }))).status).toBe("unknown-command")
    }
    expect([...store.collections.cards.values()]).toEqual(cards)
    expect(JSON.stringify(controller.design.world())).toBe(world)
    expect(requests).toEqual([])
  } finally { controller.dispose() }
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
      { name: "files.list", args: `"my docs/examples" ${scope}` },
      { name: "files.read", args: `"my docs/read me.md" ${scope}` }
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
    refreshCommand="box.files"
    refreshScope="workspace with spaces"
    onRunCommand={(name, args) => { commands.push({ name, args }) }}
  />))
  const button = host.querySelector("button")!
  expect(button.dataset.flow).toBe("box.files")
  expect(button.dataset.flowArgs).toBe('/ "workspace with spaces"')
  button.click()
  expect(commands).toEqual([{ name: "box.files", args: '/ "workspace with spaces"' }])
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
  provider.doc.getText("content").insert(0, "served document")
  const binding = liveBinding(provider.doc)
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  mounted.push({ root, host, dispose: async () => { binding.dispose(); provider.dispose() } })
  const card = fileCard("retry.ts", "seed fallback")
  flushSync(() => root.render(<FileCardBody card={card} live={{ provider, binding }} onRunCommand={() => {}} />))
  await loaded(host)
  expect(host.querySelector('[data-mode="live"]')).not.toBeNull()
  expect(host.querySelector(".cm-content")?.textContent).toBe("served document")
  const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!
  flushSync(() => editor.dispatch({ changes: { from: 15, insert: "!" } }))
  expect(provider.doc.getText("content").toString()).toBe("served document!")
  const count = sent.length
  flushSync(() => root.render(<FileCardBody card={card} onRunCommand={() => {}} />))
  expect(host.querySelector('[data-mode="read_only"]')).not.toBeNull()
  expect(host.querySelector(".cm-content")?.textContent).toBe("seed fallback")
  expect(sent.length).toBe(count)
  expect(provider.doc.getText("content").toString()).toBe("served document!")
})
