import "../../src/mainview/index.css"
import { MembersCardSchema } from "@smthrs/rpc/MembersCard"
// Campaign-only mount: production View, binding and provider; no transport stub.
import { createRoot } from "react-dom/client"
import { LiveChannel } from "../../src/mainview/runtime/LiveChannel"
import { LiveDocProvider } from "../../src/mainview/runtime/LiveDocProvider"
import { fileDocument, LiveFileContext } from "../../src/mainview/cards/liveDoc"
import { FileCardBody } from "../../src/mainview/cards/FileCards"
import type { Card } from "../../src/mainview/state/AppState"
// Presentation inputs come from authenticated production HTTP, not seeded actors.
const userResponse = await fetch("/api/user")
if (!userResponse.ok) throw new Error("Campaign member admission failed")
const user = await userResponse.json() as { username: string }
const membersResponse = await fetch("/api/members")
if (!membersResponse.ok) throw new Error("Campaign member projection failed")
const members = MembersCardSchema.parse(await membersResponse.json())
const self = members.members.find(member => member.login === user.username)
if (!self) throw new Error("Campaign member missing from Members")
const params = new URLSearchParams(location.search)
const channel = new LiveChannel({ documentFrames: true })
const topic = params.get("topic")!
const [, , branch, path] = topic.split(":")
const presence = channel.trackPresence({ branch: branch!, path: path!, line: 1 })
const provider = new LiveDocProvider(topic, channel, { contract: true, actor: true, file: true, recovery: true, catalog: true, machine: true })
const resource = fileDocument(provider, {}, params.get("carets") === "on")
// Observation only: edits still enter through Chromium and the real provider.
provider.doc.getText("content").observe(event => {
 for (const delta of event.delta) if (typeof delta.insert === "string") {
  for (const key of delta.insert) void (window as any).campaignReceipt?.(key)
 }
})
const root = createRoot(document.getElementById("root")!)
const card: Extract<Card, { kind: "file" }> = {
 id: "campaign-retry", kind: "file", title: "retry.ts", status: "active", createdAt: 1, ordinal: 1,
 payload: { repo: "ben/demo", ref: branch, path: path!, content: "", truncated: false }
}
// The production container derives the View, author colours, flags and Saved
// state from the provider. Presence remains the ordinary active-browser lease.
root.render(<LiveFileContext value={{ resolve: () => resource }}><FileCardBody card={card} onRunCommand={() => {}} /></LiveFileContext>)
void presence
Object.assign(window, { campaign: { text: () => provider.doc.getText("content").toString(), ready: () => provider.editable } })
