import type { Page, WebSocketRoute, Locator } from "@playwright/test"
import * as Y from "yjs"
import * as sync from "y-protocols/sync"
import * as encoding from "lib0/encoding"
import * as decoding from "lib0/decoding"
import { decodeLiveDocBinary, encodeLiveDocBinary } from "@smthrs/rpc/LiveDoc"
import { installCloudFixture } from "../cloudFixture"

// Test-only document host: proves browser composition, never machine durability.
export function fileCoeditFixture() {
  const doc = new Y.Doc()
  const peers: Array<{ socket: WebSocketRoute; id: number; client: number; seq: number }> = []
  let nextClient = 42
  let acknowledge = true
  const model = () => ({ branch: "T12", path: "retry.ts", language: "typescript", digest: "fixture",
    content: { kind: "text", text: doc.getText("content").toString() }, mode: "read_only", diagnostics: [], authors: [], editors: [] })
  return {
    dispose: () => doc.destroy(),
    acknowledge: (value: boolean) => { acknowledge = value },
    text: () => doc.getText("content").toString(),
    async install(page: Page, login: string) {
      await installCloudFixture(page, { capabilities: ["install", "identity"] })
      await page.route("**/api/user", route => route.fulfill({ json: { id: login === "Alice" ? 42 : 43, username: login.toLowerCase(), is_admin: false } }))
      await page.route("**/api/branches/T12/files/retry.ts*", route => route.fulfill({ json: model() }))
      await page.routeWebSocket("**/api/live", socket => {
        let peer: typeof peers[number] | undefined
        socket.onMessage(raw => {
          if (typeof raw === "string") {
            const frame = JSON.parse(raw)
            if (frame.t !== "sub") return
            if (frame.topic === "doc:code:T12:retry.ts") {
              peer = { socket, id: frame.id, client: nextClient++, seq: 0 }; peers.push(peer)
              doc.getMap("authors").set(String(peer.client), { kind: "person", login: login.toLowerCase(), name: login,
                avatar_url: "https://github.com/identicons/placeholder.png", color_index: login === "Alice" ? 0 : 1 })
              socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: 1, data: { epoch: "00112233445566778899aabbccddeeff", client_id: peer.client } }))
            } else if (frame.topic === "branch:T12:files") socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: 1, data: [model()] }))
            else socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" }))
            return
          }
          if (!peer) return
          const frame = decodeLiveDocBinary(new Uint8Array(raw))
          if (frame.id !== peer.id) return
          if (frame.kind === 2) {
            for (const other of peers) if (other !== peer) other.socket.send(Buffer.from(encodeLiveDocBinary({ ...frame, id: other.id })))
            return
          }
          const decoder = decoding.createDecoder(frame.payload)
          const kind = decoding.readVarUint(decoder)
          const response = encoding.createEncoder()
          sync.readSyncMessage(decoding.createDecoder(frame.payload), response, doc, peer)
          if (encoding.length(response)) socket.send(Buffer.from(encodeLiveDocBinary({ kind: 1, id: peer.id, payload: encoding.toUint8Array(response) })))
          if (kind === sync.messageYjsUpdate) {
            peer.seq++
            const update = encoding.createEncoder(); sync.writeUpdate(update, Y.encodeStateAsUpdate(doc))
            for (const other of peers) if (other !== peer) other.socket.send(Buffer.from(encodeLiveDocBinary({ kind: 1, id: other.id, payload: encoding.toUint8Array(update) })))
            if (acknowledge) socket.send(JSON.stringify({ t: "saved", id: peer.id, seq: peer.seq, sv: Buffer.from(Y.encodeStateVector(doc)).toString("base64") }))
          }
        })
      })
    }
  }
}

/** Read code bytes while excluding the remote caret's label widget. */
export const editorText = (editor: Locator) => editor.evaluate(element => {
  const copy = element.cloneNode(true) as HTMLElement
  copy.querySelectorAll(".cm-ySelectionCaret").forEach(widget => widget.remove())
  return copy.textContent ?? ""
})
