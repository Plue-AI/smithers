import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { operations } from "../wiki/operations.ts"

const platform = process.versions.bun ? (await import("@effect/platform-bun/BunServices")).layer : NodeServices.layer

test("install wiki inventories collect a newly merged export without changing the declaration", { timeout: 120000 }, async (t) => {
 const directory = await mkdtemp(join(tmpdir(), "wiki-install-"))
 const root = join(directory,"repo")
 t.after(() => rm(directory, { recursive: true, force: true }))
 await mkdir(root)
 await mkdir(join(root,"api"))
 await writeFile(join(root,"api/server.ts"),"export function startServer() {}\n")
 const spec = {id:"package-api",title:"api",purpose:"Describe the code with source citations",kind:"current" as const,document:"",sourceDirectory:"api",inputs:[],related:[]}
 const ops = operations({root,output:join(directory,"wiki")})
 const collect = () => Effect.runPromise(ops.collect(spec).pipe(Effect.provide(platform)))
 const first = await collect()
 assert.equal(first.markdown,"# api\n\n## api/server.ts\n\n- `export function startServer() {}` [api/server.ts:1](../sources/api/server.ts#L1)\n")
 await writeFile(join(root,"api/health.ts"),"export function healthCheck() {}\n")
 await writeFile(join(root,"api/.env"),"SECRET=never-capture\n")
 const merged = await collect()
 assert.deepEqual(merged.sources.map(source => source.path),["api/health.ts","api/server.ts"])
 assert.equal(merged.markdown,"# api\n\n## api/health.ts\n\n- `export function healthCheck() {}` [api/health.ts:1](../sources/api/health.ts#L1)\n\n## api/server.ts\n\n- `export function startServer() {}` [api/server.ts:1](../sources/api/server.ts#L1)\n")
 assert.notEqual(merged.inputDigest,first.inputDigest)

 const reviewed = { evidence: merged, reviewer: "fixture-reviewer", review: { sections: [
  {id:"section-1",verdict:"supported" as const,explanation:"The package exports these functions",citations:[{path:"api/server.ts",line:1,quote:"export function startServer() {}"}]},
  {id:"section-2",verdict:"supported" as const,explanation:"The health function is exported",citations:[{path:"api/health.ts",line:1,quote:"export function healthCheck() {}"}]},
  {id:"section-3",verdict:"supported" as const,explanation:"The server function is exported",citations:[{path:"api/server.ts",line:1,quote:"export function startServer() {}"}]}
 ]} }
 await Effect.runPromise(ops.write([reviewed],"verified").pipe(Effect.provide(platform)))
 assert.deepEqual(await Effect.runPromise(ops.check([spec],true).pipe(Effect.provide(platform))),{pages:1,verification:"verified"})
 await symlink(tmpdir(),join(root,"api/escape"))
 await assert.rejects(collect(),/symlink/)
})
