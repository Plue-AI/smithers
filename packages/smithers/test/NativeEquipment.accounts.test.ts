import { Seat } from "@smthrs/agent"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Stream } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"
import * as Providers from "../src/Providers.ts"

const fakeHome = vi.hoisted(() => ({ value: undefined as string | undefined }))
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => fakeHome.value ?? actual.homedir() }
})

const executor = RequestExecutor.RequestExecutor.of({
  execute: () => Effect.die(new Error("account resolution must not call model transport"))
})
const directories: Array<string> = []
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-account-seat-"))
  directories.push(directory)
  return directory
}
const login = (accounts: string, account: string) => {
  const directory = join(accounts, account)
  mkdirSync(directory)
  writeFileSync(join(directory, "subscription"), "signed in")
  return directory
}
const codexBinary = () => {
  const directory = fixture()
  writeFileSync(
    join(directory, "codex"),
    "#!/bin/sh\nif [ -n \"$OPENAI_API_KEY$CODEX_API_KEY$OPENAI_BASE_URL\" ]; then exit 7; fi\n" +
      "if [ \"$1 $2\" = \"login status\" ]; then\n" +
      "printf \"%s\\n\" \"$CODEX_HOME\" >> \"${0%/*}/probes\"\n" +
      "if [ -f \"$CODEX_HOME/subscription\" ]; then echo \"Logged in using ChatGPT\"; exit 0; fi\n" +
      "echo \"Not logged in\"; exit 1\nfi\n" +
      "printf \"%s\\n\" \"$CODEX_HOME\" >> \"${0%/*}/executions\"\n" +
      "/bin/cat >/dev/null\n" +
      "echo '{\"type\":\"thread.started\",\"thread_id\":\"account-test\"}'\n" +
      "echo '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"id\":\"answer\",\"text\":\"ok\"}}'\n" +
      "echo '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}'\n",
    { mode: 0o755 }
  )
  return directory
}
const resolve = (environment: Readonly<Record<string, string | undefined>>, declared: string) =>
  Effect.scoped(NodeControl.seatResolver({ PATH: codexBinary(), ...environment }, executor).resolve(declared))
const prepared = (seat: Seat.Seat) =>
  Effect.runPromise(seat.route.prepare({
    modelId: seat.modelId,
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    params: {}
  } as never))

afterEach(() => {
  fakeHome.value = undefined
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("native account-pinned seat resolution", () => {
  it.each(["sol@codex-3", "openai:gpt-6.1-sol@codex-3"])(
    "routes %s through the selected subscription and preserves its declared id",
    async (declared) => {
      const accounts = fixture()
      login(accounts, "codex-3")
      const environment = {
        SMITHERS_ACCOUNTS_DIR: accounts,
        CODEX_HOME: fixture(),
        OPENAI_API_KEY: "ambient-api-key",
        SMITHERS_OPENAI_AUTH: "api-key",
        SMITHERS_ACCOUNT_POOL_URL: "https://ambient-pool.invalid",
        SMITHERS_MODEL_PROXY_URL: "https://ambient-proxy.invalid"
      }
      const resolved = await Effect.runPromise(resolve(environment, declared))
      expect(resolved.id).toBe(declared)
      expect(resolved.modelId).toBe(
        declared.startsWith("sol@") ? Seat.modelIdOf(Providers.expandSeat("sol")) : "gpt-6.1-sol"
      )
      const request = await prepared(resolved)
      expect(request.url).toBe(`codex:${resolved.modelId}`)
      expect(JSON.stringify(request)).not.toContain("ambient-api-key")
      expect(environment.SMITHERS_OPENAI_AUTH).toBe("api-key")
    }
  )

  it.each([
    ["sol@codex-missing", "codex-missing"],
    ["sol@codex-empty", "codex-empty"],
    ["sol@codex-invalid", "codex-invalid"],
    ["sol@codex-keyonly", "codex-keyonly"],
    ["sol@codex-broken", "codex-broken"],
    ["sol@missing", "missing"],
    ["sol@../codex-3", "../codex-3"],
    ["sol@codex-3@codex-4", "codex-3@codex-4"],
    ["sol@", "(empty)"],
    ["@codex-3", "codex-3"],
    ["jev@codex-3", "codex-3"],
    ["anthropic:claude-opus-5@codex-3", "codex-3"],
    ["openai:gpt-6.1-sol@claude-2", "claude-2"],
    ["anthropic:claude-opus-5@claude-2", "claude-2"]
  ])("refuses %s with an account-specific typed error", async (declared, account) => {
    const accounts = fixture()
    login(accounts, "codex-3")
    mkdirSync(join(accounts, "codex-empty"))
    mkdirSync(join(accounts, "codex-invalid"))
    mkdirSync(join(accounts, "codex-keyonly"))
    mkdirSync(join(accounts, "codex-broken"))
    mkdirSync(join(accounts, "claude-2"))
    writeFileSync(join(accounts, "codex-invalid", "auth.json"), "{}")
    writeFileSync(join(accounts, "codex-keyonly", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "wrong-login" }))
    writeFileSync(join(accounts, "codex-broken", "auth.json"), "{broken")
    const error = await Effect.runPromise(Effect.flip(resolve({
      SMITHERS_ACCOUNTS_DIR: accounts,
      OPENAI_API_KEY: "ambient-key",
      ANTHROPIC_API_KEY: "ambient-key"
    }, declared)))
    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
    expect(error.seat).toBe(declared)
    expect(error.message.toLowerCase()).toContain("account")
    expect(error.message).toContain(account)
  })

  it.each(["opus@claude-2", "claude-code:opus@claude-2"])(
    "selects the Claude login directory for %s despite ambient credentials",
    async (declared) => {
      const accounts = fixture()
      const directory = join(accounts, "claude-2")
      mkdirSync(directory)
      const binary = fixture()
      writeFileSync(
        join(binary, "claude"),
        "#!/bin/sh\nprintf \"%s\\n\" \"$CLAUDE_CONFIG_DIR\" > \"${0%/*}/selected\"\n" +
          "if [ -n \"$CLAUDE_CODE_OAUTH_TOKEN$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN$ANTHROPIC_BASE_URL$CLAUDE_CODE_USE_BEDROCK$CLAUDE_CODE_USE_VERTEX$CLAUDE_CODE_USE_FOUNDRY$ANTHROPIC_FOUNDRY_BASE_URL\" ]; then\n" +
          "echo '{\"loggedIn\":false}'\nelse\necho '{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}'\nfi\n",
        { mode: 0o755 }
      )
      const resolved = await Effect.runPromise(resolve({
        SMITHERS_ACCOUNTS_DIR: accounts,
        PATH: binary,
        CLAUDE_CONFIG_DIR: fixture(),
        ANTHROPIC_API_KEY: "ambient-key",
        CLAUDE_CODE_OAUTH_TOKEN: "ambient-token",
        ANTHROPIC_AUTH_TOKEN: "ambient-auth-token",
        ANTHROPIC_BASE_URL: "https://ambient.invalid",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDE_CODE_USE_FOUNDRY: "1",
        ANTHROPIC_FOUNDRY_BASE_URL: "https://ambient-foundry.invalid"
      }, declared))
      expect(resolved.id).toBe(declared)
      expect(resolved.modelId).toBe("claude-opus-5-5")
      expect(readFileSync(join(binary, "selected"), "utf8")).toBe(`${directory}\n`)
    }
  )

  it("isolates Claude login status caches between pinned accounts", async () => {
    const accounts = fixture()
    mkdirSync(join(accounts, "claude-2"))
    mkdirSync(join(accounts, "claude-3"))
    const binary = fixture()
    writeFileSync(
      join(binary, "claude"),
      "#!/bin/sh\ncase \"$CLAUDE_CONFIG_DIR\" in\n" +
        "*claude-2) echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}' ;;\n" +
        "*) echo '{\"loggedIn\":false}' ;;\nesac\n",
      { mode: 0o755 }
    )
    const resolver = NodeControl.seatResolver({ SMITHERS_ACCOUNTS_DIR: accounts, PATH: binary }, executor)
    const signedIn = await Effect.runPromise(Effect.scoped(resolver.resolve("opus@claude-2")))
    expect(signedIn.id).toBe("opus@claude-2")
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(resolver.resolve("opus@claude-3"))))
    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
    expect(error.seat).toBe("opus@claude-3")
    expect(error.message).toContain("claude-3")
  })

  it("executes each pinned Codex seat in its selected login directory", async () => {
    const accounts = fixture()
    const first = login(accounts, "codex-3")
    const second = login(accounts, "codex-4")
    const binary = codexBinary()
    const resolver = NodeControl.seatResolver({
      SMITHERS_ACCOUNTS_DIR: accounts,
      PATH: binary,
      OPENAI_API_KEY: "ambient-key",
      CODEX_API_KEY: "ambient-key",
      OPENAI_BASE_URL: "https://ambient.invalid"
    }, executor)
    for (const account of ["codex-3", "codex-4", "codex-3"]) {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const seat = yield* resolver.resolve(`sol@${account}`)
        yield* seat.model.stream({
          modelId: seat.modelId,
          system: [],
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          tools: [],
          params: {}
        }).pipe(Stream.runCollect)
      })))
    }
    expect(readFileSync(join(binary, "executions"), "utf8")).toBe(`${first}\n${second}\n${first}\n`)
    expect(readFileSync(join(binary, "probes"), "utf8")).toBe(`${first}\n${second}\n`)
  })

  it("refuses a signed-out Codex account without reusing another account's cached login", async () => {
    const accounts = fixture()
    login(accounts, "codex-3")
    mkdirSync(join(accounts, "codex-4"))
    const resolver = NodeControl.seatResolver({ SMITHERS_ACCOUNTS_DIR: accounts, PATH: codexBinary() }, executor)
    expect((await Effect.runPromise(Effect.scoped(resolver.resolve("sol@codex-3")))).id).toBe("sol@codex-3")
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(resolver.resolve("sol@codex-4"))))
    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
    expect(error.message).toContain("codex-4")
    expect(error.seat).toBe("sol@codex-4")
  })

  it("defaults the accounts directory to the selected home", async () => {
    const home = fixture()
    fakeHome.value = home
    const accounts = join(home, ".smithers", "accounts")
    mkdirSync(accounts, { recursive: true })
    login(accounts, "codex-3")
    const seat = await Effect.runPromise(resolve({}, "sol@codex-3"))
    expect(seat.id).toBe("sol@codex-3")
    expect((await prepared(seat)).url).toBe(`codex:${seat.modelId}`)
  })

  it("selects ~/.codex for codex-default even with an accounts directory override", async () => {
    const home = fixture()
    fakeHome.value = home
    login(home, ".codex")
    const seat = await Effect.runPromise(resolve({
      SMITHERS_ACCOUNTS_DIR: fixture(),
      CODEX_HOME: fixture()
    }, "openai:gpt-6.1-sol@codex-default"))
    expect(seat.id).toBe("openai:gpt-6.1-sol@codex-default")
    expect((await prepared(seat)).url).toBe(`codex:${seat.modelId}`)
  })
})
