/*
 * Startup configuration tests, run by `bun test`.
 *
 * readConfig is pure, so the contract the container depends on is asserted
 * without starting anything.
 */
import { describe, expect, test } from "bun:test"
import { maxConfigurableBodyBytes, readConfig } from "../config.js"

const databaseUrl = "postgres://smthrs:secret@smithers-build-cache-postgres:5432/smithers_build_cache?sslmode=disable"

const validReadToken = "a-read-token-with-at-least-16-bytes"
const validWriteToken = "a-write-token-with-at-least-16-bytes"
const valid = {
  DATABASE_URL: databaseUrl,
  PORT: "8080",
  SMITHERS_CACHE_READ_TOKEN: validReadToken,
  SMITHERS_CACHE_WRITE_TOKEN: validWriteToken
}

describe("readConfig", () => {
  test("passes a validated read namespace prefix to the server", () => {
    expect(readConfig({ ...valid, SMITHERS_CACHE_READ_NAMESPACE_PREFIX: "pr-1/" }).config.readNamespacePrefix).toBe("pr-1/")
    for (const prefix of ["pr-1", "../main/", "pr-1/main/"]) {
      expect(readConfig({ ...valid, SMITHERS_CACHE_READ_NAMESPACE_PREFIX: prefix }).ok).toBe(false)
    }
    expect(readConfig({ DATABASE_URL: databaseUrl, SMITHERS_CACHE_READ_NAMESPACE_PREFIX: "pr-1/" }).ok).toBe(false)
  })

  test("accepts the environment the module wires", () => {
    const result = readConfig({ ...valid, SMITHERS_CACHE_MAX_BODY_BYTES: "16777216" })
    expect(result.ok).toBe(true)
    expect(result.config.port).toBe(8080)
    expect(result.config.maxArtifactBytes).toBe(16777216)
    expect(result.config.databaseUrl).toBe(databaseUrl)
    expect(result.config.development).toBe(false)
    expect(result.config.readTokenHash).toBe(
      new Bun.CryptoHasher("sha256").update(validReadToken, "utf8").digest("hex")
    )
    expect(result.config.writeTokenHash).toBe(
      new Bun.CryptoHasher("sha256").update(validWriteToken, "utf8").digest("hex")
    )
    expect(result.config.hostname).toBe("0.0.0.0")
  })

  test("defaults the port and the artifact bound", () => {
    const result = readConfig({ DATABASE_URL: databaseUrl })
    expect(result.config.port).toBe(8080)
    expect(result.config.maxArtifactBytes).toBe(16 * 1024 * 1024)
  })

  test("keeps the documented empty-token development mode", () => {
    const result = readConfig({ DATABASE_URL: databaseUrl, SMITHERS_CACHE_TOKEN: "" })
    expect(result.ok).toBe(true)
    expect(result.config.readTokenHash).toBeNull()
    expect(result.config.writeTokenHash).toBeNull()
    expect(result.config.development).toBe(true)
    expect(result.config.hostname).toBe("127.0.0.1")
  })

  test("never retains either token itself", () => {
    const result = readConfig(valid)
    expect(JSON.stringify(result.config)).not.toContain(validReadToken)
    expect(JSON.stringify(result.config)).not.toContain(validWriteToken)
  })

  test("refuses a port that is not a listenable integer", () => {
    for (const port of ["0", "-1", "70000", "abc", "8080.5", "0x1f", "", " 8080 ", "1e3"]) {
      const result = readConfig({ ...valid, PORT: port })
      expect(result.ok).toBe(false)
      expect(result.problems.join(" ")).toContain("PORT")
    }
  })

  test("refuses an artifact bound that is not a positive integer under the ceiling", () => {
    for (
      const bytes of ["0", "-1", "abc", "", "1.5", String(maxConfigurableBodyBytes + 1), "9007199254740993"]
    ) {
      const result = readConfig({ ...valid, SMITHERS_CACHE_MAX_BODY_BYTES: bytes })
      expect(result.ok).toBe(false)
      expect(result.problems.join(" ")).toContain("SMITHERS_CACHE_MAX_BODY_BYTES")
    }
  })

  test("accepts the ceiling itself", () => {
    const result = readConfig({ ...valid, SMITHERS_CACHE_MAX_BODY_BYTES: String(maxConfigurableBodyBytes) })
    expect(result.ok).toBe(true)
  })

  test("refuses a missing or non-Postgres connection string without echoing it", () => {
    const missing = readConfig({ PORT: "8080" })
    const wrong = readConfig({ DATABASE_URL: "mysql://user:hunter2@host/db" })

    expect(missing.ok).toBe(false)
    expect(missing.problems.join(" ")).toContain("DATABASE_URL")
    expect(wrong.ok).toBe(false)
    expect(wrong.problems.join(" ")).not.toContain("hunter2")
  })

  test("requires a bounded, parseable database URL with host and database", () => {
    const cases = [
      "postgres://user:secret@host",
      "postgres://user:secret@/database",
      "postgres://user:secret@host/database#fragment",
      "postgres://user:secret@host/data\nbase",
      `postgres://user:secret@host/${"a".repeat(8192)}`
    ]
    for (const candidate of cases) {
      const result = readConfig({ ...valid, DATABASE_URL: candidate })
      expect(result.ok).toBe(false)
      expect(result.problems.join(" ")).toContain("DATABASE_URL")
      expect(result.problems.join(" ")).not.toContain("secret")
    }
  })

  test("refuses either token when it cannot travel in a header", () => {
    // A credential is visible ASCII with no spaces. A token carrying anything
    // else hashes to a value no client can present, because the header value
    // arrives trimmed, so every request would answer 401 with nothing to read.
    // The shape is the one variables.tf validates, and the value is never
    // echoed back in the diagnosis.
    for (const name of ["SMITHERS_CACHE_READ_TOKEN", "SMITHERS_CACHE_WRITE_TOKEN"]) {
      for (
        const token of [
          "line\nbreak-is-long",
          "two words are long",
          " leading-is-long",
          "trailing-is-long ",
          "café-is-long-enough",
          "tab\there-is-long",
          "too-short",
          "a".repeat(4097)
        ]
      ) {
        const result = readConfig({ ...valid, [name]: token })
        expect(result.ok).toBe(false)
        expect(result.problems.join(" ")).toContain(name)
        expect(result.problems.join(" ")).not.toContain(token.trim())
      }
    }
  })

  test("accepts the token shapes the module generates for both credentials", () => {
    for (const token of ["a".repeat(64), "tok-en_1.2~3-long", "!$%&/:;<=>?@[]^`{|}~"]) {
      expect(
        readConfig({
          ...valid,
          SMITHERS_CACHE_READ_TOKEN: token,
          SMITHERS_CACHE_WRITE_TOKEN: `${token}-write`
        }).ok
      ).toBe(true)
    }
  })

  test("refuses two equal credentials instead of granting every reader write access", () => {
    // Equal values are one credential under two names, and the protocol's
    // classifier answers "write" for it, so accepting the pair would leave the
    // nominal read credential able to publish while the configuration claimed a
    // split. variables.tf refuses it too; this is the same rule for a
    // deployment that reaches the service without Terraform.
    const result = readConfig({ ...valid, SMITHERS_CACHE_WRITE_TOKEN: validReadToken })
    expect(result.ok).toBe(false)
    expect(result.problems.join(" ")).toContain("must differ")
    expect(result.problems.join(" ")).not.toContain(validReadToken)
  })

  test("refuses a lone legacy production token instead of silently granting write access", () => {
    const result = readConfig({ DATABASE_URL: databaseUrl, SMITHERS_CACHE_TOKEN: validReadToken })
    expect(result.ok).toBe(false)
    expect(result.problems.join(" ")).toContain("SMITHERS_CACHE_TOKEN")
    expect(result.problems.join(" ")).toContain("SMITHERS_CACHE_READ_TOKEN")
    expect(result.problems.join(" ")).toContain("SMITHERS_CACHE_WRITE_TOKEN")
  })

  test("requires the read and write credentials together outside development mode", () => {
    const readOnly = readConfig({ DATABASE_URL: databaseUrl, SMITHERS_CACHE_READ_TOKEN: validReadToken })
    const writeOnly = readConfig({ DATABASE_URL: databaseUrl, SMITHERS_CACHE_WRITE_TOKEN: validWriteToken })
    expect(readOnly.ok).toBe(false)
    expect(writeOnly.ok).toBe(false)
    expect(readOnly.problems.join(" ")).toContain("must both be set")
    expect(writeOnly.problems.join(" ")).toContain("must both be set")
  })

  test("reports every problem at once", () => {
    const result = readConfig({ PORT: "0", SMITHERS_CACHE_MAX_BODY_BYTES: "-5" })
    expect(result.ok).toBe(false)
    expect(result.problems).toHaveLength(3)
  })
})
