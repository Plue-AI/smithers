import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage, waitFor } from "../TestFixtures"
import { createIssueCreateSeam } from "./IssueCreateSeam"
import type { SeamContext } from "./SeamContext"
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const harness = async (http: SeamContext["http"], storage = memoryStorage()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  let disposed = false
  const settled: unknown[] = []
  const ctx: SeamContext = { http, store, dispatch: store.dispatch, baseUrl: "", actor: () => "user", nextOrdinal: store.nextOrdinal, isDisposed: () => disposed,
    withToast: async (_key, _title, _done, work) => { const result = await work(); settled.push(result); return result } }
  return { store, ctx, settled, storage, close: () => { disposed = true } }
}


test("issue creation returns before launch/delivery, deduplicates and opens only the delivered issue", async () => {
 const launch=deferred<Response>(), delivery=deferred<Response>();let calls=0;const opened:number[]=[]
 const h=await harness(async (_url,init)=>{calls++;return init?.method==="POST"?launch.promise:delivery.promise})
 const seam=createIssueCreateSeam(h.ctx,async n=>{opened.push(n)},1)
 expect(await seam.request("A real issue","Exact bytes")).toEqual({value:"Requested"})
 expect(await seam.request("A real issue","Exact bytes")).toEqual({value:"Requested"})
 expect(calls).toBe(1);expect(h.settled).toEqual([]);expect(opened).toEqual([])
 launch.resolve(Response.json({operationId:"op",state:"accepted"},{status:202}))
 await waitFor(()=>calls===2);expect(h.store.session().issueCreateRequests?.[0]?.state).toBe("running");expect(h.settled).toEqual([])
 delivery.resolve(Response.json({state:"completed",number:19}))
 await waitFor(()=>h.store.session().issueCreateRequests?.[0]?.state==="completed");expect(opened).toEqual([19])
 h.close();await h.store.dispose?.()
})
test("reload resumes the same operation and ignores stale delivery", async () => {
 const delivery=deferred<Response>();const opened:number[]=[]
 const h=await harness(async (_url,init)=>init?.method?Response.json({operationId:"op",state:"accepted"},{status:202}):delivery.promise)
 await createIssueCreateSeam(h.ctx,async n=>{opened.push(n)},1).request("Reload","Exact bytes")
 await waitFor(()=>h.store.session().issueCreateRequests?.[0]?.state==="running")
 h.close();await h.store.dispose?.()
 let launches=0
 const recovered=await harness(async (_url,init)=>{if(init?.method)launches++;return Response.json({state:"completed",number:20})},h.storage)
 createIssueCreateSeam(recovered.ctx,async n=>{opened.push(n)},1)
 await waitFor(()=>recovered.store.session().issueCreateRequests?.[0]?.state==="completed")
 expect(launches).toBe(0);expect(opened).toEqual([20])
 delivery.resolve(Response.json({state:"completed",number:18}));await new Promise(resolve=>setTimeout(resolve,10));expect(opened).toEqual([20])
 recovered.close();await recovered.store.dispose?.()
})
test("launch failure retries the persisted intent and agent calls cannot launch", async () => {
 let calls=0;const keys:string[]=[]
 const h=await harness(async (_url,init)=>{calls++;if(init?.method){keys.push(new Headers(init.headers).get("Idempotency-Key")!);return calls===1?Response.json({message:"Unavailable"},{status:503}):Response.json({operationId:"op",state:"accepted"},{status:202})}return Response.json({state:"uncertain"})})
 const seam=createIssueCreateSeam(h.ctx,async ()=>{throw Error("No success")},1)
 await seam.request("Retry","Exact bytes");await waitFor(()=>h.store.session().issueCreateRequests?.[0]?.state==="failed")
 await seam.request("Retry","Exact bytes");await waitFor(()=>h.store.session().issueCreateRequests?.[0]?.terminal===true)
 expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(h.settled).toContain("Issue failed")
 const terminalCalls=calls;expect(await seam.request("Retry","Exact bytes")).toBe("Issue failed");expect(calls).toBe(terminalCalls)
 const agent=createIssueCreateSeam({...h.ctx,actor:()=>"smithers"},async ()=>{},1)
 const before=calls;expect(await agent.request("Bypass","Exact bytes")).toBe("Sign in");expect(calls).toBe(before)
 h.close();await h.store.dispose?.()
})
