import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import { digestOf, validationErrors } from "../scripts/refresh-failure-codes.mjs"

const sourceScript = fileURLToPath(new URL("../scripts/refresh-failure-codes.mjs", import.meta.url))

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-rpc-failure-codes-")))
  const script = join(root, "packages", "rpc", "scripts", "refresh-failure-codes.mjs")
  const canonical = join(root, "docs", "api", "failure-codes.json")
  const vendored = join(root, "packages", "rpc", "src", "plue-failure-codes.json")
  const generated = join(root, "packages", "rpc", "src", "PlueFailureCodes.ts")
  for (const path of [script, canonical, vendored]) mkdirSync(dirname(path), { recursive: true })
  copyFileSync(sourceScript, script)
  const codes = [{ code: "quota_exceeded", fault: "wait", status: 429, retry_after: 60, doc: "Account cap" }]
  const document = { schema_version: 1, digest: digestOf(codes), faults: ["wait"], codes }
  const text = `${JSON.stringify(document)}\n`
  writeFileSync(canonical, text)
  const run = (...args: ReadonlyArray<string>) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5_000 })
  return { root, canonical, vendored, generated, text, document, run }
}

describe("failure-code refresh CLI", () => {
  test("writes a faithful vendored document and checks both generated artifacts without modifying them", () => {
    const files = fixture()
    try {
      const refresh = files.run()
      expect(refresh.status).toBe(0)
      expect(refresh.stdout).toContain("refresh-failure-codes: wrote")
      expect(readFileSync(files.vendored, "utf8")).toBe(files.text)
      const generated = readFileSync(files.generated, "utf8")
      expect(generated).toContain("\"quota_exceeded\": { fault: \"wait\", status: 429, retryAfter: 60 }")
      expect(generated).toContain(`export const PLUE_FAILURE_DIGEST = "${files.document.digest}"`)

      const check = files.run("--check")
      expect(check.status).toBe(0)
      expect(check.stdout).toContain("fresh against")
      expect(readFileSync(files.vendored, "utf8")).toBe(files.text)
      expect(readFileSync(files.generated, "utf8")).toBe(generated)

      writeFileSync(files.vendored, "stale vendored document")
      const staleJson = files.run("--check")
      expect(staleJson.status).toBe(1)
      expect(staleJson.stderr).toContain("plue-failure-codes.json")
      expect(readFileSync(files.vendored, "utf8")).toBe("stale vendored document")

      writeFileSync(files.vendored, files.text)
      writeFileSync(files.generated, "stale generated types")
      const staleTypes = files.run("--check")
      expect(staleTypes.status).toBe(1)
      expect(staleTypes.stderr).toContain("PlueFailureCodes.ts")
      expect(readFileSync(files.generated, "utf8")).toBe("stale generated types")
    } finally {
      rmSync(files.root, { recursive: true, force: true })
    }
  })

  test("rejects a forged digest before writing and can import a valid local document", () => {
    const files = fixture()
    try {
      const external = join(files.root, "external.json")
      writeFileSync(external, files.text)
      writeFileSync(files.canonical, "old canonical document")
      const imported = files.run("--from", external)
      expect(imported.status).toBe(0)
      expect(imported.stdout).toContain("refresh-failure-codes: wrote")
      expect(readFileSync(files.canonical, "utf8")).toBe(files.text)
      expect(readFileSync(files.vendored, "utf8")).toBe(files.text)

      const forged = { ...files.document, digest: `sha256:${"0".repeat(64)}` }
      writeFileSync(external, JSON.stringify(forged))
      const refused = files.run("--from", external)
      expect(refused.status).toBe(1)
      expect(refused.stderr).toContain("rows hash to")
      expect(readFileSync(files.canonical, "utf8")).toBe(files.text)
      expect(readFileSync(files.vendored, "utf8")).toBe(files.text)
    } finally {
      rmSync(files.root, { recursive: true, force: true })
    }
  })

  test("refuses a row whose fields would render as code, even with a matching digest", () => {
    const files = fixture()
    try {
      const generatedBefore = files.run()
      expect(generatedBefore.status).toBe(0)
      const clean = readFileSync(files.generated, "utf8")
      const external = join(files.root, "external.json")
      const hostile = [
        { code: "x", fault: "wait", status: "500 }; globalThis.PWNED = 1; ({ a: 1", retry_after: 0, doc: "d" },
        { code: "x", fault: "wait", status: 500, retry_after: "0 }; globalThis.PWNED = 1; ({ a: 1", doc: "d" },
        { code: "x\"]: 1 }; globalThis.PWNED = 1; //", fault: "wait", status: 500, retry_after: 0, doc: "d" },
        { code: "x", fault: "nobody", status: 500, retry_after: 0, doc: "d" }
      ]
      for (const row of hostile) {
        const codes = [row as never]
        writeFileSync(external, JSON.stringify({ schema_version: 1, digest: digestOf(codes), faults: ["wait"], codes }))
        const refused = files.run("--from", external)
        expect(refused.status).toBe(1)
        expect(refused.stderr).toContain("is not a failure-code document")
        expect(readFileSync(files.generated, "utf8")).toBe(clean)
        expect(readFileSync(files.canonical, "utf8")).toBe(files.text)
      }
      const schemaVersion = { ...files.document, schema_version: "1; globalThis.PWNED = 1" }
      writeFileSync(external, JSON.stringify(schemaVersion))
      expect(files.run("--from", external).status).toBe(1)
      expect(readFileSync(files.generated, "utf8")).toBe(clean)
    } finally {
      rmSync(files.root, { recursive: true, force: true })
    }
  })

  test("refuses a plain-http or other non-https --from URL before fetching", () => {
    const files = fixture()
    try {
      for (const from of ["http://127.0.0.1:1", "ftp://example.com/codes.json", "file:///etc/passwd"]) {
        const refused = files.run("--from", from)
        expect(refused.status).not.toBe(0)
        expect(refused.stderr).toContain("only https:// URLs or local files are read")
      }
      expect(readFileSync(files.canonical, "utf8")).toBe(files.text)
    } finally {
      rmSync(files.root, { recursive: true, force: true })
    }
  })

  test("every row of the vendored registry passes validation", () => {
    const vendored = JSON.parse(
      readFileSync(fileURLToPath(new URL("../src/plue-failure-codes.json", import.meta.url)), "utf8")
    )
    expect(validationErrors(vendored)).toEqual([])
  })
})
