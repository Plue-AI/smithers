import assert from "node:assert/strict"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { EditorView } from "@codemirror/view"
import type { LiveDocProvider } from "../../src/mainview/runtime/LiveDocProvider"
import { fileDocument, LiveFileContext } from "../../src/mainview/cards/liveDoc"
import { renderCardBody } from "../../src/mainview/cards/CardRenderers"
import type { Card } from "../../src/mainview/state/AppState"
import { ControllerContext } from "../../src/mainview/ControllerContext"
import type { AppController } from "../../src/mainview/state/AppController"
import type { CardActions } from "../../src/mainview/cards/CardFamily"

GlobalRegistrator.register()

// Mounted production registration over the composed install's authenticated
// provider. No sync frames or saved vectors are manufactured by this fixture.
export async function mountDocument(provider: LiveDocProvider, controller?: AppController, openedCard?: Extract<Card, { kind: "file" }>) {
  const branch = openedCard?.payload.ref ?? provider.file?.branch ?? "branch"
  const resource = controller?.fileDocuments?.resolve(branch, "retry.ts") ?? fileDocument(provider)
  let command: ReturnType<AppController["runCommandForResult"]> | undefined
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const card: Extract<Card, { kind: "file" }> = openedCard ?? {
    id: "mounted-retry", kind: "file", title: "retry.ts", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "ben/demo", ref: branch, path: "retry.ts", content: "", truncated: false }
  }
  const actions: CardActions = {
    onDecideApproval() {}, onConnectGitHub() {}, onRunWorkflow() {}, onStopRun() {}, onRetryRun() {}, onChooseWorkflowRepo() {},
    worldDocuments: [], onChangeWorldDocument() {}, onRunCommand(name, args) { command = controller?.runCommandForResult(name, args) }
  }
  const render = () => flushSync(() => root.render(<ControllerContext value={controller ?? null}><LiveFileContext value={{ resolve: () => resource }}>{renderCardBody(card, actions)}</LiveFileContext></ControllerContext>))
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
    async activate(label: string) {
      render()
      const button = [...host.querySelectorAll("button")].find(node => node.textContent === label)
      assert.ok(button, `mounted ${label} control`)
      flushSync(() => button.click())
      return await command
    },
    comparison(value: string, current = value) { render(); const outside = EditorView.findFromDOM(host.querySelector(".code-file-outside .cm-editor")!)!; assert.equal(outside.state.doc.toString(), value); assert.equal(editor().state.doc.toString(), current); },
    copyFailed: () => host.querySelector('[role="status"]')?.textContent === "Copy failed",
    recovery(count: number, value: string) { render(); assert.ok(host.textContent?.includes(`${count} edit wasn't saved`)); assert.ok(host.textContent?.includes(value)); assert.equal(host.querySelector('[contenteditable="true"]'), null); },
    text: () => editor().state.doc.toString(),
    undo() { const event = new KeyboardEvent("keydown", {key:"z",code:"KeyZ",ctrlKey:true,bubbles:true,cancelable:true}); flushSync(() => editor().contentDOM.dispatchEvent(event)); assert.ok(event.defaultPrevented, "mounted own-edits Undo keymap handled the native event"); },
    nameFlag(name: string) { render(); assert.ok([...host.querySelectorAll(".code-name-flag")].some(node => node.textContent?.includes(name)), `authenticated ${name} line flag mounted`); },
    authors() { render(); assert.ok(host.querySelector('.code-author[title*="Ben"]'), "committed Ben reference renders author colour"); assert.ok(host.querySelector('.code-author[title*="Alice"]'), "committed Alice reference renders author colour"); },
    saved() { render(); assert.equal(host.querySelector(".code-saved")?.textContent, "Saved to the machine") },
    readOnly() { render(); assert.ok(host.querySelector('[data-mode="read_only"]'), "revoked mounted File is read-only"); assert.equal(host.querySelector('[contenteditable="true"]'), null); },
    typeReadOnly(value: string) { flushSync(() => editor().contentDOM.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: value, bubbles: true, cancelable: true }))) },
    dispose() { flushSync(() => root.unmount()); host.remove(); resource.dispose(); }
  }
}
