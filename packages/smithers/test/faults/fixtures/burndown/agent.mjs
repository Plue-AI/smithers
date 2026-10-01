import { appendFileSync, closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const [root, index, seconds, count] = process.argv.slice(2)
const record = (event, extra = {}) =>
  appendFileSync(
    join(root, "processes.jsonl"),
    JSON.stringify({ event, index, pid: process.pid, at: Date.now(), ...extra }) + "\n"
  )
process.on("exit", (code) => record("exit", { code }))
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    record("cancel", { signal })
    process.exit(143)
  })
}
record("start")
if (index.startsWith("land-")) {
  // Multiple real landing processes must never overlap or precede any work.
  const lock = join(root, "landing.lock")
  const fd = openSync(lock, "wx")
  try {
    record("lock")
    for (let child = 1; child <= Number(count); child++) {
      if (readFileSync(join(root, `change-${child}`), "utf8") !== `work-${child}`) throw Error("lost work")
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    appendFileSync(join(root, "landed"), index.slice(5) + "\n")
  } finally {
    closeSync(fd)
    unlinkSync(lock)
    record("unlock")
  }
} else {
  writeFileSync(join(root, `change-${index}`), `work-${index}`)
  record("progress")
  await new Promise((resolve) => setTimeout(resolve, Number(seconds) * 1000))
  record("work-done")
}
record("done")
console.log(index)
