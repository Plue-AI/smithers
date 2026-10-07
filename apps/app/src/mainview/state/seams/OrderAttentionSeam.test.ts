import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage, waitFor } from "../TestFixtures"
import { createOrderAttentionSeam } from "./OrderAttentionSeam"
import type { SeamContext } from "./SeamContext"
const boot = async (http: SeamContext["http"], storage = memoryStorage()) => {
 const store = await createAppStore({ kind: "localStorage", storage })
 await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
 const ctx: SeamContext = { http, store, dispatch: store.dispatch, baseUrl: "https://install.test/", actor: () => "user", nextOrdinal: store.nextOrdinal }
 return {store,storage,ctx,seam:createOrderAttentionSeam(ctx),row:()=>store.session().orderRequests?.[0]}
}
test("OK persists and acknowledges before an unresolved HTTP response; duplicate presses send once",async()=>{
 let resolve!:(response:Response)=>void
 const calls:unknown[]=[]
 const h=await boot(async(url,init)=>{calls.push({url,body:init?.body});return new Promise<Response>(done=>{resolve=done})})
 expect(await Promise.all([h.seam.orderOK("order/one",2),h.seam.orderOK("order/one",2)])).toEqual([{value:"Requested"},{value:"Requested"}])
 expect(calls).toEqual([{url:"https://install.test/api/stack/attention/order%2Fone",body:'{"revision":2}'}])
 expect(h.row()).toMatchObject({state:"requested",revision:2})
 resolve(new Response(null,{status:204}));await waitFor(()=>h.row()?.state==="completed")
})
test("reload retries the recorded revision; refusal is durable and a newer press can retry",async()=>{
 const h=await boot(async()=>new Promise<Response>(()=>{}));await h.seam.orderOK("order-one",2)
 const reopened=await boot(async()=>new Response(JSON.stringify({message:"Stack attention changed",class:"conflict",code:"stale_attention"}),{status:409}),h.storage)
 reopened.seam.resumeOrderRequests();await waitFor(()=>reopened.row()?.state==="failed")
 expect(reopened.row()).toMatchObject({revision:2,error:"Stack attention changed"})
 const retry=createOrderAttentionSeam({...reopened.ctx,http:async()=>new Response(null,{status:204})})
 expect(await retry.orderOK("order-one",3)).toEqual({value:"Requested"});await waitFor(()=>reopened.row()?.state==="completed")
 expect(reopened.row()?.revision).toBe(3)
})
test("an earlier response cannot settle a newer displayed revision",async()=>{
 const responses:Array<(response:Response)=>void>=[]
 const h=await boot(async()=>new Promise<Response>(done=>responses.push(done)))
 await h.seam.orderOK("one",1);await h.seam.orderOK("one",2)
 responses[0]!(new Response(null,{status:204}));await new Promise(done=>setTimeout(done,10))
 expect(h.row()).toMatchObject({revision:2,state:"requested"})
 responses[1]!(new Response(null,{status:204}));await waitFor(()=>h.row()?.state==="completed")
})
