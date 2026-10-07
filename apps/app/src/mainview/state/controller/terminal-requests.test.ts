import { afterEach, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { silentAgent } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"
import { createTerminalRequests } from "./terminal-requests"
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
test("terminal request persists and returns before launch and execution; repeated input launches once",async()=>{
 const launch=Promise.withResolvers<Response>(),ready=Promise.withResolvers<void>()
 let posts=0,gets=0,running=false,opened=0
 const f=await fixture((async(_input,init)=>{
  if(init?.method==="POST"){posts++;expect(f.store.session().terminalRequests?.[0]?.state).toBe("requested");return launch.promise}
  gets++;return Response.json({status:running?"running":"starting"})
 }) as typeof fetch)
 const actions=createTerminalRequests(f.ctx,{repo:()=>"owner/repo",observe:()=>{},open:async()=>{opened++},ready:()=>ready.promise})
 expect(await actions.openTerminal("scratch/alice/x")).toEqual({value:"Requested"})
 expect(await actions.openTerminal("scratch/alice/x")).toEqual({value:"Requested"})
 await until(()=>posts===1)
 await until(()=>[...f.store.collections.toasts.values()].some(toast=>toast.status==="running"))
 expect(opened).toBe(0)
 launch.resolve(Response.json({id:"terminal-1",workspace_id:"branch-1"}))
 await until(()=>gets>0)
 expect(f.store.session().terminalRequests?.[0]?.state).toBe("running")
 running=true
 await until(()=>opened===1)
 expect(f.store.session().terminalRequests?.[0]?.state).toBe("running")
 expect([...f.store.collections.toasts.values()].some(toast=>toast.status==="running")).toBe(true)
 ready.resolve()
 await until(()=>f.store.session().terminalRequests?.[0]?.state==="completed")
 await until(()=>![...f.store.collections.toasts.values()].some(toast=>toast.status==="running"))
 expect(posts).toBe(1)
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
 let attempts=0;const keys:string[]=[]
 const f=await fixture((async(_input,init)=>{
  if(init?.method==="POST"){
   keys.push(new Headers(init.headers).get("Idempotency-Key")!)
   if(++attempts===1)throw new TypeError("connection ended after request")
   return Response.json({id:"terminal-1",workspace_id:"branch-1"})
  }
  return Response.json({status:"running"})
 })as typeof fetch)
 const actions=createTerminalRequests(f.ctx,{repo:()=>"owner/repo",observe:()=>{},open:async()=>{},ready:async()=>{}})
 await actions.openTerminal("branch-1")
 await until(()=>f.store.session().terminalRequests?.[0]?.state==="failed")
 await actions.openTerminal("branch-1")
 await until(()=>f.store.session().terminalRequests?.[0]?.state==="completed")
 expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1])
})

test("reload reconnects a persisted request and an old identity cannot mount its result",async()=>{
 const backing=storage(),launch=Promise.withResolvers<Response>();let opened=0
 const old=await fixture((async()=>launch.promise)as unknown as typeof fetch,backing)
 const first=createTerminalRequests(old.ctx,{repo:()=>"owner/repo",observe:()=>{},open:async()=>{opened++},ready:async()=>{}})
 await first.openTerminal("branch-1")
 const id=old.store.session().terminalRequests![0]!.id
 old.ctx.dispose()
 const restored=await fixture((async(_input,init)=>{
  if(init?.method==="POST"){expect(new Headers(init.headers).get("Idempotency-Key")).toBe(id);return Response.json({id:"terminal-1",workspace_id:"branch-1"})}
  return Response.json({status:"running"})
 })as typeof fetch,backing)
 createTerminalRequests(restored.ctx,{repo:()=>"owner/repo",observe:()=>{},open:async()=>{opened++},ready:async()=>{}})
 await until(()=>restored.store.session().terminalRequests?.[0]?.state==="completed")
 launch.resolve(Response.json({id:"stale-terminal",workspace_id:"branch-1"}))
 await new Promise(resolve=>setTimeout(resolve,30))
 expect(opened).toBe(1)
 expect(restored.store.session().terminalRequests?.[0]?.session).toBe("terminal-1")
})

test("metadata and real stream readiness keep the request running",async()=>{
 let metadata=false,opened=0
 const f=await fixture((async(_input,init)=>init?.method==="POST"?Response.json({id:"terminal-1",workspace_id:"branch-1"}):Response.json({status:"running"}))as typeof fetch)
 const ready=Promise.withResolvers<void>()
 const actions=createTerminalRequests(f.ctx,{repo:()=>"owner/repo",observe:()=>{},available:()=>metadata,open:async()=>{opened++},ready:()=>ready.promise})
 await actions.openTerminal("branch-1")
 await until(()=>f.store.session().terminalRequests?.[0]?.state==="running")
 await new Promise(resolve=>setTimeout(resolve,30));expect(opened).toBe(0)
 metadata=true;await until(()=>opened===1)
 expect(f.store.session().terminalRequests?.[0]?.state).toBe("running")
 ready.reject(new Error("broker admission refused"))
 await until(()=>f.store.session().terminalRequests?.[0]?.state==="failed")
 expect(f.store.session().terminalRequests?.[0]?.error).toBe("broker admission refused")
})
