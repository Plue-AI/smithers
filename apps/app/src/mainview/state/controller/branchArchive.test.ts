import { expect, test } from "bun:test"
import { createBranchArchive } from "./branchArchive"
import type { ControllerContext } from "./context"
import type { Session } from "../AppState"
import { waitFor } from "../TestFixtures"

type Requests = NonNullable<Session["branchArchiveRequests"]>
const fixture = (initial: Requests = [], persist:()=>Promise<void> = ()=>Promise.resolve()) => {
  let requests = initial
  let owner = "member"
  const receipts: unknown[] = []
  const ctx = { disposed: false, accountEpoch: 0, accountOwner: () => owner,
    store: { session: () => ({ branchArchiveRequests: requests }), dispatch: (t: {requests:Requests}) => {requests=t.requests;return {isPersisted:{promise:persist()}}} },
    withToast: async (_key:string,_title:string,_done:string,work:()=>Promise<unknown>) => {const value=await work();receipts.push(value);return value}
  } as unknown as ControllerContext
  return { ctx, receipts, requests:()=>requests, owner:(next:string)=>{owner=next} }
}

test("Archive failure is durable and retry uses a new request; reload replays the same pending identity", async () => {
  const f=fixture([{id:"pending",owner:"member",branch:"scratch",state:"requested"}])
  const calls:string[]=[]
  const archive=createBranchArchive(f.ctx,async(_branch,id)=>{calls.push(id);return "Broker unavailable"})
  archive.resume()
  await waitFor(()=>f.receipts.length===1)
  expect(calls).toEqual(["pending"])
  expect(f.requests()[0]).toMatchObject({state:"failed",error:"Broker unavailable"})
  expect(await archive.request("scratch")).toEqual({value:"Archive requested"})
  await waitFor(()=>f.receipts.length===2)
  expect(calls).toHaveLength(2)
  expect(calls[1]).not.toBe("pending")
})

test("A stale archive response after account change cannot settle the new account's request", async () => {
  const f=fixture()
  let resolve!:(result:true)=>void
  const archive=createBranchArchive(f.ctx,async()=>new Promise<true>(r=>{resolve=r}))
  await archive.request("scratch")
  f.owner("other")
  resolve(true)
  await waitFor(()=>f.receipts.length===1)
  expect(f.requests()[0].state).toBe("requested")
})

test("Archive waits for persistence and refuses network work after a failed durable admission", async () => {
  let reject!:(error:Error)=>void;let calls=0
  const f=fixture([],()=>new Promise<void>((_resolve,r)=>{reject=r}))
  const archive=createBranchArchive(f.ctx,async()=>{calls++;return true})
  const requested=archive.request("scratch")
  const duplicate=archive.request("scratch")
  archive.resume()
  expect(calls).toBe(0)
  reject(new Error("disk unavailable"))
  expect(await requested).toBe("Archive request could not be saved")
  expect(await duplicate).toBe("Archive request could not be saved")
  archive.resume()
  expect(calls).toBe(0)
})
