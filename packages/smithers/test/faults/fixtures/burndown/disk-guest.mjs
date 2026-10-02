// External test infrastructure, measured before use; this is not the authored flow closure.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const execute = async (root, operation) => {
  const config = JSON.parse(readFileSync(`${root}/disk.json`, "utf8"))
  process.env.ISSUE_SWEEP_MSB = config.binary
  process.env.MSB_LIBKRUNFW_PATH = config.library
  process.env.MSB_PATH = config.wrapper
  const sdk = await import(pathToFileURL(config.sdkEntry).href)
  sdk.setDefaultBackend("local")
  if (operation === "destroy") {
    const owned = async () => {
      const machines = []
      let cursor
      do {
        const page = await sdk.Sandbox.listWith((builder) => {
          const scoped = builder.label("smithers.provider", "microsandbox").label("smithers.owner", config.owner)
          return cursor === undefined ? scoped : scoped.cursor(cursor)
        })
        machines.push(...page.sandboxes.filter((machine) => machine.status !== "deleted"))
        cursor = page.nextCursor
      } while (cursor !== undefined)
      return machines
    }
    for (const machine of await owned()) await machine.destroy({ force: true, timeoutMs: 10_000 })
    const remaining = (await owned()).map((machine) => machine.name)
    assert.deepEqual(remaining, [])
    return { owner: config.owner, remaining }
  }
  // Detached SDK ownership lets the bounded guest survive individual statfs helper processes.
  // The explicit finally destroys only this owner; maxDuration also bounds parent-crash lifetime.
  const machine = operation === "create"
    ? await sdk.Sandbox.builder(config.owner).image("node:26-trixie").pullPolicy("never")
      .cpus(1).memory(512).maxDuration(120).idleTimeout(60).disableNetwork()
      .labels({ "smithers.provider": "microsandbox", "smithers.owner": config.owner })
      .ephemeral(false).detached(true).create()
    : await (await sdk.Sandbox.get(config.owner)).connect()
  const script = `
    import assert from 'node:assert/strict';
    import { mkdirSync, statfsSync, writeFileSync, unlinkSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    const path = ${JSON.stringify(config.path)}, operation = ${JSON.stringify(operation)};
    const measured = () => { const fs = statfsSync(path); return {type:fs.type,bsize:fs.bsize,blocks:fs.blocks,bavail:fs.bavail,bytes:fs.bavail*fs.bsize,capacity:fs.blocks*fs.bsize}; };
    if (operation === 'create') {
      mkdirSync(path);
      execFileSync('mount',['-t','tmpfs','-o','size=32m','tmpfs',path]);
      const before = measured(); assert.equal(before.type,0x01021994); assert.equal(before.capacity,32*1024**2);
      for (const name of ['cleanGo','prunePnpm','reapSettled']) writeFileSync(path+'/'+name,Buffer.alloc(65536,1));
      writeFileSync(path+'/pressure',Buffer.alloc(measured().bytes-4*1024**2,1));
    } else if (['cleanGo','prunePnpm','reapSettled'].includes(operation)) unlinkSync(path+'/'+operation);
    else if (operation === 'release') unlinkSync(path+'/pressure');
    else if (operation === 'unmount') { execFileSync('umount',[path]); console.log(JSON.stringify({mounted:false})); process.exit(0); }
    else assert.equal(operation,'probe');
    const result = measured(); assert.equal(result.type,0x01021994); assert.equal(result.capacity,32*1024**2);
    console.log(JSON.stringify(result));
  `
  const handle = await machine.execStreamWith(
    "node",
    (builder) => builder.args(["--input-type=module"]).stdinBytes(new TextEncoder().encode(script))
  )
  const timeout = setTimeout(() => {
    void handle.kill()
  }, 5_000)
  let output
  try {
    output = await handle.collect()
  } finally {
    clearTimeout(timeout)
  }
  assert.equal(output.code, 0, output.stderr())
  return JSON.parse(output.stdout())
}
if (process.argv[2] === "__disk_guest") {
  const root = process.argv[3], operation = process.argv[4]
  assert(root && operation)
  console.log(JSON.stringify(await execute(root, operation)))
}
