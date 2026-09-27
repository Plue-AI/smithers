/** Run an owning package's existing suite on SQLite and a real PostgreSQL server. */
import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"

const run = (command, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env, stdio: "inherit" })
  child.on("error", reject)
  child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? signal}`)))
})
const port = () => new Promise((resolve, reject) => {
  const server = createServer()
  server.on("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const value = server.address().port
    server.close((error) => error ? reject(error) : resolve(value))
  })
})
let directory
let started = false
let reports
const bin = process.env.PG_BIN ?? (process.platform === "darwin" ? "/opt/homebrew/opt/postgresql@18/bin" : "")
const pg = (name) => bin ? join(bin, name) : name
try {
  let url = process.env.SMITHERS_TEST_PG_URL
  if (!url) {
    directory = await mkdtemp(join(tmpdir(), "smithers-sql-matrix-"))
    const listeningPort = await port()
    await run(pg("initdb"), ["-D", directory, "-A", "trust", "--encoding=UTF8", "--locale=C"])
    await run(pg("pg_ctl"), ["-D", directory, "-l", join(directory, "server.log"), "-o", `-h 127.0.0.1 -p ${listeningPort}`, "-w", "start"])
    started = true
    url = `postgres://${encodeURIComponent(userInfo().username)}@127.0.0.1:${listeningPort}/postgres?sslmode=disable`
  }
  const { SMITHERS_TEST_PG_URL: ignored, SMITHERS_POSTGRES_URL: ignoredUrl, DATABASE_URL: ignoredDatabase, ...environment } = process.env
  const args = [join(process.cwd(), "node_modules/vitest/vitest.mjs"), "run", ...process.argv.slice(2)]
  const failures = []
  const coverage = !process.argv.includes("--coverage.enabled=false")
  reports = await mkdtemp(join(tmpdir(), "smithers-sql-reports-"))
  const coverageParts = ["lines", "functions", "branches", "statements"]

  for (const backend of ["sqlite", "postgres"]) {
    console.log(`\nStorage matrix: ${backend}\n`)
    try {
      await run(process.execPath, coverage ? [...args,
        "--reporter=default", "--reporter=blob", `--outputFile.blob=${join(reports, "blobs", backend + ".json")}`,
        `--coverage.reportsDirectory=${join(reports, "coverage-" + backend)}`,
        ...coverageParts.map((part) => `--coverage.thresholds.${part}=0`)
      ] : args, {
        ...environment,
        SMITHERS_BACKEND: "sqlite",
        ...(backend === "postgres" ? { SMITHERS_TEST_PG_URL: url } : {})
      })
    } catch (error) { failures.push(error) }
  }
  if (coverage) {
    try {
      await run(process.execPath, [args[0], `--merge-reports=${join(reports, "blobs")}`, "--coverage.enabled=true"], environment)
    } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, "Storage matrix failed")
} finally {
  if (started) spawnSync(pg("pg_ctl"), ["-D", directory, "-m", "immediate", "-w", "stop"], { stdio: "inherit" })
  if (directory) await rm(directory, { recursive: true, force: true })
  if (reports) await rm(reports, { recursive: true, force: true })
}
