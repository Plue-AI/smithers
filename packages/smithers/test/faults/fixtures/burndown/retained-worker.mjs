import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const [root, directory, key] = process.argv.slice(2)
const record = (event) => appendFileSync(join(root, "workers.jsonl"), JSON.stringify({ event, pid: process.pid, key, at: Date.now() }) + "\n")
writeFileSync(join(directory, "pid"), String(process.pid))
record("start")
writeFileSync(join(directory, "work"), "preserved-work")
record("progress")
const timer = setInterval(() => {
  if (!existsSync(join(root, "release"))) return
  clearInterval(timer)
  record("done")
  writeFileSync(join(directory, "exit"), "0")
}, 50)
