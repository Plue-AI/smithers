import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { LiveChannel, type LiveSocket } from "../runtime/LiveChannel"
import { useBranchConversationTopics, useTopic } from "./useTopic"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterAll(() => GlobalRegistrator.unregister())

test("two Containers project the shared topic to stub Views and release only on last unmount", async () => {
  const frames: unknown[] = []
  let count = 0
  const socket: LiveSocket = { readyState: 0, onopen: null, onclose: null, onmessage: null, send: frame => frames.push(typeof frame === "string" ? JSON.parse(frame) : frame), close: () => {} }
  const channel = new LiveChannel({ socket: () => { count++; return socket } })
  const models = new Map<string, unknown>()
  const View = ({ name, model }: { name: string; model: unknown }) => { models.set(name, model); return null }
  const Container = ({ name }: { name: string }) => <View name={name} model={useTopic("home", channel)?.data} />
  const host = document.createElement("div")
  const root = createRoot(host)
  try {
    await act(async () => root.render(<><Container name="a" /><Container name="b" /></>))
    socket.readyState = 1; socket.onopen?.()
    expect(count).toBe(1)
    expect(frames).toEqual([{ t: "sub", id: 1, topic: "home" }])
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ t: "snap", id: 1, cursor: 5, data: { items: [12] } }) }))
    expect([...models.values()]).toEqual([{ items: [12] }, { items: [12] }])
    await act(async () => root.render(<Container name="a" />))
    expect(frames).toHaveLength(1)
    await act(async () => root.unmount())
    expect(frames.at(-1)).toEqual({ t: "unsub", id: 1 })
  } finally { channel.dispose() }
})


test("dark branch topics perform no IO; enabled topics isolate each member's view and release old scopes", async () => {
  const frames: unknown[] = []
  let connections = 0
  const socket: LiveSocket = { readyState: 0, onopen: null, onclose: null, onmessage: null, send: frame => frames.push(typeof frame === "string" ? JSON.parse(frame) : frame), close: () => {} }
  const channel = new LiveChannel({ socket: () => { connections++; return socket } })
  const models = new Map<string, unknown>()
  const Container = ({ member, branch }: { member: string; branch?: string }) => {
    models.set(member, useBranchConversationTopics(branch ? { member, branch } : undefined, channel))
    return null
  }
  const root = createRoot(document.createElement("div"))
  try {
    await act(async () => root.render(<Container member="Ben" />))
    expect(connections).toBe(0)
    expect(models.get("Ben")).toEqual({ entries: undefined, view: undefined })
    await act(async () => root.render(<><Container member="Ben" branch="main" /><Container member="Alice" branch="main" /></>))
    socket.readyState = 1; socket.onopen?.()
    expect(frames).toEqual([
      { t: "sub", id: 1, topic: "conversation:main" },
      { t: "sub", id: 2, topic: "view:Ben:main" },
      { t: "sub", id: 3, topic: "view:Alice:main" }
    ])
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ t: "snap", id: 1, cursor: 5, data: ["shared answer"] }) })
      socket.onmessage?.({ data: JSON.stringify({ t: "snap", id: 2, cursor: 7, data: { last_seen_seq: 5 } }) })
      socket.onmessage?.({ data: JSON.stringify({ t: "snap", id: 3, cursor: 8, data: { last_seen_seq: 2 } }) })
    })
    expect(models.get("Ben")).toEqual({ entries: { topic: "conversation:main", cursor: 5, data: ["shared answer"] }, view: { topic: "view:Ben:main", cursor: 7, data: { last_seen_seq: 5 } } })
    expect(models.get("Alice")).toEqual({ entries: { topic: "conversation:main", cursor: 5, data: ["shared answer"] }, view: { topic: "view:Alice:main", cursor: 8, data: { last_seen_seq: 2 } } })
    await act(async () => root.render(<><Container member="Ben" branch="scratch" /><Container member="Alice" branch="main" /></>))
    expect(models.get("Ben")).toEqual({ entries: { topic: "conversation:scratch" }, view: { topic: "view:Ben:scratch" } })
    expect(channel.getSnapshot("conversation:main")?.data).toEqual(["shared answer"])
    expect(channel.getSnapshot("view:Ben:main")).toBeUndefined()
    expect(frames.slice(-3)).toEqual([{ t: "unsub", id: 2 }, { t: "sub", id: 4, topic: "conversation:scratch" }, { t: "sub", id: 5, topic: "view:Ben:scratch" }])
    await act(async () => root.render(<Container member="Ben" branch="invalid:branch" />))
    expect(models.get("Ben")).toEqual({ entries: undefined, view: undefined })
    expect(channel.collection.size).toBe(0)
    await act(async () => root.render(<Container member="" branch="main" />))
    expect(connections).toBe(1)
  } finally { await act(async () => root.unmount()); channel.dispose() }
})
