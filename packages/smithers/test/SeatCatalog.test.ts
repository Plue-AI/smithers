/**
 * The seats a native host offers Jev for an `auto` run: every alias whose
 * provider the seat resolver holds a credential for, described without the
 * credential, and never Jev.
 */
import * as SeatRouter from "@smthrs/agent/SeatRouter"
import { Effect } from "effect"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"
import * as Providers from "../src/Providers.ts"

const session = JSON.stringify({ tokens: { access_token: "a", refresh_token: "r", account_id: "acct" } })

const ids = (
  environment: Readonly<Record<string, string | undefined>>,
  files: Readonly<Record<string, string>> = {}
): ReadonlyArray<string> =>
  NodeControl.seatCandidates({ environment, homeDirectory: "/home/op", readFile: (path) => files[path] })
    .map((candidate) => candidate.id)

describe("Providers.seatDescriptions", () => {
  it("describes every alias by label, provider and context window", () => {
    expect(Object.keys(Providers.seatDescriptions)).toEqual(Object.keys(Providers.seatAliases))
    expect(Providers.seatDescriptions).toEqual({
      sol: "GPT-6 Sol, OpenAI, 400K context",
      astra: "GPT-6 Astra, OpenAI, 400K context",
      luna: "GPT-6 Luna, OpenAI, 400K context",
      opus: "Claude Opus 5.5, Anthropic, 1M context",
      sonnet: "Claude Sonnet 5.5, Anthropic, fast capable Claude for clear implementation, 1M context",
      fable: "Claude Fable 5.1, Anthropic, 1M context",
      kimi: "Kimi K3, Moonshot, backup seat, 128K context",
      qwen: "Qwen 3.8, Cerebras, 128K context"
    })
  })
})

describe("NodeControl.seatCandidates", () => {
  it("offers the Anthropic aliases for an Anthropic key, with no key text", () => {
    const key = "sk-ant-secret-value"
    const candidates = NodeControl.seatCandidates({
      environment: { ANTHROPIC_API_KEY: key },
      homeDirectory: "/home/op",
      readFile: () => undefined
    })
    expect(candidates.map((candidate) => candidate.id)).toEqual(["opus", "sonnet", "fable"])
    expect(candidates.every((candidate) => !candidate.description.includes(key))).toBe(true)
    expect(candidates.map((candidate) => candidate.description)).toEqual([
      Providers.seatDescriptions.opus,
      Providers.seatDescriptions.sonnet,
      Providers.seatDescriptions.fable
    ])
  })

  it("offers the claude-code seats for a Claude subscription signed in to Claude Code, and never beside a key", () => {
    const login = { executable: "/bin/claude", loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }
    const candidates = (environment: Readonly<Record<string, string | undefined>>, signedIn = login) =>
      NodeControl.seatCandidates({
        environment,
        homeDirectory: "/home/op",
        readFile: () => undefined,
        claudeCode: () => signedIn
      })
    expect(candidates({}).map((candidate) => candidate.id)).toEqual(Providers.claudeCodeSeats)
    expect(candidates({})[0]).toEqual({
      id: "claude-code:opus",
      description: `${Providers.seatDescriptions.opus}, on Claude Code`
    })
    expect(candidates({ ANTHROPIC_API_KEY: "a" }).map((candidate) => candidate.id)).not.toContain("claude-code:opus")
    expect(candidates({}, { ...login, authMethod: "api_key" })).toEqual([])
    // A subscription token in the environment is Claude Code's, never a route of ours.
    expect(ids({ CLAUDE_CODE_OAUTH_TOKEN: "oauth", ANTHROPIC_AUTH_TOKEN: "token" })).toEqual([])
  })

  it("offers the OpenAI aliases for the Codex subscription the resolver signs with", () => {
    const auth = join("/codex", "auth.json")
    expect(ids({ SMITHERS_OPENAI_AUTH: "chatgpt", CODEX_HOME: "/codex" }, { [auth]: session })).toEqual([
      "sol",
      "astra",
      "luna"
    ])
    // Without the mode the resolver signs `openai:` seats with OPENAI_API_KEY.
    expect(ids({ CODEX_HOME: "/codex" }, { [auth]: session })).toEqual([])
  })

  it("offers a provider's aliases through an account pool configured for its route, only with the pool credential", () => {
    const pool = {
      SMITHERS_ACCOUNT_POOL_URL: "https://pool.example/provider-pool",
      SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt,anthropic"
    }
    // The pool is asked which routes have accounts when a seat resolves, so a
    // configured route is offered without a key of the provider's own.
    // A Claude subscription has no pool route: only Claude Code signs with it.
    expect(ids({ ...pool, SMITHERS_ACCOUNT_POOL_KEY: "pool-credential" })).toEqual(["sol", "astra", "luna"])
    expect(ids({ ...pool, SMITHERS_ACCOUNT_POOL_KEY: "pool-credential", SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt" }))
      .toEqual(["sol", "astra", "luna"])
    // The configured subscription pool takes precedence over stale API-key mode.
    expect(ids({ ...pool, SMITHERS_ACCOUNT_POOL_KEY: "pool-credential", SMITHERS_OPENAI_AUTH: "api-key" })).toEqual([
      "sol",
      "astra",
      "luna"
    ])
    expect(ids(pool)).toEqual([])
  })

  it("offers the OpenAI aliases behind the model proxy only with its credential", () => {
    const proxied = { SMITHERS_OPENAI_AUTH: "chatgpt", SMITHERS_MODEL_PROXY_URL: "https://proxy.example" }
    expect(ids({ ...proxied, OPENAI_API_KEY: "proxy-credential" })).toEqual(["sol", "astra", "luna"])
    expect(ids(proxied)).toEqual([])
  })

  it("offers the OpenAI aliases for an API key in api-key mode only", () => {
    expect(ids({ OPENAI_API_KEY: "sk" })).toEqual(["sol", "astra", "luna"])
    expect(ids({ OPENAI_API_KEY: "sk", SMITHERS_OPENAI_AUTH: "api-key" })).toEqual(["sol", "astra", "luna"])
    expect(ids({ OPENAI_API_KEY: "sk", SMITHERS_OPENAI_AUTH: "bogus" })).toEqual([])
  })

  it("offers qwen for a Cerebras key, and nothing on a bare machine", () => {
    expect(ids({ CEREBRAS_API_KEY: "c" })).toEqual(["qwen"])
    expect(ids({})).toEqual([])
  })

  it("never offers Jev", () => {
    const all = ids({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", MOONSHOT_API_KEY: "m", CEREBRAS_API_KEY: "c" })
    expect(all).toEqual(Object.keys(Providers.seatAliases))
    expect(all.some((id) => Providers.isDecisionSeat(id) || Providers.isDecisionSeat(Providers.expandSeat(id)))).toBe(
      false
    )
  })
})

describe("NodeControl.layerSeatCatalog", () => {
  const read = (environment: Readonly<Record<string, string | undefined>>) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const catalog = yield* SeatRouter.Catalog
        return { candidates: yield* catalog.candidates, variants: catalog.variants }
      }).pipe(Effect.provide(NodeControl.layerSeatCatalog(environment)))
    )

  it("reads the Codex session from the file system, with the default variants", async () => {
    const home = mkdtempSync(join(tmpdir(), "seat-catalog-"))
    const missing = await read({ SMITHERS_OPENAI_AUTH: "api-key", CODEX_HOME: home, ANTHROPIC_API_KEY: "a" })
    expect(missing.candidates.map((candidate) => candidate.id)).toEqual(["opus", "sonnet", "fable"])
    expect(missing.variants).toBe(SeatRouter.defaultVariants)
    writeFileSync(join(home, "auth.json"), session)
    const signed = await read({ SMITHERS_OPENAI_AUTH: "chatgpt", CODEX_HOME: home })
    expect(signed.candidates.map((candidate) => candidate.id)).toEqual(["sol", "astra", "luna"])
  })
})
