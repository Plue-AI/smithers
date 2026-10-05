import { build } from "esbuild"
await build({stdin:{contents:`import {readFileSync} from "node:fs"; import {traceFromJournal,stepCosts} from "./packages/smithers/gateway/src/RunTrace.ts";
const reply=JSON.parse(readFileSync(process.argv[2],"utf8")); const runId=process.argv[3];
if(!reply.ok || !Array.isArray(reply.payload?.rows))throw Error("No journal");
const model=traceFromJournal({runId,flowId:"todo",status:"running"},reply.payload.rows); const steps=stepCosts(model);
if(steps.some(s=>s.costUsd===undefined))throw Error("Unpriced step");
const executionIds=new Set(model.rows.filter(r=>r.kind==="model").map(r=>r.detail.fields?.step?.executionId).filter(Boolean));
if(executionIds.size===0)throw Error("No native execution");
console.log(JSON.stringify({executionIds:[...executionIds],nanos:steps.reduce((n,s)=>n+Math.round(s.costUsd*1e9),0),steps:steps.length,calls:steps.reduce((n,s)=>n+s.calls,0)}));`,resolveDir:process.cwd()},outfile:process.argv[2],bundle:true,platform:"node",format:"esm",external:["effect", "effect/*"]})
