import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createAppController } from "../../../src/mainview/state/AppController"
import { createAppStore } from "../../../src/mainview/state/AppStore"
import { memoryStorage, silentAgent } from "../../../src/mainview/state/TestFixtures"

// A live host-issued credential is injected only into this test process.
const origin = process.env.SMITHERS_API_ORIGIN!
const token = process.env.SMITHERS_TOKEN!
const user = await fetch(new URL("/api/user", origin), { headers: { Authorization: `Bearer ${token}` } })
assert.equal(user.status, 200)
const identity = await user.json()
assert.equal(identity.username, "ben")
assert.equal(identity.credential_kind, "delegated")
assert.equal(identity.via, "smithers")
let effects = 0
const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
const controller = createAppController(store, silentAgent, {
  debugApiOrigin: origin, debugApiGates: () => ({ catalog: true, authorizer: true, view: true }),
  fetchImpl: (url, init) => { effects++; return fetch(url, init) }
})
try {
  for (const args of ["get_api_todos", '{"intent":"send","operationId":"get_api_todos"}']) {
    const result = await controller.commands.runForAgent("debug.api", args)
    assert.equal(result.status, "failed")
    assert.ok(result.status === "failed" && result.error.includes("raw API bypasses flow typing and approvals; agents use flows"))
  }
  assert.equal(store.collections.cards.has("debug-api"), false)
  assert.equal(effects, 0)
  for (const args of [[], ["--operationId", "get_api_todos"], ["--intent", "send"]]) {
    const script = `const { makeCli } = await import(process.env.DEBUG_API_CLI);
let stdout = "", code = 0, effects = 0;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => { effects++; return nativeFetch(input, init) };
await makeCli({ environment: process.env, exit: n => { code = n } }).serve(JSON.parse(process.env.DEBUG_API_ARGV), {
  env: process.env, stdout: text => { stdout += text }, exit: n => { code = n }
});
console.log(JSON.stringify({ code, effects, result: JSON.parse(stdout) }));`
    const output = await promisify(execFile)("node", ["--no-warnings", "--input-type=module", "--eval", script], {
      env: { ...process.env, DEBUG_API_CLI: new URL("../../../../../packages/smithers/src/Cli.ts", import.meta.url).href,
        DEBUG_API_ARGV: JSON.stringify(["debug", "api", ...args, "--json"]) }
    })
    const receipt = JSON.parse(output.stdout)
    assert.equal(receipt.code, 1)
    assert.equal(receipt.result.class, "never")
    assert.equal(receipt.result.code, "never")
    assert.equal(receipt.effects, 0)
    assert.ok(!output.stdout.includes(token))
  }
  console.log("C-UI-10 AUTHENTICATED DELEGATED DISPATCH PASS")
} finally { await controller.dispose() }
