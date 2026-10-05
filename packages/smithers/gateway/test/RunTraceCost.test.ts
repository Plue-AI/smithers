import { describe, expect, test } from "vitest"
import { type JournalRecord, stepCosts, traceFromJournal, traceFold, traceFoldStep, traceFoldModel } from "../src/RunTrace.ts"
const run = {runId:"run",flowId:"todo",status:"completed"}
const a="a".repeat(64), b="b".repeat(64)
const event=(sequence:number,stepId:string,costUsd?:number):JournalRecord=>({runId:"run",sequence,kind:"control.agent.model-settled",payload:{at:sequence,usage:{inputTokens:10,outputTokens:20},costUsd,step:{executionId:"exec",stepId,action:"coding",attempt:1,ask:0,retry:1,scope:stepId}}})
describe("recorded step costs",()=>{
 test("two calls in one step and one in another sum to the literal metered total",()=>{
  const records=[event(1,a,0.00011),event(2,a,0.00011),event(3,b,0.00011)]
  const model=traceFromJournal(run,[...records,records[1]!,{...event(4,a,100),runId:"foreign"}].reverse())
  expect(stepCosts(model)).toEqual([{executionId:"exec",stepId:b,calls:1,costUsd:0.00011},{executionId:"exec",stepId:a,calls:2,costUsd:0.00022}].sort((x,y)=>x.stepId.localeCompare(y.stepId)))
  expect(stepCosts(model).reduce((n,v)=>n+Math.round(v.costUsd!*1e9),0)).toBe(330000)
 })
 test.each([undefined,-1,Infinity,NaN,Number.MAX_VALUE])("an unknown or invalid cost %s never becomes zero",cost=>{
  const model=traceFromJournal(run,[event(1,a,0.00011),event(2,a,cost),event(3,b,0)])
  expect(stepCosts(model)).toEqual([{executionId:"exec",stepId:a,calls:2},{executionId:"exec",stepId:b,calls:1,costUsd:0}])
 })
 test("retry and cancellation retain completed call costs",()=>{
  const second=event(2,a,0.00011)
  const p=second.payload as any;p.step.attempt=2;p.step.retry=2;p.step.scope="retry"
  const model=traceFromJournal({...run,status:"cancelled"},[event(1,a,0.00011),second])
  expect(stepCosts(model)).toEqual([{executionId:"exec",stepId:a,calls:2,costUsd:0.00022}])
 })
 test("permutations and duplicate delivery equal the incremental fold",()=>{
  for(let seed=1;seed<=40;seed++){
   const records=Array.from({length:20},(_,i)=>event(i+1,i%2?a:b,(i+seed)/1e9))
   const fold=traceFold(run)
   for(const record of records)traceFoldStep(fold,record)
   const expected=stepCosts(traceFoldModel(fold,"completed"))
   const shuffled=[...records,...records.slice(0,5)].sort((x,y)=>(((x.sequence!*seed)%23)-((y.sequence!*seed)%23)))
   expect(stepCosts(traceFromJournal(run,shuffled))).toEqual(expected)
  }
 })
})


test("native checkpoint replay copies charge one settled model call",()=>{
 const step={executionId:"exec",stepId:a,action:"coding",attempt:1,ask:0,retry:1,scope:"ask"}
 const native:JournalRecord={runId:"run",sequence:1,kind:"control.engine.event",payload:{version:1,executionId:"exec",generation:1,sequence:1,emittedAtMs:100,sourceId:`step-fact-v1:${a}:1:0:1`,sourceSequence:123,eventType:"flows.harness.step-fact.v1",payload:{version:1,step,generation:0,frame:0,ordinal:0,cell:"",at:100,eventType:"control.agent.model-settled",sourceSequence:123,payload:{text:"ok",usage:{inputTokens:10,outputTokens:20},costUsd:0.00011}}}}
 expect(stepCosts(traceFromJournal(run,[native,{...native,sequence:2}]))).toEqual([{executionId:"exec",stepId:a,calls:1,costUsd:0.00011}])
})


test("identical step IDs in distinct executions keep separate totals",()=>{
 const other=event(2,a,0.00011); (other.payload as any).step.executionId="other"
 expect(stepCosts(traceFromJournal(run,[event(1,a,0.00011),other]))).toEqual([{executionId:"exec",stepId:a,calls:1,costUsd:0.00011},{executionId:"other",stepId:a,calls:1,costUsd:0.00011}])
})
test("aggregate overflow and unscoped historical calls invent no priced step",()=>{
 const max=Number.MAX_SAFE_INTEGER/1e9
 const historical:JournalRecord={runId:"run",sequence:3,kind:"control.agent.model-settled",payload:{at:3,costUsd:1}}
 expect(stepCosts(traceFromJournal(run,[event(1,a,max),event(2,a,max),historical]))).toEqual([{executionId:"exec",stepId:a,calls:2}])
})
