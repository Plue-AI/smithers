/**
 * Seat detection for `smthrs suggest`, over a fake environment and file
 * reader: the documented order, every way a candidate is or is not available,
 * the choice, and the two refusals.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Providers from "../src/Providers.ts"

const session = JSON.stringify({ tokens: { access_token: "a", refresh_token: "r", account_id: "acct" } })

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
      "openai:gpt-6-sol",
      "moonshot:kimi-k3",
      "openai:gpt-6-sol",
      "gemini:gemini-2.5-pro",
      "openrouter:openai/gpt-6-sol",
      "cerebras:qwen-3.8-27b"
    ])
    expect(detections.some((detection) => detection.seat.startsWith("anthropic"))).toBe(false)
  })

  it("finds a Codex session in ~/.codex/auth.json and runs it through the ChatGPT route", () => {
    const [codex] = Providers.detect(host({}, { "/home/op/.codex/auth.json": session }))

    expect(codex!.available).toBe(true)
    expect(codex!.reason).toBe("/home/op/.codex/auth.json holds a ChatGPT session")
    expect(codex!.environment).toEqual({ SMITHERS_OPENAI_AUTH: "chatgpt" })
  })

  it("reads $CODEX_HOME/auth.json instead when it is set", () => {
    const [codex] = Providers.detect(host({ CODEX_HOME: "/elsewhere" }, { "/elsewhere/auth.json": session }))

    expect(codex!.available).toBe(true)
    expect(codex!.reason).toBe("/elsewhere/auth.json holds a ChatGPT session")
  })

  it("does not count an API-key codex login or a broken file as a session", () => {
    const apiKey = JSON.stringify({ OPENAI_API_KEY: "sk-x" })
    const [keyed] = Providers.detect(host({}, { "/home/op/.codex/auth.json": apiKey }))
    const [broken] = Providers.detect(host({}, { "/home/op/.codex/auth.json": "{" }))

    expect(keyed!.available).toBe(false)
    expect(keyed!.reason).toContain("no ChatGPT token set")
    expect(broken!.available).toBe(false)
    expect(broken!.reason).toBe("/home/op/.codex/auth.json is not valid JSON")
  })

  it("takes SMITHERS_OPENAI_AUTH=chatgpt as the operator's word", () => {
    const [codex] = Providers.detect(host({ SMITHERS_OPENAI_AUTH: "chatgpt" }))

    expect(codex!.available).toBe(true)
    expect(codex!.reason).toBe("SMITHERS_OPENAI_AUTH=chatgpt")
  })

  it("names the missing file and the setup step when there is no session", () => {
    const [codex] = Providers.detect(host({}))

    expect(codex!.reason).toBe("no /home/op/.codex/auth.json")
    expect(codex!.setupHint).toContain("codex login")
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

  it("prefers the Codex session over every key", () => {
    const detections = Providers.detect(
      host({ MOONSHOT_API_KEY: "m" }, { "/home/op/.codex/auth.json": session })
    )
    const chosen = Providers.chooseSeat(detections)

    expect(chosen).toMatchObject({
      seat: "openai:gpt-6-sol",
      source: "codex-subscription",
      environment: { SMITHERS_OPENAI_AUTH: "chatgpt" }
    })
  })

  it("lists every seat it checked when nothing is available", () => {
    const detections = Providers.detect(host({ OPENAI_API_KEY: "" }))
    const chosen = Providers.chooseSeat(detections)

    expect(chosen).toBeInstanceOf(Providers.NoSeatError)
    const message = (chosen as Providers.NoSeatError).message
    expect(message).toContain("No model seat is available")
    expect(message).toContain("Codex subscription (openai:gpt-6-sol): no /home/op/.codex/auth.json")
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
    expect(Providers.defaultSeat["codex-subscription"]).toBe("openai:gpt-6-sol")
    expect(Providers.defaultSeat.openrouter).toBe("openrouter:openai/gpt-6-sol")
  })
})

describe("Providers seat aliases", () => {
  it("names one provider:model per alias", () => {
    expect(Providers.seatAliases).toEqual({
      sol: "openai:gpt-6-sol",
      astra: "openai:gpt-6-astra",
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
    (method) => {
      expect(detected({}, login({ authMethod: method }))).toEqual({
        available: true,
        reason: "Claude Code is signed in with a Claude max",
        setupHint: "run `claude auth login`",
        executable: "/opt/bin/claude"
      })
    }
  )

  it("keeps Claude on the API when ANTHROPIC_API_KEY is set, without asking Claude Code", () => {
    let asked = false
    const result = Providers.claudeCode({
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
    expect(detected({ ANTHROPIC_API_KEY: "" }, login()).available).toBe(true)
  })

  it.each(
    [
      ["not installed", undefined, "Claude Code is not installed", "install Claude Code"],
      ["signed out", login({ loggedIn: false, authMethod: "none" }), "not signed in", "`claude auth login`"],
      ["signed in with an API key", login({ authMethod: "api_key" }), "not signed in", "`claude auth login`"]
    ] as const
  )("refuses when Claude Code is %s, naming the fix", (_case, found, reason, hint) => {
    const result = detected({}, found)
    expect(result.available).toBe(false)
    expect(result.reason).toContain(reason)
    expect(result.setupHint).toContain(hint)
    expect(result.executable).toBeUndefined()
  })

  it("treats a host that cannot look for Claude Code as one without it", () => {
    expect(Providers.claudeCode(host({})).reason).toBe("Claude Code is not installed")
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

  it("reads only the status `claude auth status` prints, from the claude on PATH", () => {
    const directory = onPath(
      `[ "$1 $2" = "auth status" ] || exit 9\necho '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","email":"a@b.c"}'`
    )
    try {
      expect(Providers.claudeCodeLogin({ PATH: `/nonexistent${delimiter}${directory}` })).toEqual({
        executable: join(directory, "claude"),
        loggedIn: true,
        authMethod: "claude.ai",
        subscriptionType: "pro"
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("probes a signed-in Claude Code once per process, and a signed-out one every time", () => {
    const count = (directory: string) => readFileSync(join(directory, "probes"), "utf8").split("\n").length - 1
    const signedInDirectory = onPath(
      `echo probe >> "\${0%/*}/probes"\necho '{"loggedIn":true,"authMethod":"claude.ai"}'`
    )
    const signedOutDirectory = onPath(`echo probe >> "\${0%/*}/probes"\necho '{"loggedIn":false}'\nexit 1`)
    try {
      for (let index = 0; index < 5; index++) Providers.claudeCodeLogin({ PATH: signedInDirectory })
      expect(count(signedInDirectory)).toBe(1)
      // Another login (config directory) is another answer.
      Providers.claudeCodeLogin({ PATH: signedInDirectory, CLAUDE_CONFIG_DIR: "/other" })
      expect(count(signedInDirectory)).toBe(2)
      for (let index = 0; index < 3; index++) Providers.claudeCodeLogin({ PATH: signedOutDirectory })
      expect(count(signedOutDirectory)).toBe(3)
    } finally {
      rmSync(signedInDirectory, { recursive: true, force: true })
      rmSync(signedOutDirectory, { recursive: true, force: true })
    }
  })

  it("reads a signed-out status from a non-zero exit", () => {
    const directory = onPath(`echo '{"loggedIn":false,"authMethod":"none"}'\nexit 1`)
    try {
      expect(Providers.claudeCodeLogin({ PATH: directory })).toEqual({
        executable: join(directory, "claude"),
        loggedIn: false,
        authMethod: "none",
        subscriptionType: undefined
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("finds nothing without a claude on PATH, or with one that prints no status", () => {
    expect(Providers.claudeCodeLogin({})).toBeUndefined()
    const directory = onPath("echo not json")
    try {
      expect(Providers.claudeCodeLogin({ PATH: directory })).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
