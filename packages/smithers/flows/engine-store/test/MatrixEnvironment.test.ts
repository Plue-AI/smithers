/** The canonical matrix keeps its existing inputs and declares an optional real PostgreSQL connection. */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("../../../../../", import.meta.url))
const probe = `
import assert from "node:assert/strict"
import * as Target from "@smthrs/targets/Target"
import * as Exec from "@smthrs/targets/Exec"
import { Smithers } from "@smthrs/targets"
import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
import { plannedCalls } from "@smthrs/targets/test-support/plan"
import { suppliedEnv } from "./scripts/check-test-pins.mjs"
import { Package } from "./packages/smithers/flows/engine-store/PACKAGE.ts"
const old = BuildAndCheckTypeScriptPackage({
  testProgram: Smithers.file("//packages/smithers/flows/database/scripts/test-matrix.mjs"),
  deps: [], cwd: "packages/smithers/flows/engine-store"
})
const actual = Target.metadata(Package.test)
const previous = Target.metadata(old.test)
assert.deepEqual({ ...actual.attrs, env: {}, deps: [] }, { ...previous.attrs, deps: [] })
assert.deepEqual(actual.attrs.deps, [Package.lib])
assert.deepEqual(actual.dependencies, [Package.lib])
assert.equal(actual.cacheable, false)
assert.deepEqual(actual.kinds, previous.kinds)
assert.deepEqual(actual.workspaceAttrs, previous.workspaceAttrs)
assert.equal(suppliedEnv("packages/smithers/flows/engine-store").has("SMITHERS_TEST_PG_URL"), true)
// The package executor supplies the workspace runtime before lowering the body.
const resolved = Smithers.NodeTest({ ...actual.attrs, runtime: Smithers.Runtime.Node({ version: ">=26.4.0" }) })
const [call] = plannedCalls(resolved)
assert.equal(call.action, "smithers-build/exec")
const environment = Exec.toolEnvironment(call.payload.env, [])
assert.equal(environment.SMITHERS_TEST_PG_URL, process.env.SMITHERS_TEST_PG_URL)
assert.equal(environment.MATRIX_UNRELATED_CREDENTIAL, undefined)
for (const name of ["PGPASSWORD", "PGPASSFILE", "PGSERVICE", "PGSERVICEFILE"]) assert.equal(environment[name], undefined)
assert.deepEqual(Object.keys(call.payload.env), process.env.SMITHERS_TEST_PG_URL === undefined ? [] : ["SMITHERS_TEST_PG_URL"])
console.log("matrix environment qualified")
`

const check = (url?: string) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      MATRIX_UNRELATED_CREDENTIAL: "private-fixture-marker",
      PGPASSWORD: "private-fixture-marker",
      PGPASSFILE: "private-fixture-marker",
      PGSERVICE: "private-fixture-marker",
      PGSERVICEFILE: "private-fixture-marker",
      ...(url === undefined ? {} : { SMITHERS_TEST_PG_URL: url })
    }
  })

describe("canonical PostgreSQL matrix configuration", () => {
  it("keeps the stock disposable-server declaration when no external URL is supplied", () => {
    const result = check()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("matrix environment qualified\n")
  })

  it.each([
    "postgres://matrix-owner@127.0.0.1:55491/postgres",
    "postgres://matrix-owner@127.0.0.1:55491/postgres?sslmode=disable",
    "postgresql://matrix-owner@localhost:55492/another?connect_timeout=2&sslmode=require"
  ])("declares a credential-free connection while preserving every existing test input: %s", (url) => {
    const result = check(url)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("matrix environment qualified\n")
  })

  it.each([
    "",
    "postgres:///postgres",
    " postgres://owner@localhost/postgres",
    "postgres://owner@localhost/postgres\n",
    "unparseable-private-fixture-marker",
    "https://localhost/private-fixture-marker",
    "postgres://owner:private-fixture-marker@localhost/postgres",
    "postgres://owner@localhost/postgres?password=private-fixture-marker",
    "postgres://owner@localhost/postgres?passfile=private-fixture-marker",
    "postgres://owner@localhost/postgres?servicefile=private-fixture-marker",
    "postgres://owner@localhost/postgres?options=private-fixture-marker",
    "postgres://owner@localhost/postgres?sslmode=private-fixture-marker",
    "postgres://owner@localhost/postgres?connect_timeout=private-fixture-marker",
    "postgres://owner@localhost/postgres?connect_timeout=0",
    "postgres://owner@localhost/postgres?connect_timeout=100",
    "postgres://owner@localhost/postgres?sslmode=disable&sslmode=require",
    "postgres://owner@localhost/postgres#private-fixture-marker"
  ])("refuses malformed, credential-bearing or unsupported configuration without echoing it (case %#)", (url) => {
    const result = check(url)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("SMITHERS_TEST_PG_URL requires a credential-free PostgreSQL URL")
    expect(result.stderr).not.toContain("private-fixture-marker")
  })
})
