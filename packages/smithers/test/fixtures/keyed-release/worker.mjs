import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [root, directory, key] = process.argv.slice(2)
const record = (event) =>
  appendFileSync(join(root, "workers.jsonl"), JSON.stringify({ event, pid: process.pid, key }) + "\n")
writeFileSync(join(directory, "pid"), String(process.pid))
writeFileSync(join(directory, "work"), "preserved-work")
record("start")
const timer = setInterval(() => {
  if (!existsSync(join(root, "release"))) return
  clearInterval(timer)
  record("done")
  writeFileSync(join(directory, "exit"), "0")
}, 20)
