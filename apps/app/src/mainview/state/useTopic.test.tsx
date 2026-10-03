import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { LiveChannel, type LiveSocket } from "../runtime/LiveChannel"
import { useTopic } from "./useTopic"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterAll(() => GlobalRegistrator.unregister())

test("two Containers project the shared topic to stub Views and release only on last unmount", async () => {
  const frames: unknown[] = []
  let count = 0
  const socket: LiveSocket = { readyState: 0, onopen: null, onclose: null, onmessage: null, send: frame => frames.push(JSON.parse(frame)), close: () => {} }
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
