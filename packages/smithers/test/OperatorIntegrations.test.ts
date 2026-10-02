import { Redacted } from "effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import * as Presentation from "../src/cli/Presentation.ts"
import { withCredentials } from "../src/operator/Credentials.ts"
import { createIntegrationsCli, probe, readIntegrations } from "../src/operator/Integrations.ts"

const directories: Array<string> = []
afterAll(async () => {
  await Promise.all(directories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
const root = async () => {
  vi.stubEnv("SMITHERS_REMOTE", "")
  const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-integration-cli-"))
  directories.push(directory)
  await Fs.mkdir(Path.join(directory, ".smithers"))
  return directory
}
const serve = async (root: string, args: ReadonlyArray<string>) => {
  let code = 0
  let output = ""
  await createIntegrationsCli().serve([...args, "--root", root, "--json"], {
    exit: (value) => {
      code = value
    },
    stdout: (value) => {
      output += value
    }
  })
  return { code, output, data: JSON.parse(output) }
}

describe("integration CLI", () => {
  it("discovers fallback credentials without exposing values", async () => {
    const directory = await root()
    expect(readIntegrations(directory, undefined, {})).toEqual([])
    expect(readIntegrations(directory, undefined, { GITHUB_TOKEN: "fallback-fixture" })).toEqual([
      { id: "github", provider: "github", tokenEnv: "GITHUB_TOKEN" }
    ])
    expect(readIntegrations(directory, undefined, {
      SMITHERS_GITHUB_TOKEN: "preferred-fixture",
      GITHUB_TOKEN: "fallback-fixture",
      SMITHERS_TELEGRAM_BOT_TOKEN: "telegram-fixture"
    })).toEqual([
      { id: "github", provider: "github", tokenEnv: "SMITHERS_GITHUB_TOKEN" }
    ])
    expect(() => readIntegrations(directory, "missing.json", {})).toThrow("configuration does not exist")
  })

  it.each([
    "ftp://example.invalid",
    "http://example.invalid",
    "https://user:private-fixture@example.invalid",
    "https://example.invalid?token=private-fixture",
    "https://example.invalid#private-fixture"
  ])("refuses unsafe provider endpoint %s without echoing its credentials", async (apiBaseUrl) => {
    const directory = await root()
    await Fs.writeFile(
      Path.join(directory, ".smithers/integrations.json"),
      JSON.stringify({
        version: 1,
        integrations: [{ id: "gh", provider: "github", apiBaseUrl }]
      })
    )
    const result = await serve(directory, ["list"])
    expect(result.code).toBe(1)
    expect(result.output).toContain("API endpoint must be HTTP(S)")
    expect(result.output).not.toContain("private-fixture")
  })

  it("refuses duplicate IDs and contradictory credential sources", async () => {
    const directory = await root()
    const config = Path.join(directory, ".smithers/integrations.json")
    await Fs.writeFile(
      config,
      JSON.stringify({
        version: 1,
        integrations: [{ id: "same", provider: "github" }, { id: "same", provider: "github" }]
      })
    )
    expect(() => readIntegrations(directory)).toThrow("Integration IDs must be unique")
    await Fs.writeFile(
      config,
      JSON.stringify({
        version: 1,
        integrations: [{ id: "gh", provider: "github", tokenEnv: "TOKEN", credentialId: "stored" }]
      })
    )
    expect(() => readIntegrations(directory)).toThrow("Use tokenEnv or credentialId, not both")
  })

  it("refuses malformed configuration by path, never quoting the value or the parser's text", async () => {
    const directory = await root()
    const config = Path.join(directory, ".smithers/integrations.json")
    await Fs.writeFile(
      config,
      JSON.stringify({ version: 1, integrations: [{ id: "gh", provider: "ghp_private-fixture-token" }] })
    )
    let refusal: unknown
    try {
      readIntegrations(directory)
    } catch (error) {
      refusal = error
    }
    expect(refusal).toMatchObject({
      _tag: "/cli/Refused",
      fault: "user",
      code: "operator_failed",
      message: "Invalid integrations configuration: integrations.0.provider is invalid"
    })
    await Fs.writeFile(config, "{ \"version\": 1, ghp_private-fixture-token")
    expect(() => readIntegrations(directory)).toThrow(".smithers/integrations.json is not valid JSON")
    const listed = await serve(directory, ["list"])
    expect(listed.code).toBe(1)
    expect(listed.output).toContain("operator_failed")
    expect(listed.output).not.toContain("private-fixture-token")
  })

  it("checks every provider's default credential offline without sending requests", async () => {
    const directory = await root()
    const integrations = ["github"].map((provider) => ({ id: provider, provider }))
    await Fs.writeFile(
      Path.join(directory, ".smithers/integrations.json"),
      JSON.stringify({ version: 1, integrations })
    )
    for (const name of ["SMITHERS_GITHUB_TOKEN"]) {
      vi.stubEnv(name, "provider-fixture-secret")
    }
    const fetch = vi.fn(() => {
      throw new Error("offline diagnostics sent a request")
    })
    vi.stubGlobal("fetch", fetch)
    const result = await serve(directory, ["doctor", "--offline"])
    expect(result.code, result.output).toBe(0)
    expect(result.data).toEqual({
      healthy: true,
      integrations: integrations.map((item) => ({ ...item, healthy: true, check: "credential-present" }))
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(result.output).not.toContain("provider-fixture-secret")
  })

  it("resolves encrypted credential references through the real local store", async () => {
    const directory = await root()
    vi.stubEnv("SMITHERS_CREDENTIAL_KEY", Buffer.alloc(32, 9).toString("base64"))
    await withCredentials({ root: directory }, (service) =>
      service.create({
        id: "stored-token",
        name: "GitHub fixture",
        secret: Redacted.make("encrypted-fixture-secret")
      }), true)
    await Fs.writeFile(
      Path.join(directory, ".smithers/integrations.json"),
      JSON.stringify({
        version: 1,
        integrations: [{ id: "gh", provider: "github", credentialId: "stored-token" }]
      })
    )
    const result = await serve(directory, ["doctor", "gh", "--offline"])
    expect(result.code, result.output).toBe(0)
    expect(result.data.integrations).toEqual([
      { id: "gh", provider: "github", healthy: true, check: "credential-present" }
    ])
    expect(result.output).not.toContain("encrypted-fixture-secret")
  })

  it("reports online health without returning provider response bodies or request details", async () => {
    const directory = await root()
    vi.stubEnv("SMITHERS_GITHUB_TOKEN", "request-fixture-secret")
    await Fs.writeFile(
      Path.join(directory, ".smithers/integrations.json"),
      JSON.stringify({
        version: 1,
        integrations: [{ id: "gh", provider: "github" }]
      })
    )
    const fetch = vi.fn(async () => Response.json({ private: "response-fixture-secret" }))
    vi.stubGlobal("fetch", fetch)
    const healthy = await serve(directory, ["doctor", "gh"])
    expect(healthy.code, healthy.output).toBe(0)
    expect(healthy.data.integrations).toEqual([
      { id: "gh", provider: "github", healthy: true, check: "provider-authentication" }
    ])
    fetch.mockResolvedValue(Response.json({ message: "response-fixture-secret" }, { status: 401 }))
    const unhealthy = await serve(directory, ["doctor", "gh"])
    expect(unhealthy.code).toBe(1)
    expect(unhealthy.output).toContain("Credential lookup or provider authentication failed")
    for (const result of [healthy, unhealthy]) {
      expect(result.output).not.toContain("request-fixture-secret")
      expect(result.output).not.toContain("response-fixture-secret")
    }
  })

  it("refuses an unknown integration before requests", async () => {
    const directory = await root()
    const fetch = vi.fn(() => {
      throw new Error("an unknown integration sent a request")
    })
    vi.stubGlobal("fetch", fetch)
    const config = Path.join(directory, ".smithers/integrations.json")
    await Fs.writeFile(config, JSON.stringify({ version: 1, integrations: [{ id: "github", provider: "github" }] }))
    expect((await serve(directory, ["doctor", "unknown"])).output).toContain("Unknown integration")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("prints the generic sentence for a non-Error failure at the operator boundary", async () => {
    let rendered: unknown
    const result = await Presentation.guard({
      error: (error) => {
        rendered = error
        return undefined as never
      }
    }, async () => {
      throw "Authorization: Bearer operator-fixture-secret"
    }, { code: "operator_failed" })
    expect(result).toBeUndefined()
    expect(rendered).toEqual({
      code: "operator_failed",
      exitCode: 1,
      message: "Something went wrong on our side. Not your fault."
    })
  })

  it("lists only credential references and refuses raw secret fields", async () => {
    const directory = await root()
    vi.stubEnv("SMITHERS_INTEGRATION_TOKEN_ENV", "TEST_MISSING_TOKEN")
    const config = Path.join(directory, ".smithers/integrations.json")
    await Fs.writeFile(
      config,
      JSON.stringify({
        version: 1,
        integrations: [{ id: "github", provider: "github", tokenEnv: "TEST_MISSING_TOKEN" }]
      })
    )
    expect((await serve(directory, ["list"])).data).toEqual([{
      id: "github",
      provider: "github",
      tokenEnv: "TEST_MISSING_TOKEN"
    }])
    expect((await serve(directory, ["doctor", "--offline"])).code).toBe(1)
    await Fs.writeFile(
      config,
      JSON.stringify({ version: 1, integrations: [{ id: "github", provider: "github", token: "secret-value" }] })
    )
    const result = await serve(directory, ["list"])
    expect(result.code).toBe(1)
    expect(result.output).not.toContain("secret-value")
  })

  it("discovers GitHub and verifies it through the existing client", async () => {
    const directory = await root()
    expect(readIntegrations(directory, undefined, { SMITHERS_LINEAR_API_KEY: "secret" })).toEqual([])
    const calls: Array<string> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        calls.push(url)
        return Response.json({ resources: { core: { remaining: 5000 } } })
      })
    )
    for (const provider of ["github"] as const) {
      expect(await probe({ id: provider, provider }, "test-token")).toMatchObject({ healthy: true })
    }
    expect(calls).toContain("https://api.github.com/rate_limit")
  })

  it("refuses credentials and destinations the host never authorized, and accepts the ones it did", async () => {
    const directory = await root()
    const config = Path.join(directory, ".smithers/integrations.json")
    const declare = (integration: Record<string, unknown>) =>
      Fs.writeFile(config, JSON.stringify({ version: 1, integrations: [integration] }))
    const requests: Array<string> = []
    const fetch = vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input))
      return Response.json({ resources: { core: { remaining: 5000 } } })
    })
    vi.stubGlobal("fetch", fetch)
    vi.stubEnv("SMITHERS_CREDENTIAL_KEY", "host-encryption-fixture-secret")

    await declare({
      id: "exfil",
      provider: "github",
      tokenEnv: "SMITHERS_CREDENTIAL_KEY",
      apiBaseUrl: "https://attacker.invalid"
    })
    const borrowed = await serve(directory, ["doctor", "exfil"])
    expect(borrowed.code).toBe(1)
    expect(borrowed.output).toContain("unauthorized credential variable SMITHERS_CREDENTIAL_KEY")
    expect(borrowed.output).not.toContain("host-encryption-fixture-secret")
    expect(fetch).not.toHaveBeenCalled()

    await declare({ id: "exfil", provider: "github", apiBaseUrl: "https://attacker.invalid" })
    const redirected = await serve(directory, ["doctor", "exfil"])
    expect(redirected.code).toBe(1)
    expect(redirected.output).toContain("unauthorized github endpoint https://attacker.invalid")
    expect(fetch).not.toHaveBeenCalled()
    await expect(
      probe({ id: "exfil", provider: "github", apiBaseUrl: "https://attacker.invalid" }, "probe-fixture-secret")
    ).rejects.toThrow("unauthorized github endpoint")
    expect(fetch).not.toHaveBeenCalled()

    vi.stubEnv("SMITHERS_INTEGRATION_TOKEN_ENV", "TEAM_GITHUB_TOKEN")
    vi.stubEnv("SMITHERS_GITHUB_API_BASE_URL", "https://github.example.com/api/v3")
    vi.stubEnv("TEAM_GITHUB_TOKEN", "authorized-fixture-secret")
    await declare({
      id: "enterprise",
      provider: "github",
      tokenEnv: "TEAM_GITHUB_TOKEN",
      apiBaseUrl: "https://github.example.com/api/v3"
    })
    const authorized = await serve(directory, ["doctor", "enterprise"])
    expect(authorized.code, authorized.output).toBe(0)
    expect(authorized.data.integrations).toEqual([
      { id: "enterprise", provider: "github", healthy: true, check: "provider-authentication" }
    ])
    expect(requests).toEqual(["https://github.example.com/api/v3/rate_limit"])
    expect(authorized.output).not.toContain("authorized-fixture-secret")
  })
})

for (const provider of ["linear", "telegram", "slack", "gmail", "googlecalendar", "x"]) {
  it(`refuses stored ${provider} configuration without sending a diagnostic request`, async () => {
    const directory = await root()
    await Fs.writeFile(Path.join(directory, ".smithers/integrations.json"), JSON.stringify({ version: 1, integrations: [{ id: "retired", provider }] }))
    const fetch = vi.fn(() => { throw new Error("retired adapter reached network") })
    vi.stubGlobal("fetch", fetch)
    expect((await serve(directory, ["doctor"])).code).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
  })
}
