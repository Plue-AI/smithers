/**
 * The complete seat-resolution matrix: every supported provider crossed with
 * every state its API key variable can be in, plus the seat-string shapes the
 * parser has to separate — bare, prefixed, trailing-separator, and multiply
 * separated.
 *
 * The resolver is the agent's front door: a seat that resolves wrong routes a
 * run to the wrong provider, and a seat that fails to resolve must say which
 * variable to set.
 */
import { Seat } from "@smthrs/agent"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as ModelError from "@smthrs/model/ModelError"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"
import * as Providers from "../src/Providers.ts"

const executor = RequestExecutor.RequestExecutor.of({
  execute: () => Effect.die(new Error("model transport was not expected"))
})

const resolve = (
  environment: Readonly<Record<string, string | undefined>>,
  seat: string
) => Effect.scoped(NodeControl.seatResolver(environment, executor).resolve(seat))

const keyed = {
  ANTHROPIC_API_KEY: "anthropic-key",
  MOONSHOT_API_KEY: "moonshot-key",
  OPENAI_API_KEY: "openai-key",
  OPENROUTER_API_KEY: "openrouter-key"
}

const prepared = (seat: Seat.Seat, modelId: string) =>
  Effect.runPromise(
    seat.route.prepare({
      modelId,
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      params: {}
    } as never)
  )

describe("NodeControl.seatResolver providers", () => {
  it.each(
    [
      ["anthropic", "anthropic:claude-sonnet-4-5", "https://api.anthropic.com/v1/messages", 200_000],
      ["openai", "openai:gpt-5.6-sol", "https://api.openai.com/v1/responses", 400_000],
      ["openrouter", "openrouter:openai/gpt-5.6-sol", "https://openrouter.ai/api/v1/responses", 400_000]
    ] as const
  )("routes a keyed %s seat to its own endpoint", async (_provider, seat, url, tokens) => {
    const resolved = await Effect.runPromise(resolve(keyed, seat))

    expect(resolved.id).toBe(seat)
    expect(resolved.modelId).toBe(Seat.modelIdOf(seat))
    expect(resolved.contextWindowTokens).toBe(tokens)
    const request = await prepared(resolved, resolved.modelId)
    expect(request.url).toBe(url)
    // The credential is applied by Auth as the request leaves; it never enters
    // the sealed, credential-free view.
    expect(JSON.stringify(request.publicHeaders)).not.toContain("key")
  })

  it("routes a seat with no separator through Anthropic as a bare model id", async () => {
    const resolved = await Effect.runPromise(resolve(keyed, "claude-opus-4-1"))

    // The one provider convention this host assumes: no prefix means Anthropic.
    expect(resolved.id).toBe("claude-opus-4-1")
    expect(resolved.contextWindowTokens).toBe(200_000)
    expect((await prepared(resolved, "claude-opus-4-1")).url).toBe("https://api.anthropic.com/v1/messages")
  })

  it("keeps every separator after the first inside the model id", async () => {
    const resolved = await Effect.runPromise(resolve(keyed, "openrouter:anthropic/claude:beta"))

    // OpenRouter spells vendor and model with a slash, and a colon in a model
    // id belongs to the model, not to another provider prefix.
    expect(Seat.modelIdOf("openrouter:anthropic/claude:beta")).toBe("anthropic/claude:beta")
    expect(resolved.contextWindowTokens).toBe(200_000)
  })

  it("resolves a seat that is nothing but a provider prefix", async () => {
    const resolved = await Effect.runPromise(resolve(keyed, "openai:"))

    // A trailing separator is an empty model id, which no catalog pattern
    // matches, so the conservative floor applies rather than zero.
    expect(resolved.id).toBe("openai:")
    expect(resolved.contextWindowTokens).toBe(128_000)
  })

  it("gives a model the catalog has never met the conservative floor", async () => {
    const resolved = await Effect.runPromise(resolve(keyed, "anthropic:some-unreleased-model"))

    expect(resolved.contextWindowTokens).toBe(128_000)
  })

  it("refuses a provider prefix that names no route", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve(keyed, "mystery:model-x")))

    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
    expect(error.seat).toBe("mystery:model-x")
    expect(error.message).toBe("No route is configured for the mystery provider")
  })

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
    "refuses the %s prefix without reading an inherited property as its key variable",
    async (provider) => {
      const error = await Effect.runPromise(Effect.flip(resolve(keyed, `${provider}:foo`)))

      expect(error).toBeInstanceOf(Seat.SeatUnresolved)
      expect(error.seat).toBe(`${provider}:foo`)
      expect(error.message).toBe(`No route is configured for the ${provider} provider`)
    }
  )

  it("refuses an empty provider prefix rather than defaulting it", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve(keyed, ":claude-sonnet-4-5")))

    // A leading separator is an explicit empty provider, which is not the same
    // as no separator at all.
    expect(error.message).toBe("No route is configured for the  provider")
  })

  it("refuses the empty seat", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve({}, "")))

    // No separator, so the Anthropic route applies and the missing key is what
    // the operator hears about.
    expect(error.message).toBe("Set ANTHROPIC_API_KEY to run the  seat")
  })
})

describe("NodeControl.seatResolver credentials", () => {
  it.each(
    [
      ["anthropic", "anthropic:claude-sonnet-4-5", "ANTHROPIC_API_KEY"],
      ["openai", "openai:gpt-5.6-sol", "OPENAI_API_KEY"],
      ["openrouter", "openrouter:openai/gpt-5.6-sol", "OPENROUTER_API_KEY"],
      ["a bare model id", "claude-sonnet-4-5", "ANTHROPIC_API_KEY"]
    ] as const
  )("refuses %s with its key variable absent and with it empty, naming the variable", async (
    _provider,
    seat,
    variable
  ) => {
    const absent = await Effect.runPromise(Effect.flip(resolve({}, seat)))
    const empty = await Effect.runPromise(Effect.flip(resolve({ [variable]: "" }, seat)))

    // An empty string is treated exactly like an unset variable: a blank key
    // would otherwise reach the provider and fail as an opaque 401.
    expect(absent.message).toBe(`Set ${variable} to run the ${seat} seat`)
    expect(empty.message).toBe(absent.message)
    expect(absent.seat).toBe(seat)
  })

  it("reads only the variable its own provider owns", async () => {
    const wrongKey = await Effect.runPromise(Effect.flip(resolve({ OPENAI_API_KEY: "k" }, "anthropic:claude-3")))
    const rightKey = await Effect.runPromise(resolve({ ANTHROPIC_API_KEY: "k" }, "anthropic:claude-3"))

    expect(wrongKey.message).toBe("Set ANTHROPIC_API_KEY to run the anthropic:claude-3 seat")
    expect(rightKey.id).toBe("anthropic:claude-3")
  })

  it("accepts a single-character key as present", async () => {
    const resolved = await Effect.runPromise(resolve({ OPENAI_API_KEY: "k" }, "openai:gpt-5.6-sol"))

    // Length one is the boundary of the `length === 0` refusal.
    expect(resolved.id).toBe("openai:gpt-5.6-sol")
  })

  it("routes an explicitly configured OpenAI-compatible owner provider", async () => {
    const resolved = await Effect.runPromise(resolve({
      OPENAI_API_KEY: "owner-key",
      SMITHERS_OPENAI_COMPATIBLE_BASE_URL: "http://provider.internal:8080"
    }, "openai:scripted"))
    expect((await prepared(resolved, resolved.modelId)).url).toBe("http://provider.internal:8080/v1/chat/completions")
  })

  it("refuses a keyed provider when the environment record is empty", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve({}, "openrouter:openai/gpt-5.6-sol")))

    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
  })
})

describe("NodeControl.seatResolver ChatGPT mode", () => {
  const directories: Array<string> = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  const codexOnPath = (signedIn: boolean): string => {
    const directory = mkdtempSync(join(tmpdir(), "flows-seat-codex-"))
    directories.push(directory)
    writeFileSync(
      join(directory, "codex"),
      signedIn
        ? "#!/bin/sh\necho \"Logged in using ChatGPT\"\n"
        : "#!/bin/sh\necho \"Not logged in\" >&2\nexit 1\n",
      { mode: 0o755 }
    )
    return directory
  }

  it.each([
    ["openai:gpt-5.6-sol", "gpt-5.6-sol", "chatgpt"],
    ["codex:sol", "gpt-6.1-sol", undefined],
    ["codex:gpt-6-luna", "gpt-6-luna", undefined]
  ])("routes %s through the signed-in vendor CLI", async (id, modelId, authMode) => {
    const resolved = await Effect.runPromise(resolve({
      SMITHERS_OPENAI_AUTH: authMode,
      PATH: codexOnPath(true),
      OPENAI_API_KEY: "unused"
    }, id))
    expect(resolved.id).toBe(id)
    expect(resolved.modelId).toBe(modelId)
    const request = await prepared(resolved, modelId)
    expect(request.url).toBe(`codex:${modelId}`)
    expect(request.publicHeaders).toEqual({})
    expect(JSON.stringify(request)).not.toContain("unused")
  })

  it.each(["signed out", "missing"])("refuses a %s vendor CLI without API key fallback", async (status) => {
    const error = await Effect.runPromise(Effect.flip(resolve({
      SMITHERS_OPENAI_AUTH: "chatgpt",
      PATH: status === "missing" ? "/nonexistent" : codexOnPath(false),
      OPENAI_API_KEY: "unused"
    }, "openai:gpt-5.6-sol")))
    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
    expect(error.message).toContain("codex login --device-auth")
  })

  it("refuses a mode value it does not know rather than guessing a credential source", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve({ SMITHERS_OPENAI_AUTH: "oauth" }, "openai:gpt-5.6-sol")))

    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
    expect(error.message).toBe(
      "SMITHERS_OPENAI_AUTH must be \"api-key\" or \"chatgpt\" to run the openai:gpt-5.6-sol seat"
    )
  })

  it("treats an empty mode exactly like an unset one: the API key path stays the default", async () => {
    const resolved = await Effect.runPromise(
      resolve({ SMITHERS_OPENAI_AUTH: "", OPENAI_API_KEY: "k" }, "openai:gpt-5.6-sol")
    )

    expect((await prepared(resolved, "gpt-5.6-sol")).url).toBe("https://api.openai.com/v1/responses")
  })

  it("scopes the mode to the openai provider: every other seat keeps its own key", async () => {
    const environment = {
      SMITHERS_OPENAI_AUTH: "chatgpt",
      PATH: "/nonexistent",
      ANTHROPIC_API_KEY: "anthropic-key"
    }

    const resolved = await Effect.runPromise(resolve(environment, "anthropic:claude-sonnet-4-5"))

    expect((await prepared(resolved, "claude-sonnet-4-5")).url).toBe("https://api.anthropic.com/v1/messages")
  })
})

describe("NodeControl.seatResolver OpenAI-compatible providers", () => {
  it.each(
    [
      ["moonshot", "moonshot:kimi-k3", "MOONSHOT_API_KEY", "https://api.moonshot.ai/v1/chat/completions"],
      [
        "gemini",
        "gemini:gemini-2.5-pro",
        "GEMINI_API_KEY",
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
      ],
      [
        "gemini via GOOGLE_API_KEY",
        "gemini:gemini-2.5-pro",
        "GOOGLE_API_KEY",
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
      ],
      ["cerebras", "cerebras:qwen-3.8-27b", "CEREBRAS_API_KEY", "https://api.cerebras.ai/v1/chat/completions"],
      ["vercel", "vercel:anthropic/claude-sonnet-4.5", "AI_GATEWAY_API_KEY", "https://ai-gateway.vercel.sh/v1/chat/completions"]
    ] as const
  )("routes a keyed %s seat through Chat Completions at its own endpoint", async (_provider, seat, variable, url) => {
    const resolved = await Effect.runPromise(resolve({ [variable]: "key" }, seat))

    expect(resolved.id).toBe(seat)
    const request = await prepared(resolved, Seat.modelIdOf(seat))
    expect(request.url).toBe(url)
    expect(JSON.stringify(request.publicHeaders)).not.toContain("key")
  })

  it("names every variable the provider reads when none is set", async () => {
    const gemini = await Effect.runPromise(Effect.flip(resolve({ GEMINI_API_KEY: "" }, "gemini:gemini-2.5-pro")))
    const moonshot = await Effect.runPromise(Effect.flip(resolve({}, "moonshot:kimi-k3")))

    expect(gemini.message).toBe("Set GEMINI_API_KEY or GOOGLE_API_KEY to run the gemini:gemini-2.5-pro seat")
    expect(moonshot.message).toBe("Set MOONSHOT_API_KEY to run the moonshot:kimi-k3 seat")
  })
})

describe("NodeControl.seatResolver Claude subscriptions", () => {
  // A stand-in `claude` that prints the status `claude auth status` would.
  const claudeOnPath = (status: object): { readonly PATH: string; readonly cleanup: () => void } => {
    const directory = mkdtempSync(join(tmpdir(), "claude-code-seat-"))
    writeFileSync(join(directory, "claude"), `#!/bin/sh\necho '${JSON.stringify(status)}'\n`, { mode: 0o755 })
    return { PATH: directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
  }
  const signedIn = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }
  let cleanup = () => {}
  afterEach(() => cleanup())

  it("shares one in-flight status probe across two concurrent seat resolves", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-code-seat-"))
    cleanup = () => rmSync(directory, { recursive: true, force: true })
    writeFileSync(
      join(directory, "claude"),
      `#!/bin/sh\necho probe >> "\${0%/*}/probes"\n/bin/sleep 0.1\necho '{"loggedIn":true,"authMethod":"claude.ai"}'\n`,
      { mode: 0o755 }
    )
    const environment = { PATH: directory }
    const [opus, fable] = await Promise.all([
      Effect.runPromise(resolve(environment, "claude-code:opus")),
      Effect.runPromise(resolve(environment, "claude-code:fable"))
    ])
    expect([opus.modelId, fable.modelId]).toEqual(["claude-opus-5-5", "claude-fable-5-1"])
    expect(readFileSync(join(directory, "probes"), "utf8")).toBe("probe\n")
  })

  it("puts executable stderr in the typed refusal when status JSON is empty", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-code-seat-"))
    cleanup = () => rmSync(directory, { recursive: true, force: true })
    writeFileSync(join(directory, "claude"), "#!/bin/sh\necho 'workspace unreachable' >&2\nexit 1\n", { mode: 0o755 })
    const error = await Effect.runPromise(Effect.flip(resolve({ PATH: directory }, "claude-code:opus")))
    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
    expect(error.message).toContain("workspace unreachable")
    expect(error.message).toContain("claude auth login")
  })

  // Anthropic lets only Claude Code sign with a subscription credential, so
  // the direct Messages route never takes one, whatever variable holds it.
  it.each(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"] as const)(
    "refuses an anthropic seat that has only %s, asking for ANTHROPIC_API_KEY",
    async (variable) => {
      const error = await Effect.runPromise(
        Effect.flip(resolve({ [variable]: "sk-ant-oat01-subscription" }, "anthropic:claude-sonnet-4-6"))
      )
      expect(error.message).toBe("Set ANTHROPIC_API_KEY to run the anthropic:claude-sonnet-4-6 seat")
    }
  )

  it("runs a claude-code seat on the signed-in Claude Code, as the model its alias names", async () => {
    const claude = claudeOnPath(signedIn)
    cleanup = claude.cleanup
    const resolved = await Effect.runPromise(resolve({ PATH: claude.PATH }, "claude-code:opus"))

    expect(resolved.id).toBe("claude-code:opus")
    expect(resolved.modelId).toBe("claude-opus-5-5")
    expect(resolved.contextWindowTokens).toBe(SeatResolver.contextWindowTokensFor("claude-opus-5-5"))
    const request = await prepared(resolved, resolved.modelId)
    expect(request).toMatchObject({ routeId: "claude-code", url: "claude-code:claude-opus-5-5" })
    expect(JSON.parse(request.bodyText).messages).toEqual([{
      role: "user",
      content: [{ type: "text", text: "hello" }]
    }])
  })

  it.each(["opus", "sonnet", "fable"] as const)(
    "runs the %s alias on an Anthropic key when one is set, else on the signed-in Claude Code",
    async (alias) => {
      const claude = claudeOnPath(signedIn)
      cleanup = claude.cleanup
      const model = Providers.expandSeat(alias).slice("anthropic:".length)
      const keyed = await Effect.runPromise(resolve({ PATH: claude.PATH, ANTHROPIC_API_KEY: "k" }, alias))
      expect([keyed.id, keyed.modelId]).toEqual([alias, model])
      expect((await prepared(keyed, keyed.modelId)).url).toBe("https://api.anthropic.com/v1/messages")
      const subscribed = await Effect.runPromise(resolve({ PATH: claude.PATH }, alias))
      expect([subscribed.id, subscribed.modelId]).toEqual([alias, model])
      expect(await prepared(subscribed, subscribed.modelId)).toMatchObject({
        routeId: "claude-code",
        url: `claude-code:${model}`
      })
    }
  )

  it("names Claude Code when a Claude alias has neither route", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve({ PATH: "/nonexistent" }, "opus")))
    expect(error.message).toBe(
      "Claude Code is not installed, so the claude-code:opus seat cannot run: install Claude Code (https://code.claude.com), then run `claude auth login`"
    )
  })

  // The Agent SDK spawns `claude` with `--no-session-persistence` unless the
  // session is kept; a stand-in records the argv and ends the turn.
  it.each([[undefined, true], ["1", false]] as const)(
    "keeps a claude-code session for `claude --resume` only when SMITHERS_HIJACKABLE is %s",
    async (hijackable, ephemeral) => {
      const directory = mkdtempSync(join(tmpdir(), "claude-code-seat-"))
      cleanup = () => rmSync(directory, { recursive: true, force: true })
      writeFileSync(
        join(directory, "claude"),
        `#!/bin/sh\nif [ "$1" = auth ]; then echo '${JSON.stringify(signedIn)}'; exit 0; fi\n` +
          `echo "$@" > "\${0%/*}/argv"\nexit 1\n`,
        { mode: 0o755 }
      )
      const resolved = await Effect.runPromise(
        resolve({ PATH: directory, SMITHERS_HIJACKABLE: hijackable }, "claude-code:opus")
      )
      await Effect.runPromiseExit(Stream.runDrain(resolved.model.stream({
        modelId: resolved.modelId,
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [],
        params: {}
      } as never)))
      expect(readFileSync(join(directory, "argv"), "utf8").includes("--no-session-persistence")).toBe(ephemeral)
    }
  )

  it.each(
    [
      [
        "an API key is set",
        { ANTHROPIC_API_KEY: "api-key" },
        signedIn,
        "$ANTHROPIC_API_KEY is set, so Claude seats run on the API, so the claude-code:opus seat cannot run: use an anthropic:<model> seat, or unset ANTHROPIC_API_KEY to use your Claude subscription"
      ],
      [
        "Claude Code is signed out",
        {},
        { loggedIn: false, authMethod: "none" },
        "Claude Code is not signed in with a Claude subscription, so the claude-code:opus seat cannot run: run `claude auth login`"
      ],
      [
        "Claude Code is signed in with an API key",
        {},
        { loggedIn: true, authMethod: "api_key" },
        "Claude Code is not signed in with a Claude subscription, so the claude-code:opus seat cannot run: run `claude auth login`"
      ]
    ] as const
  )("refuses a claude-code seat when %s", async (_case, environment, status, message) => {
    const claude = claudeOnPath(status)
    cleanup = claude.cleanup
    const error = await Effect.runPromise(
      Effect.flip(resolve({ ...environment, PATH: claude.PATH }, "claude-code:opus"))
    )
    expect(error.message).toBe(message)
  })

  it("refuses a claude-code seat when Claude Code is not installed", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve({ PATH: "/nonexistent" }, "claude-code:opus")))
    expect(error.message).toBe(
      "Claude Code is not installed, so the claude-code:opus seat cannot run: install Claude Code (https://code.claude.com), then run `claude auth login`"
    )
  })
})

describe("NodeControl.seatResolver behind SMITHERS_ACCOUNT_POOL_URL", () => {
  const pool = "https://cloud.example.test/provider-pool/"
  const pooled = {
    SMITHERS_ACCOUNT_POOL_URL: pool,
    SMITHERS_ACCOUNT_POOL_PROVIDERS: "anthropic,chatgpt",
    SMITHERS_ACCOUNT_POOL_KEY: "pool-token",
    ANTHROPIC_API_KEY: "metered-token",
    OPENAI_API_KEY: "metered-token",
    SMITHERS_MODEL_PROXY_URL: "https://cloud.example.test/model-proxy/",
    CEREBRAS_API_KEY: "cerebras-key"
  }
  // A pool answering GET /routes with whatever `answer()` returns now.
  const poolExecutor = (answer: () => ReadonlyArray<string>) => {
    const asked: Array<{ url: string; authorization: string | undefined }> = []
    const executor = RequestExecutor.RequestExecutor.of({
      execute: (request) =>
        Effect.sync(() => {
          asked.push({ url: request.url, authorization: request.headers.authorization })
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ routes: answer() }), { headers: { "content-type": "application/json" } })
          )
        })
    })
    return { asked, executor }
  }
  const resolveWith = (
    environment: Readonly<Record<string, string | undefined>>,
    executor: RequestExecutor.RequestExecutor,
    seat: string
  ) => Effect.scoped(NodeControl.seatResolver(environment, executor).resolve(seat))

  it("sends ChatGPT-mode openai and anthropic seats to the pool and every other provider direct", async () => {
    const { asked, executor } = poolExecutor(() => ["anthropic", "chatgpt"])
    const resolver = NodeControl.seatResolver(pooled, executor)
    const anthropic = await Effect.runPromise(Effect.scoped(resolver.resolve("anthropic:claude-sonnet-4-6")))
    const openai = await Effect.runPromise(Effect.scoped(resolver.resolve("openai:gpt-6-luna")))
    const cerebras = await Effect.runPromise(Effect.scoped(resolver.resolve("cerebras:qwen-3.8-27b")))

    // A connected Anthropic API key signs the seat at the pool; the host
    // sends only the pool credential, never the metered key.
    const messages = await prepared(anthropic, anthropic.modelId)
    expect(messages.url).toBe("https://cloud.example.test/provider-pool/anthropic/v1/messages")
    expect(JSON.stringify(messages)).not.toContain("metered-token")
    const chatgpt = await prepared(openai, openai.modelId)
    expect(chatgpt.url).toBe("https://cloud.example.test/provider-pool/chatgpt/codex/responses")
    expect(chatgpt.publicHeaders.originator).toBe("codex_cli_rs")
    expect((await prepared(cerebras, cerebras.modelId)).url).toBe(
      "https://cloud.example.test/model-proxy/cerebras/v1/chat/completions"
    )
    expect(asked).toEqual([{
      url: "https://cloud.example.test/provider-pool/routes",
      authorization: "Bearer pool-token"
    }])
  })

  it("keeps an anthropic seat on the host's own key while the pool has no Anthropic key, without a restart", async () => {
    let routes: ReadonlyArray<string> = ["chatgpt"]
    const { executor } = poolExecutor(() => routes)
    const before = await Effect.runPromise(resolveWith(pooled, executor, "anthropic:claude-sonnet-4-6"))
    expect((await prepared(before, before.modelId)).url).toBe(
      "https://cloud.example.test/model-proxy/anthropic/v1/messages"
    )
    // No platform key either: the seat refuses rather than borrowing another route.
    const { ANTHROPIC_API_KEY: _metered, SMITHERS_MODEL_PROXY_URL: _proxy, ...keyless } = pooled
    await expect(Effect.runPromise(resolveWith(keyless, executor, "anthropic:claude-sonnet-4-6"))).rejects
      .toMatchObject({ _tag: "@smthrs/agent/Seat/SeatUnresolved" })

    routes = ["anthropic", "chatgpt"]
    const after = await Effect.runPromise(resolveWith(keyless, executor, "anthropic:claude-sonnet-4-6"))
    expect((await prepared(after, after.modelId)).url).toBe(
      "https://cloud.example.test/provider-pool/anthropic/v1/messages"
    )
  })

  it("resolves the Claude aliases at the pool instead of Claude Code", async () => {
    const { executor } = poolExecutor(() => ["anthropic"])
    const { ANTHROPIC_API_KEY: _metered, SMITHERS_MODEL_PROXY_URL: _proxy, ...keyless } = pooled
    const opus = await Effect.runPromise(resolveWith(keyless, executor, "opus"))
    expect(opus.id).toBe("opus")
    expect((await prepared(opus, opus.modelId)).url).toBe(
      "https://cloud.example.test/provider-pool/anthropic/v1/messages"
    )
  })

  it("keeps a Claude alias on the signed-in Claude Code while the pool has no Anthropic key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-code-seat-"))
    try {
      writeFileSync(
        join(directory, "claude"),
        `#!/bin/sh\necho '${JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })}'\n`,
        { mode: 0o755 }
      )
      let routes: ReadonlyArray<string> = ["chatgpt"]
      const { executor } = poolExecutor(() => routes)
      const { ANTHROPIC_API_KEY: _metered, SMITHERS_MODEL_PROXY_URL: _proxy, ...keyless } = pooled
      const subscribed = await Effect.runPromise(resolveWith({ ...keyless, PATH: directory }, executor, "opus"))
      expect(subscribed.id).toBe("opus")
      expect(await prepared(subscribed, subscribed.modelId)).toMatchObject({
        routeId: "claude-code",
        url: "claude-code:claude-opus-5-5"
      })
      // The alias is offered either way, and a key connected later serves it.
      expect(
        await NodeControl.seatCandidates({
          environment: keyless,
          homeDirectory: directory,
          readFile: () => undefined,
          claudeCode: async () => undefined
        })
      ).toContain("opus")
      routes = ["anthropic"]
      const pooledSeat = await Effect.runPromise(
        resolveWith({ ...keyless, PATH: directory }, executor, "opus")
      )
      expect((await prepared(pooledSeat, pooledSeat.modelId)).url).toBe(
        "https://cloud.example.test/provider-pool/anthropic/v1/messages"
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("refuses an empty pool without API-key fallback, then uses a newly connected account", async () => {
    let routes: ReadonlyArray<string> = []
    const { asked, executor } = poolExecutor(() => routes)
    await expect(Effect.runPromise(resolveWith(pooled, executor, "openai:gpt-6-luna"))).rejects.toMatchObject({
      _tag: "@smthrs/agent/Seat/SeatUnresolved"
    })

    // No restart: a resolver built after the connect asks the pool again.
    routes = ["chatgpt"]
    const after = await Effect.runPromise(resolveWith(pooled, executor, "openai:gpt-6-luna"))
    expect((await prepared(after, after.modelId)).url).toBe(
      "https://cloud.example.test/provider-pool/chatgpt/codex/responses"
    )
    expect(asked).toHaveLength(2)
  })

  it("keeps a repository's own key on a route the pool is not offered, and never asks without the pool key", async () => {
    const { asked, executor } = poolExecutor(() => ["anthropic", "chatgpt"])
    // The backend offers only the routes the repository does not key itself.
    const anthropic = await Effect.runPromise(resolveWith(
      {
        SMITHERS_ACCOUNT_POOL_URL: pool,
        SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt",
        SMITHERS_ACCOUNT_POOL_KEY: "pool-token",
        ANTHROPIC_API_KEY: "repository-key"
      },
      executor,
      "anthropic:claude-sonnet-4-6"
    ))
    expect((await prepared(anthropic, anthropic.modelId)).url).toBe("https://api.anthropic.com/v1/messages")
    const openai = await Effect.runPromise(resolveWith(
      {
        SMITHERS_ACCOUNT_POOL_URL: pool,
        SMITHERS_ACCOUNT_POOL_PROVIDERS: "anthropic",
        SMITHERS_ACCOUNT_POOL_KEY: "pool-token",
        OPENAI_API_KEY: "repository-key"
      },
      executor,
      "openai:gpt-6-luna"
    ))
    expect((await prepared(openai, openai.modelId)).url).toBe("https://api.openai.com/v1/responses")
    expect(asked).toEqual([])
    await expect(Effect.runPromise(resolveWith(
      { SMITHERS_ACCOUNT_POOL_URL: pool, SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt", OPENAI_API_KEY: "repository-key" },
      executor,
      "openai:gpt-6-luna"
    ))).rejects.toMatchObject({ _tag: "@smthrs/agent/Seat/SeatUnresolved" })
    expect(asked).toEqual([])
  })

  it("refuses every pooled seat while the pool does not answer", async () => {
    let calls = 0
    const unreachable = RequestExecutor.RequestExecutor.of({
      execute: () => {
        calls++
        return Effect.fail(new ModelError.ModelError({ code: "transport", message: "connection refused" }))
      }
    })
    const resolver = NodeControl.seatResolver(pooled, unreachable)
    for (const id of ["openai:gpt-6-sol", "openai:gpt-6-luna"]) {
      await expect(Effect.runPromise(Effect.scoped(resolver.resolve(id)))).rejects.toMatchObject({
        _tag: "@smthrs/agent/Seat/SeatUnresolved"
      })
    }
    expect(calls).toBe(1)
  })

  it("keeps a configured pool on subscriptions even with stale api-key mode", async () => {
    const { executor } = poolExecutor(() => ["anthropic", "chatgpt"])
    const resolved = await Effect.runPromise(
      resolveWith({ ...pooled, SMITHERS_OPENAI_AUTH: "api-key" }, executor, "openai:gpt-6-luna")
    )
    expect((await prepared(resolved, resolved.modelId)).url).toBe(
      "https://cloud.example.test/provider-pool/chatgpt/codex/responses"
    )
  })

  it("asks the pool again once its answer is 30 seconds old, without a restart", async () => {
    let routes: ReadonlyArray<string> = []
    const { asked, executor } = poolExecutor(() => routes)
    const resolver = NodeControl.seatResolver(pooled, executor)
    const urls = await Effect.runPromise(
      Effect.gen(function*() {
        const url = (seat: Seat.Seat) => Effect.promise(async () => (await prepared(seat, seat.modelId)).url)
        const first = yield* Effect.flip(Effect.scoped(resolver.resolve("openai:gpt-6-luna")))
        routes = ["chatgpt"]
        yield* TestClock.adjust("20 seconds")
        const cached = yield* Effect.flip(Effect.scoped(resolver.resolve("openai:gpt-6-luna")))
        yield* TestClock.adjust("11 seconds")
        const next = yield* Effect.scoped(resolver.resolve("openai:gpt-6-luna"))
        return [first._tag, cached._tag, yield* url(next)]
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(urls).toEqual([
      "@smthrs/agent/Seat/SeatUnresolved",
      "@smthrs/agent/Seat/SeatUnresolved",
      "https://cloud.example.test/provider-pool/chatgpt/codex/responses"
    ])
    expect(asked).toHaveLength(2)
  })
})

describe("NodeControl.seatResolver behind SMITHERS_MODEL_PROXY_URL", () => {
  const proxy = "https://cloud.example.test/api/model/"

  it.each(
    [
      [
        "anthropic:claude-sonnet-4-5",
        "ANTHROPIC_API_KEY",
        "https://cloud.example.test/api/model/anthropic/v1/messages"
      ],
      ["claude-opus-4-1", "ANTHROPIC_API_KEY", "https://cloud.example.test/api/model/anthropic/v1/messages"],
      ["openai:gpt-5.6-sol", "OPENAI_API_KEY", "https://cloud.example.test/api/model/openai/v1/responses"],
      [
        "openrouter:openai/gpt-5.6-sol",
        "OPENROUTER_API_KEY",
        "https://cloud.example.test/api/model/openrouter/v1/responses"
      ],
      [
        "cerebras:qwen-3.8-27b",
        "CEREBRAS_API_KEY",
        "https://cloud.example.test/api/model/cerebras/v1/chat/completions"
      ],
      ["moonshot:kimi-k3", "MOONSHOT_API_KEY", "https://api.moonshot.ai/v1/chat/completions"]
    ] as const
  )("sends a %s seat to the proxied origin", async (seat, variable, url) => {
    const resolved = await Effect.runPromise(
      resolve({ SMITHERS_MODEL_PROXY_URL: proxy, [variable]: "cloud-token" }, seat)
    )

    const request = await prepared(resolved, resolved.modelId)
    expect(request.url).toBe(url)
    expect(JSON.stringify(request.publicHeaders)).not.toContain("cloud-token")
  })

  it("sends a ChatGPT-mode openai seat to the proxied ChatGPT backend with the proxy credential", async () => {
    const resolved = await Effect.runPromise(
      resolve(
        { SMITHERS_MODEL_PROXY_URL: proxy, SMITHERS_OPENAI_AUTH: "chatgpt", OPENAI_API_KEY: "cloud-token" },
        "openai:gpt-6-luna"
      )
    )

    const request = await prepared(resolved, resolved.modelId)
    expect(request.url).toBe("https://cloud.example.test/api/model/chatgpt/codex/responses")
    expect(JSON.stringify(request)).not.toContain("cloud-token")
    expect(request.publicHeaders.originator).toBe("codex_cli_rs")
  })

  it("refuses a ChatGPT-mode seat behind the proxy without the proxy credential", async () => {
    const error = await Effect.runPromise(
      Effect.flip(resolve({ SMITHERS_MODEL_PROXY_URL: proxy, SMITHERS_OPENAI_AUTH: "chatgpt" }, "openai:gpt-6-luna"))
    )

    expect(error.message).toBe("Set OPENAI_API_KEY to run the openai:gpt-6-luna seat through the model proxy")
  })

  it("keeps a provider the proxy does not serve on its own origin", async () => {
    const limited = { SMITHERS_MODEL_PROXY_URL: proxy, SMITHERS_MODEL_PROXY_PROVIDERS: "anthropic,vercel" }
    const anthropic = await Effect.runPromise(
      resolve({ ...limited, ANTHROPIC_API_KEY: "cloud-token" }, "anthropic:claude-sonnet-4-5")
    )
    expect((await prepared(anthropic, anthropic.modelId)).url).toBe(
      "https://cloud.example.test/api/model/anthropic/v1/messages"
    )
    const openai = await Effect.runPromise(resolve({ ...limited, OPENAI_API_KEY: "own-key" }, "openai:gpt-5.6-sol"))
    expect((await prepared(openai, openai.modelId)).url).toBe("https://api.openai.com/v1/responses")
    const chatgpt = await Effect.runPromise(
      Effect.flip(
        resolve({ ...limited, SMITHERS_OPENAI_AUTH: "chatgpt", PATH: "/nonexistent" }, "openai:gpt-6-luna")
      )
    )
    expect(chatgpt.message).toContain("codex login")
  })

  it("sends an AI Gateway seat to the proxy's Gateway route with the host's proxy credential", async () => {
    const gateway = { SMITHERS_MODEL_PROXY_URL: proxy, SMITHERS_MODEL_PROXY_PROVIDERS: "vercel" }
    const resolved = await Effect.runPromise(
      resolve({ ...gateway, AI_GATEWAY_API_KEY: "smithers_flowhost_seat" }, "vercel:openai/gpt-5.1")
    )
    const request = await prepared(resolved, resolved.modelId)
    expect(resolved.modelId).toBe("openai/gpt-5.1")
    expect(request.url).toBe("https://cloud.example.test/api/model/vercel/v1/chat/completions")
    expect(JSON.stringify(request.publicHeaders)).not.toContain("smithers_flowhost_seat")
    const keyless = await Effect.runPromise(Effect.flip(resolve(gateway, "vercel:openai/gpt-5.1")))
    expect(keyless.message).toBe("Set AI_GATEWAY_API_KEY to run the vercel:openai/gpt-5.1 seat")
  })

  it("treats an empty proxy variable as unset", async () => {
    const resolved = await Effect.runPromise(
      resolve({ SMITHERS_MODEL_PROXY_URL: "", ANTHROPIC_API_KEY: "key" }, "anthropic:claude-sonnet-4-5")
    )

    expect((await prepared(resolved, resolved.modelId)).url).toBe("https://api.anthropic.com/v1/messages")
  })
})

describe("NodeControl.seatResolver aliases", () => {
  it.each(
    [
      ["sol", "gpt-6.1-sol", "https://api.openai.com/v1/responses"],
      ["luna", "gpt-6-luna", "https://api.openai.com/v1/responses"],
      ["opus", "claude-opus-5-5", "https://api.anthropic.com/v1/messages"],
      ["sonnet", "claude-sonnet-5-5", "https://api.anthropic.com/v1/messages"],
      ["fable", "claude-fable-5-1", "https://api.anthropic.com/v1/messages"],
      ["kimi", "kimi-k3", "https://api.moonshot.ai/v1/chat/completions"],
      ["Luna ", "gpt-6-luna", "https://api.openai.com/v1/responses"]
    ] as const
  )("resolves %j to its provider's route and keeps the declared id", async (alias, modelId, url) => {
    const resolved = await Effect.runPromise(resolve(keyed, alias))

    expect(resolved.id).toBe(alias)
    expect(resolved.modelId).toBe(modelId)
    expect((await prepared(resolved, resolved.modelId)).url).toBe(url)
  })

  it("reads the aliased provider's credential, naming the expanded seat", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve({ ANTHROPIC_API_KEY: "k" }, "luna")))

    expect(error.message).toBe("Set OPENAI_API_KEY to run the openai:gpt-6-luna seat")
  })

  it.each(["jev", "typesafe-ai/jev", "openrouter:typesafe-ai/jev"])("refuses %j as an agent seat", async (seat) => {
    const error = await Effect.runPromise(Effect.flip(resolve(keyed, seat)))

    expect(error.seat).toBe(seat)
    expect(error.message).toContain("classifier")
  })
})
