import { afterAll, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import * as Cell from "@smthrs/harness/Cell"
import { Effect, Option } from "effect"
import { chatCopyFlows } from "./chat"
import type { CommandActions } from "./Declare"
import { FlowGesture, reserveBrowserCommandGesture } from "../CommandGesture"

GlobalRegistrator.register()
afterAll(async () => { await GlobalRegistrator.unregister() })

const call = new Cell.Call({
 flowName: "chat.copy-message", input: { text: "plain HTTP message" }, capabilities: [],
 effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
 placement: Option.none(), identity: new Cell.CallIdentity({session:"clipboard",frame:0,cell:"copy",ordinal:0,declaration:"copy",layers:[]})
})

test("the production chat flow copies with an absent or refused native clipboard", async () => {
 const entry = chatCopyFlows({} as CommandActions)[0]!
 const copies: string[] = []
 Object.defineProperty(document, "execCommand", { configurable: true, value: () => {
  copies.push((document.activeElement as HTMLTextAreaElement).value); return true
 }})
 for (const native of [undefined, {writeText: async () => { throw new Error("refused") }}]) {
  Object.defineProperty(navigator, "clipboard", { configurable:true, value:native })
  const result = await Effect.runPromise(entry.binding.run(call))
  expect(result).toMatchObject({outcome:"success",value:{value:"Copied to clipboard."}})
 }
 expect(copies).toEqual(["plain HTTP message", "plain HTTP message"])
 let release!: () => void
 const pending = new Promise<void>(resolve => { release = resolve })
 Object.defineProperty(globalThis, "ClipboardItem", {configurable:true, value:class { constructor(_data: unknown) {} }})
 Object.defineProperty(navigator, "clipboard", {configurable:true, value:{write:async()=>{ await pending; throw new Error("refused") }}})
 const gesture = reserveBrowserCommandGesture("chat.copy-message")!
 expect(gesture).toBeDefined()
 let done = false
 const result = Effect.runPromise(entry.binding.run(call).pipe(Effect.provideService(FlowGesture, gesture))).then(value=>{done=true;return value})
 await Promise.resolve(); expect(done).toBe(false); expect(copies).toHaveLength(2)
 release(); expect(await result).toMatchObject({outcome:"success"}); expect(copies).toHaveLength(3)
 gesture.release()
})
