import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"
import { SCOPED_TEST_USER } from "../identity"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// Browser projection through the production terminal seam. The isolated Go
// fixture executes for real; bundle/UID and publication proofs run separately.
test("C-PRC-02: DB-free migration failures remain visible in terminal output", async ({ page }) => {
  const fixture = mkdtempSync(join(tmpdir(), "prc02-browser-"))
  try {
    const product = join(fixture, "packages/backend/db/product")
    mkdirSync(join(product, "migrations"), { recursive: true })
    writeFileSync(join(fixture, "go.mod"), "module fixture\n\ngo 1.26.8\n")
    writeFileSync(join(product, "migrate.go"), `package product
import("embed";"io/fs")
//go:embed migrations/*.sql
var migrations embed.FS
const BaselineVersion=1
type migrationSpec struct{version int;path string}
var migrationRegistry=[]migrationSpec{{1,"migrations/0001_things.sql"}}
func registeredMigrations()([]fs.DirEntry,error){return migrations.ReadDir("migrations")}
`)
    writeFileSync(join(product, "migrations/0001_things.sql"), "CREATE TABLE things(id int); CREATE TABLE IF NOT EXISTS things(id int);\n")
    writeFileSync(join(fixture, "packages/backend/db/ownership.csv"), "table,target_owner,status\nthings,product,installed\n")
    copyFileSync(resolve(__dirname, "../../../../../packages/backend/db/product/migration_registry_test.go"), join(product, "migration_registry_test.go"))
    const command = "go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/"
    const env: NodeJS.ProcessEnv = { ...process.env, GOTOOLCHAIN: "local", HOME: fixture }
    for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY/.test(key) || ["DATABASE_URL", "SMITHERS_TEST_DATABASE_URL", "PGPASSFILE", "PGSERVICE", "PGSERVICEFILE"].includes(key)) delete env[key]
    const run = spawnSync("go", ["test", "-run", "TestMigrationGate|TestMigrationRegistry", "./packages/backend/db/product/"], { cwd: fixture, env, encoding: "utf8", timeout: 30_000 })
    expect(run.error).toBeUndefined()
    expect(run.status).not.toBe(0)
    const output = run.stdout + run.stderr
    expect(output).toContain("duplicate CREATE")
    expect(output).toContain("FAIL")

    await installCloudFixture(page, { capabilities: ["identity", "install"] })
    const branch = "retry-webhooks", id = "prc02-branch", terminalId = "prc02-terminal"
    await page.route("**/api/branches", route => route.fulfill({ json: [{ id, name: branch }] }))
    await page.route(`**/api/branches/${branch}`, route => route.fulfill({ json: { name: branch, machine: { id } } }))
    await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
      if (typeof raw !== "string") return
      const frame = JSON.parse(raw)
      if (frame.t !== "sub") return
      const data = frame.topic === `branch:${id}` || frame.topic === `branch:${branch}` ? {
        id, name: branch, head: "1111111111111111111111111111111111111111", machine: { state: "awake" }, presence: [],
        terminals: [{ id: terminalId, title: "Shell", owner: { kind: "person", login: SCOPED_TEST_USER.login, name: "Ben", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 0 }, agents: [], watchers: [], frozen: false }], ssh_line: "ssh fixture"
      } : undefined
      socket.send(JSON.stringify(data === undefined ? { t: "err", id: frame.id, code: "unsupported" } : { t: "snap", id: frame.id, cursor: 1, data }))
    }))
    await page.route("**/api/auth/sse-ticket", route => route.fulfill({ json: { ticket: "prc02-ticket", expires_at: new Date(Date.now() + 60_000).toISOString() } }))
    let typed = ""
    await page.routeWebSocket(/\/workspace\/sessions\/prc02-terminal\/terminal/, socket => {
      socket.onMessage(raw => {
        if (typeof raw === "string") return // resize control frames
        typed += new TextDecoder().decode(raw)
        if (typed.includes("\r")) socket.send(Buffer.from(output.replaceAll("\n", "\r\n")))
      })
      socket.send(Buffer.from("$ "))
    })
    await page.goto("/")
    await say(page, `/branch ${branch}`)
    const branchCard = page.getByTestId(`card-branch:${id}`)
    await expect(branchCard).toBeVisible()
    await branchCard.getByRole("tab", { name: /^Terminals/ }).press("Enter")
    await branchCard.getByRole("button", { name: "Shell", exact: true }).press("Enter")
    const terminal = page.getByTestId(`card-terminal:${terminalId}`)
    await expect(terminal).toBeVisible()
    await terminal.locator("textarea").focus()
    await page.keyboard.type(command)
    await page.keyboard.press("Enter")
    await expect.poll(() => typed).toBe(command + "\r")
    await expect(terminal).toContainText("duplicate CREATE")
    await expect(terminal).toContainText("FAIL")
    await expect(page.getByTestId("composer-input")).toBeEnabled()
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
