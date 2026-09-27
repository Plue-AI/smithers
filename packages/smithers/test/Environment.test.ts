/**
 * The closed `SMITHERS_*` environment contract.
 */
import { describe, expect, it } from "vitest"
import * as Environment from "../src/Environment.ts"

describe("the environment contract", () => {
  it("names every variable rc.0 reads", () => {
    expect(Environment.names.map((name) => name.name)).toEqual([
      "SMITHERS_AUDIENCE",
      "SMITHERS_REMOTE",
      "SMITHERS_API_KEY",
      "SMITHERS_CREDENTIAL_KEY",
      "SMITHERS_CACHE_URL",
      "SMITHERS_CACHE_TOKEN",
      "SMITHERS_CACHE_NAMESPACE",
      "SMITHERS_MCP_CONFIG",
      "SMITHERS_OPENAI_AUTH",
      "SMITHERS_TEST_COMMAND",
      "SMITHERS_TEST_CONTAINER",
      "SMITHERS_TEST_CWD",
      "SMITHERS_TEST_TIMEOUT_MS",
      "SMITHERS_BASH_CONTAINER",
      "SMITHERS_ASKS",
      "SMITHERS_BACKEND",
      "SMITHERS_MEMORY_DB",
      "SMITHERS_SUPERVISOR_STANCE",
      "SMITHERS_BUG_ENDPOINT",
      "SMITHERS_JJ_PATH",
      "SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS",
      "SMITHERS_INSIDE_RUN",
      "SMITHERS_RUN_ID"
    ])
    for (const name of Environment.names) expect(name.purpose.length).toBeGreaterThan(0)
  })

  it("does not infer alternate prefixes", () => {
    expect(Environment.read({ FLOWS_BACKEND: "pglite" }, "SMITHERS_BACKEND")).toBeUndefined()
    expect(Environment.read({ FLOWS_API_KEY: "token" }, "SMITHERS_API_KEY")).toBeUndefined()
    expect(Environment.read({ FLOWS_RUN_ID: "run-1" }, "SMITHERS_RUN_ID")).toBeUndefined()
    expect(Environment.read({ FLOWS_REMOTE: "alternate" }, "SMITHERS_REMOTE")).toBeUndefined()
  })

  it("reads the canonical name", () => {
    expect(Environment.read({ SMITHERS_REMOTE: "canonical" }, "SMITHERS_REMOTE")).toBe("canonical")
  })

  it("treats an exported-but-empty value as unset", () => {
    // An exported blank is how a shell spells "not configured"; reading it as
    // a value turns `export SMITHERS_API_KEY=` into an empty bearer token.
    expect(Environment.read({ SMITHERS_REMOTE: "" }, "SMITHERS_REMOTE")).toBeUndefined()
  })

  it("reads a name the table does not carry without inventing an alias", () => {
    expect(Environment.read({ ANTHROPIC_API_KEY: "key" }, "ANTHROPIC_API_KEY")).toBe("key")
    expect(Environment.read({ FLOWS_ANTHROPIC_API_KEY: "key" }, "ANTHROPIC_API_KEY")).toBeUndefined()
  })

  it("reads a positive integer and ignores anything else", () => {
    expect(
      Environment.readInteger(
        { SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS: "5000" },
        "SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS"
      )
    )
      .toBe(5000)
    expect(Environment.readInteger({ SMITHERS_TEST_TIMEOUT_MS: "42" }, "SMITHERS_TEST_TIMEOUT_MS")).toBe(42)
    for (const value of ["30abc", " 30", "30 ", "0", "-1", "3e2", "soon", ""]) {
      expect(
        Environment.readInteger(
          { SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS: value },
          "SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS"
        )
      )
        .toBeUndefined()
    }
    expect(Environment.readInteger({}, "SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS")).toBeUndefined()
  })
})

describe("the database-backend refusal", () => {
  it("accepts sqlite and an unset value", () => {
    expect(Environment.unsupportedBackend(undefined)).toBeUndefined()
    expect(Environment.unsupportedBackend("")).toBeUndefined()
    expect(Environment.unsupportedBackend("sqlite")).toBeUndefined()
    expect(Environment.unsupportedBackend("postgres")).toBeUndefined()
  })

  it("uses the database contract's sentence verbatim for every other value", () => {
    // The contract prints one exact sentence, and an operator's script greps
    // for it. Paraphrasing it — this module said "pglite is not supported in
    // 1.0.0-rc.0" and never named the fix — is a contract change. The literal
    // is repeated here rather than read off the module, so a rewritten
    // constant fails instead of agreeing with itself.
    const expected =
      "unsupported_database: choose sqlite or postgres. PostgreSQL requires SMITHERS_POSTGRES_URL or DATABASE_URL. See https://smithers.sh/migration/1.0#databases."

    expect(Environment.unsupportedBackendMessage).toBe(expected)
    for (const backend of ["pglite", "mysql"]) {
      expect(Environment.unsupportedBackend(backend)).toBe(expected)
    }
  })
})
