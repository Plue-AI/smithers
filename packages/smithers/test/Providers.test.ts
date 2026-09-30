/**
 * Seat detection for `smthrs suggest`, over a fake environment and file
 * reader: the documented order, every way a candidate is or is not available,
 * the choice, and the two refusals.
 */
import * as Effect from "effect/Effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as Providers from "../src/Providers.ts"

const host = (
  environment: Readonly<Record<string, string | undefined>>,
  files: Readonly<Record<string, string>> = {}
): Providers.Host => ({
  environment,
  homeDirectory: "/home/op",
  readFile: (path) => files[path]
})

describe("Providers.detect", () => {
  it("reports every candidate in the documented order, all unavailable on a bare machine", () => {
    const detections = Providers.detect(host({}))

    expect(detections.map((detection) => detection.id)).toEqual([
      "codex-subscription",
      "kimi-k3",
      "openai",
      "gemini",
      "openrouter",
      "cerebras"
    ])
    expect(detections.every((detection) => !detection.available)).toBe(true)
    expect(detections.map((detection) => detection.seat)).toEqual([
      "codex:sol",
      "moonshot:kimi-k3",
      "openai:gpt-6-sol",
      "gemini:gemini-2.5-pro",
      "openrouter:openai/gpt-6-sol",
      "cerebras:qwen-3.8-27b"
    ])
    expect(detections.some((detection) => detection.seat.startsWith("anthropic"))).toBe(false)
  })

  it.each([undefined, "", "api-key", "oauth"])("requires explicit Codex opt-in for %j", (mode) => {
    const readFile = vi.fn(() => {
      throw new Error("credential files must not be read")
    })
    const [codex] = Providers.detect({ ...host({ SMITHERS_OPENAI_AUTH: mode }), readFile })

    expect(codex!.available).toBe(false)
    expect(codex!.reason).toBe("set SMITHERS_OPENAI_AUTH=chatgpt to use Codex")
    expect(codex!.environment).toEqual({ SMITHERS_OPENAI_AUTH: "chatgpt" })
    expect(codex!.setupHint).toContain("codex login")
    expect(readFile).not.toHaveBeenCalled()
  })

  it("takes explicit Codex opt-in without reading vendor credentials", () => {
    const readFile = vi.fn(() => {
      throw new Error("credential files must not be read")
    })
    const [codex] = Providers.detect({
      ...host({ SMITHERS_OPENAI_AUTH: "chatgpt", CODEX_HOME: "/elsewhere" }),
      readFile
    })

    expect(codex!.available).toBe(true)
    expect(codex!.reason).toBe("SMITHERS_OPENAI_AUTH=chatgpt")
    expect(codex!.seat).toBe("codex:sol")
    expect(readFile).not.toHaveBeenCalled()
  })

  it.each(
    [
      ["kimi-k3", "MOONSHOT_API_KEY"],
      ["openai", "OPENAI_API_KEY"],
      ["gemini", "GEMINI_API_KEY"],
      ["gemini", "GOOGLE_API_KEY"],
      ["openrouter", "OPENROUTER_API_KEY"],
      ["cerebras", "CEREBRAS_API_KEY"]
    ] as const
  )("marks %s available when %s is set", (id, variable) => {
    const detection = Providers.detect(host({ [variable]: "k" })).find((entry) => entry.id === id)!

    expect(detection.available).toBe(true)
    expect(detection.reason).toBe(`$${variable} is set`)
    expect(detection.environment).toEqual({})
  })

  it("treats an exported-but-empty key as unset and says so", () => {
    const openai = Providers.detect(host({ OPENAI_API_KEY: "" })).find((entry) => entry.id === "openai")!

    expect(openai.available).toBe(false)
    expect(openai.reason).toBe("$OPENAI_API_KEY exported but empty")
    // Spelled without an `=`: `bin.ts` redacts every failure line it prints,
    // and `KEY=<value>` is exactly the shape `Redaction.redact` rewrites.
    expect(openai.setupHint).toBe("set OPENAI_API_KEY to your API key")
  })
})

describe("Providers.chooseSeat", () => {
  it("chooses the first available candidate in order", () => {
    const detections = Providers.detect(host({ OPENAI_API_KEY: "k", MOONSHOT_API_KEY: "m", CEREBRAS_API_KEY: "c" }))
    const chosen = Providers.chooseSeat(detections)

    expect(chosen).toMatchObject({ seat: "moonshot:kimi-k3", source: "kimi-k3", label: "Kimi K3" })
  })

  it("prefers an explicitly selected Codex session over every key", () => {
    const detections = Providers.detect(
      host({ MOONSHOT_API_KEY: "m", SMITHERS_OPENAI_AUTH: "chatgpt" })
    )
    const chosen = Providers.chooseSeat(detections)

    expect(chosen).toMatchObject({
      seat: "codex:sol",
      source: "codex-subscription",
      environment: { SMITHERS_OPENAI_AUTH: "chatgpt" }
    })
  })

  it("chooses a key instead of an unconfigured Codex login", () => {
    const chosen = Providers.chooseSeat(Providers.detect(
      host({ OPENAI_API_KEY: "k" })
    ))

    expect(chosen).toMatchObject({ source: "openai", environment: {} })
  })

  it("lists every seat it checked when nothing is available", () => {
    const detections = Providers.detect(host({ OPENAI_API_KEY: "" }))
    const chosen = Providers.chooseSeat(detections)

    expect(chosen).toBeInstanceOf(Providers.NoSeatError)
    const message = (chosen as Providers.NoSeatError).message
    expect(message).toContain("No model seat is available")
    expect(message).toContain("Codex subscription (codex:sol): set SMITHERS_OPENAI_AUTH=chatgpt to use Codex")
    expect(message).toContain("Kimi K3 (moonshot:kimi-k3): $MOONSHOT_API_KEY is not set")
    expect(message).toContain("OpenAI (openai:gpt-6-sol): $OPENAI_API_KEY exported but empty")
    expect(message).toContain("Gemini (gemini:gemini-2.5-pro): $GEMINI_API_KEY or $GOOGLE_API_KEY is not set")
    expect(message).toContain("Cerebras (cerebras:qwen-3.8-27b)")
    expect(message).toContain("--seat <provider:model>")
  })

  it("takes an override ahead of every detection, available or not", () => {
    const chosen = Providers.chooseSeat(Providers.detect(host({})), "openrouter:vendor/model:beta")

    expect(chosen).toEqual({
      seat: "openrouter:vendor/model:beta",
      source: "override",
      label: "--seat openrouter:vendor/model:beta",
      environment: {}
    })
  })

  it.each(["gpt", ":model", "openai:", ""])("refuses the malformed override %j", (override) => {
    const chosen = Providers.chooseSeat([], override)

    expect(chosen).toBeInstanceOf(Providers.SeatSyntaxError)
    expect((chosen as Error).message).toBe(`--seat must be spelled provider:model, got "${override}"`)
  })

  it("refuses an Anthropic override", () => {
    const chosen = Providers.chooseSeat([], "anthropic:claude-sonnet-4-5")

    expect(chosen).toBeInstanceOf(Providers.SeatSyntaxError)
    expect((chosen as Error).message).toContain("never uses an Anthropic seat")
  })

  it.each(
    [
      ["gpt", "malformed"],
      ["anthropic:claude-sonnet-4-5", "anthropic"]
    ] as const
  )("names why the override %j is refused, so a caller can branch on it", (override, reason) => {
    const chosen = Providers.chooseSeat([], override) as Providers.SeatSyntaxError
    const handled = Effect.runSync(
      Effect.fail(chosen).pipe(
        Effect.catchTag("/suggest/SeatSyntaxError", (error) => Effect.succeed(`${error.reason} ${error.seat}`))
      )
    )

    expect(handled).toBe(`${reason} ${override}`)
  })

  it("fails as a tagged refusal a caller can catch when nothing is available", () => {
    const chosen = Providers.chooseSeat(Providers.detect(host({}))) as Providers.NoSeatError
    const handled = Effect.runSync(
      Effect.fail(chosen).pipe(
        Effect.catchTag("/suggest/NoSeatError", (error) => Effect.succeed(error.detections.length))
      )
    )

    expect(handled).toBe(Providers.detect(host({})).length)
  })
})

describe("Providers.compatibleKey", () => {
  it("reads the provider's variables in order and ignores empty ones", () => {
    expect(Providers.compatibleKey("gemini", { GEMINI_API_KEY: "", GOOGLE_API_KEY: "g" })).toEqual({
      variable: "GOOGLE_API_KEY",
      key: "g"
    })
    expect(Providers.compatibleKey("gemini", { GEMINI_API_KEY: "x", GOOGLE_API_KEY: "g" })).toEqual({
      variable: "GEMINI_API_KEY",
      key: "x"
    })
    expect(Providers.compatibleKey("moonshot", {})).toBeUndefined()
    expect(Providers.compatibleKey("constructor", { MOONSHOT_API_KEY: "m" })).toBeUndefined()
  })
})

describe("Providers default seats", () => {
  it("never default a candidate or a starter credential to a GPT-5.6 model", () => {
    const seats = [...Object.values(Providers.defaultSeat), ...Providers.starterSeats.map(([, seat]) => seat)]
    expect(seats.filter((seat) => /gpt-5\.6/.test(seat))).toEqual([])
    expect(Providers.defaultSeat.openai).toBe("openai:gpt-6-sol")
    expect(Providers.defaultSeat["codex-subscription"]).toBe("codex:sol")
    expect(Providers.defaultSeat.openrouter).toBe("openrouter:openai/gpt-6-sol")
  })
})

describe("Providers seat aliases", () => {
  it("names one provider:model per alias", () => {
    expect(Providers.seatAliases).toEqual({
      sol: "openai:gpt-6.1-sol",
      luna: "openai:gpt-6-luna",
      opus: "anthropic:claude-opus-5-5",
      sonnet: "anthropic:claude-sonnet-5-5",
      fable: "anthropic:claude-fable-5-1",
      kimi: Providers.defaultSeat["kimi-k3"],
      qwen: Providers.defaultSeat.cerebras
    })
  })

  it.each([
    ["luna", "openai:gpt-6-luna"],
    [" OPUS ", "anthropic:claude-opus-5-5"],
    ["openai:gpt-6-sol", "openai:gpt-6-sol"],
    ["coding/implement", "coding/implement"],
    ["jev", "jev"]
  ])("expands %j to %j", (seat, expected) => {
    expect(Providers.expandSeat(seat)).toBe(expected)
  })

  it.each([
    ["luna", undefined],
    ["anthropic:claude-opus-5-5", undefined],
    ["jev", "classifier"],
    ["vercel:typesafe-ai/jev", "classifier"],
    ["typesafe-ai/jev", "classifier"],
    ["gpt-6-luna", "neither"],
    ["open ai:x", "neither"]
  ])("refuses %j only when it cannot run a turn", (seat, refusal) => {
    const message = Providers.seatRefusal(seat)
    if (refusal === undefined) expect(message).toBeUndefined()
    else expect(message).toContain(refusal)
  })
})

describe("Providers.claudeCode", () => {
  const login = (overrides: Partial<Providers.ClaudeCodeLogin> = {}): Providers.ClaudeCodeLogin => ({
    executable: "/opt/bin/claude",
    loggedIn: true,
    authMethod: "claude.ai",
    subscriptionType: "max",
    ...overrides
  })
  const detected = (
    environment: Readonly<Record<string, string | undefined>>,
    found: Providers.ClaudeCodeLogin | undefined
  ) => Providers.claudeCode({ ...host(environment), claudeCode: () => found })

  it.each(["claude.ai", "oauth_token"])(
    "offers the seats for a subscription Claude Code signed in with %s",
    async (method) => {
      expect(await detected({}, login({ authMethod: method }))).toEqual({
        available: true,
        reason: "Claude Code is signed in with a Claude max",
        setupHint: "run `claude auth login`",
        executable: "/opt/bin/claude"
      })
    }
  )

  it("keeps Claude on the API when ANTHROPIC_API_KEY is set, without asking Claude Code", async () => {
    let asked = false
    const result = await Providers.claudeCode({
      ...host({ ANTHROPIC_API_KEY: "sk-ant" }),
      claudeCode: () => {
        asked = true
        return login()
      }
    })
    expect(result.available).toBe(false)
    expect(result.reason).toBe("$ANTHROPIC_API_KEY is set, so Claude seats run on the API")
    expect(asked).toBe(false)
    // An exported-but-empty key is unset.
    expect((await detected({ ANTHROPIC_API_KEY: "" }, login())).available).toBe(true)
  })

  it.each(
    [
      ["not installed", undefined, "Claude Code is not installed", "install Claude Code"],
      ["signed out", login({ loggedIn: false, authMethod: "none" }), "not signed in", "`claude auth login`"],
      ["signed in with an API key", login({ authMethod: "api_key" }), "not signed in", "`claude auth login`"]
    ] as const
  )("refuses when Claude Code is %s, naming the fix", async (_case, found, reason, hint) => {
    const result = await detected({}, found)
    expect(result.available).toBe(false)
    expect(result.reason).toContain(reason)
    expect(result.setupHint).toContain(hint)
    expect(result.executable).toBeUndefined()
  })

  it("treats a host that cannot look for Claude Code as one without it", async () => {
    expect((await Providers.claudeCode(host({}))).reason).toBe("Claude Code is not installed")
  })

  it("names one seat per Anthropic alias, each running the model its alias names", () => {
    expect(Providers.claudeCodeSeats).toEqual(["claude-code:opus", "claude-code:sonnet", "claude-code:fable"])
    expect(Providers.claudeCodeSeats.map((seat) => Providers.claudeCodeModel(seat.slice("claude-code:".length))))
      .toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"])
    expect(Providers.claudeCodeModel("sol")).toBe("sol")
    expect(Providers.claudeCodeModel("claude-haiku-4-5")).toBe("claude-haiku-4-5")
  })
})

describe("Providers.claudeCodeLogin", () => {
  const onPath = (script: string) => {
    const directory = mkdtempSync(join(tmpdir(), "claude-login-"))
    writeFileSync(join(directory, "claude"), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    return directory
  }

  it("reads only the status `claude auth status` prints, from the claude on PATH", async () => {
    const directory = onPath(
      `[ "$1 $2" = "auth status" ] || exit 9\necho '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","email":"a@b.c"}'`
    )
    try {
      expect(await Providers.claudeCodeLogin({ PATH: `/nonexistent${delimiter}${directory}` })).toEqual({
        executable: join(directory, "claude"),
        loggedIn: true,
        authMethod: "claude.ai",
        subscriptionType: "pro"
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("shares a signed-in Claude Code status per process and caches a signed-out one briefly", async () => {
    const count = (directory: string) => readFileSync(join(directory, "probes"), "utf8").split("\n").length - 1
    const signedInDirectory = onPath(
      `echo probe >> "\${0%/*}/probes"\necho '{"loggedIn":true,"authMethod":"claude.ai"}'`
    )
    const signedOutDirectory = onPath(`echo probe >> "\${0%/*}/probes"\necho '{"loggedIn":false}'\nexit 1`)
    try {
      await Promise.all(Array.from({ length: 5 }, () => Providers.claudeCodeLogin({ PATH: signedInDirectory })))
      expect(count(signedInDirectory)).toBe(1)
      // Another login (config directory) is another answer.
      await Providers.claudeCodeLogin({ PATH: signedInDirectory, CLAUDE_CONFIG_DIR: "/other" })
      expect(count(signedInDirectory)).toBe(2)
      await Promise.all(Array.from({ length: 3 }, () => Providers.claudeCodeLogin({ PATH: signedOutDirectory })))
      expect(count(signedOutDirectory)).toBe(1)
    } finally {
      rmSync(signedInDirectory, { recursive: true, force: true })
      rmSync(signedOutDirectory, { recursive: true, force: true })
    }
  })

  it("isolates token-backed environments without inspecting their tokens", async () => {
    const directory = onPath(
      `echo probe >> "\${0%/*}/probes"\nif [ "$CLAUDE_CODE_OAUTH_TOKEN" = one ]; then\n` +
        `  echo '{"loggedIn":true,"authMethod":"oauth_token"}'\nelse\n` +
        `  echo '{"loggedIn":false,"authMethod":"none"}'\nfi`
    )
    try {
      const first = { PATH: directory, CLAUDE_CODE_OAUTH_TOKEN: "one" }
      const second = { PATH: directory, CLAUDE_CODE_OAUTH_TOKEN: "two" }
      expect((await Providers.claudeCodeLogin(first))?.loggedIn).toBe(true)
      expect((await Providers.claudeCodeLogin(second))?.loggedIn).toBe(false)
      expect((await Providers.claudeCodeLogin(first))?.loggedIn).toBe(true)
      expect(readFileSync(join(directory, "probes"), "utf8")).toBe("probe\nprobe\n")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("re-reads a signed-out answer after 30 seconds and keeps a signed-in answer", async () => {
    const directory = onPath(`echo probe >> "\${0%/*}/probes"\necho '{"loggedIn":false}'\nexit 1`)
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000)
    const count = () => readFileSync(join(directory, "probes"), "utf8").trim().split("\n").length
    try {
      expect((await Providers.claudeCodeLogin({ PATH: directory }))?.loggedIn).toBe(false)
      writeFileSync(
        join(directory, "claude"),
        `#!/bin/sh\necho probe >> "\${0%/*}/probes"\necho '{"loggedIn":true,"authMethod":"claude.ai"}'\n`
      )
      clock.mockReturnValue(30_999)
      expect((await Providers.claudeCodeLogin({ PATH: directory }))?.loggedIn).toBe(false)
      expect(count()).toBe(1)
      clock.mockReturnValue(31_000)
      expect((await Providers.claudeCodeLogin({ PATH: directory }))?.loggedIn).toBe(true)
      expect(count()).toBe(2)
      clock.mockReturnValue(1_000_000)
      expect((await Providers.claudeCodeLogin({ PATH: directory }))?.loggedIn).toBe(true)
      expect(count()).toBe(2)
    } finally {
      clock.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ["failed", `echo probe >> "\${0%/*}/probes"\necho 'workspace unreachable' >&2\nexit 1`],
    ["API-key", `echo probe >> "\${0%/*}/probes"\necho '{"loggedIn":true,"authMethod":"api_key"}'`]
  ])("re-reads a %s answer after 30 seconds", async (_kind, script) => {
    const directory = onPath(script)
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000)
    const count = () => readFileSync(join(directory, "probes"), "utf8").trim().split("\n").length
    try {
      const first = await Providers.claudeCodeLogin({ PATH: directory })
      expect(first?.loggedIn && first.authMethod === "claude.ai").toBe(false)
      writeFileSync(
        join(directory, "claude"),
        `#!/bin/sh\necho probe >> "\${0%/*}/probes"\necho '{"loggedIn":true,"authMethod":"claude.ai"}'\n`
      )
      clock.mockReturnValue(30_999)
      expect(await Providers.claudeCodeLogin({ PATH: directory })).toEqual(first)
      expect(count()).toBe(1)
      clock.mockReturnValue(31_000)
      expect((await Providers.claudeCodeLogin({ PATH: directory }))?.authMethod).toBe("claude.ai")
      expect(count()).toBe(2)
    } finally {
      clock.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("turns a synchronous spawn error into a cached failed status", async () => {
    const directory = onPath(`echo '{"loggedIn":true,"authMethod":"claude.ai"}'`)
    try {
      const environment = { PATH: directory, BAD: "invalid\0value" }
      const first = Providers.claudeCodeLogin(environment)
      expect(Providers.claudeCodeLogin(environment)).toBe(first)
      expect(await first).toMatchObject({ loggedIn: false, error: "claude auth status could not start" })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("reads a signed-out status from a non-zero exit", async () => {
    const directory = onPath(`echo '{"loggedIn":false,"authMethod":"none"}'\nexit 1`)
    try {
      expect(await Providers.claudeCodeLogin({ PATH: directory })).toEqual({
        executable: join(directory, "claude"),
        loggedIn: false,
        authMethod: "none",
        subscriptionType: undefined
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("finds nothing without a claude on PATH, and reports invalid status", async () => {
    expect(await Providers.claudeCodeLogin({})).toBeUndefined()
    const directory = onPath("echo not json")
    try {
      expect(await Providers.claudeCodeLogin({ PATH: directory })).toMatchObject({
        loggedIn: false,
        error: "claude auth status returned no valid JSON"
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
