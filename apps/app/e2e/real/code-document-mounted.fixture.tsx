import assert from "node:assert/strict"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { EditorView } from "@codemirror/view"
import type { LiveDocProvider } from "../../src/mainview/runtime/LiveDocProvider"
import { fileDocument, LiveFileContext } from "../../src/mainview/cards/liveDoc"
import { renderCardBody } from "../../src/mainview/cards/CardRenderers"
import type { Card } from "../../src/mainview/state/AppState"
import type { CardActions } from "../../src/mainview/cards/CardFamily"

GlobalRegistrator.register()

// Mounted production registration over the composed install's authenticated
// provider. No sync frames or saved vectors are manufactured by this fixture.
export async function mountDocument(provider: LiveDocProvider) {
  const resource = fileDocument(provider)
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const card: Extract<Card, { kind: "file" }> = {
    id: "mounted-retry", kind: "file", title: "retry.ts", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "ben/demo", ref: "branch", path: "retry.ts", content: "", truncated: false }
  }
  const actions: CardActions = {
    onDecideApproval() {}, onConnectGitHub() {}, onRunWorkflow() {}, onStopRun() {}, onRetryRun() {}, onChooseWorkflowRepo() {},
    worldDocuments: [], onChangeWorldDocument() {}, onRunCommand() {}
  }
  const render = () => flushSync(() => root.render(<LiveFileContext value={{ resolve: () => resource }}>{renderCardBody(card, actions)}</LiveFileContext>))
  render()
  const started = performance.now()
  while (!host.querySelector(".cm-editor")) {
    if (performance.now() - started > 10000) throw new Error("Registered File editor failed to mount")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const editor = () => EditorView.findFromDOM(host.querySelector(".cm-editor")!)!
  assert.ok(editor(), "production CodeEditorView mounted")
  return {
    insert(at: number, value: string) { flushSync(() => editor().dispatch({ changes: { from: at, insert: value } })) },
    text: () => editor().state.doc.toString(),
    saved() { render(); assert.equal(host.querySelector(".code-saved")?.textContent, "Saved to the machine") },
    dispose() { flushSync(() => root.unmount()); host.remove(); resource.dispose(); }
  }
}
