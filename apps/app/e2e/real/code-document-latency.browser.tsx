import "../../src/mainview/index.css"
import { actorColour } from "../../src/mainview/cards/views/ActorChip"
import { MembersCardSchema } from "@smthrs/rpc/MembersCard"
import { ActorSchema } from "@smthrs/rpc/CardPrimitives"
// Campaign-only mount: production View, binding and provider; no transport stub.
import { useLiveQuery } from "@tanstack/react-db"
import { createRoot } from "react-dom/client"
import { LiveChannel } from "../../src/mainview/runtime/LiveChannel"
import { LiveDocProvider } from "../../src/mainview/runtime/LiveDocProvider"
import { fileDocument, liveFileModel } from "../../src/mainview/cards/liveDoc"
import { CodeEditorView } from "../../src/mainview/cards/views/CodeEditorView"
import type { FileCard } from "@smthrs/rpc/FileCard"
// Presentation inputs come from authenticated production HTTP, not seeded actors.
const userResponse = await fetch("/api/user")
if (!userResponse.ok) throw new Error("Campaign member admission failed")
const user = await userResponse.json() as { username: string }
const membersResponse = await fetch("/api/members")
if (!membersResponse.ok) throw new Error("Campaign member projection failed")
const members = MembersCardSchema.parse(await membersResponse.json())
const self = members.members.find(member => member.login === user.username)
if (!self) throw new Error("Campaign member missing from Members")
const actor = ActorSchema.parse({ kind: "person", login: self.login, name: self.name, avatar_url: self.avatar_url, color_index: self.color_index })
const params = new URLSearchParams(location.search)
const channel = new LiveChannel({ documentFrames: true })
const provider = new LiveDocProvider(params.get("topic")!, channel, { contract: true, actor: true, file: true, recovery: true, catalog: true, machine: true })
const resource = fileDocument(provider, {}, params.get("carets") === "on")
const root = createRoot(document.getElementById("root")!)
const model: FileCard = { branch: "T12", path: "retry.ts", language: "typescript", digest: "campaign", content: { kind: "text", text: "" }, mode: "read_only", diagnostics: [], authors: [], editors: [] }
const Mount = () => {
 useLiveQuery(q => q.from({ status: provider.collection }))
 return <CodeEditorView model={liveFileModel(model, provider, provider.awareness.getStates())} binding={provider.editable ? resource.binding : undefined} view={{ maximized: false }} actions={[]} gestures={{}} onAction={() => {}} onView={({ line }) => provider.awareness.setLocalState({ ...provider.awareness.getLocalState(), actor, colour: actorColour(actor), line: line ?? 1 })} />
}
root.render(<Mount />)
Object.assign(window, { campaign: { text: () => provider.doc.getText("content").toString(), ready: () => provider.editable } })
