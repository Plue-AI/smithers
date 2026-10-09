import { afterEach, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { silentAgent } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"
import { createTerminalRequests } from "./terminal-requests"
import { TerminalUnavailable } from "../CloudTerminalClient"
import type { StorageApi } from "@tanstack/db"

const cleanups: Array<() => void> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
const storage = (): StorageApi => {
 const rows = new Map<string,string>()
 return { getItem:key=>rows.get(key)??null,setItem:(key,value)=>{rows.set(key,value)},removeItem:key=>{rows.delete(key)} }
}
const until = async (condition: () => boolean) => {
 for(let i=0;i<100;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,10))}
 throw new Error("Terminal request did not settle")
}
async function fixture(fetchImpl: typeof fetch, backing=storage()) {
 const store = await createAppStore({ kind:"localStorage",storage:backing })
 await store.dispatch({type:"identity.session.loaded",actor:"system",state:"signed-in",login:"alice",admin:false,scopesPlain:null}).isPersisted.promise
 const ctx=createControllerContext(store,silentAgent,{fetchImpl,workflowPollMs:10,toastDebounceMs:0})
 const notices=createFailureController(ctx);ctx.withToast=notices.withToast;ctx.resolveToast=notices.resolveToast
 cleanups.push(()=>ctx.dispose())
 return {store,ctx}
}
/*
 * The documented receipt contract (docs/api/openapi/terminals.yaml): one 202
 * receipt per Idempotency-Key whose status advances. An owner terminal has no
 * workspace session row, so a session GET is a 404 here as it is on an install.
 */
function receipts(status: () => "pending"|"running"|"failed"|"closed" = () => "running") {
 const issued=new Map<string,string>(),keys:string[]=[];let gets=0
 const fetchImpl=(async(_input:unknown,init?:RequestInit)=>{
  if(init?.method!=="POST"){gets++;return Response.json({message:"Not found"},{status:404})}
  const key=new Headers(init.headers).get("Idempotency-Key")!;keys.push(key)
  expect(JSON.parse(String(init.body))).toEqual({branch:"branch-1"})
  if(!issued.has(key))issued.set(key,`terminal-${issued.size+1}`)
  return Response.json({id:issued.get(key),workspace_id:"branch-1",user_id:7,status:status()},{status:202})
 }) as typeof fetch
 return {fetchImpl,keys,gets:()=>gets}
}
test("terminal request persists and returns before launch and execution; repeated input launches once",async()=>{
 const launch=Promise.withResolvers<void>(),ready=Promise.withResolvers<void>()
 let status:"pending"|"running"="pending",opened=0
 const server=receipts(()=>status)
 const f=await fixture((async(input,init)=>{
  if(server.keys.length===0){expect(f.store.session().terminalRequests?.[0]?.state).toBe("requested");await launch.promise}
  return server.fetchImpl(input,init)
 }) as typeof fetch)
 const actions=createTerminalRequests(f.ctx,{repo:()=>"owner/repo",observe:()=>{},open:async()=>{opened++},ready:()=>ready.promise})
 expect(await actions.openTerminal("branch-1")).toEqual({value:"Requested"})
 expect(await actions.openTerminal("branch-1")).toEqual({value:"Requested"})
 await until(()=>[...f.store.collections.toasts.values()].some(toast=>toast.status==="running"))
 expect(server.keys).toEqual([])
 expect(opened).toBe(0)
 launch.resolve()
 await until(()=>server.keys.length>1)
 expect(f.store.session().terminalRequests).toHaveLength(1)
 expect(f.store.session().terminalRequests?.[0]).toMatchObject({state:"running",session:"terminal-1",branchId:"branch-1"})
 expect(opened).toBe(0)
 status="running"
 await until(()=>opened===1)
 expect(f.store.session().terminalRequests?.[0]?.state).toBe("running")
 expect([...f.store.collections.toasts.values()].some(toast=>toast.status==="running")).toBe(true)
 ready.resolve()
 await until(()=>f.store.session().terminalRequests?.[0]?.state==="completed")
 await until(()=>![...f.store.collections.toasts.values()].some(toast=>toast.status==="running"))
 expect(new Set(server.keys).size).toBe(1)
 expect(server.gets()).toBe(0)
})
test("status reads back off within the terminal-open budget",async()=>{
 const server=receipts(()=>"pending")
 const f=await fixture(server.fetchImpl)
 const actions=createTerminalRequests(f.ctx,{repo:()=>"owner/repo",observe:()=>{},open:async()=>{throw new Error("must not open")},ready:async()=>{}})
 await actions.openTerminal("branch-1")
 await new Promise(resolve=>setTimeout(resolve,300))
 // A fixed 10 ms poll would read 30 times; doubling from 10 ms reads at 0, 10, 30, 70 and 150 ms.
 expect(server.keys.length).toBeGreaterThanOrEqual(3)
 expect(server.keys.length).toBeLessThanOrEqual(7)
 expect(f.store.session().terminalRequests?.[0]?.state).toBe("running")
})
for (const status of ["failed","closed"] as const) test(`a ${status} receipt settles the request and a retry starts a new one`,async()=>{
 let current:"pending"|typeof status="pending"
 const server=receipts(()=>current)
 const f=await fixture(server.fetchImpl)
 const actions=createTerminalRequests(f.ctx,{repo:()=>"owner/repo",observe:()=>{},open:async()=>{throw new Error("must not open")},ready:async()=>{}})
 await actions.openTerminal("branch-1")
 await until(()=>f.store.session().terminalRequests?.[0]?.state==="running")
 current=status
 await until(()=>f.store.session().terminalRequests?.[0]?.state==="failed")
 expect(f.store.session().terminalRequests?.[0]).toMatchObject({error:"Terminal unavailable",uncertain:false,session:"terminal-1"})
 await actions.openTerminal("branch-1")
 await until(()=>new Set(server.keys).size===2)
 expect(server.gets()).toBe(0)
})
test("a refused launch is durable and retry creates a new request",async()=>{
 const keys:string[]=[]
 const f=await fixture((async(_input,init)=>{keys.push(new Headers(init?.headers).get("Idempotency-Key")!);return Response.json({message:"Machine failed"},{status:400})})as typeof fetch)
 const actions=createTerminalRequests(f.ctx,{repo:()=>"owner/repo",observe:()=>{},open:async()=>{throw new Error("must not open")},ready:async()=>{}})
 await actions.openTerminal("branch-1")
 await until(()=>f.store.session().terminalRequests?.[0]?.state==="failed")
 expect(f.store.session().terminalRequests?.[0]?.error).toBe("Machine failed")
 await actions.openTerminal("branch-1")
 await until(()=>keys.length===2)
 expect(keys[0]).not.toBe(keys[1])
})

test("a lost launch acknowledgment retries the same durable request", async()=>{
 let attempts=0
 const server=receipts()
 const f=await fixture((async(input,init)=>{
  if(++attempts===1){server.keys.push(new Headers(init?.headers).get("Idempotency-Key")!);throw new TypeError("connection ended after request")}
  return server.fetchImpl(input,init)
 })as typeof fetch)
 const actions=createTerminalRequests(f.ctx,{repo:()=>"owner/repo",observe:()=>{},open:async()=>{},ready:async()=>{}})
 await actions.openTerminal("branch-1")
 await until(()=>f.store.session().terminalRequests?.[0]?.state==="failed")
 expect(f.store.session().terminalRequests?.[0]?.uncertain).toBe(true)
 await actions.openTerminal("branch-1")
 await until(()=>f.store.session().terminalRequests?.[0]?.state==="completed")
 expect(server.keys).toHaveLength(2);expect(server.keys[0]).toBe(server.keys[1])
})

test("reload reconnects a persisted request and an old identity cannot mount its result",async()=>{
 const backing=storage(),launch=Promise.withResolvers<Response>();let opened=0
 const old=await fixture((async()=>launch.promise)as unknown as typeof fetch,backing)
 const first=createTerminalRequests(old.ctx,{repo:()=>"owner/repo",observe:()=>{},open:async()=>{opened++},ready:async()=>{}})
 await first.openTerminal("branch-1")
 const id=old.store.session().terminalRequests![0]!.id
 old.ctx.dispose()
 const server=receipts()
 const restored=await fixture(server.fetchImpl,backing)
 createTerminalRequests(restored.ctx,{repo:()=>"owner/repo",observe:()=>{},open:async()=>{opened++},ready:async()=>{}})
 await until(()=>restored.store.session().terminalRequests?.[0]?.state==="completed")
 expect(server.keys).toEqual([id])
 launch.resolve(Response.json({id:"stale-terminal",workspace_id:"branch-1",user_id:7,status:"running"}))
 await new Promise(resolve=>setTimeout(resolve,30))
 expect(opened).toBe(1)
 expect(restored.store.session().terminalRequests?.[0]?.session).toBe("terminal-1")
})

test("a receipt for another session fails the persisted request for good",async()=>{
 const server=receipts()
 const f=await fixture(server.fetchImpl)
 await f.store.dispatch({type:"terminal.requests.changed",actor:"system",requests:[{id:"9a4c3d4e-1b2f-4c5d-8e9f-0a1b2c3d4e5f",owner:"alice",repo:"owner/repo",branch:"branch-1",branchId:"branch-1",session:"terminal-lost",state:"running"}]}).isPersisted.promise
 createTerminalRequests(f.ctx,{repo:()=>"owner/repo",observe:()=>{},open:async()=>{throw new Error("must not open")},ready:async()=>{}})
 await until(()=>f.store.session().terminalRequests?.[0]?.state==="failed")
 expect(f.store.session().terminalRequests?.[0]).toMatchObject({session:"terminal-lost",uncertain:false})
})

test("metadata and real stream readiness keep the request running",async()=>{
 let metadata=false,opened=0
 const f=await fixture(receipts().fetchImpl)
 const ready=Promise.withResolvers<void>()
 const actions=createTerminalRequests(f.ctx,{repo:()=>"owner/repo",observe:()=>{},available:()=>metadata,open:async()=>{opened++},ready:()=>ready.promise})
 await actions.openTerminal("branch-1")
 await until(()=>f.store.session().terminalRequests?.[0]?.state==="running")
 await new Promise(resolve=>setTimeout(resolve,30));expect(opened).toBe(0)
 metadata=true;await until(()=>opened===1)
 expect(f.store.session().terminalRequests?.[0]?.state).toBe("running")
 // The real readiness wait (awaitTerminalReady) rejects with the socket's note.
 ready.reject(new TerminalUnavailable({ sentence: "broker admission refused" }))
 await until(()=>f.store.session().terminalRequests?.[0]?.state==="failed")
 expect(f.store.session().terminalRequests?.[0]?.error).toBe("broker admission refused")
})
