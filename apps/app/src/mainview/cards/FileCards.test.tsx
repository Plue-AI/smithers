import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"

import type { Card } from "../state/AppState"
import { FileCardAddressLine, FileCardBody, FileListCardBody } from "./FileCards"
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
  const { disposeCodeViewPool } = await import("@smthrs/ui/adapters/code-view")
  disposeCodeViewPool()
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
  for (let i = 0; i < 300 && !host.querySelector('[data-slot="code-view"]'); i++) await wait(10)
  expect(host.querySelector('[data-slot="code-view"]')).not.toBeNull()
}

describe("S1 File mapping", () => {
  test("all text, including Markdown, uses the same read-only code renderer", async () => {
    for (const path of ["src/a.ts", "README.md", "LICENSE"]) {
      const host = render(fileCard(path, "literal file bytes\n"))
      await loaded(host)
      expect(host.querySelector("pre")?.textContent).toBe("literal file bytes\n")
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
  expect(host.querySelector("pre")?.textContent).toBe("const retry = 1\n")
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
    for (const name of ["file.compare", "file.reapply"]) {
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
