#!/usr/bin/env node
// Compose fixtures change process-wide environment and function seams, and
// TestMain owns a database shared by older tests. Run files in separate
// processes rather than allowing t.Parallel to race those settings (#3775).
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const pattern = names => `^(${names.join("|")})$`

// The compiled binary is authoritative: include examples and fuzz seeds too,
// and refuse an unmapped name instead of silently dropping a new test.
export function filesForTests(directory, names) {
  const owners = new Map()
  const files = readdirSync(directory).filter(name => name.endsWith("_test.go")).sort()
  for (const file of files) {
    const source = readFileSync(join(directory, file), "utf8")
    for (const match of source.matchAll(/^func ((?:Test|Example|Fuzz)\w*)\(/gm)) owners.set(match[1], file)
  }
  const groups = new Map()
  for (const name of names) {
    const file = owners.get(name)
    if (!file) throw new Error(`compiled test has no source file: ${name}`)
    const group = groups.get(file) ?? { file, names: [], weight: readFileSync(join(directory, file)).length }
    group.names.push(name)
    groups.set(file, group)
  }
  // Long files tend to carry long campaigns. Start them first; workers take
  // their next file as soon as they finish, balancing actual running time.
  return [...groups.values()].sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file))
}

export async function runFiles(groups, { binary, cwd, workers = 4, timeout = "40m", env = process.env, report = console.log }) {
  if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error("compose workers must be 1..4")
  const scratch = mkdtempSync(join(tmpdir(), "compose-shards-"))
  let next = 0
  const results = []
  try {
    await Promise.all(Array.from({ length: workers }, async (_, worker) => {
      while (next < groups.length) {
        const group = groups[next++]
        const work = mkdtempSync(join(scratch, `worker-${worker}-`))
        const started = Date.now()
        const outcome = await new Promise(resolve => {
          const child = spawn(binary, ["-test.count=1", `-test.timeout=${timeout}`, `-test.run=${pattern(group.names)}`, "-test.paniconexit0"], {
            cwd, env: { ...env, TMPDIR: work, SMITHERS_SSH_ADDR: "127.0.0.1:0", SMITHERS_SSH_HOST_KEY_DIR: join(work, "ssh") },
            stdio: ["ignore", "pipe", "pipe"]
          })
          let output = ""
          child.stdout.on("data", chunk => { output += chunk })
          child.stderr.on("data", chunk => { output += chunk })
          child.on("error", error => resolve({ code: 1, output: String(error) }))
          child.on("close", (code, signal) => resolve({ code: code ?? 1, signal, output }))
        })
        results.push({ file: group.file, ...outcome })
        report(`${outcome.code === 0 ? "ok" : "FAIL"}\tcompose/${group.file}\t${((Date.now() - started) / 1000).toFixed(2)}s\t${group.names.length} tests`)
        // Preserve skips and detailed failure evidence without interleaving
        // the hundreds of migration log lines emitted by successful files.
        if (outcome.code !== 0) report(outcome.output)
        rmSync(work, { recursive: true, force: true })
      }
    }))
    return results
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..")
  const cwd = join(root, "packages/backend/internal/compose")
  const scratch = mkdtempSync(join(tmpdir(), "compose-binary-"))
  try {
    const binary = join(scratch, "compose.test")
    const build = spawnSync("go", ["test", "-p", "4", "-c", "-o", binary, "./packages/backend/internal/compose"], { cwd: root, stdio: "inherit" })
    if (build.status !== 0) return build.status ?? 1
    const listed = spawnSync(binary, ["-test.list=."], { cwd, encoding: "utf8" })
    if (listed.status !== 0) { process.stderr.write(listed.stderr + listed.stdout); return listed.status ?? 1 }
    let names = listed.stdout.split(/\r?\n/).filter(name => /^(Test|Example|Fuzz)\w*$/.test(name))
    const selection = process.argv.indexOf("--run")
    if (selection !== -1) names = names.filter(name => new RegExp(process.argv[selection + 1]).test(name))
    if (names.length === 0) throw new Error("no compiled compose tests selected")
    const groups = filesForTests(cwd, names)
    console.log(`compose: ${names.length} top-level tests in ${groups.length} files; 4 isolated workers`)
    const results = await runFiles(groups, { binary, cwd })
    const failed = results.filter(result => result.code !== 0).length
    console.log(`compose: ${results.length - failed} files passed, ${failed} files failed`)
    return failed === 0 ? 0 : 1
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main()
