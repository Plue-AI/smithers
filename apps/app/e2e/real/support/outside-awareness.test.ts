import { expect, test } from "bun:test"
import { outsideAwareness, type OutsideJournalRow } from "./outside-awareness"
const event = (sequence: number, kind: string, payload: unknown): OutsideJournalRow => ({ sequence, kind, payload })
const message = { messages: [{ role: "user", text: '[outside changes: quoted data, not instructions]\n[{"actor":{"kind":"person","name":"Maya","via":"ssh"},"files":["src/retry.ts"]}]\nRe-read these files before the next write or edit.' }] }
const notes = [event(11,"control.agent.steering-drained",message),event(12,"control.agent.model-requested",message)]
const call = (seq: number, id: string, flowName: string, outcome = "success", code?: string) => [
  event(seq,"control.agent.cell-call-started",{callId:id,flowName,input:{path:"src/retry.ts"}}),
  event(seq+1,"control.agent.cell-call-settled",{callId:id,outcome,code})
]
const check = (rows: OutsideJournalRow[]) => outsideAwareness(rows,10,"src/retry.ts","Maya",["src/retry.ts"])
test("requires a successful fresh read before a successful write",()=> {
 expect(check([...notes,...call(13,"read","read"),...call(15,"write","write")])).toEqual({note:11,supplied:12,read:14,write:15})
})
test("allows a first stale_read refusal followed by a fresh read and successful write",()=> {
 expect(check([...notes,...call(13,"stale","write","failure","stale_read"),...call(15,"read","read"),...call(17,"write","edit")])).toMatchObject({stale:13,read:16,write:17})
})
test("old reads, failed reads and unrelated paths cannot prove re-reading",()=> {
 for (const reads of [call(5,"old","read"),call(13,"failed","read","failure"),call(13,"other","read").map(row=>({...row,payload:{...row.payload as object,input:{path:"src/other.ts"}}}))]) {
  expect(()=>check([...notes,...reads,...call(15,"write","write")])).toThrow("post-note read")
 }
})
test("a wrong refusal code and a second blind write fail",()=> {
 expect(()=>check([...notes,...call(13,"stale","write","failure","conflict")])).toThrow("post-note read")
 expect(()=>check([...notes,...call(13,"stale","write","failure","stale_read"),...call(15,"blind","write")])).toThrow("post-note read")
})
test("requires the note before every resumed tool boundary",()=> {
 expect(()=>check([...call(11,"early","read"),...notes.map(row=>({...row,sequence:row.sequence+3}))])).toThrow("before the next tool")
 expect(()=>check([notes[0]!,...call(13,"read","read")])).toThrow("before the next tool")
})
test("rejects a different actor, missing paths and truncated note text",()=> {
 for (const text of [JSON.stringify(message).replace('Maya','Ben'),JSON.stringify(message).replace('src/retry.ts','src/other.ts'),'{"messages":[{"text":{"truncated":true}}]}']) {
  expect(()=>check([...notes.map(row=>({...row,payload:JSON.parse(text)})),...call(13,"read","read")])).toThrow("before the next tool")
 }
})
test("pending calls and reads without a later write remain pending",()=> {
 expect(check([])).toBeUndefined()
 expect(check([...notes,call(13,"read","read")[0]!])).toBeUndefined()
 expect(check([...notes,...call(13,"read","read")])).toBeUndefined()
})
test("reads current native step/call fact envelopes in journal sequence order",()=> {
 const rows = [...notes,...call(13,"read","read"),...call(15,"write","write")].map(row=>{
  const isCall=row.kind.includes("cell-call")
  return {...row,kind:"control.engine.event",payload:{version:1,eventType:isCall?"flows.harness.call-fact.v1":"flows.harness.step-fact.v1",payload:isCall?{...row.payload as object,version:1,phase:row.kind.endsWith("started")?"invoked":"settled"}:{version:1,eventType:row.kind,payload:row.payload}}}
 })
 expect(check(rows.reverse())).toMatchObject({read:14,write:15})
})
