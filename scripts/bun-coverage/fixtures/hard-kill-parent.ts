import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./hard-kill-child.ts", import.meta.url))], {
  stdout: "pipe", stderr: "pipe"
})
let timer: ReturnType<typeof setTimeout> | undefined
try {
  const reader = child.stdout.getReader()
  const ready = await Promise.race([
    reader.read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Hard-kill child readiness deadline")), 3_000)
    })
  ])
  assert.equal(new TextDecoder().decode(ready.value).trim(), "ready")
  reader.releaseLock()
  child.kill("SIGKILL")
  assert.equal(await child.exited, 137)
  assert.equal(child.signalCode, "SIGKILL")
  console.log("actual-bun-exit:137:SIGKILL")
} finally { clearTimeout(timer); child.kill("SIGKILL") }
