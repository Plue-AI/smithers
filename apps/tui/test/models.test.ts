import * as NodeControl from "@smthrs/cli/NodeControl"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Models from "../src/models.ts"

/** Claude Code signs its own requests, so resolving its seat never reaches the executor. */
const unusedExecutor = {} as RequestExecutor.RequestExecutor

describe("seatOf", () => {
  const available: ReadonlyArray<Models.Model> = [{ seat: "test:worker", label: "Test", provider: "Test" }]
  test.each(
    [
      ["sol", "openai:gpt-6.1-sol"],
      ["luna", Models.delegateModels.luna],
      // A Claude alias stays an alias: the seat resolver runs it on a key or on Claude Code.
      ["opus", "opus"],
      ["fable", "fable"],
      [" Sonnet ", "sonnet"],
      ["qwen", Models.delegateModels.cerebras],
      [" Sol ", "openai:gpt-6.1-sol"],
      ["openai:gpt-6-sol", "openai:gpt-6-sol"],
      ["anthropic:claude-opus-5-5", "anthropic:claude-opus-5-5"],
      ["cerebras:gpt-oss-120b", "cerebras:gpt-oss-120b"],
      ["test:other", "test:other"],
      ["gpt-9", undefined],
      ["nowhere:model", undefined],
      ["openai:", undefined],
      ["", undefined]
    ] as const
  )("%p resolves to %p", (declared, seat) => {
    expect(Models.seatOf(declared, available)).toBe(seat)
  })
})

describe("default chat seat", () => {
  test("prefers Cerebras, then Sol, then another available provider", async () => {
    expect((await Models.detect({ CEREBRAS_API_KEY: "test", OPENAI_API_KEY: "test" })).defaultSeat).toBe(
      Models.delegateModels.cerebras
    )
    expect((await Models.detect({ OPENAI_API_KEY: "test", MOONSHOT_API_KEY: "test" })).defaultSeat).toBe(
      Models.delegateModels.sol
    )
    expect((await Models.detect({ OPENAI_API_KEY: "test", SMITHERS_TUI_SEAT: "custom:chat" })).defaultSeat).toBe(
      "custom:chat"
    )
  })

  test("keeps Codex subscription seats behind explicit opt-in even when an API key is present", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "tui-codex-"))
    try {
      writeFileSync(
        join(codexHome, "auth.json"),
        JSON.stringify({
          tokens: { access_token: "fixture-session", refresh_token: "fixture-refresh" }
        })
      )
      const environment = { CODEX_HOME: codexHome, OPENAI_API_KEY: "key" }
      const keyed = Models.detectWithoutClaude(environment)
      expect(keyed.environment.SMITHERS_OPENAI_AUTH).toBeUndefined()
      expect(keyed.models.filter((model) => model.seat.startsWith("openai:"))).toEqual(
        expect.arrayContaining([expect.objectContaining({ provider: "OpenAI" })])
      )
      expect(keyed.models.some((model) => model.provider === "Codex subscription")).toBe(false)

      const optedIn = Models.detectWithoutClaude({ ...environment, SMITHERS_OPENAI_AUTH: "chatgpt" })
      expect(optedIn.environment.SMITHERS_OPENAI_AUTH).toBe("chatgpt")
      expect(optedIn.models.filter((model) => model.seat.startsWith("openai:"))).toEqual(
        expect.arrayContaining([expect.objectContaining({ provider: "Codex subscription" })])
      )
      expect(optedIn.models.some((model) => model.provider === "OpenAI")).toBe(false)
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })
})

describe("account pool startup discovery", () => {
  const environment = {
    PATH: "",
    CODEX_HOME: "/nonexistent",
    SMITHERS_ACCOUNT_POOL_URL: "https://pool.test",
    SMITHERS_ACCOUNT_POOL_KEY: "fixture-key",
    SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt,anthropic"
  }
  const transport = (body: string, status = 200) => {
    const requests: string[] = []
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url)
        expect(request.headers.authorization).toBe("Bearer fixture-key")
        return HttpClientResponse.fromWeb(request, new Response(body, { status }))
      })
    )
    return {
      requests,
      layer: RequestExecutor.layer.pipe(Layer.provide(Layer.succeed(KernelHttpClient.HttpClient)(client)))
    }
  }

  test.each([
    { routes: ["chatgpt"], seat: "openai:gpt-6-luna" },
    { routes: ["anthropic"], seat: "anthropic:claude-sonnet-4-6" },
    { routes: ["anthropic", "chatgpt"], seat: "openai:gpt-6-luna" }
  ])("offers only a shared resolver default grounded in connected routes $routes", async ({ routes, seat }) => {
    const fixture = transport(JSON.stringify({ routes }))
    const available = await Models.detect(environment, fixture.layer)
    expect(available.defaultSeat).toBe(seat)
    expect(available.workerSeat).toBe(seat)
    expect(available.models).toEqual([{ seat, label: expect.any(String), provider: "Account pool" }])
    expect(fixture.requests).toEqual(["https://pool.test/routes"])
    expect(available.environment).toEqual(environment)
  })

  test.each([
    { body: "not json", status: 200 },
    { body: "null", status: 200 },
    { body: JSON.stringify({ routes: [] }), status: 200 },
    { body: JSON.stringify({ routes: ["unknown"] }), status: 200 },
    { body: JSON.stringify({ routes: ["chatgpt"] }), status: 401 },
    { body: JSON.stringify({ routes: ["chatgpt"] }), status: 403 }
  ])("refuses failed or unusable discovery %j without inventing a model", async ({ body, status }) => {
    const fixture = transport(body, status)
    const available = await Models.detect(environment, fixture.layer)
    expect(available.models).toEqual([])
    expect(available.defaultSeat).toBeUndefined()
    expect(available.workerSeat).toBeUndefined()
    expect(fixture.requests).toEqual(["https://pool.test/routes"])
  })

  test("unpermitted routes and incomplete credentials never produce an offered seat", async () => {
    const fixture = transport(JSON.stringify({ routes: ["chatgpt"] }))
    expect(
      (await Models.detect({ ...environment, SMITHERS_ACCOUNT_POOL_PROVIDERS: "anthropic" }, fixture.layer)).models
    ).toEqual([])
    for (
      const missing of ["SMITHERS_ACCOUNT_POOL_URL", "SMITHERS_ACCOUNT_POOL_KEY", "SMITHERS_ACCOUNT_POOL_PROVIDERS"]
    ) {
      const before = fixture.requests.length
      expect((await Models.detect({ ...environment, [missing]: "" }, fixture.layer)).models).toEqual([])
      expect(fixture.requests.length).toBe(before)
    }
  })

  test("keeps local credentials and explicit chat/worker overrides while adding a discovered pool seat", async () => {
    const fixture = transport(JSON.stringify({ routes: ["chatgpt"] }))
    const keyed = await Models.detect({ ...environment, OPENAI_API_KEY: "local-key" }, fixture.layer)
    expect(keyed.defaultSeat).toBe(Models.delegateModels.sol)
    expect(keyed.models.map((model) => model.seat)).toEqual([Models.delegateModels.sol, "openai:gpt-6-luna"])
    const overridden = await Models.detect({
      ...environment,
      SMITHERS_TUI_SEAT: "custom:chat",
      SMITHERS_TUI_WORKER_SEAT: "custom:worker"
    }, fixture.layer)
    expect(overridden.defaultSeat).toBe("custom:chat")
    expect(overridden.workerSeat).toBe("custom:worker")
    expect(overridden.models).toHaveLength(1)
  })
})

describe("routing", () => {
  const available: Models.Available = {
    models: [
      { seat: "openai:gpt-6-sol", label: "GPT-6 Sol", provider: "OpenAI" },
      { seat: "openai:gpt-6-sol", label: "GPT-6 Sol", provider: "OpenRouter" },
      { seat: "cerebras:qwen", label: "Qwen", provider: "Cerebras" },
      { seat: Models.delegateModels.cerebras, label: "Qwen 3.8", provider: "Cerebras" },
      { seat: "gemini:gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "Gemini" }
    ],
    defaultSeat: undefined,
    workerSeat: undefined,
    environment: {}
  }

  test("offers the routing graph's seats whose provider runs here", () => {
    const service = Models.routing(available, {}, true)!
    expect(Effect.runSync(service.candidates)).toEqual(["luna", "sol"])
  })

  test("offers the Claude seats on Claude Code as on an Anthropic key", () => {
    for (const seat of ["claude-code:opus", "anthropic:claude-opus-5-5"]) {
      const claude = { ...available, models: [{ seat, label: "Claude Opus 5.5", provider: "Claude" }] }
      expect(Effect.runSync(Models.routing(claude, {}, true)!.candidates)).toEqual(["opus", "fable", "sonnet"])
    }
  })

  test("routes nothing unjudged or when the operator named the worker seat", () => {
    expect(Models.routing(available, {}, false)).toBeUndefined()
    expect(Models.routing(available, { SMITHERS_TUI_WORKER_SEAT: "openai:gpt-6-sol" }, true)).toBeUndefined()
  })
})

describe("delegable", () => {
  test("names aliases and detected seats whose provider is reachable", async () => {
    const openai = [{ seat: "openai:gpt-6-sol", label: "GPT-6 Sol", provider: "OpenAI" }]
    expect(Models.delegable(openai)).not.toContain("cerebras")
    expect(Models.delegable(openai)).toContain("sol")
    expect(Models.delegable(openai)).toContain("openai:gpt-6-sol")
    expect(Models.delegable([{ seat: Models.delegateModels.cerebras, label: "Qwen 3.8", provider: "Cerebras" }]))
      .toEqual(["cerebras", "qwen", Models.delegateModels.cerebras])
    const claude = (await Models.detect({ ANTHROPIC_API_KEY: "test" })).models
    expect(Models.delegable(claude)).toEqual(expect.arrayContaining(["opus", "sonnet", "fable"]))
    expect(Models.delegable(claude)).not.toContain("claude-code:opus")
    expect(Models.delegable([])).toEqual([])
  })
})

describe("Claude Code seats", () => {
  const claudeOnPath = (status: object) => {
    const directory = mkdtempSync(join(tmpdir(), "tui-claude-"))
    writeFileSync(join(directory, "claude"), `#!/bin/sh\necho '${JSON.stringify(status)}'\n`, { mode: 0o755 })
    return directory
  }

  test("offers claude-code seats for a Claude Code subscription, and Anthropic seats instead for a key", async () => {
    const directory = claudeOnPath({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })
    try {
      const claude = (models: ReadonlyArray<Models.Model>) =>
        models.filter((model) => model.seat.startsWith("claude-code:") || model.seat.startsWith("anthropic:"))
      expect(claude((await Models.detect({ PATH: directory })).models)).toEqual([
        { seat: "claude-code:opus", label: "Claude Opus 5.5", provider: "Claude Code" },
        { seat: "claude-code:sonnet", label: "Claude Sonnet 5.5", provider: "Claude Code" },
        { seat: "claude-code:fable", label: "Claude Fable 5.1", provider: "Claude Code" }
      ])
      expect(Models.delegable((await Models.detect({ PATH: directory })).models)).toEqual(expect.arrayContaining([
        "opus",
        "sonnet",
        "fable",
        "claude-code:opus",
        "claude-code:sonnet",
        "claude-code:fable"
      ]))
      const keyed = claude((await Models.detect({ PATH: directory, ANTHROPIC_API_KEY: "k" })).models).map((model) =>
        model.seat
      )
      expect(keyed).toEqual(["anthropic:claude-opus-5-5", "anthropic:claude-sonnet-5-5", "anthropic:claude-fable-5-1"])
      expect(Models.seatOf("claude-code:opus", [])).toBe("claude-code:opus")
      expect(Models.labelOf("claude-code:fable", [])).toBe("Claude Fable 5.1")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("runs an agent file's `model: opus` on Claude Code when no Anthropic key is set", async () => {
    const directory = claudeOnPath({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })
    try {
      const environment = { PATH: directory }
      const seat = Models.seatOf("opus", (await Models.detect(environment)).models)!
      expect(seat).toBe("opus")
      // The Anthropic route would refuse without a key; Claude Code runs it.
      const resolved = await Effect.runPromise(NodeControl.seatResolver(environment, unusedExecutor).resolve(seat))
      expect([resolved.id, resolved.modelId]).toEqual(["opus", "claude-opus-5-5"])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("uses the startup probe for a token-backed seat resolve", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tui-claude-"))
    writeFileSync(
      join(directory, "claude"),
      `#!/bin/sh\necho probe >> "\${0%/*}/probes"\necho '{"loggedIn":true,"authMethod":"oauth_token"}'\n`,
      { mode: 0o755 }
    )
    try {
      const available = await Models.detect({ PATH: directory, CLAUDE_CODE_OAUTH_TOKEN: "test-token" })
      await Effect.runPromise(NodeControl.seatResolver(available.environment, unusedExecutor).resolve("opus"))
      expect(readFileSync(join(directory, "probes"), "utf8")).toBe("probe\n")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("offers none when Claude Code is signed out", async () => {
    const directory = claudeOnPath({ loggedIn: false, authMethod: "none" })
    try {
      expect((await Models.detect({ PATH: directory })).models.filter((model) => model.provider === "Claude Code"))
        .toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
