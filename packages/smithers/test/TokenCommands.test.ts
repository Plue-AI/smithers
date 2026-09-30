import * as Audience from "@smthrs/build-cli/Audience"
import type { RuntimeConfig } from "@smthrs/build-cli/Cli"
import * as ScopedToken from "@smthrs/control/ScopedToken"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import * as TokenCommands from "../src/cli/TokenCommands.ts"

const key = "gateway-root-secret"

const invoke = async (
  args: Array<string>,
  environment: Record<string, string | undefined> = {},
  terminal = false
) => {
  const result = { stdout: "", stderr: "", codes: [] as Array<number> }
  const config: RuntimeConfig = {
    environment,
    stdout: {
      isTTY: terminal,
      columns: 80,
      write: (text) => {
        result.stdout += text
      }
    },
    stderr: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stderr += text
      }
    },
    exit: (code) => {
      result.codes.push(code)
    }
  }
  const presentation = Audience.fromArguments(args, {
    env: config.environment,
    stdout: config.stdout?.isTTY,
    stderr: config.stderr?.isTTY
  })
  await makeCli({ ...config, presentation }).serve(Audience.incurArguments(args, presentation), {
    env: config.environment,
    stdout: (text) => {
      result.stdout += text
    },
    exit: (code) => {
      result.codes.push(code)
    }
  })
  return result
}

describe("smthrs token mint", () => {
  it("mints a token the gateway credential verifies, with the grant and expiry it carries", async () => {
    const before = Date.now()
    const result = await invoke(
      ["token", "mint", "--scope", "read:runs", "--scope", "approve:runs", "--ttl", "1h", "--run", "run-1", "--json"],
      { SMITHERS_TOKEN: key }
    )

    expect(result.codes).toEqual([])
    expect(result.stderr).toBe("")
    const document = JSON.parse(result.stdout) as TokenCommands.MintedToken
    expect(document).toMatchObject({
      scopes: ["read:runs", "approve:runs"],
      procedures: ["List", "Watch", "Projection.Snapshot", "Projection.Subscribe", "Approve", "Deny", "Approval.Submit"],
      runId: "run-1"
    })
    expect(document).not.toHaveProperty("flowId")
    const expiresAt = Date.parse(document.expiresAt)
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60 * 60 * 1000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000)
    const claims = await Effect.runPromise(ScopedToken.verify(key, document.token, Date.now()))
    expect(claims.exp).toBe(expiresAt)
    expect(claims.runId).toBe("run-1")
    // Signed under the credential, so another credential's gateway refuses it.
    await expect(Effect.runPromise(ScopedToken.verify("another-secret", document.token, Date.now()))).rejects.toThrow()
  })

  it("prints only the token for a person, and defaults the lifetime to one hour", async () => {
    const result = await invoke(
      ["token", "mint", "--scope", "write:runs", "--flow", "demo", "--audience", "human", "--silent"],
      { SMITHERS_TOKEN: key },
      true
    )

    expect(result.codes).toEqual([])
    const [title, token, ...rest] = result.stdout.split("\n")
    expect(title).toBe("token mint")
    expect(token!.startsWith("smt1.")).toBe(true)
    expect(rest.join("\n").trim()).toBe("")
    expect(result.stdout).not.toContain("procedures")
    const claims = await Effect.runPromise(ScopedToken.verify(key, token!, Date.now()))
    expect(claims.exp - claims.iat).toBe(60 * 60 * 1000)
    expect(claims.flowId).toBe("demo")
    expect(claims.procedures).toEqual(["Plan", "Run", "Steer", "Signal", "Cancel", "Resume"])
  })

  it("refuses to mint without SMITHERS_TOKEN, with an unknown scope, or with a bad lifetime", async () => {
    const missing = await invoke(["token", "mint", "--scope", "read:runs"], {})
    expect(missing.codes).toEqual([2])
    expect(missing.stdout + missing.stderr).toContain("Set SMITHERS_TOKEN")

    const blank = await invoke(["token", "mint", "--scope", "read:runs"], { SMITHERS_TOKEN: "  " })
    expect(blank.codes).toEqual([2])
    expect(blank.stdout + blank.stderr).toContain("Set SMITHERS_TOKEN")

    for (const ttl of ["0s", "soon", "-1h", "1y"]) {
      const bad = await invoke(["token", "mint", "--scope", "read:runs", "--ttl", ttl], { SMITHERS_TOKEN: key })
      expect([ttl, bad.codes]).toEqual([ttl, [2]])
      expect(bad.stdout + bad.stderr).toContain("--ttl must be a positive duration")
      expect(bad.stdout + bad.stderr).not.toContain("smt1.")
    }

    // The parser refuses an unknown scope and a missing one before the handler runs.
    for (const args of [["--scope", "everything"], []]) {
      const refused = await invoke(["token", "mint", ...args], { SMITHERS_TOKEN: key })
      expect(refused.codes.length).toBeGreaterThan(0)
      expect(refused.codes.every((code) => code !== 0)).toBe(true)
      expect(refused.stdout + refused.stderr).not.toContain("smt1.")
    }
  })

  it("is not a removed verb any more", async () => {
    const help = await invoke(["token", "--help"])
    expect(help.codes).not.toContain(1)
    expect(help.stdout).toContain("mint")
    expect(help.stdout).not.toContain("was removed in 1.0.0-rc.0")
  })
})
